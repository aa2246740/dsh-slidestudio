/**
 * Pluggable image generate. No public-web scrape.
 * Presets cover the mainstream vendor wire formats (OpenAI images,
 * DashScope sync/async, Gemini Imagen, Stability SD3); `template` maps
 * an arbitrary sync JSON API onto {{var}} interpolation + a dotted
 * response path. When generate is on, fail closed — never write a fake
 * placeholder PNG.
 */
import { placeholderSize } from "./placeholder-png.js";
import { XAI_API_BASE } from "./grok-hosted.js";
import {
  buildTemplateRequest,
  jsonPath,
  templateVars,
  type EndpointTemplate,
} from "./endpoint-template.js";

export type ImageKind = "generated";

export type GeneratedImage = {
  bytes: Buffer;
  mime: "image/png" | "image/jpeg";
  width: number;
  height: number;
  kind: ImageKind;
  note: string;
};

export type ImageGeneratePreset =
  | "openai"
  | "dashscope-sync"
  | "dashscope-task"
  | "gemini-imagen"
  | "stability"
  | "template";

export const IMAGE_GENERATE_PRESETS: readonly ImageGeneratePreset[] = [
  "openai",
  "dashscope-sync",
  "dashscope-task",
  "gemini-imagen",
  "stability",
  "template",
];

export type ImagePortConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Wire format; empty/unknown falls back to "openai". */
  preset?: string;
  /** {{var}} request template; only used when preset === "template". */
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

export const GROK_IMAGINE_MODEL = "grok-imagine-image-2.0" as const;

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

/** Signed-in Grok: always the xAI imagine endpoint. Missing token fails at generate. */
export function grokImageConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ImagePortConfig {
  return {
    enabled: true,
    baseUrl: env.SLIDESTUDIO_IMAGE_BASE_URL?.trim() || XAI_API_BASE,
    apiKey: env.SLIDESTUDIO_IMAGE_API_KEY?.trim() || undefined,
    model: env.SLIDESTUDIO_IMAGE_MODEL?.trim() || GROK_IMAGINE_MODEL,
    preset: env.SLIDESTUDIO_IMAGE_PRESET?.trim() || undefined,
    template: templateFromEnv(env.SLIDESTUDIO_IMAGE_TEMPLATE),
    timeoutMs: Number(env.SLIDESTUDIO_IMAGE_TIMEOUT_MS) || 180_000,
  };
}

export function imageConfigured(cfg: ImagePortConfig = imageConfigFromEnv()): boolean {
  // The template preset may describe a keyless intranet API; every named
  // vendor preset authenticates with an API key.
  return Boolean(
    cfg.enabled && cfg.baseUrl && (cfg.apiKey || cfg.preset === "template"),
  );
}

function generatePreset(cfg: ImagePortConfig): ImageGeneratePreset {
  const p = cfg.preset?.trim();
  return (IMAGE_GENERATE_PRESETS as readonly string[]).includes(p ?? "")
    ? (p as ImageGeneratePreset)
    : "openai";
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

function isXaiImagine(cfg: ImagePortConfig): boolean {
  const model = cfg.model ?? "";
  const base = cfg.baseUrl ?? "";
  return model.includes("grok-imagine") || /api\.x\.ai/i.test(base);
}

const SLOT_ASPECTS = [
  { id: "1:1", ratio: 1 },
  { id: "4:3", ratio: 4 / 3 },
  { id: "3:4", ratio: 3 / 4 },
  { id: "16:9", ratio: 16 / 9 },
  { id: "9:16", ratio: 9 / 16 },
] as const;

/** Map a planned photo frame to the nearest API aspect. 258×344 → 3:4, not 16:9. */
export function aspectFromSlot(width: number, height: number): string {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("photo slot width and height must be positive");
  }
  const r = width / height;
  let bestId = "16:9";
  let best = Infinity;
  for (const slot of SLOT_ASPECTS) {
    const dist = Math.abs(Math.log(r / slot.ratio));
    if (dist < best) {
      best = dist;
      bestId = slot.id;
    }
  }
  return bestId;
}

function aspectRatio(aspect?: string): string {
  const raw = (aspect || "16:9").trim();
  if (raw === "square") return "1:1";
  if (raw === "portrait") return "3:4";
  if (raw === "widescreen") return "16:9";
  return raw;
}

function sizeForAspect(aspect?: string): string {
  const ratio = aspectRatio(aspect);
  if (ratio === "1:1") return "1024x1024";
  if (ratio === "3:4" || ratio === "9:16") return "1024x1536";
  if (ratio === "4:3") return "1024x768";
  return "1536x1024";
}

export function pngSizeFromBytes(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined;
  if (bytes.toString("ascii", 1, 4) !== "PNG") return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!(width > 0) || !(height > 0)) return undefined;
  return { width, height };
}

function requestBody(cfg: ImagePortConfig, prompt: string, aspect: string | undefined): Record<string, unknown> {
  const model = cfg.model || (isXaiImagine(cfg) ? GROK_IMAGINE_MODEL : "image");
  if (isXaiImagine(cfg)) {
    return {
      model,
      prompt: prompt.slice(0, 800),
      n: 1,
      aspect_ratio: aspectRatio(aspect),
      response_format: "b64_json",
    };
  }
  return {
    model,
    prompt: prompt.slice(0, 800),
    size: sizeForAspect(aspect),
    n: 1,
    response_format: "b64_json",
  };
}

async function bytesFromApiPayload(
  parsed: unknown,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mime: "image/png" | "image/jpeg" }> {
  const rec = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const data = Array.isArray(rec.data) ? rec.data : [];
  const first = data[0] && typeof data[0] === "object" ? (data[0] as Record<string, unknown>) : undefined;
  const b64 = typeof first?.b64_json === "string" ? first.b64_json : undefined;
  if (b64) {
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length < 64) throw new Error("image API returned empty bytes");
    return { bytes, mime: "image/png" };
  }
  const url = typeof first?.url === "string" ? first.url.trim() : "";
  if (!url) throw new Error("image API returned no b64_json or url");
  const res = await fetchFn(url, { signal });
  if (!res.ok) throw new Error(`image URL HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 64) throw new Error("image URL returned empty bytes");
  const mime = /jpe?g/i.test(res.headers.get("content-type") ?? "") || /\.jpe?g(\?|$)/i.test(url)
    ? "image/jpeg"
    : "image/png";
  return { bytes, mime };
}

/** qwen-image native sizes (multimodal-generation) per aspect. */
function dashscopeSyncSize(aspect?: string): string {
  const ratio = aspectRatio(aspect);
  if (ratio === "1:1") return "1328*1328";
  if (ratio === "3:4") return "1140*1472";
  if (ratio === "9:16") return "928*1664";
  if (ratio === "4:3") return "1472*1140";
  return "1664*928";
}

/** wanx async task sizes (768–1440, multiples of 32). */
function dashscopeTaskSize(aspect?: string): string {
  const ratio = aspectRatio(aspect);
  if (ratio === "1:1") return "1024*1024";
  if (ratio === "3:4" || ratio === "9:16") return "960*1440";
  if (ratio === "4:3") return "1024*768";
  return "1440*960";
}

function stabilityAspect(aspect?: string): string {
  const ratio = aspectRatio(aspect);
  if (ratio === "1:1" || ratio === "16:9" || ratio === "9:16") return ratio;
  if (ratio === "4:3") return "3:2";
  if (ratio === "3:4") return "2:3";
  return "16:9";
}

async function readJson(res: { ok: boolean; status: number; text(): Promise<string> }, label: string): Promise<unknown> {
  const body = await res.text();
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${body.slice(0, 180)}`);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${label} returned non-JSON`);
  }
}

async function bytesFromImageUrl(
  url: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
  headers?: Record<string, string>,
): Promise<{ bytes: Buffer; mime: "image/png" | "image/jpeg" }> {
  const res = await fetchFn(url, { signal, headers });
  if (!res.ok) throw new Error(`image URL HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 64) throw new Error("image URL returned empty bytes");
  const mime = /jpe?g/i.test(res.headers.get("content-type") ?? "") || /\.jpe?g(\?|$)/i.test(url)
    ? "image/jpeg"
    : "image/png";
  return { bytes, mime };
}

function bytesFromB64(b64: string): { bytes: Buffer; mime: "image/png" | "image/jpeg" } {
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length < 64) throw new Error("image API returned empty bytes");
  return { bytes, mime: "image/png" };
}

/** OpenAI-compatible /images/generations contract. */
async function generateViaOpenai(
  cfg: ImagePortConfig,
  prompt: string,
  aspect: string | undefined,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mime: "image/png" | "image/jpeg" }> {
  const res = await fetchFn(imagesUrl(cfg.baseUrl!), {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey!.trim()}`,
    },
    body: JSON.stringify(requestBody(cfg, prompt, aspect)),
  });
  const parsed = await readJson(res, "image");
  return bytesFromApiPayload(parsed, fetchFn, signal);
}

/** DashScope synchronous multimodal-generation (qwen-image). */
async function generateViaDashscopeSync(
  cfg: ImagePortConfig,
  prompt: string,
  aspect: string | undefined,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mime: "image/png" | "image/jpeg" }> {
  const base = cfg.baseUrl!.replace(/\/+$/, "");
  const url = /services\/aigc\/multimodal-generation\/generation\/?$/.test(base)
    ? base
    : `${base}/api/v1/services/aigc/multimodal-generation/generation`;
  const res = await fetchFn(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey!.trim()}`,
    },
    body: JSON.stringify({
      model: cfg.model || "qwen-image",
      input: { messages: [{ role: "user", content: [{ text: prompt.slice(0, 800) }] }] },
      parameters: { size: dashscopeSyncSize(aspect), n: 1 },
    }),
  });
  const parsed = await readJson(res, "image");
  const urlOut = jsonPath(parsed, "output.choices.0.message.content");
  const items = Array.isArray(urlOut) ? urlOut : [];
  for (const item of items) {
    const image = item && typeof item === "object" ? (item as Record<string, unknown>).image : undefined;
    if (typeof image === "string" && image.startsWith("http")) {
      return bytesFromImageUrl(image, fetchFn, signal);
    }
  }
  throw new Error("image API returned no image url");
}

/** DashScope async text2image task (wanx): create → poll task → results[].url. */
async function generateViaDashscopeTask(
  cfg: ImagePortConfig,
  prompt: string,
  aspect: string | undefined,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mime: "image/png" | "image/jpeg" }> {
  const base = cfg.baseUrl!.replace(/\/+$/, "");
  const createUrl = /services\/aigc\/text2image\/image-synthesis\/?$/.test(base)
    ? base
    : `${base}/api/v1/services/aigc/text2image/image-synthesis`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey!.trim()}`,
  };
  const res = await fetchFn(createUrl, {
    method: "POST",
    signal,
    headers: { ...headers, "X-DashScope-Async": "enable" },
    body: JSON.stringify({
      model: cfg.model || "wanx2.1-t2i-turbo",
      input: { prompt: prompt.slice(0, 800) },
      parameters: { size: dashscopeTaskSize(aspect), n: 1 },
    }),
  });
  const created = await readJson(res, "image task");
  const taskId = jsonPath(created, "output.task_id");
  if (typeof taskId !== "string" || !taskId) {
    throw new Error("image task returned no task_id");
  }
  const taskUrl = `${base}/api/v1/tasks/${taskId}`;
  const deadline = Date.now() + (cfg.timeoutMs ?? 180_000);
  for (;;) {
    const poll = await fetchFn(taskUrl, { signal, headers });
    const task = await readJson(poll, "image task");
    const status = String(jsonPath(task, "output.task_status") ?? "").toUpperCase();
    if (status === "SUCCEEDED") {
      const imageUrl = jsonPath(task, "output.results.0.url");
      if (typeof imageUrl !== "string" || !imageUrl) {
        throw new Error("image task SUCCEEDED without results[].url");
      }
      return bytesFromImageUrl(imageUrl, fetchFn, signal);
    }
    if (status && status !== "PENDING" && status !== "RUNNING") {
      const message = jsonPath(task, "output.message") ?? jsonPath(task, "message");
      throw new Error(`image task ${status}: ${String(message ?? "").slice(0, 120)}`);
    }
    if (Date.now() > deadline) throw new Error("image task timed out");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** Gemini Imagen :predict (generativelanguage.googleapis.com). */
async function generateViaGeminiImagen(
  cfg: ImagePortConfig,
  prompt: string,
  aspect: string | undefined,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mime: "image/png" | "image/jpeg" }> {
  const base = cfg.baseUrl!.replace(/\/+$/, "");
  const url = /:predict\??.*$/.test(base)
    ? base
    : `${base}/models/${encodeURIComponent(cfg.model || "imagen-3.0-generate-002")}:predict`;
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetchFn(`${url}${sep}key=${encodeURIComponent(cfg.apiKey!.trim())}`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [{ prompt: prompt.slice(0, 800) }],
      parameters: { sampleCount: 1, aspectRatio: aspectRatio(aspect) },
    }),
  });
  const parsed = await readJson(res, "image");
  const b64 = jsonPath(parsed, "predictions.0.bytesBase64Encoded");
  if (typeof b64 !== "string" || !b64) {
    throw new Error("image API returned no predictions[].bytesBase64Encoded");
  }
  return bytesFromB64(b64);
}

/** Stability AI v2beta sd3 (multipart form). */
async function generateViaStability(
  cfg: ImagePortConfig,
  prompt: string,
  aspect: string | undefined,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mime: "image/png" | "image/jpeg" }> {
  const base = cfg.baseUrl!.replace(/\/+$/, "");
  const url = /stable-image\/generate\/sd3\/?$/.test(base)
    ? base
    : `${base}/v2beta/stable-image/generate/sd3`;
  const form = new FormData();
  form.append("prompt", prompt.slice(0, 800));
  form.append("aspect_ratio", stabilityAspect(aspect));
  form.append("output_format", "png");
  if (cfg.model) form.append("model", cfg.model);
  const res = await fetchFn(url, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${cfg.apiKey!.trim()}`, Accept: "application/json" },
    body: form,
  });
  const parsed = await readJson(res, "image");
  const b64 = jsonPath(parsed, "image");
  if (typeof b64 !== "string" || !b64) {
    throw new Error("image API returned no image field");
  }
  return bytesFromB64(b64);
}

/** Custom template: {{prompt}}/{{size}}/{{model}}/{{key}} + dotted imagePath. */
async function generateViaTemplate(
  cfg: ImagePortConfig,
  prompt: string,
  aspect: string | undefined,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mime: "image/png" | "image/jpeg" }> {
  const tmpl = cfg.template;
  if (!tmpl?.imagePath) {
    throw new Error("template preset requires template.imagePath (response image field path)");
  }
  const size = sizeForAspect(aspect);
  const [width, height] = size.split("x");
  const vars = templateVars({
    prompt: prompt.slice(0, 800),
    size,
    width,
    height,
    aspect: aspectRatio(aspect),
    model: cfg.model,
    n: "1",
    key: cfg.apiKey?.trim(),
    apikey: cfg.apiKey?.trim(),
  });
  const req = buildTemplateRequest({ ...tmpl, url: tmpl.url || cfg.baseUrl }, vars);
  const res = await fetchFn(req.url, { ...req.init, signal });
  const parsed = await readJson(res, "image");
  const raw = jsonPath(parsed, tmpl.imagePath);
  if (typeof raw !== "string" || !raw) {
    throw new Error(`template imagePath ${tmpl.imagePath} resolved to nothing`);
  }
  if (/^https?:\/\//i.test(raw)) return bytesFromImageUrl(raw, fetchFn, signal);
  return bytesFromB64(raw);
}

async function generateViaApi(
  cfg: ImagePortConfig,
  prompt: string,
  aspect: string | undefined,
  deps: ImagePortDeps,
): Promise<GeneratedImage> {
  const preset = generatePreset(cfg);
  if (preset !== "template" && !cfg.apiKey?.trim()) {
    throw new Error("image generate has no API key — refusing to write a placeholder PNG");
  }
  const fetchFn = deps.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 180_000);
  try {
    let out: { bytes: Buffer; mime: "image/png" | "image/jpeg" };
    switch (preset) {
      case "dashscope-sync":
        out = await generateViaDashscopeSync(cfg, prompt, aspect, fetchFn, ctrl.signal);
        break;
      case "dashscope-task":
        out = await generateViaDashscopeTask(cfg, prompt, aspect, fetchFn, ctrl.signal);
        break;
      case "gemini-imagen":
        out = await generateViaGeminiImagen(cfg, prompt, aspect, fetchFn, ctrl.signal);
        break;
      case "stability":
        out = await generateViaStability(cfg, prompt, aspect, fetchFn, ctrl.signal);
        break;
      case "template":
        out = await generateViaTemplate(cfg, prompt, aspect, fetchFn, ctrl.signal);
        break;
      default:
        out = await generateViaOpenai(cfg, prompt, aspect, fetchFn, ctrl.signal);
    }
    const measured = pngSizeFromBytes(out.bytes);
    const ph = placeholderSize(aspect);
    return {
      bytes: out.bytes,
      mime: out.mime,
      width: measured?.width ?? ph.width,
      height: measured?.height ?? ph.height,
      kind: "generated",
      note: "generated — write_page bounds must use this aspect; do not stretch or cover-crop a mismatched frame",
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
      if (!(cfg.enabled && cfg.baseUrl)) {
        throw new Error("image generate is not configured — refusing to write a placeholder PNG");
      }
      return generateViaApi(cfg, prompt, aspect, deps);
    },
  };
}
