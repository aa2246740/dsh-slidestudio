/**
 * One `SlidesAgentRuntime` per Hub slide session. The manager owns turn
 * sequencing (followup, resume, steer, operator stop), rebuilds an idle
 * session's runtime when its route, tool policy or discussion mode changes
 * (history is recovered from `_agent/runtime-session.v1.jsonl`), and forwards
 * runtime events and turn outcomes to the host. No DSH agent service is used.
 */
import type { RuntimeEvent, RuntimeTurnResult, SlidesAgentRuntime } from "@open-slidestudio/slides-runtime";
import { discussionOnly } from "./assistant-conversation.js";
import type { LiveQuestionBroker } from "./assistant-questions.js";
import { buildDiskContextSummary, hasPersistedDeckHistory, type DiskSummaryReason } from "./context-summary.js";
import {
  turnMessageText,
  type SessionFollowupOptions,
  type SessionTurnMessage,
  type SlidesSessionHandle,
} from "./session-handle.js";
import {
  buildSessionRuntime,
  sessionRuntimeKey,
  type RouteLimits,
  type SessionRouteSpec,
  type SessionRuntimeDeps,
} from "./session-runtime-config.js";

export type TurnAction =
  | { readonly kind: "prompt"; readonly text: string; readonly seedFromSummary?: string }
  /** Continue the persisted transcript; prompt `fallbackText` when nothing is resumable. */
  | { readonly kind: "resume"; readonly fallbackText: string; readonly seedFromSummary?: string };

export type SessionRuntimeManagerOptions = SessionRuntimeDeps & {
  /** Route limits from the LLM catalog (`ctx.llm.resolveModelInfo`). */
  readonly resolveLimits: (spec: SessionRouteSpec) => Promise<RouteLimits>;
  readonly onEvent?: (sessionId: string, event: RuntimeEvent) => void;
  readonly onTurnEnd?: (sessionId: string, result: RuntimeTurnResult) => void;
  readonly onTurnError?: (sessionId: string, error: unknown) => void;
  /** A turn began (busy) or every queued turn settled (idle). */
  readonly onStatus?: (sessionId: string, status: "running" | "idle") => void;
};

type Entry = {
  readonly sessionId: string;
  spec: SessionRouteSpec;
  limits: RouteLimits;
  runtime: SlidesAgentRuntime;
  key: string;
  unsubscribe: () => void;
  turn?: Promise<unknown>;
  ticket: number;
  stoppedTicket: number;
  steers: string[];
};

const STOPPED_BEFORE_START = "the operator stopped the run before it started";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class SessionRuntimeManager {
  private readonly entries = new Map<string, Entry>();
  private readonly pendingSeedReasons = new Map<string, DiskSummaryReason>();
  private disposed = false;

  constructor(private readonly options: SessionRuntimeManagerOptions) {}

  /** Request a fresh summary-seeded context on this session's next turn (model switch or failover). */
  markSeedOnNextTurn(sessionId: string, reason: DiskSummaryReason = "model-switch"): void {
    this.pendingSeedReasons.set(sessionId, reason);
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** True while a turn for this session is queued or running. */
  running(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    return Boolean(entry && (entry.turn || entry.runtime.running));
  }

  sessionIds(): string[] {
    return [...this.entries.keys()];
  }

  spec(sessionId: string): SessionRouteSpec | undefined {
    return this.entries.get(sessionId)?.spec;
  }

  runtime(sessionId: string): SlidesAgentRuntime | undefined {
    return this.entries.get(sessionId)?.runtime;
  }

  questions(sessionId: string): LiveQuestionBroker | undefined {
    return this.entries.get(sessionId)?.runtime.questions;
  }

  /** Route-facing handle; undefined until the session has been opened in this process. */
  handle(sessionId: string): SlidesSessionHandle | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    return {
      status: this.running(sessionId) ? "running" : "idle",
      followup: (message: SessionTurnMessage, options?: SessionFollowupOptions) =>
        this.enqueue(sessionId, {
          kind: "prompt",
          text: turnMessageText(message),
          ...(options?.seedFromSummary ? { seedFromSummary: options.seedFromSummary } : {}),
        }),
      steer: (message: SessionTurnMessage) => this.steer(sessionId, turnMessageText(message)),
    };
  }

  /**
   * Open (or re-route) a session runtime. An idle session on a different route
   * is rebuilt immediately so a failed rebuild surfaces to the caller; a busy
   * one keeps its runtime and picks the new route up before its next turn.
   */
  async open(sessionId: string, spec: SessionRouteSpec): Promise<void> {
    if (this.disposed) throw new Error("the slides host was disposed");
    const limits = await this.options.resolveLimits(spec);
    const entry = this.entries.get(sessionId);
    if (!entry) {
      this.entries.set(sessionId, this.create(sessionId, spec, limits));
      return;
    }
    entry.spec = spec;
    entry.limits = limits;
    if (!this.running(sessionId)) await this.refresh(entry);
  }

  private create(sessionId: string, spec: SessionRouteSpec, limits: RouteLimits): Entry {
    const built = buildSessionRuntime(this.options, sessionId, spec, limits);
    const entry: Entry = {
      sessionId,
      spec,
      limits,
      runtime: built.runtime,
      key: built.key,
      unsubscribe: () => undefined,
      ticket: 0,
      stoppedTicket: 0,
      steers: [],
    };
    entry.unsubscribe = this.subscribe(entry);
    return entry;
  }

  private subscribe(entry: Entry): () => void {
    return entry.runtime.subscribe((event) =>
      this.safeCall("onEvent", () => this.options.onEvent?.(entry.sessionId, event)),
    );
  }

  /** Rebuild an idle runtime whose route, tool policy or discussion mode changed. */
  private async refresh(entry: Entry): Promise<void> {
    if (sessionRuntimeKey(this.options, entry.sessionId, entry.spec) === entry.key) return;
    const built = buildSessionRuntime(this.options, entry.sessionId, entry.spec, entry.limits);
    const previous = entry.runtime;
    entry.unsubscribe();
    await previous.dispose();
    entry.runtime = built.runtime;
    entry.key = built.key;
    entry.unsubscribe = this.subscribe(entry);
  }

  private safeCall(label: string, fn: () => unknown): void {
    try {
      const result = fn();
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).catch((error) => {
          console.warn(`[slides] ${label} failed:`, error instanceof Error ? error.message : error);
        });
      }
    } catch (error) {
      console.warn(`[slides] ${label} failed:`, error instanceof Error ? error.message : error);
    }
  }

  /** Queue a turn; it starts after any previous turn of the same session settled. */
  enqueue(sessionId: string, action: TurnAction): void {
    const entry = this.entries.get(sessionId);
    if (!entry || this.disposed) throw new Error(`unknown session ${sessionId}`);
    const ticket = (entry.ticket += 1);
    const prior = entry.turn ?? Promise.resolve();
    this.safeCall("onStatus(running)", () => this.options.onStatus?.(sessionId, "running"));
    const turn = prior
      .catch(() => undefined)
      .then(() => this.execute(entry, action, ticket))
      .then(
        (result) => {
          if (result) this.safeCall("onTurnEnd", () => this.options.onTurnEnd?.(sessionId, result));
        },
        (error: unknown) => this.safeCall("onTurnError", () => this.options.onTurnError?.(sessionId, error)),
      );
    entry.turn = turn;
    void turn
      .finally(() => {
        if (entry.turn !== turn) return;
        entry.turn = undefined;
        entry.steers.length = 0;
        this.safeCall("onStatus(idle)", () => this.options.onStatus?.(sessionId, "idle"));
      })
      .catch(() => undefined);
  }

  private async execute(entry: Entry, action: TurnAction, ticket: number): Promise<RuntimeTurnResult | undefined> {
    if (this.disposed) return undefined;
    if (ticket <= entry.stoppedTicket) return this.stoppedResult(entry);
    await this.refresh(entry);
    if (ticket <= entry.stoppedTicket) return this.stoppedResult(entry);
    const pending = this.start(entry, action);
    if (entry.runtime.running) {
      for (const text of entry.steers.splice(0)) entry.runtime.steer(text);
    } else {
      entry.steers.length = 0;
    }
    return pending;
  }

  private resolveTurnSeed(sessionId: string, explicitSeed: string | undefined): string | undefined {
    if (explicitSeed?.trim()) {
      this.pendingSeedReasons.delete(sessionId);
      return explicitSeed.trim();
    }
    const pendingReason = this.pendingSeedReasons.get(sessionId);
    if (!pendingReason) return undefined;
    const binding = this.options.store.bindingFor(sessionId);
    if (!binding) {
      this.pendingSeedReasons.delete(sessionId);
      return undefined;
    }
    const root = this.options.store.resolveRoot(binding);
    // Keep pending model-switch seed unconsumed across read-only discussion turns so dialogue stays intact.
    if (discussionOnly(root)) return undefined;
    this.pendingSeedReasons.delete(sessionId);
    return hasPersistedDeckHistory(root) ? buildDiskContextSummary(root, { reason: pendingReason }) : undefined;
  }

  private start(entry: Entry, action: TurnAction): Promise<RuntimeTurnResult> {
    const seedFromSummary = this.resolveTurnSeed(entry.sessionId, action.seedFromSummary);
    if (action.kind === "prompt") {
      return seedFromSummary
        ? entry.runtime.prompt({ text: action.text, seedFromSummary })
        : entry.runtime.prompt(action.text);
    }
    if (seedFromSummary) return entry.runtime.prompt({ text: action.fallbackText, seedFromSummary });
    return entry.runtime.resume().catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith("nothing to resume:")) {
        return entry.runtime.prompt(action.fallbackText);
      }
      throw error;
    });
  }

  private stoppedResult(entry: Entry): RuntimeTurnResult {
    entry.steers.length = 0;
    return {
      turn: 0,
      status: "aborted",
      fault: { code: "operator-stop", detail: STOPPED_BEFORE_START },
      toolNames: [],
    };
  }

  /** Discard any steers queued while a turn or failover was starting. */
  clearSteers(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) entry.steers.length = 0;
  }

  /** Inject text into the running turn; text sent while a turn is still queued joins it on start. */
  steer(sessionId: string, text: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error(`unknown session ${sessionId}`);
    if (entry.runtime.running) entry.runtime.steer(text);
    else if (entry.turn) entry.steers.push(text);
  }

  /**
   * Operator stop: cancel queued turns, abort the running one and wait for it
   * to settle, bounded by `timeoutMs`. Returns whether the session went idle.
   */
  async stop(sessionId: string, timeoutMs: number): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry) return true;
    entry.stoppedTicket = entry.ticket;
    entry.steers.length = 0;
    entry.runtime.abort();
    const turn = entry.turn;
    if (!turn) return true;
    let settled = false;
    await Promise.race([
      turn.then(
        () => (settled = true),
        () => (settled = true),
      ),
      sleep(timeoutMs),
    ]);
    return settled;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      entries.map(async (entry) => {
        entry.unsubscribe();
        await entry.runtime.dispose().catch(() => undefined);
      }),
    );
  }
}
