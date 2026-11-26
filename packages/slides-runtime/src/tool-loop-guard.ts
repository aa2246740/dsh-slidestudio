/**
 * Short-loop breaker for repeated identical argument-validation failures.
 * Counts only consecutive equivalent failures of one tool inside one turn:
 * array indices and duplicate copies of one issue are ignored, a new
 * validation category resets the streak, and every call issued inside one step
 * is a single model decision sharing one count. Synchronous by design so a
 * caller can abort the active loop from its event listener.
 */
import { createHash } from "node:crypto";
import { INVALID_ARGS_CODE, type GuardEvent, type GuardToolError } from "./guard-events.js";

export const TOOL_INVALID_ARGS_LOOP_CODE = "tool-invalid-args-loop";
export const TOOL_INVALID_ARGS_LIMIT = 3;

export type ToolLoopTrip = {
  readonly code: typeof TOOL_INVALID_ARGS_LOOP_CODE;
  readonly detail: string;
  readonly toolName: string;
  readonly count: number;
};

type IssuedCall = { readonly toolName: string; readonly issuedSeq: number; readonly step?: number };

type Streak = {
  readonly toolName: string;
  readonly fingerprint: string;
  readonly count: number;
  readonly lastResultSeq: number;
  readonly lastStep?: number;
};

type LoopState = {
  seq: number;
  readonly calls: Map<string, IssuedCall>;
  streak?: Streak;
  tripped: boolean;
};

function freshState(): LoopState {
  return { seq: 0, calls: new Map(), tripped: false };
}

/** Sorted unique validation issues with array positions folded away. */
export function normalizedValidationIssues(message: string): string[] {
  const body = message
    .replace(/^\s*Error:\s*/i, "")
    .replace(/^\s*invalid arguments(?:\s+for\s+tool\s+[^:]+)?\s*:\s*/i, "");
  const issues = body
    .split(/;|\r?\n/)
    .map((issue) =>
      issue
        .replace(/\[\s*\d+\s*\]/g, "[]")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  return [...new Set(issues)].sort();
}

function failureFingerprint(error: GuardToolError, texts: readonly string[]): string {
  const direct = error.message?.trim() ? error.message : undefined;
  const joined = texts.filter((text) => text.trim()).join("; ");
  const message = direct ?? (joined || undefined);
  const canonical = {
    code: error.code || INVALID_ARGS_CODE,
    name: error.name ?? "ToolArgsError",
    issues: message ? normalizedValidationIssues(message) : ["message-unavailable"],
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function isRetryAfterSeen(streak: Streak | undefined, issuedStep: number | undefined, issuedSeq: number): boolean {
  if (!streak) return false;
  if (issuedStep !== undefined && streak.lastStep !== undefined) return issuedStep > streak.lastStep;
  return issuedSeq > streak.lastResultSeq;
}

type Failure = {
  readonly toolName: string;
  readonly fingerprint: string;
  readonly issuedSeq: number;
  readonly resultSeq: number;
  readonly issuedStep?: number;
};

/** Same failure again: +1 only when issued after the previous identical failure was visible. */
function nextStreak(previous: Streak | undefined, failure: Failure): Streak {
  const same = previous?.toolName === failure.toolName && previous.fingerprint === failure.fingerprint;
  const retried = same && isRetryAfterSeen(previous, failure.issuedStep, failure.issuedSeq);
  return {
    toolName: failure.toolName,
    fingerprint: failure.fingerprint,
    count: same && previous ? previous.count + (retried ? 1 : 0) : 1,
    lastResultSeq: failure.resultSeq,
    ...(failure.issuedStep !== undefined ? { lastStep: failure.issuedStep } : {}),
  };
}

export class ToolInvalidArgsLoopGuard {
  private readonly states = new Map<string, LoopState>();

  reset(sessionId: string): void {
    this.states.delete(sessionId);
  }

  observe(sessionId: string, event: GuardEvent): ToolLoopTrip | undefined {
    if (event.type === "turn/start") {
      this.states.set(sessionId, freshState());
      return undefined;
    }
    if (event.type === "turn/end") {
      this.reset(sessionId);
      return undefined;
    }
    const state = this.states.get(sessionId) ?? freshState();
    this.states.set(sessionId, state);
    if (event.type === "tool/call") {
      if (event.callId && event.toolName) {
        state.seq += 1;
        state.calls.set(event.callId, {
          toolName: event.toolName,
          issuedSeq: state.seq,
          ...(event.step !== undefined ? { step: event.step } : {}),
        });
      }
      return undefined;
    }
    return event.type === "tool/result" ? this.onResult(state, event) : undefined;
  }

  private onResult(state: LoopState, event: Extract<GuardEvent, { type: "tool/result" }>): ToolLoopTrip | undefined {
    const pending = state.calls.get(event.callId);
    state.calls.delete(event.callId);
    const issuedSeq = pending?.issuedSeq ?? state.seq;
    state.seq += 1;
    const toolName = pending?.toolName;
    if (event.error?.code !== INVALID_ARGS_CODE || !toolName) {
      // A different tool's result between retries is not a repaired write.
      if (toolName === state.streak?.toolName) state.streak = undefined;
      return undefined;
    }
    const fingerprint = failureFingerprint(event.error, event.texts);
    const issuedStep = pending?.step ?? event.step;
    state.streak = nextStreak(state.streak, { toolName, fingerprint, issuedSeq, resultSeq: state.seq, issuedStep });
    const count = state.streak.count;
    if (count < TOOL_INVALID_ARGS_LIMIT || state.tripped) return undefined;
    state.tripped = true;
    return {
      code: TOOL_INVALID_ARGS_LOOP_CODE,
      toolName,
      count,
      detail: `连续 ${count} 次调用 ${toolName} 出现相同参数错误，Agent 已暂停。请修正输入或提示后重试。`,
    };
  }
}
