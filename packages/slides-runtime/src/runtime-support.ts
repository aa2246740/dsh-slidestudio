/** Pure helpers for the runtime: transcript inspection, turn outcomes, guard events and ports. */
import type { AgentEvent, AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createInitialSystemMessage,
  toToolDeclaration,
  validateToolArguments,
  type AssistantMessage,
  type ImageContent,
} from "@earendil-works/pi-ai";
import type { ModelPolicyProfile } from "@open-slidestudio/presentation-run";
import type { SlideProjectPort, SlideSchemaValidator } from "@open-slidestudio/slides-tools";
import { classifyLlmFailure, type RuntimeFault } from "./faults.js";
import { INVALID_ARGS_CODE, type GuardEvent, type GuardToolError } from "./guard-events.js";
import { readLlmFailure } from "./llm-port.js";
import type { TurnEndReason } from "./session-store.js";
import type { ProjectBinding, RuntimeToolArgsError } from "./tool-adapter.js";

export type TurnState = {
  turn: number;
  step: number;
  fault?: RuntimeFault;
  readonly toolNames: string[];
  readonly prepared: Set<string>;
  readonly invalidArgs: Map<string, RuntimeToolArgsError>;
  readonly deliveries: Map<string, () => Promise<void>>;
  inFlightImageCallIds: Set<string>;
  /** Read-reference results projected untruncated into the request in flight. */
  inFlightReferenceCallIds?: readonly string[];
  readonly signal: AbortController;
};

export function createTurnState(turn: number): TurnState {
  return {
    turn,
    step: 0,
    toolNames: [],
    prepared: new Set(),
    invalidArgs: new Map(),
    deliveries: new Map(),
    inFlightImageCallIds: new Set(),
    signal: new AbortController(),
  };
}

export type RuntimeTurnStatus = "completed" | "aborted" | "paused" | "failed" | "max-tokens";

export type RuntimeTurnResult = {
  readonly turn: number;
  readonly status: RuntimeTurnStatus;
  readonly fault?: RuntimeFault;
  /** Final assistant text of the turn, if any. */
  readonly text?: string;
  readonly toolNames: readonly string[];
};

export type RuntimeEvent =
  | { readonly type: "agent"; readonly event: AgentEvent }
  | { readonly type: "turn/start"; readonly turn: number }
  | { readonly type: "turn/end"; readonly result: RuntimeTurnResult }
  | { readonly type: "guard/trip"; readonly fault: RuntimeFault }
  | { readonly type: "lease/lost"; readonly fault: RuntimeFault }
  | { readonly type: "rate-limit/wait"; readonly attempt: number; readonly waitMs: number }
  | { readonly type: "context/escalate"; readonly tier: number }
  | { readonly type: "max-tokens/retry"; readonly attempt: number; readonly thinkingLevel: ThinkingLevel }
  | { readonly type: "post-turn"; readonly results: readonly { name: string; ok: boolean; error?: string }[] };

export type PromptInput =
  | string
  | {
      readonly text: string;
      readonly images?: readonly ImageContent[];
      /** Start this turn from a fresh context seeded with this compact disk summary instead of replayed history. */
      readonly seedFromSummary?: string;
    };

export function userPromptMessage(input: PromptInput): AgentMessage {
  const text = typeof input === "string" ? input : input.text;
  const images = typeof input === "string" ? [] : (input.images ?? []);
  return {
    role: "user",
    content: images.length ? [{ type: "text", text }, ...images] : text,
    timestamp: Date.now(),
  };
}

/** Fan out a runtime event while containing both synchronous throws and async listener rejections. */
export function notifyListeners(listeners: Iterable<(event: RuntimeEvent) => void>, event: RuntimeEvent): void {
  for (const listener of listeners) {
    try {
      const out = listener(event) as unknown;
      if (out && typeof (out as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(out).catch(() => undefined);
      }
    } catch {
      // Listener failures never break the loop.
    }
  }
}

/** Derive the final turn outcome from the turn's fault state and trailing assistant message. */
export function resolveTurnOutcome(
  turn: number,
  toolNames: readonly string[],
  fault: RuntimeFault | undefined,
  messages: readonly AgentMessage[],
  policy: ModelPolicyProfile,
): RuntimeTurnResult {
  const base = { turn, toolNames: [...toolNames] };
  const last = lastAssistant(messages);
  const text = assistantText(last);
  const withText = text ? { ...base, text } : base;
  if (fault) {
    return { ...withText, status: fault.code === "operator-stop" ? "aborted" : "paused", fault };
  }
  if (last?.stopReason === "aborted") {
    return { ...withText, status: "aborted", fault: { code: "operator-stop", detail: "the run was aborted" } };
  }
  if (last?.stopReason === "error") {
    return {
      ...withText,
      status: "failed",
      fault: classifyLlmFailure(readLlmFailure(last) ?? { code: "UNKNOWN", message: "" }, policy),
    };
  }
  return { ...withText, status: last?.stopReason === "length" ? "max-tokens" : "completed" };
}

export function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown };
    if (message.role === "assistant") return messages[index] as AssistantMessage;
    if (message.role === "user") return undefined;
  }
  return undefined;
}

/** Remove a trailing failed or tool-less truncated assistant reply so `continue()` can resume cleanly. */
export function withoutTrailingFailure(messages: readonly AgentMessage[]): AgentMessage[] {
  const last = messages[messages.length - 1] as { role?: unknown; stopReason?: unknown; content?: unknown } | undefined;
  const hasToolCall =
    Array.isArray(last?.content) && last.content.some((b) => (b as { type?: unknown })?.type === "toolCall");
  const failed =
    last?.role === "assistant" &&
    (last.stopReason === "error" || last.stopReason === "aborted" || (last.stopReason === "length" && !hasToolCall));
  return failed ? messages.slice(0, -1) : [...messages];
}

export function assistantText(message: AssistantMessage | undefined): string | undefined {
  const text = message?.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("")
    .trim();
  return text || undefined;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Session/trace turn-end reason for a result. */
export function turnEndReason(result: RuntimeTurnResult): TurnEndReason {
  switch (result.status) {
    case "completed":
      return { kind: "completed" };
    case "max-tokens":
      return { kind: "max-tokens" };
    case "aborted":
      return { kind: "aborted", reason: { kind: "operator-stop" } };
    case "paused":
      return { kind: "aborted", reason: { kind: "guard", reason: result.fault?.code ?? "paused" } };
    default:
      return {
        kind: "error",
        error: { code: result.fault?.code ?? "agent-error", message: result.fault?.detail ?? "turn failed" },
      };
  }
}

export function textsOf(content: unknown): string[] {
  return (Array.isArray(content) ? content : [])
    .filter((block) => (block as { type?: unknown }).type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? ""));
}

/** Prefix recovered messages with a fresh initial system message when the first saved row was system-scoped. */
export function withRecoveredSystemHeader(
  messages: AgentMessage[],
  systemPrompt: string,
  tools: readonly AgentTool[],
): AgentMessage[] {
  const head = messages[0] as { role?: unknown } | undefined;
  const initial = createInitialSystemMessage(systemPrompt, tools.map(toToolDeclaration));
  return head?.role === "system" && initial ? [initial, ...messages] : messages;
}

/** Collect `toolCallId`s of tool-result messages that still carry an image block in `messages`. */
export function imageResultCallIds(messages: readonly AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const rec = message as unknown as { role?: unknown; toolCallId?: unknown; content?: unknown };
    if (rec.role !== "toolResult" || !Array.isArray(rec.content)) continue;
    if (rec.content.some((block) => (block as { type?: unknown }).type === "image") && rec.toolCallId != null) {
      ids.add(String(rec.toolCallId));
    }
  }
  return ids;
}

export type ToolEndFacts = {
  readonly callId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly content: unknown;
  readonly step: number;
  /** pi-agent-core skipped `beforeToolCall` (schema validation failed first). */
  readonly unprepared: boolean;
  readonly knownTool: boolean;
  readonly aborted: boolean;
  readonly adapterError?: { readonly name: string; readonly message: string };
};

function invalidArgsError(facts: ToolEndFacts, texts: readonly string[]): GuardToolError | undefined {
  if (facts.adapterError) {
    return { code: INVALID_ARGS_CODE, name: facts.adapterError.name, message: facts.adapterError.message };
  }
  if (!facts.isError || !facts.unprepared || !facts.knownTool || facts.aborted) return undefined;
  return { code: INVALID_ARGS_CODE, name: "ToolArgsError", message: texts.join("; ") };
}

/** Guard event for a finished tool call. */
export function toolResultEvent(facts: ToolEndFacts): GuardEvent {
  const texts = textsOf(facts.content);
  const error = invalidArgsError(facts, texts);
  return { type: "tool/result", callId: facts.callId, step: facts.step, texts, ...(error ? { error } : {}) };
}

/** Wrap a host project port so the runtime learns every binding the port creates or reopens. */
export function observingPort(port: SlideProjectPort, onBind: (binding: ProjectBinding) => void): SlideProjectPort {
  return {
    ...port,
    open(input) {
      const opened = port.open(input);
      if (!opened.refusal && opened.projectRoot)
        onBind({ projectId: opened.projectId, projectRoot: opened.projectRoot });
      return opened;
    },
  };
}

/** JSON Schema validator for slide tool arguments backed by pi-ai's tool-argument validation. */
export const piAiSchemaValidator: SlideSchemaValidator = (schema, value) => {
  try {
    validateToolArguments(
      { name: "slide_tool", description: "", parameters: schema },
      { type: "toolCall", id: "validate", name: "slide_tool", arguments: (value ?? {}) as never },
    );
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*-\s*/, "").trim())
      .filter((line) => line && !/^Validation failed/i.test(line));
  }
};
