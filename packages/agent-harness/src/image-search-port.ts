/**
 * Pluggable image search. No vendor hardcode.
 * POST { query } → { images: [{ url | b64_json, width, height, attribution }] }.
 * Non-generic presets delegate to the shared vendor-preset port.
 */
import {
  createImageSearchPort as createCoreImageSearchPort,
  IMAGE_SEARCH_PRESETS,
  type EndpointTemplate,
  type ImageSearchPortConfig as CoreImageSearchPortConfig,
} from "@open-slidestudio/presentation-run";

export type ImageSearchHit = {
  bytes: Buffer;
  mime: "image/png" | "image/jpeg" | "image/webp";
  width?: number;
  height?: number;
  attribution?: string;
  note: string;
};

export type ImageSearchNone = {
  kind: "none";
  note: string;
};

export type ImageSearchPortConfig = {
  url?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Wire format preset; "generic"/empty uses the local POST path below. */
  preset?: string;
  template?: EndpointTemplate;
};

export type ImageSearchPort = {
  search: (query: string) => Promise<ImageSearchHit | ImageSearchNone>;
};

export type ImageSearchPortDeps = {
  fetch?: typeof fetch;
};

export function imageSearchConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ImageSearchPortConfig {
  return {
    url: env.SLIDESTUDIO_IMAGE_SEARCH_URL?.trim() || undefined,
    apiKey: env.SLIDESTUDIO_IMAGE_SEARCH_KEY?.trim() || undefined,
    preset: env.SLIDESTUDIO_IMAGE_SEARCH_PRESET?.trim() || undefined,
    template: templateFromEnv(env.SLIDESTUDIO_IMAGE_SEARCH_TEMPLATE),
    timeoutMs: Number(env.SLIDESTUDIO_IMAGE_SEARCH_TIMEOUT_MS) || 20_000,
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

export function imageSearchConfigured(
  cfg: ImageSearchPortConfig = imageSearchConfigFromEnv(),
): boolean {
  if (!cfg.url) return false;
  const needsKey = ["pixabay", "pexels", "unsplash", "bing"].includes(
    cfg.preset ?? "",
  );
  return !needsKey || Boolean(cfg.apiKey?.trim());
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

function firstImage(raw: unknown): {
  b64?: string;
  url?: string;
  width?: number;
  height?: number;
  attribution?: string;
} | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o.images)
    ? o.images
    : Array.isArray(o.data)
      ? o.data
      : [];
  const first = list[0];
  if (!first || typeof first !== "object") return undefined;
  const img = first as Record<string, unknown>;
  const b64 =
    typeof img.b64_json === "string"
      ? img.b64_json
      : typeof img.b64 === "string"
        ? img.b64
        : undefined;
  const url = typeof img.url === "string" ? img.url : undefined;
  const width = typeof img.width === "number" ? img.width : undefined;
  const height = typeof img.height === "number" ? img.height : undefined;
  const attribution =
    typeof img.attribution === "string"
      ? img.attribution
      : typeof img.source === "string"
        ? img.source
        : undefined;
  if (!b64 && !url) return undefined;
  return { b64, url, width, height, attribution };
}

export function createImageSearchPort(
  cfg: ImageSearchPortConfig = imageSearchConfigFromEnv(),
  deps: ImageSearchPortDeps = {},
): ImageSearchPort {
  return {
    async search(query) {
      const q = query.trim();
      if (!q) {
        return { kind: "none", note: "search query empty" };
      }
      if (!cfg.url) {
        return {
          kind: "none",
          note: "no image search URL — design without a bitmap, or use generate if that port is on",
        };
      }
      const preset = cfg.preset?.trim();
      if (
        preset &&
        preset !== "generic" &&
        (IMAGE_SEARCH_PRESETS as readonly string[]).includes(preset)
      ) {
        const core = createCoreImageSearchPort(
          cfg as unknown as CoreImageSearchPortConfig,
          deps,
        );
        return core.search(q);
      }
      const fetchFn = deps.fetch ?? fetch;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 20_000);
      try {
        const res = await fetchFn(cfg.url, {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "Content-Type": "application/json",
            ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
          },
          body: JSON.stringify({ query: q.slice(0, 400) }),
        });
        const body = await res.text();
        if (!res.ok) {
          return { kind: "none", note: `image search HTTP ${res.status}` };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body) as unknown;
        } catch {
          return { kind: "none", note: "image search returned non-JSON" };
        }
        const hit = firstImage(parsed);
        if (!hit) {
          return { kind: "none", note: "image search returned no images" };
        }
        let bytes: Buffer;
        if (hit.b64) {
          bytes = Buffer.from(hit.b64, "base64");
        } else if (hit.url) {
          const imgRes = await fetchFn(hit.url, { signal: ctrl.signal });
          if (!imgRes.ok) {
            return { kind: "none", note: `image download HTTP ${imgRes.status}` };
          }
          bytes = Buffer.from(await imgRes.arrayBuffer());
        } else {
          return { kind: "none", note: "image search hit had no bytes" };
        }
        if (bytes.length < 64) {
          return { kind: "none", note: "image search returned empty bytes" };
        }
        return {
          bytes,
          mime: mimeFromBytes(bytes),
          width: hit.width,
          height: hit.height,
          attribution: hit.attribution,
          note: hit.attribution
            ? `search hit — ${hit.attribution}`
            : "search hit from configured image search port",
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { kind: "none", note: `image search failed: ${msg.slice(0, 180)}` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
