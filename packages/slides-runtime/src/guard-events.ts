/**
 * Host-neutral guard event vocabulary. A "turn" is one user prompt run; a
 * "step" is one model decision (one assistant message). Parallel tool calls
 * emitted in one assistant message share the same step.
 */
export type GuardToolError = {
  readonly code: string;
  readonly name?: string;
  readonly message?: string;
};

export type GuardEvent =
  | { readonly type: "turn/start"; readonly turn: number }
  | { readonly type: "turn/end"; readonly turn: number }
  | {
      readonly type: "tool/call";
      readonly callId: string;
      readonly toolName: string;
      readonly step?: number;
    }
  | {
      readonly type: "tool/result";
      readonly callId: string;
      readonly step?: number;
      /** Model-visible text blocks of the result, in order. */
      readonly texts: readonly string[];
      /** Present for argument-validation failures (`code: "INVALID_ARGS"`) and other SDK errors. */
      readonly error?: GuardToolError;
    }
  | { readonly type: "other" };

export const INVALID_ARGS_CODE = "INVALID_ARGS";
