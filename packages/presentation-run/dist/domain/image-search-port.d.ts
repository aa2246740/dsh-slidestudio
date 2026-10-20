/**
 * Pluggable image search. No vendor hardcode.
 * `generic` preset: POST { query } → { images: [{ url | b64_json, width,
 * height, attribution }] }. Named presets cover mainstream stock/photo
 * APIs (Pixabay, Pexels, Unsplash, Bing); `template` maps any sync JSON
 * API via {{query}} interpolation + a dotted response path.
 */
import { type EndpointTemplate } from "./endpoint-template.js";
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
export type ImageSearchPreset = "generic" | "pixabay" | "pexels" | "unsplash" | "bing" | "template";
export declare const IMAGE_SEARCH_PRESETS: readonly ImageSearchPreset[];
export type ImageSearchPortConfig = {
    url?: string;
    apiKey?: string;
    timeoutMs?: number;
    /** Wire format; empty/unknown falls back to "generic". */
    preset?: string;
    /** {{query}} request template; only used when preset === "template". */
    template?: EndpointTemplate;
};
export type ImageSearchPort = {
    search: (query: string) => Promise<ImageSearchHit | ImageSearchNone>;
};
export type ImageSearchPortDeps = {
    fetch?: typeof fetch;
};
export declare function imageSearchConfigFromEnv(env?: NodeJS.ProcessEnv): ImageSearchPortConfig;
export declare function imageSearchConfigured(cfg?: ImageSearchPortConfig): boolean;
export declare function createImageSearchPort(cfg?: ImageSearchPortConfig, deps?: ImageSearchPortDeps): ImageSearchPort;
//# sourceMappingURL=image-search-port.d.ts.map