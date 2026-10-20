import { t } from "./i18n.js";

/**
 * @typedef {{method?: string, headers?: Record<string, unknown>, body?: string, imagePath?: string, attribution?: string}} ToolEndpointTemplate
 */

/**
 * @typedef {{kind?: string, preset?: string, url?: string, apiKeySet?: boolean, model?: string, template?: ToolEndpointTemplate}} ToolEndpoint
 */

/** @param {string} id */
function settingsInput(id) {
  return /** @type {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null} */ (document.getElementById(id));
}

/** @param {string} prefix */
export function toggleTplBlock(prefix) {
  const block = settingsInput(`${prefix}-tpl`);
  if (!block) return;
  block.hidden = settingsInput(`${prefix}-preset`)?.value !== "template";
}

/** @param {string} prefix @param {ToolEndpoint | null | undefined} endpoint */
function fillEndpointBasics(prefix, endpoint) {
  const on = endpoint?.kind === "custom";
  const url = settingsInput(`${prefix}-url`);
  const key = /** @type {HTMLInputElement | null} */ (settingsInput(`${prefix}-key`));
  const model = settingsInput(`${prefix}-model`);
  const preset = /** @type {HTMLSelectElement | null} */ (settingsInput(`${prefix}-preset`));
  if (preset) preset.value = (on && endpoint.preset) || preset.options[0]?.value || "";
  if (url) url.value = on ? endpoint.url || "" : "";
  if (key) {
    key.value = "";
    key.placeholder = on && endpoint.apiKeySet ? t("已保存，留空则保持") : t("可选");
  }
  if (model) model.value = on ? endpoint.model || "" : "";
}

/** @param {string} prefix @param {ToolEndpointTemplate | undefined} tmpl */
function fillEndpointTemplate(prefix, tmpl = {}) {
  const tplMethod = settingsInput(`${prefix}-tpl-method`);
  const tplHeaders = settingsInput(`${prefix}-tpl-headers`);
  const tplBody = settingsInput(`${prefix}-tpl-body`);
  const tplPath = settingsInput(`${prefix}-tpl-path`);
  const tplAttr = settingsInput(`${prefix}-tpl-attr`);
  if (tplMethod) tplMethod.value = tmpl.method || "";
  if (tplHeaders) tplHeaders.value = tmpl.headers ? JSON.stringify(tmpl.headers) : "";
  if (tplBody) tplBody.value = tmpl.body || "";
  if (tplPath) tplPath.value = tmpl.imagePath || "";
  if (tplAttr) tplAttr.value = tmpl.attribution || "";
}

/** @param {string} prefix @param {ToolEndpoint | null | undefined} endpoint */
export function fillEndpoint(prefix, endpoint) {
  fillEndpointBasics(prefix, endpoint);
  fillEndpointTemplate(prefix, endpoint?.kind === "custom" ? endpoint.template : undefined);
  toggleTplBlock(prefix);
}

/** @param {string} prefix */
export function collectEndpoint(prefix) {
  const url = String(settingsInput(`${prefix}-url`)?.value || "").trim();
  if (!url) return { kind: "off" };
  const modelEl = settingsInput(`${prefix}-model`);
  const preset = String(settingsInput(`${prefix}-preset`)?.value || "").trim();
  /** @type {{kind: "custom", url: string, apiKey: string, model: string, preset: string | undefined, template?: ToolEndpointTemplate}} */
  const out = {
    kind: "custom",
    url,
    apiKey: String(settingsInput(`${prefix}-key`)?.value || ""),
    model: String(modelEl?.value || "").trim(),
    preset: preset || undefined,
  };
  if (preset === "template") {
    const headersRaw = String(settingsInput(`${prefix}-tpl-headers`)?.value || "").trim();
    let headers;
    if (headersRaw) {
      try {
        headers = JSON.parse(headersRaw);
      } catch {
        throw new Error(t("请求头不是合法 JSON"));
      }
    }
    out.template = {
      method: String(settingsInput(`${prefix}-tpl-method`)?.value || "").trim() || undefined,
      headers,
      body: String(settingsInput(`${prefix}-tpl-body`)?.value || "").trim() || undefined,
      imagePath: String(settingsInput(`${prefix}-tpl-path`)?.value || "").trim() || undefined,
      attribution: String(settingsInput(`${prefix}-tpl-attr`)?.value || "").trim() || undefined,
    };
  }
  return out;
}
