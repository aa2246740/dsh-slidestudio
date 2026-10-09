/**
 * Pluggable image generate. No public-web scrape.
 * Intranet/local OpenAI-compatible /v1/images/generations, or a labeled 占位 file.
 */
import { writePlaceholderPng } from "./placeholder-png.js";
import {
  createImagePort as createCoreImagePort,
  IMAGE_GENERATE_PRESETS,
  type EndpointTemplate,
} from "@open-slidestudio/presentation-run";

export type ImageKind = "generated" | "placeholder";

export type GeneratedImage = {
  bytes: Buffer;
  mime: "image/png" | "image/jpeg" | "image/webp";
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
  /** Wire format preset; empty/"openai" uses the local OpenAI path below,
   *  anything else delegates to the shared vendor-preset port. */
  preset?: string;
  template?: EndpointTemplate;
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
    preset: env.SLIDESTUDIO_IMAGE_PRESET?.trim() || undefined,
    template: templateFromEnv(env.SLIDESTUDIO_IMAGE_TEMPLATE),
    timeoutMs: Number(env.SLIDESTUDIO_IMAGE_TIMEOUT_MS) || 180_000,
    enabled: !disabled && Boolean(baseUrl),
  };
}

function templateFromEnv(raw: string | undefined): EndpointTemplate | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as EndpointTemplate)
      : undefined;
  } catch {
    return undefined;
  }
}

export function imageConfigured(cfg: ImagePortConfig = imageConfigFromEnv()): boolean {
  return Boolean(cfg.enabled && cfg.baseUrl);
}

function isNamedPreset(preset: string | undefined): boolean {
  return Boolean(
    preset &&
      preset !== "openai" &&
      (IMAGE_GENERATE_PRESETS as readonly string[]).includes(preset),
  );
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
          if (isNamedPreset(cfg.preset)) {
            const core = createCoreImagePort(cfg, deps);
            const img = await core.generate(prompt, aspect);
            return { ...img, kind: "generated", note: img.note };
          }
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
