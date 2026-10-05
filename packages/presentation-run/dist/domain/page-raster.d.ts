import { repoPlaywrightRuntimeFile, type PlaywrightRuntimeRoots } from "./playwright-runtime.js";
export type PageRasterKind = "native-slide" | "unavailable";
export type PageRasterResult = {
    bytes?: Buffer;
    width: number;
    height: number;
    kind: PageRasterKind;
    note: string;
    layout?: PageLayoutDiagnostics;
};
export type PageRasterShot = {
    bytes: Buffer;
    width: number;
    height: number;
    layout?: PageLayoutDiagnostics;
};
export declare function projectHasPptd(root: string): boolean;
export type RenderedLayoutIssueKind = "text-overflow-x" | "text-overflow-y" | "text-contrast" | "text-contrast-unresolved" | "text-collision" | "line-text-intersection" | "line-text-clearance" | "element-outside-slide" | "non-footer-text-in-footer-zone" | "footer-outside-footer-zone" | "font-not-ready";
export type RenderedLayoutWarningKind = "text-collision";
export type RenderedLayoutIssue = {
    kind: RenderedLayoutIssueKind;
    elementId?: string;
    detail: string;
};
export type RenderedLayoutWarning = {
    kind: RenderedLayoutWarningKind;
    elementIds: [string, string];
    detail: string;
};
export type RenderedLayoutNode = {
    id: string;
    type: string;
    layoutRole?: "footer" | "content" | "decoration";
    left: number;
    top: number;
    right: number;
    bottom: number;
    scrollWidth: number;
    clientWidth: number;
    scrollHeight: number;
    clientHeight: number;
    textColor?: string;
    backgroundColor?: string;
    backgroundSource?: string;
    contrastRatio?: number;
    requiredContrast?: number;
    contrastUnresolvedSource?: string;
};
export type RenderedLayoutSnapshot = {
    slideWidth: number;
    slideHeight: number;
    fontsReady: boolean;
    nodes: RenderedLayoutNode[];
};
export type PageLayoutDiagnostics = {
    checked: true;
    fontsReady: boolean;
    footerZoneTop: number;
    hardIssues: RenderedLayoutIssue[];
    warnings: RenderedLayoutWarning[];
    ok: boolean;
};
export type PageRasterPort = {
    available: boolean;
    render: (opts: {
        projectRoot: string;
        pageIndex: number;
    }) => Promise<PageRasterResult>;
    close?: () => Promise<void>;
};
export type PageRasterPortOpts = {
    editorBaseUrl?: string;
    pinnedRuntimePath?: string;
    nativeSlideSize?: boolean;
    screenshot?: (opts: {
        editorBaseUrl: string;
        projectRoot: string;
        pageIndex: number;
    }) => Promise<PageRasterShot>;
};
export type { PlaywrightRuntimeRoots } from "./playwright-runtime.js";
export { repoPlaywrightRuntimeFile };
/** Remove editor fit-to-viewport scaling inside the isolated raster page. */
export declare function normalizeRasterPageToNativeSlideSize(page: RasterPage): Promise<void>;
/**
 * Lookup order: SLIDESTUDIO_PLAYWRIGHT_RUNTIME (exclusive if set),
 * <repo>/.runtime/playwright/runtime.mjs, the managed
 * <stateDir>/playwright-runtime/runtime.mjs, a self-consistent
 * ~/.codex/playwright-runtime/runtime.mjs, then a machine-discovered
 * playwright materialized into the managed dir. Missing runtimes resolve to
 * the managed path so Hub can provision it (see provisionManagedRuntime).
 */
export declare function pinnedPlaywrightRuntimePath(env?: NodeJS.ProcessEnv, roots?: PlaywrightRuntimeRoots): string;
/** True only when the pinned runtime file exists and exports the launch API. Does not launch Chromium. */
export declare function rasterRuntimeReady(env?: NodeJS.ProcessEnv, runtimeFile?: string): boolean;
export declare function editorUrlFromEnv(env?: NodeJS.ProcessEnv): string | undefined;
export declare function pageRasterRel(id: string): string;
export declare function savePageRaster(projectRoot: string, id: string, bytes: Buffer): {
    src: string;
    abs: string;
};
/** Bytes grok-4.6 can see. Missing or tiny files are not a raster. */
export declare function readPageRaster(projectRoot: string, pageId: string): Buffer | undefined;
export declare function rasterToDataUrl(bytes: Buffer): string;
export type RasterPage = {
    setExtraHTTPHeaders: (headers: Record<string, string>) => Promise<void>;
    goto: (url: string, opts: {
        waitUntil: "networkidle";
        timeout: number;
    }) => Promise<void>;
    waitForSelector: (sel: string, opts: {
        timeout: number;
    }) => Promise<unknown>;
    addStyleTag: (opts: {
        content: string;
    }) => Promise<unknown>;
    evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
    locator: (sel: string) => {
        screenshot: (opts: {
            type: "png";
        }) => Promise<Buffer>;
        boundingBox: () => Promise<{
            width: number;
            height: number;
        } | null>;
    };
    close: () => Promise<void>;
};
/**
 * Classify high-confidence layout faults from one rendered DOM snapshot.
 * This compares text with text, not labels with their diagram shapes, so a
 * material overlap is a real compose blocker. Sub-pixel contact stays a
 * warning to avoid renderer-noise failures.
 */
export declare function assessRenderedLayout(snapshot: RenderedLayoutSnapshot): PageLayoutDiagnostics;
export declare function readRenderedLayout(page: RasterPage): Promise<PageLayoutDiagnostics>;
export declare function createPageRasterPort(opts?: PageRasterPortOpts): PageRasterPort;
//# sourceMappingURL=page-raster.d.ts.map