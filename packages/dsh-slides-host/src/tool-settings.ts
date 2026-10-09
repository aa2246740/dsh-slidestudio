import fs from "node:fs";
import path from "node:path";
import {
  IMAGE_GENERATE_PRESETS,
  IMAGE_SEARCH_PRESETS,
  type EndpointTemplate,
} from "@open-slidestudio/presentation-run";

const SETTINGS_FILE = "slides-tool-settings.json";

export type ToolEndpoint =
  | { readonly kind: "off" }
  | {
      readonly kind: "custom";
      readonly url: string;
      readonly apiKey: string;
      readonly model: string;
      /** Vendor wire format; empty = the endpoint's default preset. */
      readonly preset?: string;
      /** {{var}} request template; only used when preset === "template". */
      readonly template?: EndpointTemplate;
    };

export type ToolSettings = {
  readonly research: ToolEndpoint;
  readonly imageSearch: ToolEndpoint;
  readonly imageGenerate: ToolEndpoint;
};

export type ToolEndpointView =
  | { readonly kind: "off" }
  | {
      readonly kind: "custom";
      readonly url: string;
      readonly apiKeySet: boolean;
      readonly model: string;
      readonly preset?: string;
      readonly template?: EndpointTemplate;
    };

export type ToolSettingsView = {
  readonly research: ToolEndpointView;
  readonly imageSearch: ToolEndpointView;
  readonly imageGenerate: ToolEndpointView;
};

const OFF: ToolEndpoint = { kind: "off" };

export function emptyToolSettings(): ToolSettings {
  return { research: OFF, imageSearch: OFF, imageGenerate: OFF };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function assertHttpUrl(url: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} must be an http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must be an http(s) URL`);
  }
  return url;
}

function parseTemplate(value: unknown, label: string): EndpointTemplate | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)) throw new Error(`${label}.template must be an object`);
  const headers: Record<string, string> = {};
  if (value.headers != null) {
    if (!isRecord(value.headers)) throw new Error(`${label}.template.headers must be an object`);
    for (const [k, v] of Object.entries(value.headers)) {
      if (typeof v === "string" && k.trim()) headers[k.trim()] = v;
    }
  }
  const out: EndpointTemplate = {
    url: readString(value.url) || undefined,
    method: readString(value.method) || undefined,
    headers: Object.keys(headers).length ? headers : undefined,
    body: typeof value.body === "string" ? value.body : undefined,
    imagePath: readString(value.imagePath) || undefined,
    attribution: readString(value.attribution) || undefined,
  };
  return Object.values(out).some((v) => v != null) ? out : undefined;
}

function parseEndpoint(value: unknown, label: string, previous: ToolEndpoint): ToolEndpoint {
  if (value == null) return previous;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const kind = readString(value.kind) || (readString(value.url) ? "custom" : "off");
  if (kind === "off") return OFF;
  if (kind !== "custom") throw new Error(`${label}.kind must be off or custom`);
  const url = readString(value.url);
  if (!url) return OFF;
  const keepKey = value.keepKey === true || readString(value.apiKey) === "";
  const nextKey = readString(value.apiKey);
  const apiKey =
    nextKey || (keepKey && previous.kind === "custom" ? previous.apiKey : "");
  const allowed =
    label === "imageGenerate"
      ? (IMAGE_GENERATE_PRESETS as readonly string[])
      : (IMAGE_SEARCH_PRESETS as readonly string[]);
  const preset = readString(value.preset);
  if (preset && !allowed.includes(preset)) {
    throw new Error(`${label}.preset must be one of ${allowed.join(", ")}`);
  }
  return {
    kind: "custom",
    url: assertHttpUrl(url, label),
    apiKey,
    model: readString(value.model),
    preset: preset || undefined,
    template: parseTemplate(value.template, label),
  };
}

export function parseToolSettingsPatch(value: unknown, previous: ToolSettings): ToolSettings {
  if (!isRecord(value)) throw new Error("tool settings must be an object");
  return {
    research: OFF,
    imageSearch: parseEndpoint(value.imageSearch, "imageSearch", previous.imageSearch),
    imageGenerate: parseEndpoint(value.imageGenerate, "imageGenerate", previous.imageGenerate),
  };
}

function endpointFromEnv(
  url: string,
  apiKey: string,
  model = "",
  preset = "",
  templateJson = "",
): ToolEndpoint {
  if (!url) return OFF;
  let template: EndpointTemplate | undefined;
  if (templateJson.trim()) {
    try {
      template = parseTemplate(JSON.parse(templateJson), "env");
    } catch {
      template = undefined;
    }
  }
  return { kind: "custom", url, apiKey, model, preset: preset || undefined, template };
}

export function toolSettingsFromEnv(env: NodeJS.ProcessEnv): ToolSettings {
  return {
    research: OFF,
    imageSearch: endpointFromEnv(
      env.SLIDESTUDIO_IMAGE_SEARCH_URL?.trim() || "",
      env.SLIDESTUDIO_IMAGE_SEARCH_KEY?.trim() || "",
      "",
      env.SLIDESTUDIO_IMAGE_SEARCH_PRESET?.trim() || "",
      env.SLIDESTUDIO_IMAGE_SEARCH_TEMPLATE ?? "",
    ),
    imageGenerate: endpointFromEnv(
      env.SLIDESTUDIO_IMAGE_BASE_URL?.trim() || "",
      env.SLIDESTUDIO_IMAGE_API_KEY?.trim() || "",
      env.SLIDESTUDIO_IMAGE_MODEL?.trim() || "",
      env.SLIDESTUDIO_IMAGE_PRESET?.trim() || "",
      env.SLIDESTUDIO_IMAGE_TEMPLATE ?? "",
    ),
  };
}

export function toolSettingsFile(home: string): string {
  return path.join(home, SETTINGS_FILE);
}

export function readStoredToolSettings(home: string): ToolSettings | undefined {
  const file = toolSettingsFile(home);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parseToolSettingsPatch(parsed, emptyToolSettings());
  } catch {
    return undefined;
  }
}

export function readToolSettings(home: string, env: NodeJS.ProcessEnv = process.env): ToolSettings {
  return readStoredToolSettings(home) ?? toolSettingsFromEnv(env);
}

export function writeToolSettings(home: string, settings: ToolSettings): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = toolSettingsFile(home);
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

function viewEndpoint(endpoint: ToolEndpoint): ToolEndpointView {
  if (endpoint.kind === "off") return { kind: "off" };
  return {
    kind: "custom",
    url: endpoint.url,
    apiKeySet: Boolean(endpoint.apiKey),
    model: endpoint.model,
    preset: endpoint.preset,
    template: endpoint.template,
  };
}

export function toToolSettingsView(settings: ToolSettings): ToolSettingsView {
  return {
    research: viewEndpoint(settings.research),
    imageSearch: viewEndpoint(settings.imageSearch),
    imageGenerate: viewEndpoint(settings.imageGenerate),
  };
}

const OVERLAY_KEYS = [
  "SLIDESTUDIO_RESEARCH_URL",
  "SLIDESTUDIO_RESEARCH_API_KEY",
  "SLIDESTUDIO_IMAGE_SEARCH_URL",
  "SLIDESTUDIO_IMAGE_SEARCH_KEY",
  "SLIDESTUDIO_IMAGE_BASE_URL",
  "SLIDESTUDIO_IMAGE_API_KEY",
  "SLIDESTUDIO_IMAGE_MODEL",
  "SLIDESTUDIO_IMAGE_PRESET",
  "SLIDESTUDIO_IMAGE_TEMPLATE",
  "SLIDESTUDIO_IMAGE_SEARCH_PRESET",
  "SLIDESTUDIO_IMAGE_SEARCH_TEMPLATE",
  "SLIDESTUDIO_IMAGE",
] as const;

function setOrDelete(env: NodeJS.ProcessEnv, key: string, value: string): void {
  if (value) env[key] = value;
  else delete env[key];
}

export function applyToolSettingsToEnv(env: NodeJS.ProcessEnv, settings: ToolSettings): NodeJS.ProcessEnv {
  for (const key of OVERLAY_KEYS) delete env[key];
  if (settings.imageSearch.kind === "custom") {
    setOrDelete(env, "SLIDESTUDIO_IMAGE_SEARCH_URL", settings.imageSearch.url);
    setOrDelete(env, "SLIDESTUDIO_IMAGE_SEARCH_KEY", settings.imageSearch.apiKey);
    setOrDelete(env, "SLIDESTUDIO_IMAGE_SEARCH_PRESET", settings.imageSearch.preset ?? "");
    setOrDelete(
      env,
      "SLIDESTUDIO_IMAGE_SEARCH_TEMPLATE",
      settings.imageSearch.template ? JSON.stringify(settings.imageSearch.template) : "",
    );
  }
  if (settings.imageGenerate.kind === "custom") {
    setOrDelete(env, "SLIDESTUDIO_IMAGE_BASE_URL", settings.imageGenerate.url);
    setOrDelete(env, "SLIDESTUDIO_IMAGE_API_KEY", settings.imageGenerate.apiKey);
    setOrDelete(env, "SLIDESTUDIO_IMAGE_MODEL", settings.imageGenerate.model);
    setOrDelete(env, "SLIDESTUDIO_IMAGE_PRESET", settings.imageGenerate.preset ?? "");
    setOrDelete(
      env,
      "SLIDESTUDIO_IMAGE_TEMPLATE",
      settings.imageGenerate.template ? JSON.stringify(settings.imageGenerate.template) : "",
    );
    env.SLIDESTUDIO_IMAGE = "1";
  }
  return env;
}

export function mergeToolSettingsEnv(
  env: NodeJS.ProcessEnv,
  settings: ToolSettings,
): NodeJS.ProcessEnv {
  return applyToolSettingsToEnv({ ...env }, settings);
}

export function loadToolSettingsIntoProcess(home: string, env: NodeJS.ProcessEnv = process.env): ToolSettings {
  const stored = readStoredToolSettings(home);
  if (!stored) return toolSettingsFromEnv(env);
  applyToolSettingsToEnv(env, stored);
  return stored;
}
