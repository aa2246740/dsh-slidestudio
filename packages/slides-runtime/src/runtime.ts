/**
 * `SlidesAgentRuntime`: the single host-neutral core agent loop. It drives
 * pi-agent-core's `Agent` over the canonical slide tools and wires the
 * context budget (`transformContext`), argument/progress/lease guards
 * (`beforeToolCall` + event observation), steering, abort, 429 backoff,
 * provider-overflow retry, post-turn hooks, the JSONL session log, the public
 * trace and the single-writer lease.
 */
import crypto from "node:crypto";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { resolveModelPolicyProfile, type ModelPolicyProfile } from "@open-slidestudio/presentation-run";
import { runPostTurnHooks, type PostTurnHook, type SlideCaller } from "@open-slidestudio/slides-tools";
import { ContextBudget, type ContextBudgetOptions } from "./context-budget.js";
import { classifyFault, type RuntimeFault } from "./faults.js";
import { isLeaseFaultCode, type WriterLeaseKeeper } from "./lease-keeper.js";
import type { ProgressGuard } from "./progress-guard.js";
import type { GuardEvent } from "./guard-events.js";
import {
  buildRuntimeTools,
  defaultSystemPrompt,
  leaseKeeperFor,
  progressGuardFor,
  streamWithBudget,
  type SlidesRuntimeOptions,
} from "./runtime-config.js";
import {
  flushImageDeliveries,
  recoverTurnFailures,
  reportDeliveredReferences,
  seededContext,
  trackOutgoing,
} from "./runtime-recovery.js";
import {
  createTurnState,
  notifyListeners,
  resolveTurnOutcome,
  toolResultEvent,
  turnEndReason,
  userPromptMessage,
  withRecoveredSystemHeader,
  withoutTrailingFailure,
  type PromptInput,
  type RuntimeEvent,
  type RuntimeTurnResult,
  type TurnState,
} from "./runtime-support.js";
import { RuntimeSessionStore, type RecoveredSession } from "./session-store.js";
import { TokenCalibration } from "./token-estimate.js";
import { ToolInvalidArgsLoopGuard } from "./tool-loop-guard.js";
import type { ProjectBinding } from "./tool-adapter.js";
import { assistantRows, readTraceHighWater, resultRow, toolRow, TraceWriter, turnRow } from "./trace-projection.js";
import { QuestionBroker, type AssistantQuestionRow } from "./user-question.js";

export type { PromptInput, RuntimeEvent } from "./runtime-support.js";

export class SlidesAgentRuntime {
  readonly sessionId: string;
  readonly caller: SlideCaller;
  readonly questions?: QuestionBroker;
  readonly recovery?: RecoveredSession & { readonly interruptedQuestions: readonly string[] };
  private readonly agent: Agent;
  private readonly tools: readonly AgentTool[];
  private readonly policy: ModelPolicyProfile;
  private readonly budget: ContextBudget;
  private readonly store: RuntimeSessionStore;
  private readonly trace: TraceWriter;
  private readonly toolLoop = new ToolInvalidArgsLoopGuard();
  /** Online estimate calibration from provider-reported input usage. */
  readonly calibration = new TokenCalibration();
  private readonly reportedReferences = new Set<string>();
  private pendingSeed?: string;
  private readonly progress?: ProgressGuard;
  private readonly lease?: WriterLeaseKeeper;
  private readonly postTurnHooks: readonly PostTurnHook[];
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly toolNames: ReadonlySet<string>;
  private bound?: ProjectBinding;
  private syncedDiskSeq = -1;
  private turnCounter = 0;
  private current?: TurnState;
  private disposed = false;

  constructor(private readonly options: SlidesRuntimeOptions) {
    this.sessionId = options.sessionId ?? crypto.randomUUID();
    this.caller = options.caller ?? { kind: "hub-run", id: `hub-run:${this.sessionId}` };
    this.policy = options.policy ?? resolveModelPolicyProfile();
    this.postTurnHooks = options.postTurnHooks ?? [];
    this.lease = leaseKeeperFor(options, this.caller, (fault) => this.failTurn(fault, "lease/lost"));
    const writeGate = this.lease
      ? (projectRoot: string, write: () => void) => this.lease!.withAuthorizedWrite(projectRoot, write)
      : undefined;
    this.store = new RuntimeSessionStore({
      persistImages: options.persistImages === true,
      ...(writeGate ? { writeGate } : {}),
    });
    this.trace = new TraceWriter(writeGate);
    if (options.userQuestions) this.questions = new QuestionBroker(() => this.bound?.projectRoot, writeGate);
    this.progress = progressGuardFor(options);
    this.budget = new ContextBudget(() => this.budgetOptions());
    const tools = buildRuntimeTools(options, {
      caller: this.caller,
      sessionId: this.sessionId,
      policy: this.policy,
      questions: this.questions,
      binding: () => this.bound,
      onBind: (binding) => this.bind(binding),
      onInvalidArgs: (callId, error) => this.current?.invalidArgs.set(callId, error),
      deferDelivery: (callId, hook) => this.current?.deliveries.set(callId, hook),
      turnSignal: () => this.current?.signal.signal,
    });
    this.tools = tools;
    this.toolNames = new Set(tools.map((tool) => tool.name));
    const recovered = options.project ? this.inspectProject(options.project, tools) : undefined;
    if (recovered) this.recovery = recovered;
    this.pendingSeed = options.initialSummaryContext?.trim() || undefined;
    const seeded = this.pendingSeed ? seededContext(this.pendingSeed, this.systemPrompt(), tools) : undefined;
    this.agent = this.createAgent(tools, seeded ?? recovered?.messages ?? []);
  }

  /** Read-only recovery inspection; disk closure waits until this runtime acquires the writer lease. */
  private inspectProject(project: ProjectBinding, tools: AgentTool[]) {
    const inspected = this.store.inspect(project.projectRoot);
    this.bound = project;
    const interruptedQuestions = this.questions?.stalePendingIds() ?? [];
    this.turnCounter = Math.max(inspected.lastTurn, readTraceHighWater(project.projectRoot).maxTurn);
    const messages = withRecoveredSystemHeader(inspected.messages, this.systemPrompt(), tools);
    return { ...inspected, messages, interruptedQuestions };
  }

  /** Re-inspect disk state under the held lease so stale constructor or pre-handoff snapshots never win. */
  private syncBoundProject(projectRoot: string): void {
    const fresh = this.store.inspect(projectRoot);
    const diskMaxSeq = fresh.records.reduce(
      (max, row) => (typeof row.seq === "number" && row.seq > max ? row.seq : max),
      0,
    );
    this.store.attach(projectRoot);
    this.trace.attach(projectRoot);
    this.turnCounter = Math.max(this.turnCounter, fresh.lastTurn, readTraceHighWater(projectRoot).maxTurn);
    if (fresh.records.length > 0 && diskMaxSeq > this.syncedDiskSeq) {
      this.agent.state.messages = withRecoveredSystemHeader(fresh.messages, this.systemPrompt(), this.tools);
    }
    if (fresh.interruptedTurn !== undefined) {
      this.store.append({ type: "turn/end", turn: fresh.interruptedTurn, reason: { kind: "interrupted" } });
      this.trace.write([turnRow({ turn: fresh.interruptedTurn }, { kind: "interrupted" })]);
    }
    this.questions?.markInterrupted();
    this.syncedDiskSeq = this.store.currentSeq;
  }

  private systemPrompt(): string {
    return this.options.systemPrompt ?? defaultSystemPrompt(this.options.workingDirectory ?? this.options.dataRoot);
  }

  private createAgent(tools: AgentTool[], messages: AgentMessage[]): Agent {
    const agent = new Agent({
      initialState: {
        systemPrompt: this.systemPrompt(),
        model: this.options.llm.model,
        thinkingLevel: this.thinkingLevel(),
        tools,
        messages,
      },
      streamFn: streamWithBudget(
        this.options.llm,
        () => this.budgetOptions(),
        (outgoing) => trackOutgoing(this.current, outgoing, this.options.contextBudget),
        {
          projection: () => this.budget.lastProjection,
          onEstimate: (tokens) => this.calibration.recordRequest(tokens),
          thinkingLevel: () => this.agent.state.thinkingLevel,
        },
      ),
      transformContext: this.budget.transform,
      beforeToolCall: (context) => this.beforeToolCall(context),
      toolExecution: "parallel",
      sessionId: this.sessionId,
    });
    agent.subscribe((event) => this.onAgentEvent(event));
    return agent;
  }

  private thinkingLevel(): ThinkingLevel {
    return this.options.thinkingLevel ?? this.options.llm.route.reasoningEffort ?? "off";
  }

  private budgetOptions(): ContextBudgetOptions {
    const route = this.options.llm.route;
    return {
      contextWindow: route.contextWindow,
      maxOutputTokens: route.maxTokens,
      tokenMultiplier: this.calibration.multiplier,
      ...this.options.contextBudget,
    };
  }

  /** The bound project, if any. */
  get binding(): ProjectBinding | undefined {
    return this.bound;
  }

  get messages(): readonly AgentMessage[] {
    return this.agent.state.messages;
  }

  get running(): boolean {
    return this.current !== undefined;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    notifyListeners(this.listeners, event);
  }

  private bind(binding: ProjectBinding): void {
    if (this.bound?.projectRoot === binding.projectRoot && this.store.attachedFile) return;
    if (this.current && this.lease) {
      const fault = this.lease.acquire(binding.projectRoot);
      if (fault) {
        this.failTurn(fault, "lease/lost");
        return;
      }
    }
    this.bound = binding;
    this.store.attach(binding.projectRoot);
    this.trace.attach(binding.projectRoot);
  }

  /** Start a new turn from a user prompt. */
  prompt(input: PromptInput): Promise<RuntimeTurnResult> {
    const seed = typeof input === "string" ? undefined : input.seedFromSummary?.trim();
    return this.runTurn(() => this.agent.prompt(userPromptMessage(input)), false, seed || undefined);
  }

  /** Continue an interrupted turn from the persisted transcript (freshly synced under lease when bound). */
  resume(): Promise<RuntimeTurnResult> {
    return this.runTurn(() => this.agent.continue(), true);
  }

  /** Inject a user message after the current assistant step (ignored if idle, aborted or faulted). */
  steer(text: string): void {
    if (!this.current || this.current.signal.signal.aborted || Boolean(this.current.fault)) return;
    this.agent.steer({ role: "user", content: text, timestamp: Date.now() });
  }

  /** Operator stop of the running turn. */
  abort(detail = "the operator stopped the run"): void {
    this.agent.clearSteeringQueue();
    if (!this.current) return;
    this.current.fault ??= { code: "operator-stop", detail };
    this.current.signal.abort();
    this.agent.abort();
  }

  listQuestions(): AssistantQuestionRow[] {
    return this.questions?.list() ?? [];
  }

  answerQuestion(id: string, answer: unknown): void {
    if (!this.questions) throw new Error("user questions are disabled for this runtime");
    this.questions.answer(id, answer);
  }

  cancelQuestion(id: string): void {
    if (!this.questions) throw new Error("user questions are disabled for this runtime");
    this.questions.cancel(id);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abort("the runtime was disposed");
    await this.agent.waitForIdle();
    this.questions?.dispose();
    this.lease?.release();
  }

  private failTurn(fault: RuntimeFault, type: "guard/trip" | "lease/lost"): void {
    const turn = this.current;
    if (!turn || turn.fault) return;
    turn.fault = fault;
    this.emit({ type, fault });
    turn.signal.abort();
    this.agent.abort();
  }

  private canWriteBoundProject(fault?: RuntimeFault): boolean {
    if (isLeaseFaultCode(fault?.code)) return false;
    if (!this.bound || !this.lease) return true;
    return this.lease.isAuthorized(this.bound.projectRoot);
  }

  private async runTurn(start: () => Promise<void>, isResume = false, seed?: string): Promise<RuntimeTurnResult> {
    if (this.disposed) throw new Error("the runtime was disposed");
    if (this.current) throw new Error("a turn is already running");
    const state = createTurnState(this.turnCounter + 1);
    this.current = state;
    this.budget.reset();
    let caughtFault: RuntimeFault | undefined;
    try {
      const refusal = this.bound && this.lease ? this.lease.acquire(this.bound.projectRoot) : undefined;
      if (refusal) {
        state.fault = refusal;
      } else {
        if (this.bound) this.syncBoundProject(this.bound.projectRoot);
        this.applySeed(seed ?? this.pendingSeed);
        this.agent.state.thinkingLevel = this.thinkingLevel();
        if (isResume) {
          this.agent.state.messages = withoutTrailingFailure(this.agent.state.messages);
          const last = this.agent.state.messages.at(-1) as { role?: unknown } | undefined;
          if (last?.role !== "user" && last?.role !== "toolResult") {
            this.lease?.release();
            this.current = undefined;
            throw new Error("nothing to resume: the transcript does not end with a user or tool message");
          }
        }
        state.turn = this.turnCounter += 1;
        this.beginTurn(state.turn);
        await start();
        await recoverTurnFailures({
          agent: this.agent,
          budget: this.budget,
          options: this.options,
          policy: this.policy,
          state,
          emit: (event) => this.emit(event),
        });
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("nothing to resume:")) throw error;
      caughtFault = classifyFault(error);
    }
    try {
      await this.runHooks(state, caughtFault);
    } catch (error) {
      caughtFault ??= classifyFault(error);
    }
    return this.endTurn(state, caughtFault);
  }

  private beginTurn(turn: number): void {
    this.store.append({ type: "turn/start", turn });
    this.trace.write([turnRow({ turn })]);
    this.observeGuards({ type: "turn/start", turn });
    this.emit({ type: "turn/start", turn });
  }

  private computeResult(state: TurnState, caughtFault?: RuntimeFault): RuntimeTurnResult {
    return caughtFault && !state.fault
      ? { turn: state.turn, status: "failed", fault: caughtFault, toolNames: [...state.toolNames] }
      : this.outcome(state);
  }

  private endTurn(state: TurnState, caughtFault?: RuntimeFault): RuntimeTurnResult {
    let result: RuntimeTurnResult;
    try {
      const writable = this.canWriteBoundProject(state.fault ?? caughtFault);
      result = this.computeResult(state, caughtFault);
      if (writable) {
        const reason = turnEndReason(result);
        try {
          if (result.fault) this.store.append({ type: "fault", turn: state.turn, ...result.fault });
          this.store.append({ type: "turn/end", turn: state.turn, reason });
          if (this.bound) this.syncedDiskSeq = this.store.currentSeq;
        } catch (error) {
          caughtFault ??= classifyFault(error);
        }
        try {
          this.trace.write([turnRow({ turn: state.turn }, reason)]);
        } catch (error) {
          caughtFault ??= classifyFault(error);
        }
        result = this.computeResult(state, caughtFault);
      }
      this.observeGuards({ type: "turn/end", turn: state.turn });
      result = this.computeResult(state, caughtFault);
    } catch (error) {
      caughtFault ??= classifyFault(error);
      result = this.computeResult(state, caughtFault);
    } finally {
      this.agent.clearSteeringQueue();
      this.lease?.release();
      this.current = undefined;
    }
    this.emit({ type: "turn/end", result });
    return result;
  }

  private async runHooks(state: TurnState, caughtFault?: RuntimeFault): Promise<void> {
    if (!this.bound || !this.postTurnHooks.length) return;
    const results: { name: string; ok: boolean; error?: string }[] = [];
    for (const hook of this.postTurnHooks) {
      if (state.signal.signal.aborted || !this.canWriteBoundProject(state.fault ?? caughtFault)) break;
      const [row] = await runPostTurnHooks([hook], {
        projectId: this.bound.projectId,
        projectRoot: this.bound.projectRoot,
        caller: this.caller,
        sessionId: this.sessionId,
        signal: state.signal.signal,
        toolNames: state.toolNames,
      });
      if (row) results.push(row);
    }
    // Re-check lease after the final hook so a mid-hook takeover surfaces as a lease fault.
    if (results.length && !state.fault) this.canWriteBoundProject(caughtFault);
    if (results.length) this.emit({ type: "post-turn", results });
  }

  /** Replace the model context with a fresh summary-seeded one; the session log keeps the raw history. */
  private applySeed(summary: string | undefined): void {
    this.pendingSeed = undefined;
    if (summary) this.agent.state.messages = seededContext(summary, this.systemPrompt(), this.tools);
  }

  private outcome(state: TurnState): RuntimeTurnResult {
    return resolveTurnOutcome(state.turn, state.toolNames, state.fault, this.agent.state.messages, this.policy);
  }

  private async beforeToolCall(context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> {
    const turn = this.current;
    turn?.prepared.add(context.toolCall.id);
    const fault = turn?.fault;
    if (fault) return { block: true, reason: `${fault.code}: ${fault.detail}`, terminate: true };
    return undefined;
  }

  private observeGuards(event: GuardEvent): void {
    const turn = this.current;
    const trip = this.toolLoop.observe(this.sessionId, event);
    let progressTrip;
    try {
      progressTrip = this.bound
        ? this.progress?.observe(this.sessionId, this.bound.projectRoot, event, turn?.turn)
        : undefined;
    } catch {
      progressTrip = undefined;
    }
    const tripped = trip ?? progressTrip;
    if (tripped) this.failTurn({ code: tripped.code, detail: tripped.detail }, "guard/trip");
  }

  private async onAgentEvent(event: AgentEvent): Promise<void> {
    try {
      await this.handleAgentEvent(event);
    } catch {
      // A persistence or projection failure must not crash the agent loop.
    }
    this.emit({ type: "agent", event });
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    const turn = this.current;
    if (!turn) return;
    const stamp = { turn: turn.turn, step: turn.step };
    switch (event.type) {
      case "turn_start":
        turn.step += 1;
        return;
      case "message_end":
        return this.onMessageEnd(turn, event.message);
      case "tool_execution_start":
        turn.toolNames.push(event.toolName);
        this.trace.write([toolRow(stamp, event.toolCallId, event.toolName, event.args)]);
        this.observeGuards({ type: "tool/call", callId: event.toolCallId, toolName: event.toolName, step: turn.step });
        return;
      case "tool_execution_end": {
        const content = (event.result as { content?: unknown } | undefined)?.content;
        this.trace.write([resultRow(stamp, event.toolCallId, content, event.isError)]);
        const adapterError = turn.invalidArgs.get(event.toolCallId);
        this.observeGuards(
          toolResultEvent({
            callId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            content,
            step: turn.step,
            unprepared: !turn.prepared.has(event.toolCallId),
            knownTool: this.toolNames.has(event.toolName),
            aborted: turn.signal.signal.aborted,
            ...(adapterError ? { adapterError: { name: adapterError.name, message: adapterError.message } } : {}),
          }),
        );
        return;
      }
      default:
        return;
    }
  }

  private async onMessageEnd(turn: TurnState, message: AgentMessage): Promise<void> {
    this.store.append({ type: "message", turn: turn.turn, message });
    const record = message as unknown as { role?: unknown; stopReason?: unknown };
    if (record.role !== "assistant") return;
    this.trace.write(assistantRows({ turn: turn.turn, step: turn.step }, message));
    const delivered = turn.inFlightImageCallIds;
    const references = turn.inFlightReferenceCallIds ?? [];
    turn.inFlightImageCallIds = new Set();
    turn.inFlightReferenceCallIds = [];
    this.calibration.observeUsage((message as AssistantMessage).usage);
    if (
      record.stopReason === "error" ||
      record.stopReason === "aborted" ||
      turn.signal.signal.aborted ||
      Boolean(turn.fault)
    ) {
      return;
    }
    if (this.canWriteBoundProject(turn.fault)) {
      reportDeliveredReferences(references, this.reportedReferences, this.options.contextBudget);
    }
    await flushImageDeliveries(turn, delivered, () => this.canWriteBoundProject(turn.fault));
  }
}

/** Create a runtime; when `options.project` is set, the persisted session is recovered first. */
export function createSlidesRuntime(options: SlidesRuntimeOptions): SlidesAgentRuntime {
  return new SlidesAgentRuntime(options);
}
