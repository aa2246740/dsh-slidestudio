/**
 * Hosted xAI produce tools for signed-in Grok (pi-xai).
 * MiniMax / OpenRouter keep env-port search and image URLs; they must not call this.
 */
import type { ImageSearchHit, ImageSearchNone, ImageSearchPort } from "./image-search-port.js";

export const XAI_RESPONSES_PATH = "/responses" as const;
export const XAI_API_BASE = "https://api.x.ai/v1" as const;
export const GROK_SEARCH_MODEL = "grok-4.6" as const;

export type GrokWebSearchResult = {
  readonly query: string;
  readonly text: string;
  readonly facts: readonly string[];
  readonly citations: readonly string[];
  readonly source: "pi-xai-hosted";
};

export type GrokHostedPortConfig = {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
};

export type GrokHostedPortDeps = {
  readonly fetch?: typeof fetch;
  readonly abortSignal?: AbortSignal;
};

function configFromEnv(
  cfg: GrokHostedPortConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): { apiKey: string; baseUrl: string; model: string; timeoutMs: number } {
  const apiKey = (cfg.apiKey ?? env.SLIDESTUDIO_IMAGE_API_KEY ?? "").trim();
  const baseUrl = (cfg.baseUrl ?? env.SLIDESTUDIO_IMAGE_BASE_URL ?? XAI_API_BASE).replace(/\/+$/, "");
  return {
    apiKey,
    baseUrl,
    model: (cfg.model ?? env.SLIDESTUDIO_GROK_MODEL ?? GROK_SEARCH_MODEL).trim() || GROK_SEARCH_MODEL,
    timeoutMs: cfg.timeoutMs ?? 90_000,
  };
}

function outputText(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.output_text === "string" && rec.output_text.trim()) return rec.output_text;
  if (!Array.isArray(rec.output)) return "";
  const parts: string[] = [];
  for (const item of rec.output) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.text === "string") parts.push(row.text);
    if (!Array.isArray(row.content)) continue;
    for (const block of row.content) {
      if (!block || typeof block !== "object") continue;
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

function citationsFrom(text: string, parsed: unknown): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) {
    if (match[1]) found.add(match[1]);
  }
  for (const match of text.matchAll(/https?:\/\/[^\s)<>"]+/g)) {
    found.add(match[0].replace(/[.,;]+$/, ""));
  }
  if (parsed && typeof parsed === "object") {
    const rec = parsed as Record<string, unknown>;
    const citations = rec.citations;
    if (Array.isArray(citations)) {
      for (const row of citations) {
        if (typeof row === "string" && row.startsWith("http")) found.add(row);
        if (row && typeof row === "object") {
          const url = (row as { url?: unknown }).url;
          if (typeof url === "string" && url.startsWith("http")) found.add(url);
        }
      }
    }
  }
  return [...found].slice(0, 8);
}

function factsFrom(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("!["))
    .slice(0, 8);
}

function markdownImageUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) {
    if (match[1]) urls.push(match[1]);
  }
  return urls;
}

async function xaiResponses(
  cfg: ReturnType<typeof configFromEnv>,
  prompt: string,
  tools: readonly Record<string, unknown>[],
  deps: GrokHostedPortDeps,
): Promise<{ text: string; raw: unknown }> {
  if (!cfg.apiKey) {
    throw new Error("Grok hosted tool needs the xAI access token (sign in with dsh-oauth-login)");
  }
  const fetchFn = deps.fetch ?? fetch;
  const timeout = AbortSignal.timeout(cfg.timeoutMs);
  const signal = deps.abortSignal ? AbortSignal.any([timeout, deps.abortSignal]) : timeout;
  try {
    const res = await fetchFn(`${cfg.baseUrl}${XAI_RESPONSES_PATH}`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        input: [{ role: "user", content: prompt }],
        tools,
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`xAI responses HTTP ${res.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new Error("xAI responses returned non-JSON");
    }
    return { text: outputText(parsed).trim(), raw: parsed };
  } catch (error) {
    if (deps.abortSignal?.aborted) {
      throw new Error("xAI hosted web_search cancelled", { cause: error });
    }
    if (timeout.aborted) {
      throw new Error(`xAI hosted web_search timed out after ${cfg.timeoutMs}ms`, { cause: error });
    }
    throw error;
  }
}

export async function grokWebSearch(
  query: string,
  cfg: GrokHostedPortConfig = {},
  deps: GrokHostedPortDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<GrokWebSearchResult> {
  const q = query.trim();
  if (!q) {
    return { query: "", text: "", facts: [], citations: [], source: "pi-xai-hosted" };
  }
  const resolved = configFromEnv(cfg, env);
  const { text, raw } = await xaiResponses(
    resolved,
    `Search the live web for recent facts. Return concise bullet facts with source URLs.\nQuery: ${q.slice(0, 400)}`,
    [{ type: "web_search" }],
    deps,
  );
  return {
    query: q,
    text,
    facts: factsFrom(text),
    citations: citationsFrom(text, raw),
    source: "pi-xai-hosted",
  };
}

function mimeFromBytes(bytes: Buffer): ImageSearchHit["mime"] {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "image/png";
}

export function createGrokImageSearchPort(
  cfg: GrokHostedPortConfig = {},
  deps: GrokHostedPortDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): ImageSearchPort {
  return {
    async search(query) {
      const q = query.trim();
      if (!q) return { kind: "none", note: "search query empty" };
      try {
        const resolved = configFromEnv(cfg, env);
        const { text } = await xaiResponses(
          resolved,
          `Find one high-quality reference image for a slide background or cover. Return a markdown image embed.\nQuery: ${q.slice(0, 400)}`,
          [{ type: "web_search", enable_image_search: true }],
          deps,
        );
        const urls = markdownImageUrls(text);
        const url = urls[0];
        if (!url) {
          return { kind: "none", note: "xAI image search returned no image URL" };
        }
        const fetchFn = deps.fetch ?? fetch;
        const imgRes = await fetchFn(url);
        if (!imgRes.ok) {
          return { kind: "none", note: `image download HTTP ${imgRes.status}` };
        }
        const bytes = Buffer.from(await imgRes.arrayBuffer());
        if (bytes.length < 64) {
          return { kind: "none", note: "xAI image search returned empty bytes" };
        }
        return {
          bytes,
          mime: mimeFromBytes(bytes),
          note: `search hit from xAI image search — ${url}`,
          attribution: url,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { kind: "none", note: `xAI image search failed: ${msg.slice(0, 180)}` };
      }
    },
  };
}

export type { ImageSearchHit, ImageSearchNone };
