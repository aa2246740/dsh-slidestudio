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
export declare function templateVars(vars: Record<string, string | undefined>): Record<string, string>;
export declare function interpolate(tpl: string, vars: Record<string, string>): string;
/** Dotted path with numeric segments, e.g. jsonPath(obj, "output.results.0.url"). */
export declare function jsonPath(obj: unknown, path: string): unknown;
export declare function buildTemplateRequest(tmpl: EndpointTemplate, vars: Record<string, string>): {
    url: string;
    init: RequestInit;
};
//# sourceMappingURL=endpoint-template.d.ts.map