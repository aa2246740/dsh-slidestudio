/**
 * Configurable intranet/local LLM port (OOP-20).
 * OpenAI-compatible chat/completions. No hardcoded public vendor.
 */
export type LlmFailureKind = "rate_limit" | "busy" | "timeout" | "transient" | "client";

export type LlmRetryInfo = {
  attempt: number;
  maxRetries: number;
  waitMs: number;
  status?: number;
  kind: Exclude<LlmFailureKind, "client">;
  message: string;
};

export type LlmRetryPolicy = {
  /** Retries after the first failure. Google SDK default is 4. */
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
};

export type LlmPortConfig = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  /** false = text-only backend; completeJsonWithImages throws so callers fall back. */
  image?: boolean;
  retry?: LlmRetryPolicy;
  /** Fired before each wait. Never include the API key. */
  onRetry?: (info: LlmRetryInfo) => void | Promise<void>;
};

export type LlmPortDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

export class LlmHttpError extends Error {
  readonly name = "LlmHttpError";
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export type LlmImage = {
  /** data URL (data:image/...;base64,…) or http(s) URL. */
  url: string;
};

export type LlmToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Gemini OpenAI-compat: must echo thought_signature on the next turn. */
  extra_content?: Record<string, unknown>;
};

export type LlmToolSpec = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type LlmContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type LlmChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | LlmContentPart[] }
  | { role: "assistant"; content?: string | null; tool_calls?: LlmToolCall[] }
  | { role: "tool"; tool_call_id: string; name?: string; content: string };

export type LlmTurnResult = {
  content: string;
  toolCalls: LlmToolCall[];
};

export type LlmPort = {
  completeJson: (system: string, user: string) => Promise<unknown>;
  /**
   * Multimodal variant: user text + images. Backends that cannot read
   * images will throw; callers must catch and fall back to completeJson.
   */
  completeJsonWithImages?: (system: string, user: string, images: LlmImage[]) => Promise<unknown>;
  /**
   * One chat turn. When `tools` is set the model may return `tool_calls`
   * instead of a final JSON object — this is the agent runtime loop.
   */
  completeTurn?: (messages: LlmChatMessage[], tools?: LlmToolSpec[]) => Promise<LlmTurnResult>;
};

export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmPortConfig | undefined {
  const baseUrl = env.SLIDESTUDIO_LLM_BASE_URL?.trim();
  if (!baseUrl) return undefined;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: env.SLIDESTUDIO_LLM_API_KEY,
    model: env.SLIDESTUDIO_LLM_MODEL?.trim() || "local",
    timeoutMs: Number(env.SLIDESTUDIO_LLM_TIMEOUT_MS) || 120_000,
    image: env.SLIDESTUDIO_LLM_IMAGE === "0" ? false : undefined,
    retry: retryPolicyFromEnv(env),
  };
}

function retryPolicyFromEnv(env: NodeJS.ProcessEnv): LlmRetryPolicy | undefined {
  const maxRetries = Number(env.SLIDESTUDIO_LLM_RETRY_MAX);
  const initialDelayMs = Number(env.SLIDESTUDIO_LLM_RETRY_INITIAL_MS);
  const maxDelayMs = Number(env.SLIDESTUDIO_LLM_RETRY_MAX_MS);
  const retry: LlmRetryPolicy = {};
  if (Number.isFinite(maxRetries) && maxRetries >= 0) retry.maxRetries = maxRetries;
  if (Number.isFinite(initialDelayMs) && initialDelayMs >= 0) {
    retry.initialDelayMs = initialDelayMs;
  }
  if (Number.isFinite(maxDelayMs) && maxDelayMs >= 0) retry.maxDelayMs = maxDelayMs;
  return Object.keys(retry).length ? retry : undefined;
}

export function isRetryableLlmStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function kindFromLlmStatus(status: number): LlmFailureKind {
  if (status === 429) return "rate_limit";
  if (status === 503) return "busy";
  if (status === 408) return "timeout";
  if (status >= 500) return "transient";
  return "client";
}

export function parseRetryAfterMs(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.round(Number(trimmed) * 1000));
  }
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) return Math.max(0, when - now);
  return undefined;
}

/** Google RESOURCE_EXHAUSTED bodies often include `retryDelay: "8s"`. */
export function parseGoogleRetryDelayMs(body: string): number | undefined {
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (m) return Math.max(0, Math.round(Number(m[1]) * 1000));
  return undefined;
}

export function computeBackoffMs(opts: {
  attempt: number;
  initialDelayMs: number;
  maxDelayMs: number;
  retryAfterMs?: number;
  jitterUnit?: number;
}): number {
  if (opts.retryAfterMs != null && Number.isFinite(opts.retryAfterMs) && opts.retryAfterMs > 0) {
    const unit = opts.jitterUnit ?? 0.5;
    const jitter = 1 + (unit - 0.5) * 0.1;
    return Math.min(opts.maxDelayMs, Math.max(0, Math.round(opts.retryAfterMs * jitter)));
  }
  const exp = opts.initialDelayMs * 2 ** Math.max(0, opts.attempt);
  const unit = opts.jitterUnit ?? 0.5;
  const factor = 0.5 + unit * 0.5;
  return Math.min(opts.maxDelayMs, Math.max(0, Math.round(exp * factor)));
}

export function classifyLlmFailure(err: unknown): {
  retryable: boolean;
  status?: number;
  kind: LlmFailureKind;
  retryAfterMs?: number;
  message: string;
} {
  if (err instanceof LlmHttpError) {
    return {
      retryable: err.retryable,
      status: err.status,
      kind: kindFromLlmStatus(err.status),
      retryAfterMs: err.retryAfterMs,
      message: err.message,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const m = message.match(/LLM HTTP (\d{3})/i);
  if (m) {
    const status = Number(m[1]);
    return {
      retryable: isRetryableLlmStatus(status),
      status,
      kind: kindFromLlmStatus(status),
      message,
    };
  }
  if (/abort|timed?\s*out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(message)) {
    return { retryable: true, kind: "timeout", message };
  }
  return { retryable: false, kind: "client", message };
}

export function formatLlmWaitMessage(info: {
  kind: string;
  attempt: number;
  maxRetries: number;
  waitMs: number;
}): string {
  const sec = Math.max(1, Math.round(info.waitMs / 1000));
  const why =
    info.kind === "rate_limit"
      ? "用量超了"
      : info.kind === "busy"
        ? "模型忙"
        : info.kind === "timeout"
          ? "这次超时了"
          : "暂时出错";
  return `${why} · ${sec}s 后自动重试（${info.attempt}/${info.maxRetries}）`;
}

/**
 * Resolve an OpenAI-compatible chat completions URL.
 * Accepts a host, a `/v1` base, an `/openai` compat base, or a full path.
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const u = baseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(u)) return u;
  if (u.endsWith("/v1") || /\/openai$/i.test(u)) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}

export function parseLlmConfig(raw: unknown): LlmPortConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const baseUrl = typeof o.baseUrl === "string" ? o.baseUrl.trim() : "";
  if (!baseUrl) return undefined;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: typeof o.apiKey === "string" && o.apiKey.trim() ? o.apiKey.trim() : undefined,
    model: typeof o.model === "string" && o.model.trim() ? o.model.trim() : "local",
    timeoutMs: typeof o.timeoutMs === "number" ? o.timeoutMs : 120_000,
    image: o.image === false ? false : undefined,
    retry: o.retry && typeof o.retry === "object" ? (o.retry as LlmRetryPolicy) : undefined,
  };
}

type ChatMessage = {
  content?: string | null;
  tool_calls?: unknown;
  function_call?: unknown;
};

export function normalizeToolCalls(raw: unknown): LlmToolCall[] {
  if (!Array.isArray(raw)) {
    if (raw && typeof raw === "object") {
      return normalizeToolCalls([raw]);
    }
    return [];
  }
  const out: LlmToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const fn = o.function && typeof o.function === "object" ? (o.function as Record<string, unknown>) : o;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) continue;
    const args =
      typeof fn.arguments === "string"
        ? fn.arguments
        : fn.arguments && typeof fn.arguments === "object"
          ? JSON.stringify(fn.arguments)
          : "{}";
    const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : `call_${out.length + 1}`;
    const extra =
      o.extra_content && typeof o.extra_content === "object" ? (o.extra_content as Record<string, unknown>) : undefined;
    out.push({
      id,
      type: "function",
      function: { name, arguments: args },
      ...(extra ? { extra_content: extra } : {}),
    });
  }
  return out;
}

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

async function postChatOnce(
  config: LlmPortConfig,
  payload: Record<string, unknown>,
  deps: LlmPortDeps,
): Promise<ChatMessage> {
  const url = chatCompletionsUrl(config.baseUrl);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.timeoutMs ?? 120_000);
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers,
      signal: ac.signal,
      body: JSON.stringify(payload),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/abort/i.test(message) || (e instanceof Error && e.name === "AbortError")) {
      throw new LlmHttpError(`LLM HTTP 408: request timed out`, 408, true);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), now()) ?? parseGoogleRetryDelayMs(body);
    throw new LlmHttpError(
      `LLM HTTP ${res.status}: ${body.slice(0, 240)}`,
      res.status,
      isRetryableLlmStatus(res.status),
      retryAfterMs,
    );
  }
  const json = (await res.json()) as {
    choices?: { message?: ChatMessage }[];
  };
  return json.choices?.[0]?.message ?? {};
}

async function postChat(
  config: LlmPortConfig,
  payload: Record<string, unknown>,
  deps: LlmPortDeps = {},
): Promise<ChatMessage> {
  const maxRetries = Math.min(8, Math.max(0, config.retry?.maxRetries ?? DEFAULT_MAX_RETRIES));
  const initialDelayMs = Math.max(0, config.retry?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  const maxDelayMs = Math.min(120_000, Math.max(0, config.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await postChatOnce(config, payload, deps);
    } catch (e) {
      lastError = e;
      const info = classifyLlmFailure(e);
      if (!info.retryable || attempt >= maxRetries) {
        throw e instanceof LlmHttpError ? e : new Error(info.message);
      }
      const kind = info.kind === "client" ? "transient" : info.kind;
      const waitMs = computeBackoffMs({
        attempt,
        initialDelayMs,
        maxDelayMs,
        retryAfterMs: info.retryAfterMs,
        jitterUnit: random(),
      });
      await config.onRetry?.({
        attempt: attempt + 1,
        maxRetries,
        waitMs,
        status: info.status,
        kind,
        message: info.message,
      });
      await sleep(waitMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

async function callJson(
  config: LlmPortConfig,
  system: string,
  user: unknown,
  deps: LlmPortDeps,
  withJsonFormat = true,
): Promise<unknown> {
  const payload: Record<string, unknown> = {
    model: config.model,
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (withJsonFormat) payload.response_format = { type: "json_object" };
  let message: ChatMessage;
  try {
    message = await postChat(config, payload, deps);
  } catch (e) {
    if (withJsonFormat && e instanceof Error && /LLM HTTP (400|422)/.test(e.message)) {
      return callJson(config, system, user, deps, false);
    }
    throw e;
  }
  const content = contentToText(message.content);
  if (!content) throw new Error("LLM returned empty content");
  const trimmed = content.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fence ? fence[1]!.trim() : trimmed;
  return JSON.parse(text) as unknown;
}

export function createLlmPort(config: LlmPortConfig, deps: LlmPortDeps = {}): LlmPort {
  return {
    async completeJson(system, user) {
      return callJson(config, system, user, deps);
    },
    async completeJsonWithImages(system, user, images) {
      if (config.image === false) {
        throw new Error("LLM backend is text-only (image disabled)");
      }
      const parts = [
        { type: "text", text: user },
        ...images.map((img) => ({
          type: "image_url",
          image_url: { url: img.url },
        })),
      ];
      return callJson(config, system, parts, deps);
    },
    async completeTurn(messages, tools) {
      const payload: Record<string, unknown> = {
        model: config.model,
        temperature: 0.3,
        messages,
      };
      if (tools?.length) payload.tools = tools;
      const message = await postChat(config, payload, deps);
      const legacy = message.function_call ? normalizeToolCalls([message.function_call]) : [];
      return {
        content: contentToText(message.content).trim(),
        toolCalls: normalizeToolCalls(message.tool_calls).concat(legacy),
      };
    },
  };
}
