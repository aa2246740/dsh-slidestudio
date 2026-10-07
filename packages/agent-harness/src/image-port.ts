/**
 * Pluggable image generate. No public-web scrape.
 * Intranet/local OpenAI-compatible /v1/images/generations, or a labeled 占位 file.
 */
import { writePlaceholderPng } from "./placeholder-png.js";

export type ImageKind = "generated" | "placeholder";

export type GeneratedImage = {
  bytes: Buffer;
  mime: "image/png";
  width: number;
  height: number;
  kind: ImageKind;
  note: string;
};

export type ImagePortConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** false = never call a remote image API. */
  enabled?: boolean;
};

export type ImagePort = {
  generate: (prompt: string, aspect?: string) => Promise<GeneratedImage>;
};

export type ImagePortDeps = {
  fetch?: typeof fetch;
};

export function imageConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ImagePortConfig {
  const disabled = env.SLIDESTUDIO_IMAGE === "0";
  const explicit = env.SLIDESTUDIO_IMAGE_BASE_URL?.trim();
  const llmBase = env.SLIDESTUDIO_LLM_BASE_URL?.trim();
  const optIn = env.SLIDESTUDIO_IMAGE === "1";
  const raw = explicit || (optIn ? llmBase : "");
  const baseUrl = raw ? raw.replace(/\/+$/, "") : "";
  return {
    baseUrl: baseUrl || undefined,
    apiKey: env.SLIDESTUDIO_IMAGE_API_KEY || env.SLIDESTUDIO_LLM_API_KEY,
    model: env.SLIDESTUDIO_IMAGE_MODEL?.trim() || undefined,
    timeoutMs: Number(env.SLIDESTUDIO_IMAGE_TIMEOUT_MS) || 180_000,
    enabled: !disabled && Boolean(baseUrl),
  };
}

export function imageConfigured(cfg: ImagePortConfig = imageConfigFromEnv()): boolean {
  return Boolean(cfg.enabled && cfg.baseUrl);
}

function imagesUrl(baseUrl: string): string {
  if (/\/images\/generations\/?$/.test(baseUrl)) return baseUrl;
  if (/\/openai\/v1\/?$/.test(baseUrl)) return `${baseUrl}/images/generations`;
  if (/\/v1\/?$/.test(baseUrl)) return `${baseUrl}/images/generations`;
  if (/generativelanguage\.googleapis\.com/i.test(baseUrl)) {
    return `${baseUrl.replace(/\/+$/, "")}/openai/images/generations`;
  }
  return `${baseUrl}/v1/images/generations`;
}

function sizeForAspect(aspect?: string): string {
  const raw = (aspect || "16:9").trim();
  if (raw === "1:1" || raw === "square") return "1024x1024";
  if (raw === "3:4" || raw === "portrait") return "1024x1536";
  return "1536x1024";
}

async function generateViaApi(
  cfg: ImagePortConfig,
  prompt: string,
  aspect: string | undefined,
  deps: ImagePortDeps,
): Promise<GeneratedImage> {
  const fetchFn = deps.fetch ?? fetch;
  const url = imagesUrl(cfg.baseUrl!);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 180_000);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model || "image",
        prompt: prompt.slice(0, 800),
        size: sizeForAspect(aspect),
        n: 1,
        response_format: "b64_json",
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`image HTTP ${res.status}`);
    }
    const parsed = JSON.parse(body) as {
      data?: { b64_json?: string; url?: string }[];
    };
    const b64 = parsed.data?.[0]?.b64_json;
    if (!b64) throw new Error("image API returned no b64_json");
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length < 64) throw new Error("image API returned empty bytes");
    const ph = writePlaceholderPng(aspect);
    return {
      bytes,
      mime: "image/png",
      width: ph.width,
      height: ph.height,
      kind: "generated",
      note: "generated — layout around this file, do not stretch",
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createImagePort(
  cfg: ImagePortConfig = imageConfigFromEnv(),
  deps: ImagePortDeps = {},
): ImagePort {
  return {
    async generate(prompt, aspect) {
      if (cfg.enabled && cfg.baseUrl) {
        try {
          return await generateViaApi(cfg, prompt, aspect, deps);
        } catch {
          const ph = writePlaceholderPng(aspect);
          return {
            ...ph,
            mime: "image/png",
            kind: "placeholder",
            note: "image API unavailable — 占位 file, not a photo. Label the page 占位.",
          };
        }
      }
      const ph = writePlaceholderPng(aspect);
      return {
        ...ph,
        mime: "image/png",
        kind: "placeholder",
        note: "no image API configured — 占位 file, not a photo. Label the page 占位.",
      };
    },
  };
}
