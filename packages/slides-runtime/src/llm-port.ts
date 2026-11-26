/**
 * Host-neutral LLM port. The core loop talks to exactly one `StreamFn`
 * (pi-agent-core's contract) plus routing metadata; DSH, a standalone pi-ai
 * client, or a test double each implement it. Failures are never thrown: they
 * travel as a final assistant message (`stopReason: "error" | "aborted"`) that
 * carries a structured `LlmFailure` diagnostic.
 */
import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import { redactText } from "./redact.js";

export type { StreamFn } from "@earendil-works/pi-agent-core";

export type LlmInputModality = "text" | "image";

/** Routing metadata the runtime, guards and context budget need about the active model. */
export type LlmRoute = {
  readonly providerId: string;
  readonly modelId: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly inputModalities: readonly LlmInputModality[];
  readonly reasoningEffort?: ThinkingLevel;
};

/** Structured provider failure. `code` is the provider/host code (e.g. `RATE_LIMIT`, `AUTH`). */
export type LlmFailure = {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
};

export interface LlmPort {
  readonly route: LlmRoute;
  /** pi-ai model descriptor handed to the agent loop for this route. */
  readonly model: Model<Api>;
  /** Must never throw; failures are encoded in the returned stream. */
  readonly stream: StreamFn;
}

export const LLM_FAILURE_DIAGNOSTIC = "slides-runtime/llm-failure";

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Build the pi-ai model descriptor for a route served by an arbitrary transport. */
export function modelForRoute(
  route: LlmRoute,
  transport: { readonly api?: Api; readonly baseUrl?: string } = {},
): Model<Api> {
  return {
    id: route.modelId,
    name: route.modelId,
    api: transport.api ?? "slides-runtime",
    provider: route.providerId,
    baseUrl: transport.baseUrl ?? "",
    input: [...route.inputModalities],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: route.reasoningEffort !== undefined && route.reasoningEffort !== "off",
    contextWindow: route.contextWindow,
    maxTokens: route.maxTokens,
  };
}

/** Derive a route from a pi-ai model descriptor. */
export function routeForModel(model: Model<Api>, reasoningEffort?: ThinkingLevel): LlmRoute {
  return {
    providerId: model.provider,
    modelId: model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    inputModalities: model.input.filter((value): value is LlmInputModality => value === "text" || value === "image"),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/** An empty in-flight assistant message for `model`. */
export function assistantShell(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function failureDetails(failure: LlmFailure): JsonObject {
  return {
    code: failure.code,
    message: redactText(failure.message),
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
    ...(failure.requestId ? { requestId: failure.requestId } : {}),
  };
}

/** Record a structured failure on an assistant message (idempotent per message). */
export function attachLlmFailure(message: AssistantMessage, failure: LlmFailure): AssistantMessage {
  const safeMessage = redactText(failure.message);
  const others = (message.diagnostics ?? []).filter((row) => row.type !== LLM_FAILURE_DIAGNOSTIC);
  message.diagnostics = [
    ...others,
    {
      type: LLM_FAILURE_DIAGNOSTIC,
      timestamp: Date.now(),
      details: failureDetails({ ...failure, message: safeMessage }),
    },
  ];
  message.errorMessage = message.errorMessage ? redactText(message.errorMessage) : safeMessage;
  return message;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read the structured failure of a terminal assistant message, if it failed. */
export function readLlmFailure(message: AssistantMessage): LlmFailure | undefined {
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
  const row = message.diagnostics?.find((item) => item.type === LLM_FAILURE_DIAGNOSTIC);
  const details = row?.details ?? {};
  const status = numberField(details.status);
  const retryAfterMs = numberField(details.retryAfterMs);
  const fallbackCode = message.stopReason === "aborted" ? "ABORTED" : "UNKNOWN";
  return {
    code: typeof details.code === "string" && details.code ? details.code : fallbackCode,
    message: typeof details.message === "string" ? details.message : (message.errorMessage ?? "model request failed"),
    ...(status !== undefined ? { status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(typeof details.requestId === "string" ? { requestId: details.requestId } : {}),
  };
}

/** A terminal failed assistant message for `model`. */
export function failureMessage(model: Model<Api>, failure: LlmFailure, aborted = false): AssistantMessage {
  const safeMessage = redactText(failure.message);
  const message: AssistantMessage = {
    ...assistantShell(model),
    stopReason: aborted ? "aborted" : "error",
    errorMessage: safeMessage,
  };
  return attachLlmFailure(message, { ...failure, message: safeMessage });
}

/** A stream that immediately ends with `failure` (used for setup errors and fail-closed ports). */
export function failedStream(model: Model<Api>, failure: LlmFailure, aborted = false): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message = failureMessage(model, failure, aborted);
  stream.push({ type: "start", partial: assistantShell(model) });
  stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
  return stream;
}

/** Normalize a thrown value into a failure without leaking non-string payloads. */
export function failureFromThrown(error: unknown, code = "UNKNOWN"): LlmFailure {
  if (error instanceof Error) {
    const raw = (error as { code?: unknown }).code;
    const status = numberField((error as { status?: unknown }).status);
    return {
      code: typeof raw === "string" && raw ? raw : error.name === "AbortError" ? "ABORTED" : code,
      message: redactText(error.message || error.name),
      ...(status !== undefined ? { status } : {}),
    };
  }
  return { code, message: typeof error === "string" ? redactText(error) : "model request failed" };
}
