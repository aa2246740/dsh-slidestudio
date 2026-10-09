/**
 * Generic "custom template" endpoint engine shared by the image ports.
 * Lets a settings user describe an arbitrary sync JSON HTTP API without
 * product code: `{{var}}` interpolation in url/headers/body plus a dotted
 * path to the image URL/base64 in the response.
 *
 * Only plain request/response APIs are covered — signed auth, async
 * task polling and multipart bodies stay named presets.
 */
export type EndpointTemplate = {
  /** Request URL, may contain {{vars}}. */
  url?: string;
  /** HTTP method; default POST when body is set, GET otherwise. */
  method?: string;
  /** Header map; values may contain {{vars}} (use {{key}} for apiKey). */
  headers?: Record<string, string>;
  /** JSON request body template; {{vars}} interpolate as strings. */
  body?: string;
  /** Dotted path to the image URL or base64 in the JSON response,
   *  e.g. "data.0.url" or "output.choices.0.message.content.0.image". */
  imagePath?: string;
  /** Fixed attribution label for search hits (stock APIs require one). */
  attribution?: string;
};

export function templateVars(
  vars: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) out[k] = v ?? "";
  return out;
}

export function interpolate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, name: string) => vars[name] ?? "");
}

/** Dotted path with numeric segments, e.g. jsonPath(obj, "output.results.0.url"). */
export function jsonPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const seg of path.split(".").filter(Boolean)) {
    if (Array.isArray(cur)) {
      const i = Number(seg);
      cur = Number.isInteger(i) ? cur[i] : undefined;
    } else if (cur && typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function buildTemplateRequest(
  tmpl: EndpointTemplate,
  vars: Record<string, string>,
): { url: string; init: RequestInit } {
  const url = interpolate(tmpl.url ?? "", vars);
  if (!/^https?:\/\//i.test(url)) throw new Error("template url must be an http(s) URL");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(tmpl.headers ?? {})) {
    headers[k] = interpolate(v, vars);
  }
  const body = tmpl.body ? interpolate(tmpl.body, vars) : undefined;
  const method = (tmpl.method || (body ? "POST" : "GET")).toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return { url, init: { method, headers } };
  }
  if (body && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json";
  }
  return { url, init: { method, headers, body } };
}
