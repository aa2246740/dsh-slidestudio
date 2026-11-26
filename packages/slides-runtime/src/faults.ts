/**
 * Host-neutral fault taxonomy: classify provider/runtime failures into stable
 * product fault codes, parse Retry-After hints and compute the bounded 429
 * backoff. Every detail string is redacted before it can reach disk or UI.
 */
import type { ModelPolicyProfile } from "@open-slidestudio/presentation-run";
import type { LlmFailure } from "./llm-port.js";
import { redactText } from "./redact.js";

export type RuntimeFault = {
  readonly code: string;
  readonly detail: string;
  readonly retryAfterMs?: number;
  readonly attemptId?: string;
};

/** 15s, 30s, 60s, 2m, 5m. Further attempts cap at 15m. */
export const RATE_LIMIT_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
export const RATE_LIMIT_BACKOFF_CAP_MS = 15 * 60_000;
const FAULT_DETAIL_MAX = 800;

export const BOUNDED_TRIP_CODES: ReadonlySet<string> = new Set([
  "tool-invalid-args-loop",
  "repeated-invalid-args",
  "repeated-business-rejection",
  "planning-no-progress-budget",
  "production-no-progress-budget",
]);

export const PAUSE_FAULT_CODES: ReadonlySet<string> = new Set([
  "provider-quota",
  "provider-auth",
  "provider-token-plan",
  "provider-rate-limit",
  "provider-unavailable",
  "operator-stop",
  "host-interrupted",
  ...BOUNDED_TRIP_CODES,
]);

export function isPauseFault(fault: Pick<RuntimeFault, "code">): boolean {
  return PAUSE_FAULT_CODES.has(fault.code);
}

export function isBoundedTripFault(fault: Pick<RuntimeFault, "code">): boolean {
  return BOUNDED_TRIP_CODES.has(fault.code);
}

/** Temporary provider 429 only; quota / token-plan exhaustion does not recover by waiting. */
export function isWaitAndResumeFault(fault: Pick<RuntimeFault, "code">): boolean {
  return fault.code === "provider-rate-limit";
}

export function isTokenPlanExhausted(detail: string): boolean {
  return /2056|Token Plan 用量上限|请升级 Token Plan/i.test(detail);
}

function serializationFault(detail: string): RuntimeFault | undefined {
  if (!/non-JSON-serializable|circular structure|Converting circular/i.test(detail)) return undefined;
  const pathMatch = detail.match(/(?:path|property|at)\s+['"]?([A-Za-z0-9_.[\]-]+)['"]?/i);
  const typeMatch = detail.match(/\b(?:type|typeof)\s+['"]?([A-Za-z0-9_$]+)['"]?/i);
  const at = pathMatch?.[1] ? ` at ${pathMatch[1]}` : "";
  const type = typeMatch?.[1] ? ` (${typeMatch[1]})` : "";
  return {
    code: "serialization-error",
    detail: `event payload is not JSON-serializable${at}${type}. Field values, credentials and model text were not recorded.`,
  };
}

type ErrorRecord = { readonly code: string; readonly detail: string };

function stringOrNumber(value: unknown): string {
  if (typeof value === "string") return value;
  return typeof value === "number" ? String(value) : "";
}

function errorRecord(error: unknown): ErrorRecord {
  if (error instanceof Error) {
    return { code: stringOrNumber((error as { code?: unknown }).code), detail: error.message };
  }
  if (error && typeof error === "object") {
    const rec = error as { code?: unknown; message?: unknown; detail?: unknown };
    const detail =
      typeof rec.detail === "string"
        ? rec.detail
        : typeof rec.message === "string"
          ? rec.message
          : JSON.stringify(error);
    return { code: stringOrNumber(rec.code), detail };
  }
  return { code: "", detail: String(error) };
}

const isAuth = (rec: ErrorRecord): boolean =>
  ["AUTH", "401", "403"].includes(rec.code) ||
  /unauthorized|forbidden|invalid api key|鉴权|401\b|403\b/i.test(rec.detail);
const isRateLimit = (rec: ErrorRecord): boolean =>
  rec.code === "RATE_LIMIT" || rec.code === "429" || /(?:\b429\b|rate[\s_-]?limit)/i.test(rec.detail);
const isQuota = (rec: ErrorRecord): boolean => rec.code === "QUOTA" || /quota|RESOURCE_EXHAUSTED/i.test(rec.detail);
const isUnavailable = (rec: ErrorRecord): boolean =>
  rec.code === "SERVER" || /UNAVAILABLE|"code":\s*503/.test(rec.detail);
const isGenericProviderError = (rec: ErrorRecord): boolean =>
  rec.code === "PI_AI_ERROR" &&
  /Provider returned error/i.test(rec.detail) &&
  !/401|403|invalid api key/i.test(rec.detail);

function providerCode(rec: ErrorRecord): string | undefined {
  if (isTokenPlanExhausted(rec.detail) || rec.code === "2056") return "provider-token-plan";
  if (isGenericProviderError(rec)) return "provider-rate-limit";
  if (isQuota(rec)) return "provider-quota";
  if (isAuth(rec)) return "provider-auth";
  if (isRateLimit(rec)) return "provider-rate-limit";
  if (isUnavailable(rec)) return "provider-unavailable";
  return undefined;
}

/** Classify any thrown value or error-like record into a redacted runtime fault. */
export function classifyFault(error: unknown): RuntimeFault {
  const raw = errorRecord(error);
  const detail = redactText(raw.detail).slice(0, FAULT_DETAIL_MAX);
  const serialization = serializationFault(detail);
  if (serialization) return serialization;
  const rec = { code: raw.code, detail };
  return { code: providerCode(rec) ?? (rec.code || "agent-error"), detail };
}

function statusCode(status: number | undefined, policy?: ModelPolicyProfile): string | undefined {
  if (status === undefined) return undefined;
  if (status === 401 || status === 403) return "provider-auth";
  if (status === 429) return "provider-rate-limit";
  if (policy?.retryableHttpStatuses?.includes(status) || status === 503) return "provider-unavailable";
  return undefined;
}

/**
 * Classify a structured LLM port failure. HTTP status wins over message text;
 * `ModelPolicyProfile.retryableHttpStatuses` widens the transient set.
 */
export function classifyLlmFailure(failure: LlmFailure, policy?: ModelPolicyProfile): RuntimeFault {
  if (failure.code === "ABORTED") return { code: "operator-stop", detail: redactText(failure.message) };
  if (/CONTEXT_(?:WINDOW|BUDGET|HISTORY)/.test(failure.code)) {
    return { code: "context-overflow", detail: redactText(failure.message).slice(0, FAULT_DETAIL_MAX) };
  }
  const byStatus = statusCode(failure.status, policy);
  const base = byStatus
    ? { code: byStatus, detail: redactText(failure.message).slice(0, FAULT_DETAIL_MAX) }
    : classifyFault({ code: failure.code, message: failure.message });
  const retryAfterMs = failure.retryAfterMs ?? parseRetryAfterMs(failure.message);
  return retryAfterMs !== undefined && base.code === "provider-rate-limit" ? { ...base, retryAfterMs } : base;
}

function capWaitMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(RATE_LIMIT_BACKOFF_CAP_MS, Math.round(ms));
}

function parseRetryAfterHeader(header: string, now: number): number | undefined {
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return capWaitMs(Number(trimmed) * 1000);
  const when = Date.parse(trimmed);
  return Number.isNaN(when) ? undefined : capWaitMs(Math.max(0, when - now));
}

const TEXT_RETRY_PATTERNS: readonly (readonly [RegExp, number])[] = [
  [/"retry_after_seconds(?:_raw)?"\s*:\s*(\d+(?:\.\d+)?)/i, 1000],
  [/retry-after\s*[:=]\s*"?(\d+(?:\.\d+)?)/i, 1000],
  [/retry in (\d+(?:\.\d+)?)\s*s/i, 1000],
  [/retry in (\d+(?:\.\d+)?)\s*m/i, 60_000],
  [/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i, 1000],
];

function parseRetryAfterFromText(text: string, now: number): number | undefined {
  if (!text.trim()) return undefined;
  const seconds = text.match(TEXT_RETRY_PATTERNS[0]![0]);
  if (seconds) return capWaitMs(Number(seconds[1]) * 1000);
  const header = text.match(/"Retry-After"\s*:\s*"([^"]+)"/i);
  const fromHeader = header ? parseRetryAfterHeader(header[1]!, now) : undefined;
  if (fromHeader != null) return fromHeader;
  for (const [pattern, unit] of TEXT_RETRY_PATTERNS.slice(1)) {
    const match = text.match(pattern);
    if (match) return capWaitMs(Number(match[1]) * unit);
  }
  return undefined;
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name];
  if (typeof direct === "string") return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && typeof value === "string") return value;
  }
  return undefined;
}

type RetrySource = {
  headers?: Record<string, unknown>;
  retryAfter?: unknown;
  retryAfterMs?: unknown;
  retry_after_seconds?: unknown;
  detail?: unknown;
  message?: unknown;
};

function retryFromFields(rec: RetrySource): number | undefined {
  if (typeof rec.retryAfterMs === "number") return capWaitMs(rec.retryAfterMs);
  if (typeof rec.retryAfter === "number") return capWaitMs(rec.retryAfter * 1000);
  if (typeof rec.retry_after_seconds === "number") return capWaitMs(rec.retry_after_seconds * 1000);
  return undefined;
}

/** Honor HTTP Retry-After / `retry_after_seconds` hints. Milliseconds, capped at 15 minutes. */
export function parseRetryAfterMs(source: unknown, now = Date.now()): number | undefined {
  if (source == null) return undefined;
  if (typeof source === "number" && Number.isFinite(source)) {
    return capWaitMs(source > 10_000 ? source : source * 1000);
  }
  if (typeof source === "string") return parseRetryAfterFromText(source, now);
  if (typeof source !== "object") return undefined;
  const rec = source as RetrySource;
  const header = headerValue(rec.headers, "retry-after");
  const fromHeader = header ? parseRetryAfterHeader(header, now) : undefined;
  if (fromHeader != null) return fromHeader;
  const fromFields = retryFromFields(rec);
  if (fromFields !== undefined) return fromFields;
  const blob = [rec.detail, rec.message].filter((value) => typeof value === "string").join("\n");
  const fromText = blob ? parseRetryAfterFromText(blob, now) : undefined;
  return fromText ?? parseRetryAfterFromText(JSON.stringify(source), now);
}

/** Wait before resuming: Retry-After when present, else 15s, 30s, 60s, 2m, 5m, cap 15m. `attempt` is 0-based. */
export function rateLimitWaitMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) return capWaitMs(retryAfterMs);
  const index = Math.max(0, Math.floor(attempt));
  return index < RATE_LIMIT_BACKOFF_MS.length ? RATE_LIMIT_BACKOFF_MS[index]! : RATE_LIMIT_BACKOFF_CAP_MS;
}
