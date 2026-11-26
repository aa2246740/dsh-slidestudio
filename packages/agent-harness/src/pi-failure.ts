/**
 * Pi RPC failures the host used to treat as “empty assistant / did not write”.
 * Gemini free-tier 429 is the common case. Never log secrets.
 */
import type { PiRpcLine } from "./pi-rpc.js";
import { parseGoogleRetryDelayMs } from "./llm-port.js";

export type PiFailureKind = "rate_limit" | "auth" | "client" | "unknown";

export type PiFailure = {
  kind: PiFailureKind;
  retryable: boolean;
  dailyQuota: boolean;
  retiredModel: boolean;
  status?: number;
  retryAfterMs?: number;
  message: string;
  raw: string;
};

/** Same-provider xAI produce models when Codex is overloaded or Grok is preferred. */
export const XAI_PRODUCE_MODELS = [
  "grok-4.5",
  "grok-4.20-0309-reasoning",
  "grok-4.3",
  "grok-4.20-0309-non-reasoning",
] as const;

/** Same-provider Google produce models when the preferred id is out of quota. */
export const GOOGLE_PRODUCE_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.1-flash-lite",
] as const;

export function piErrorTextsFromEvents(events: PiRpcLine[]): string[] {
  const out: string[] = [];
  for (const ev of events) {
    const msg = ev.message && typeof ev.message === "object" ? (ev.message as Record<string, unknown>) : undefined;
    const stop = (msg?.stopReason ?? ev.stopReason) as unknown;
    const err = (msg?.errorMessage ?? ev.errorMessage ?? ev.error) as unknown;
    if (typeof err === "string" && err.trim()) {
      out.push(err);
      continue;
    }
    if (stop === "error") out.push("Pi assistant stopReason=error");
  }
  return out;
}

export function isGoogleDailyQuota(raw: string): boolean {
  return /GenerateRequestsPerDay|PerDayPerProjectPerModel|requests per day|per day/i.test(raw);
}

export function isRetiredGoogleModel(raw: string): boolean {
  return /no longer available|is not found|models\/gemini-[^\s]+ is no longer|update your code to use models\//i.test(
    raw,
  );
}

export function shouldSwitchPiModel(failure: PiFailure | undefined): boolean {
  return Boolean(failure?.dailyQuota || failure?.retiredModel);
}

export function classifyPiFailure(raw: string): PiFailure {
  const text = raw.trim() || "Pi failed";
  const dailyQuota = isGoogleDailyQuota(text);
  const retiredModel = isRetiredGoogleModel(text);
  if (
    /403/.test(text) &&
    /run out of credits|add credits|need a .*subscription|upgrade at|insufficient (?:credits|quota)|usage limit/i.test(
      text,
    )
  ) {
    return {
      kind: "rate_limit",
      retryable: false,
      dailyQuota: false,
      retiredModel: false,
      status: 403,
      message: "供应商额度或订阅暂时不可用。进度已保留；补充额度、重新登录或切换供应商后可以继续。",
      raw: text.slice(0, 1_200),
    };
  }
  if (/Codex error:.*overloaded|currently overloaded/i.test(text)) {
    return {
      kind: "rate_limit",
      retryable: true,
      dailyQuota: false,
      retiredModel: false,
      status: 503,
      retryAfterMs: 2_000,
      message: "Codex 过载。会改走已登录的 Grok。",
      raw: text.slice(0, 1_200),
    };
  }
  if (/503|UNAVAILABLE|currently unavailable|Service Unavailable/i.test(text)) {
    return {
      kind: "rate_limit",
      retryable: true,
      dailyQuota: false,
      retiredModel: false,
      status: 503,
      retryAfterMs: 8_000,
      message: "Pi 模型暂时不可用（503）。稍后重试。",
      raw: text.slice(0, 1_200),
    };
  }
  if (/429|RESOURCE_EXHAUSTED|Too Many Requests|quota/i.test(text)) {
    return {
      kind: "rate_limit",
      retryable: !dailyQuota,
      dailyQuota,
      retiredModel: false,
      status: 429,
      retryAfterMs: dailyQuota ? undefined : parseGoogleRetryDelayMs(text),
      message: summarizePiError(text),
      raw: text.slice(0, 1_200),
    };
  }
  if (retiredModel || /404/.test(text)) {
    return {
      kind: "client",
      retryable: false,
      dailyQuota: false,
      retiredModel: retiredModel || /no longer available/i.test(text),
      status: 404,
      message: summarizePiError(text),
      raw: text.slice(0, 1_200),
    };
  }
  if (/exceeds the context window|context window|context length|too many tokens/i.test(text)) {
    return {
      kind: "client",
      retryable: false,
      dailyQuota: false,
      retiredModel: false,
      message:
        "上下文爆了：模型把过长的 skill / pptd 读进对话。从盘上已写页继续，不要再读 vendor 大文件。宿主不得 salvage-compose。",
      raw: text.slice(0, 1_200),
    };
  }
  if (/401|API key|no api key|unauthoriz|unauthenticated|auth failed/i.test(text)) {
    return {
      kind: "auth",
      retryable: false,
      dailyQuota: false,
      retiredModel: false,
      status: /401/.test(text) ? 401 : undefined,
      message: summarizePiError(text),
      raw: text.slice(0, 1_200),
    };
  }
  return {
    kind: "unknown",
    retryable: false,
    dailyQuota: false,
    retiredModel: false,
    message: summarizePiError(text),
    raw: text.slice(0, 1_200),
  };
}

export function classifyPiEvents(events: PiRpcLine[]): PiFailure | undefined {
  const texts = piErrorTextsFromEvents(events);
  if (!texts.length) return undefined;
  return classifyPiFailure(texts[texts.length - 1]!);
}

export function summarizePiError(raw: string): string {
  if (/429|RESOURCE_EXHAUSTED|quota|Too Many Requests/i.test(raw)) {
    const model = raw.match(/model:\s*([a-z0-9._-]+)/i)?.[1];
    const delay = raw.match(/retry in ([0-9.]+s)/i)?.[1];
    if (isGoogleDailyQuota(raw)) {
      return model
        ? `Pi 模型 ${model} 今天的免费次数用完了。会改试同供应商的其他模型。`
        : "Pi 模型今天的免费次数用完了。会改试同供应商的其他模型。";
    }
    return delay ? `Pi 模型限流（429），约 ${delay} 后再试。` : "Pi 模型限流（429）。稍后重试。";
  }
  if (isRetiredGoogleModel(raw) || (/404/.test(raw) && /gemini/i.test(raw))) {
    const next = raw.match(/use models\/([a-z0-9._-]+)/i)?.[1];
    return next ? `Pi 模型已下线。Google 建议改用 ${next}。` : "Pi 模型已下线或不可用。会改试同供应商的其他模型。";
  }
  if (/401|API key|no api key|unauthoriz|unauthenticated|auth failed/i.test(raw)) {
    return "Pi 鉴权失败。请回到创建页重新登录。";
  }
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.slice(0, 240);
}

export function piModelCandidates(preferred: string | undefined, provider: string | undefined): string[] {
  const first = preferred?.trim();
  if (provider === "xai-auth" || provider === "xai") {
    const rest = XAI_PRODUCE_MODELS.filter((id) => id !== first);
    return first ? [first, ...rest] : [...XAI_PRODUCE_MODELS];
  }
  if (provider && provider !== "google") {
    return first ? [first] : [];
  }
  const rest = GOOGLE_PRODUCE_MODELS.filter((id) => id !== first);
  return first ? [first, ...rest] : [...GOOGLE_PRODUCE_MODELS];
}
