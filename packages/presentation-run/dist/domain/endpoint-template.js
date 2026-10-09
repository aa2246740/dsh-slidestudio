export function templateVars(vars) {
    const out = {};
    for (const [k, v] of Object.entries(vars))
        out[k] = v ?? "";
    return out;
}
export function interpolate(tpl, vars) {
    return tpl.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, name) => vars[name] ?? "");
}
/** Dotted path with numeric segments, e.g. jsonPath(obj, "output.results.0.url"). */
export function jsonPath(obj, path) {
    let cur = obj;
    for (const seg of path.split(".").filter(Boolean)) {
        if (Array.isArray(cur)) {
            const i = Number(seg);
            cur = Number.isInteger(i) ? cur[i] : undefined;
        }
        else if (cur && typeof cur === "object") {
            cur = cur[seg];
        }
        else {
            return undefined;
        }
    }
    return cur;
}
export function buildTemplateRequest(tmpl, vars) {
    const url = interpolate(tmpl.url ?? "", vars);
    if (!/^https?:\/\//i.test(url))
        throw new Error("template url must be an http(s) URL");
    const headers = {};
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
//# sourceMappingURL=endpoint-template.js.map