import { type EndpointTemplate } from "@open-slidestudio/presentation-run";
export type ToolEndpoint = {
    readonly kind: "off";
} | {
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
export type ToolEndpointView = {
    readonly kind: "off";
} | {
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
export declare function emptyToolSettings(): ToolSettings;
export declare function parseToolSettingsPatch(value: unknown, previous: ToolSettings): ToolSettings;
export declare function toolSettingsFromEnv(env: NodeJS.ProcessEnv): ToolSettings;
export declare function toolSettingsFile(home: string): string;
export declare function readStoredToolSettings(home: string): ToolSettings | undefined;
export declare function readToolSettings(home: string, env?: NodeJS.ProcessEnv): ToolSettings;
export declare function writeToolSettings(home: string, settings: ToolSettings): void;
export declare function toToolSettingsView(settings: ToolSettings): ToolSettingsView;
export declare function applyToolSettingsToEnv(env: NodeJS.ProcessEnv, settings: ToolSettings): NodeJS.ProcessEnv;
export declare function mergeToolSettingsEnv(env: NodeJS.ProcessEnv, settings: ToolSettings): NodeJS.ProcessEnv;
export declare function loadToolSettingsIntoProcess(home: string, env?: NodeJS.ProcessEnv): ToolSettings;
//# sourceMappingURL=tool-settings.d.ts.map