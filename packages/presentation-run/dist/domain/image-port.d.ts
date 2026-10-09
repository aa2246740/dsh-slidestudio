import { type EndpointTemplate } from "./endpoint-template.js";
export type ImageKind = "generated";
export type GeneratedImage = {
    bytes: Buffer;
    mime: "image/png" | "image/jpeg";
    width: number;
    height: number;
    kind: ImageKind;
    note: string;
};
export type ImageGeneratePreset = "openai" | "dashscope-sync" | "dashscope-task" | "gemini-imagen" | "stability" | "template";
export declare const IMAGE_GENERATE_PRESETS: readonly ImageGeneratePreset[];
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
export declare const GROK_IMAGINE_MODEL: "grok-imagine-image-2.0";
export declare function imageConfigFromEnv(env?: NodeJS.ProcessEnv): ImagePortConfig;
/** Signed-in Grok: always the xAI imagine endpoint. Missing token fails at generate. */
export declare function grokImageConfigFromEnv(env?: NodeJS.ProcessEnv): ImagePortConfig;
export declare function imageConfigured(cfg?: ImagePortConfig): boolean;
/** Map a planned photo frame to the nearest API aspect. 258×344 → 3:4, not 16:9. */
export declare function aspectFromSlot(width: number, height: number): string;
export declare function pngSizeFromBytes(bytes: Buffer): {
    width: number;
    height: number;
} | undefined;
export declare function createImagePort(cfg?: ImagePortConfig, deps?: ImagePortDeps): ImagePort;
//# sourceMappingURL=image-port.d.ts.map