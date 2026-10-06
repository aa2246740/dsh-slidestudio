import fs from "node:fs";
import path from "node:path";
import { redactText } from "./agent-trace.js";
import { scrubRegisteredSecrets } from "./providers.js";
const ERROR_REL = path.join("_agent", "dsh-agent-error.json");
const WAIT_REL = path.join("_agent", "dsh-rate-limit-wait.json");
export function agentErrorPath(projectRoot) {
    return path.join(projectRoot, ERROR_REL);
}
export function rateLimitWaitPath(projectRoot) {
    return path.join(projectRoot, WAIT_REL);
}
export function readAgentError(projectRoot) {
    const file = agentErrorPath(projectRoot);
    if (!fs.existsSync(file))
        return undefined;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (typeof parsed.code === "string" && typeof parsed.detail === "string") {
            return {
                code: parsed.code,
                detail: parsed.detail,
                ...(typeof parsed.attemptId === "string" ? { attemptId: parsed.attemptId } : {}),
                ...(parsed.recovering === true ? { recovering: true } : {}),
            };
        }
    }
    catch {
        // ignore corrupt fault files
    }
    return undefined;
}
/** A retained fault from a previous attempt is history, not this turn's result. */
export function readCurrentAgentError(projectRoot) {
    const error = readAgentError(projectRoot);
    return error?.recovering ? undefined : error;
}
/** Fault details can echo provider request text — scrub before disk/UI. */
function scrubFault(error) {
    const detail = scrubRegisteredSecrets(redactText(error.detail));
    return detail === error.detail ? error : { ...error, detail };
}
export function recordAgentError(projectRoot, error) {
    fs.mkdirSync(path.join(projectRoot, "_agent"), { recursive: true });
    fs.writeFileSync(agentErrorPath(projectRoot), `${JSON.stringify(scrubFault(error), null, 2)}\n`);
}
export function clearAgentError(projectRoot) {
    const file = agentErrorPath(projectRoot);
    if (fs.existsSync(file))
        fs.unlinkSync(file);
}
/** 15s, 30s, 60s, 2m, 5m. Further attempts cap at 15m. Not a fixed 60s hammer. */
export const RATE_LIMIT_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
export const RATE_LIMIT_BACKOFF_CAP_MS = 15 * 60_000;
export function readRateLimitWait(projectRoot) {
    const file = rateLimitWaitPath(projectRoot);
    if (!fs.existsSync(file))
        return undefined;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (typeof parsed.attempt === "number" &&
            typeof parsed.waitMs === "number" &&
            typeof parsed.nextRetryAt === "number" &&
            typeof parsed.code === "string") {
            return {
                attempt: parsed.attempt,
                waitMs: parsed.waitMs,
                nextRetryAt: parsed.nextRetryAt,
                code: parsed.code,
            };
        }
    }
    catch {
        // ignore corrupt wait files
    }
    return undefined;
}
export function writeRateLimitWait(projectRoot, wait) {
    fs.mkdirSync(path.join(projectRoot, "_agent"), { recursive: true });
    fs.writeFileSync(rateLimitWaitPath(projectRoot), `${JSON.stringify(wait, null, 2)}\n`);
}
export function clearRateLimitWait(projectRoot) {
    const file = rateLimitWaitPath(projectRoot);
    if (fs.existsSync(file))
        fs.unlinkSync(file);
}
const PAUSE_CODES = new Set([
    "provider-quota",
    "provider-auth",
    "provider-token-plan",
    "provider-rate-limit",
    "provider-unavailable",
    "operator-stop",
    "host-interrupted",
    "tool-invalid-args-loop",
    "repeated-invalid-args",
    "repeated-business-rejection",
    "planning-no-progress-budget",
    "production-no-progress-budget",
]);
export function isPauseFault(error) {
    return PAUSE_CODES.has(error.code);
}
/**
 * Pause codes produced by the bounded-guard trip path only — never by a
 * provider or the operator. On `complete` these are the only faults a stale
 * cancel may leave behind; provider/auth/quota and operator-stop faults must
 * survive settle so a failed edit on a finished deck still reads as paused.
 */
const BOUNDED_TRIP_CODES = new Set([
    "tool-invalid-args-loop",
    "repeated-invalid-args",
    "repeated-business-rejection",
    "planning-no-progress-budget",
    "production-no-progress-budget",
]);
export function isBoundedTripFault(error) {
    return BOUNDED_TRIP_CODES.has(error.code);
}
/**
 * Temporary provider 429 only. Token-plan / quota exhaustion will not recover
 * by waiting; those stay paused for the operator to switch model or top up.
 */
export function isWaitAndResumeFault(error) {
    return error.code === "provider-rate-limit";
}
/** 401/403 empty or rejected key. Do not wait-and-retry. */
export function isHardProviderFault(error) {
    return error.code === "provider-auth";
}
/** MiniMax China token-plan 2056. Pause for the user; do not auto-retry. */
export function isMinimaxTokenPlanExhausted(detail) {
    return /2056|Token Plan 用量上限|请升级 Token Plan/i.test(detail);
}
/** CN 401/403 may switch to OpenRouter. Temporary 429 waits; 2056 does not. */
export function isOpenRouterFailoverFault(error) {
    return error.code === "provider-auth";
}
/** OpenRouter 401/403/unavailable may use MiniMax CN. OpenRouter 429 does not. */
export function isMinimaxCnFailoverFault(error) {
    return error.code === "provider-auth" || error.code === "provider-unavailable";
}
function classifySerializationFault(detail) {
    if (!/non-JSON-serializable|circular structure|Converting circular/i.test(detail))
        return undefined;
    const pathMatch = detail.match(/(?:path|property|at)\s+['"]?([A-Za-z0-9_.[\]-]+)['"]?/i);
    const typeMatch = detail.match(/\b(?:type|typeof)\s+['"]?([A-Za-z0-9_$]+)['"]?/i);
    const path = pathMatch?.[1] ? ` at ${pathMatch[1]}` : "";
    const type = typeMatch?.[1] ? ` (${typeMatch[1]})` : "";
    return {
        code: "serialization-error",
        detail: `event payload is not JSON-serializable${path}${type}. Field values, credentials and model text were not recorded.`,
    };
}
export function classifyAgentError(error) {
    const rec = asErrorRecord(error);
    const detail = scrubRegisteredSecrets(redactText(rec.detail)).slice(0, 800);
    const serialization = classifySerializationFault(detail);
    if (serialization)
        return serialization;
    if (isMinimaxTokenPlanExhausted(detail) || rec.code === "2056") {
        return { code: "provider-token-plan", detail };
    }
    if (rec.code === "PI_AI_ERROR" &&
        /Provider returned error/i.test(detail) &&
        !/401|403|invalid api key/i.test(detail)) {
        return { code: "provider-rate-limit", detail };
    }
    if (rec.code === "QUOTA" || /quota|RESOURCE_EXHAUSTED/i.test(detail)) {
        return { code: "provider-quota", detail };
    }
    if (rec.code === "AUTH" ||
        rec.code === "401" ||
        rec.code === "403" ||
        /unauthorized|forbidden|invalid api key|鉴权|401\b|403\b/i.test(detail)) {
        return { code: "provider-auth", detail };
    }
    if (rec.code === "RATE_LIMIT" ||
        rec.code === "429" ||
        /(?:\b429\b|rate[\s_-]?limit)/i.test(detail)) {
        return { code: "provider-rate-limit", detail };
    }
    if (rec.code === "SERVER" || /UNAVAILABLE|"code":\s*503/.test(detail)) {
        return { code: "provider-unavailable", detail };
    }
    return { code: rec.code || "agent-error", detail };
}
function asErrorRecord(error) {
    if (error instanceof Error) {
        const code = "code" in error && typeof error.code === "string" ? error.code : "";
        const numeric = "code" in error && typeof error.code === "number" ? String(error.code) : "";
        return { code: code || numeric, detail: error.message };
    }
    if (error && typeof error === "object") {
        const rec = error;
        const detail = typeof rec.detail === "string"
            ? rec.detail
            : typeof rec.message === "string"
                ? rec.message
                : JSON.stringify(error);
        const code = typeof rec.code === "string"
            ? rec.code
            : typeof rec.code === "number"
                ? String(rec.code)
                : "";
        return { code, detail };
    }
    return { code: "", detail: String(error) };
}
function capWaitMs(ms) {
    if (!Number.isFinite(ms) || ms < 0)
        return 0;
    return Math.min(RATE_LIMIT_BACKOFF_CAP_MS, Math.round(ms));
}
function parseRetryAfterHeader(header, now) {
    const trimmed = header.trim();
    if (!trimmed)
        return undefined;
    if (/^\d+(\.\d+)?$/.test(trimmed))
        return capWaitMs(Number(trimmed) * 1000);
    const when = Date.parse(trimmed);
    if (!Number.isNaN(when))
        return capWaitMs(Math.max(0, when - now));
    return undefined;
}
function parseRetryAfterFromText(text, now) {
    if (!text.trim())
        return undefined;
    const retryAfterSeconds = text.match(/"retry_after_seconds(?:_raw)?"\s*:\s*(\d+(?:\.\d+)?)/i);
    if (retryAfterSeconds)
        return capWaitMs(Number(retryAfterSeconds[1]) * 1000);
    const retryAfterHeader = text.match(/"Retry-After"\s*:\s*"([^"]+)"/i);
    if (retryAfterHeader) {
        const fromHeader = parseRetryAfterHeader(retryAfterHeader[1], now);
        if (fromHeader != null)
            return fromHeader;
    }
    const retryAfterField = text.match(/retry-after\s*[:=]\s*"?(\d+(?:\.\d+)?)/i);
    if (retryAfterField)
        return capWaitMs(Number(retryAfterField[1]) * 1000);
    const retryInSeconds = text.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
    if (retryInSeconds)
        return capWaitMs(Number(retryInSeconds[1]) * 1000);
    const retryInMinutes = text.match(/retry in (\d+(?:\.\d+)?)\s*m/i);
    if (retryInMinutes)
        return capWaitMs(Number(retryInMinutes[1]) * 60_000);
    const retryDelay = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
    if (retryDelay)
        return capWaitMs(Number(retryDelay[1]) * 1000);
    return undefined;
}
function headerValue(headers, name) {
    if (!headers)
        return undefined;
    const direct = headers[name];
    if (typeof direct === "string")
        return direct;
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lower && typeof value === "string")
            return value;
    }
    return undefined;
}
/**
 * Honor HTTP Retry-After / OpenRouter retry_after_seconds.
 * Returns milliseconds, capped at 15 minutes.
 */
export function parseRetryAfterMs(source, now = Date.now()) {
    if (source == null)
        return undefined;
    if (typeof source === "number" && Number.isFinite(source)) {
        return capWaitMs(source > 10_000 ? source : source * 1000);
    }
    if (typeof source === "string")
        return parseRetryAfterFromText(source, now);
    if (typeof source !== "object")
        return undefined;
    const rec = source;
    const header = headerValue(rec.headers, "retry-after");
    if (header) {
        const fromHeader = parseRetryAfterHeader(header, now);
        if (fromHeader != null)
            return fromHeader;
    }
    if (typeof rec.retryAfterMs === "number")
        return capWaitMs(rec.retryAfterMs);
    if (typeof rec.retryAfter === "number")
        return capWaitMs(rec.retryAfter * 1000);
    if (typeof rec.retry_after_seconds === "number") {
        return capWaitMs(rec.retry_after_seconds * 1000);
    }
    const blob = [rec.detail, rec.message]
        .filter((value) => typeof value === "string")
        .join("\n");
    if (blob) {
        const fromText = parseRetryAfterFromText(blob, now);
        if (fromText != null)
            return fromText;
    }
    return parseRetryAfterFromText(JSON.stringify(source), now);
}
/**
 * Wait before resuming the same Hub session.
 * Honor Retry-After when present; otherwise 15s, 30s, 60s, 2m, 5m, cap 15m.
 * `attempt` is 0-based.
 */
export function rateLimitWaitMs(attempt, retryAfterMs) {
    if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return capWaitMs(retryAfterMs);
    }
    const idx = Math.max(0, Math.floor(attempt));
    if (idx < RATE_LIMIT_BACKOFF_MS.length)
        return RATE_LIMIT_BACKOFF_MS[idx];
    return RATE_LIMIT_BACKOFF_CAP_MS;
}
export class AgentFaults {
    pending = new Map();
    note(sessionId, error, projectRoot) {
        let attemptId = error.attemptId;
        if (!attemptId && projectRoot) {
            try {
                const parsed = JSON.parse(fs.readFileSync(path.join(projectRoot, "_agent", "attempt.v1.json"), "utf8"));
                if (typeof parsed.attemptId === "string" && parsed.attemptId)
                    attemptId = parsed.attemptId;
            }
            catch {
                /* attempt file is optional until the first turn */
            }
        }
        const recorded = { ...error, ...(attemptId ? { attemptId } : {}) };
        this.pending.set(sessionId, recorded);
        if (projectRoot)
            recordAgentError(projectRoot, recorded);
    }
    clear(sessionId, projectRoot) {
        this.pending.delete(sessionId);
        if (projectRoot) {
            clearAgentError(projectRoot);
            clearRateLimitWait(projectRoot);
        }
    }
    settle(sessionId, projectRoot, phaseKind) {
        // pending is in-memory; a fault recorded before a process restart only
        // survives on disk. Fall back so settle can still reconcile it.
        const pending = this.pending.get(sessionId);
        const error = pending ?? readAgentError(projectRoot);
        if (!error)
            return;
        // A completed presentation cannot be paused by a guard trip whose cancel
        // never landed: that marker is stale. Provider and operator faults on a
        // finished deck are real failures — keep them so the run reads paused.
        if (phaseKind === "complete" && isBoundedTripFault(error)) {
            this.clear(sessionId, projectRoot);
            return;
        }
        // beginAttempt marks the previous on-disk error recovering. Do not write
        // its stale in-memory copy back over that marker when a later turn ends.
        if (pending) {
            const disk = readAgentError(projectRoot);
            if (disk?.recovering && disk.attemptId === pending.attemptId) {
                this.pending.delete(sessionId);
                return;
            }
        }
        if (isPauseFault(error)) {
            if (error.recovering && phaseKind === "page-ready") {
                this.clear(sessionId, projectRoot);
                return;
            }
            recordAgentError(projectRoot, error);
            return;
        }
        if (error.recovering && phaseKind === "page-ready") {
            this.clear(sessionId, projectRoot);
            return;
        }
        recordAgentError(projectRoot, error);
    }
}
/** Infrastructure hints must not treat digits inside trace ids as HTTP status codes. */
export function friendlyProviderCause(detail) {
    const d = detail.slice(0, 200);
    if (/auth|unauthoriz|\b(?:401|403)\b|invalid.*(key|token)|凭据|认证/i.test(d))
        return "（模型服务认证失效或未配置）";
    if (/timeout|timed out|abort|ECONNREFUSED|ECONNRESET|ENOTFOUND|network|fetch failed/i.test(d))
        return "（模型服务暂时不可达）";
    if (/rate.?limit|\b429\b|quota/i.test(d))
        return "（模型服务限流，请稍后重试）";
    if (/not in the current provider roster|no credential|UNKNOWN_MODEL|NO_ADAPTER/i.test(d))
        return "（该模型未配置或不可用，请更换模型）";
    if (/invalid_argument|invalid request|Bad Request|\b400\b/i.test(d))
        return "（模型服务拒绝了本次请求）";
    return "";
}
//# sourceMappingURL=agent-fault.js.map