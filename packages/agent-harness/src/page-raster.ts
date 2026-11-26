/**
 * Native page raster: Playwright screenshot of editor #slide.
 * Not official iframe. Not exporter-native background-only PNG.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePlaywrightRuntime } from "@open-slidestudio/presentation-run";
import { mediaId } from "./media-store.js";
import {
  assessRenderedLayout,
  type PageLayoutDiagnostics,
  type RenderedLayoutSnapshot,
} from "./rendered-layout-assessment.js";

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

export {
  assessRenderedLayout,
  type PageLayoutDiagnostics,
  type RenderedLayoutIssue,
  type RenderedLayoutIssueKind,
  type RenderedLayoutNode,
  type RenderedLayoutSnapshot,
  type RenderedLayoutWarning,
  type RenderedLayoutWarningKind,
} from "./rendered-layout-assessment.js";

export type PageRasterPort = {
  available: boolean;
  render: (opts: { projectRoot: string; pageIndex: number }) => Promise<PageRasterResult>;
  close?: () => Promise<void>;
};

export type PageRasterPortOpts = {
  editorBaseUrl?: string;
  pinnedRuntimePath?: string;
  screenshot?: (opts: { editorBaseUrl: string; projectRoot: string; pageIndex: number }) => Promise<PageRasterShot>;
};

/**
 * Same resolution contract as packages/presentation-run domain/playwright-runtime
 * (env → repo .runtime → managed dir under the DSH data root → self-consistent
 * ~/.codex seed → machine discovery → managed pending path). Keep aligned.
 */
export function pinnedPlaywrightRuntimePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolvePlaywrightRuntime(env).path;
}

export function editorUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = env.SLIDESTUDIO_EDITOR_URL?.trim();
  return url ? url.replace(/\/+$/, "") : undefined;
}

export function savePageRaster(projectRoot: string, id: string, bytes: Buffer): { src: string; abs: string } {
  const dir = path.join(projectRoot, "_agent", "rasters");
  fs.mkdirSync(dir, { recursive: true });
  const name = `${mediaId(id)}.png`;
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, bytes);
  return { src: `_agent/rasters/${name}`, abs };
}

export function rasterToDataUrl(bytes: Buffer): string {
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

type RasterBrowser = {
  newPage: (opts: { viewport: { width: number; height: number } }) => Promise<RasterPage>;
  close: () => Promise<void>;
};

export type RasterPage = {
  goto: (url: string, opts: { waitUntil: "networkidle"; timeout: number }) => Promise<void>;
  waitForSelector: (sel: string, opts: { timeout: number }) => Promise<unknown>;
  addStyleTag: (opts: { content: string }) => Promise<unknown>;
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
  locator: (sel: string) => {
    screenshot: (opts: { type: "png" }) => Promise<Buffer>;
    boundingBox: () => Promise<{ width: number; height: number } | null>;
  };
  close: () => Promise<void>;
};

export async function readRenderedLayout(page: RasterPage): Promise<PageLayoutDiagnostics> {
  const snapshot = await page.evaluate<RenderedLayoutSnapshot>(async () => {
    const fonts = document.fonts;
    if (fonts) await fonts.ready;
    const slide = document.querySelector("#slide");
    if (!slide) {
      return { slideWidth: 0, slideHeight: 0, fontsReady: false, nodes: [] };
    }
    const slideRect = slide.getBoundingClientRect();
    const fontNodes = Array.from(slide.querySelectorAll(".el.text, .el.chart text, .el.table td, .el.table th"));
    const fontsReady =
      !fonts ||
      (fonts.status === "loaded" &&
        fontNodes.every((node) => fonts.check(`12px ${getComputedStyle(node).fontFamily}`)));
    type Rgba = { r: number; g: number; b: number; a: number };
    const parseColor = (value: string): Rgba | undefined => {
      const match = value.match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i);
      if (!match) return undefined;
      return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
        a: match[4] === undefined ? 1 : Number(match[4]),
      };
    };
    const linear = (channel: number): number => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: Rgba): number =>
      0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
    const contrast = (foreground: Rgba, background: Rgba): number => {
      const fg = luminance(foreground);
      const bg = luminance(background);
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    };
    const clampAlpha = (value: number): number => Math.max(0, Math.min(1, value));
    const composite = (top: Rgba, bottom: Rgba): Rgba => {
      const alpha = clampAlpha(top.a + bottom.a * (1 - top.a));
      if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / alpha,
        g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / alpha,
        b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / alpha,
        a: alpha,
      };
    };
    const colorCss = (color: Rgba): string =>
      `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${color.a.toFixed(3)})`;
    const opacityThrough = (element: Element): number => {
      let opacity = 1;
      let current: Element | null = element;
      while (current) {
        const value = Number.parseFloat(getComputedStyle(current).opacity);
        if (Number.isFinite(value)) opacity *= clampAlpha(value);
        if (current === slide) break;
        current = current.parentElement;
      }
      return clampAlpha(opacity);
    };
    type SolidPaint = {
      kind: "solid";
      element: Element;
      rawColor: Rgba;
      opacity: number;
      color: Rgba;
      css: string;
      source: string;
    };
    type ResolvedPaint = {
      kind: "resolved";
      color: Rgba;
      css: string;
      source: string;
      layers: SolidPaint[];
      textGroup?: {
        rawBackground: Rgba;
        under: Rgba;
        commonOpacity: number;
        foregroundOnlyOpacity: number;
      };
    };
    type UnresolvedPaint = { kind: "unresolved"; source: string };
    const paintOnElement = (element: Element): SolidPaint | UnresolvedPaint | undefined => {
      const computed = getComputedStyle(element);
      const tag = element.tagName.toLowerCase();
      const imageElement =
        element instanceof HTMLImageElement ||
        element instanceof HTMLCanvasElement ||
        element instanceof HTMLVideoElement ||
        tag === "image";
      if (imageElement) return { kind: "unresolved", source: `${tag}:image` };
      if (computed.backgroundImage && computed.backgroundImage !== "none") {
        return { kind: "unresolved", source: `${tag}:background-image` };
      }
      const opacity = opacityThrough(element);
      const background = parseColor(computed.backgroundColor);
      if (background && background.a > 0) {
        const color = { ...background, a: clampAlpha(background.a * opacity) };
        return {
          kind: "solid",
          element,
          rawColor: background,
          opacity,
          color,
          css: computed.backgroundColor,
          source: `${tag}:background`,
        };
      }
      if (typeof SVGGeometryElement !== "undefined" && element instanceof SVGGeometryElement) {
        const fillCss = computed.fill.trim();
        if (/^url\(/i.test(fillCss)) {
          return { kind: "unresolved", source: `${tag}:fill-image` };
        }
        const fill = parseColor(fillCss);
        if (fill && fill.a > 0) {
          const color = { ...fill, a: clampAlpha(fill.a * opacity) };
          return {
            kind: "solid",
            element,
            rawColor: fill,
            opacity,
            color,
            css: fillCss,
            source: `${tag}:fill`,
          };
        }
      }
      return undefined;
    };
    const resolveSolidLayers = (layers: readonly SolidPaint[]): Rgba | undefined => {
      const opaqueIndex = layers.findIndex((layer) => layer.color.a >= 0.999);
      if (opaqueIndex < 0) return undefined;
      let resolved = { ...layers[opaqueIndex]!.color, a: 1 };
      for (let index = opaqueIndex - 1; index >= 0; index -= 1) {
        resolved = composite(layers[index]!.color, resolved);
      }
      return resolved;
    };
    const resolvePaintStack = (candidates: readonly Element[]): ResolvedPaint | UnresolvedPaint | undefined => {
      const layers: SolidPaint[] = [];
      for (const candidate of candidates) {
        const paint = paintOnElement(candidate);
        if (!paint) continue;
        if (paint.kind === "unresolved") return paint;
        layers.push(paint);
        if (paint.color.a < 0.999) continue;
        const resolved = resolveSolidLayers(layers);
        if (!resolved) return undefined;
        return {
          kind: "resolved",
          color: resolved,
          css: colorCss(resolved),
          source: layers.map((layer) => layer.source).join(" + "),
          layers,
        };
      }
      return undefined;
    };
    const backgroundAt = (
      textRoot: HTMLElement,
      runElement: Element,
      x: number,
      y: number,
    ): ResolvedPaint | UnresolvedPaint | undefined => {
      const svgRun = runElement.namespaceURI === "http://www.w3.org/2000/svg";
      const ownLayers: Element[] = [];
      // SVG text fill is foreground, never its own background. Keep the rest
      // of the chart visible so a label over a bar samples that bar's fill.
      let current: Element | null = svgRun ? runElement.parentElement : runElement;
      while (current && textRoot.contains(current)) {
        ownLayers.push(current);
        if (current === textRoot) break;
        current = current.parentElement;
      }
      const hiddenTarget = svgRun ? runElement : textRoot;
      const styledTarget = hiddenTarget as HTMLElement | SVGElement;
      const priorVisibility = styledTarget.style.visibility;
      styledTarget.style.visibility = "hidden";
      try {
        const underLayers = document
          .elementsFromPoint(x, y)
          .filter((candidate) => candidate !== hiddenTarget && !hiddenTarget.contains(candidate));
        const resolved = resolvePaintStack([...ownLayers, ...underLayers]);
        if (!resolved || resolved.kind === "unresolved") return resolved;
        const sharedIndex = resolved.layers.findIndex(
          (layer, index) =>
            index < ownLayers.length && (layer.element === runElement || layer.element.contains(runElement)),
        );
        if (sharedIndex < 0) return resolved;
        const shared = resolved.layers[sharedIndex]!;
        const under = resolveSolidLayers(resolved.layers.slice(sharedIndex + 1));
        if (!under && (shared.opacity < 0.999 || shared.rawColor.a < 0.999)) {
          return { kind: "unresolved", source: `${shared.source}:opacity-backdrop` };
        }
        return {
          ...resolved,
          textGroup: {
            rawBackground: shared.rawColor,
            under: under ?? resolved.color,
            commonOpacity: shared.opacity,
            foregroundOnlyOpacity: shared.opacity > 0 ? clampAlpha(opacityThrough(runElement) / shared.opacity) : 0,
          },
        };
      } finally {
        styledTarget.style.visibility = priorVisibility;
      }
    };
    function sampleTextRun(node: HTMLElement, textRun: Text) {
      let unresolved: string | undefined;
      let worst:
        | {
            ratio: number;
            required: number;
            foreground: string;
            background: string;
            source: string;
          }
        | undefined;

      const run: Element = textRun.parentElement ?? node;
      const computed = getComputedStyle(run);
      const foregroundCss = run.namespaceURI === "http://www.w3.org/2000/svg" ? computed.fill : computed.color;
      const range = document.createRange();
      range.selectNodeContents(textRun);
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0.5 && rect.height > 0.5);
      if (rects.length === 0) return { unresolved, worst };
      if (/^url\(/i.test(foregroundCss)) {
        unresolved ??= `${run.tagName.toLowerCase()}:foreground-image`;
        return { unresolved, worst };
      }
      const foreground = parseColor(foregroundCss);
      if (!foreground) {
        unresolved ??= `${run.tagName.toLowerCase()}:foreground-${foregroundCss || "unknown"}`;
        return { unresolved, worst };
      }
      const fontSize = Number.parseFloat(computed.fontSize) || 0;
      const parsedWeight = Number.parseInt(computed.fontWeight, 10);
      const fontWeight = Number.isFinite(parsedWeight) ? parsedWeight : computed.fontWeight === "bold" ? 700 : 400;
      const required = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700) ? 3 : 4.5;
      for (const runRect of rects) {
        const points: Array<[number, number]> = [
          [runRect.left + runRect.width * 0.5, runRect.top + runRect.height * 0.5],
          [runRect.left + Math.min(runRect.width * 0.2, 8), runRect.top + runRect.height * 0.5],
        ];
        for (const [x, y] of points) {
          const background = backgroundAt(node, run, x, y);
          if (!background) return { unresolved, worst };
          if (background.kind === "unresolved") {
            unresolved ??= background.source;
            return { unresolved, worst };
          }
          let visibleBackground = background.color;
          let visibleForeground: Rgba;
          if (background.textGroup) {
            const localTextPixel = composite(
              {
                ...foreground,
                a: clampAlpha(foreground.a * background.textGroup.foregroundOnlyOpacity),
              },
              background.textGroup.rawBackground,
            );
            visibleBackground = composite(
              {
                ...background.textGroup.rawBackground,
                a: clampAlpha(background.textGroup.rawBackground.a * background.textGroup.commonOpacity),
              },
              { ...background.textGroup.under, a: 1 },
            );
            visibleForeground = composite(
              {
                ...localTextPixel,
                a: clampAlpha(localTextPixel.a * background.textGroup.commonOpacity),
              },
              { ...background.textGroup.under, a: 1 },
            );
          } else {
            visibleForeground = composite(
              { ...foreground, a: clampAlpha(foreground.a * opacityThrough(run)) },
              { ...background.color, a: 1 },
            );
          }
          const ratio = contrast(visibleForeground, visibleBackground);
          if (!worst || ratio - required < worst.ratio - worst.required) {
            worst = {
              ratio,
              required,
              foreground: colorCss(visibleForeground),
              background: colorCss(visibleBackground),
              source: background.source,
            };
          }
        }
      }
      return { unresolved, worst };
    }

    function renderedNodeContrast(node: HTMLElement) {
      const hasContrastText =
        node.classList.contains("text") || node.classList.contains("chart") || node.classList.contains("table");
      let worstContrast:
        | {
            ratio: number;
            required: number;
            foreground: string;
            background: string;
            source: string;
          }
        | undefined;
      let contrastUnresolvedSource: string | undefined;
      if (hasContrastText && (node.textContent ?? "").trim()) {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const textRuns: Text[] = [];
        let next = walker.nextNode();
        while (next) {
          if (next instanceof Text && (next.textContent ?? "").trim()) textRuns.push(next);
          next = walker.nextNode();
        }
        for (const textRun of textRuns) {
          const sample = sampleTextRun(node, textRun);
          if (sample.unresolved) contrastUnresolvedSource ??= sample.unresolved;
          if (
            sample.worst &&
            (!worstContrast ||
              sample.worst.ratio - sample.worst.required < worstContrast.ratio - worstContrast.required)
          ) {
            worstContrast = sample.worst;
          }
        }
      }
      return { worstContrast, contrastUnresolvedSource };
    }

    function renderedNodeSnapshot(node: HTMLElement) {
      const rect = node.getBoundingClientRect();
      const isText = node.classList.contains("text");
      const slideScale = slideRect.width > 0 ? slideRect.width / 960 : 1;
      const isHorizontalRule =
        node.classList.contains("shape") && rect.width >= 16 * slideScale && rect.height <= 4 * slideScale;
      const { worstContrast, contrastUnresolvedSource } = renderedNodeContrast(node);
      return {
        id: node.dataset.id || "unknown",
        type: isText ? "text" : isHorizontalRule ? "rule" : "element",
        layoutRole: (["footer", "content", "decoration"] as const).includes(
          node.dataset.layoutRole as "footer" | "content" | "decoration",
        )
          ? (node.dataset.layoutRole as "footer" | "content" | "decoration")
          : undefined,
        inherited: node.hasAttribute("data-inherited"),
        left: rect.left - slideRect.left,
        top: rect.top - slideRect.top,
        right: rect.right - slideRect.left,
        bottom: rect.bottom - slideRect.top,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        textColor: worstContrast?.foreground,
        backgroundColor: worstContrast?.background,
        backgroundSource: worstContrast?.source,
        contrastRatio: worstContrast?.ratio,
        requiredContrast: worstContrast?.required,
        contrastUnresolvedSource,
      };
    }

    return {
      slideWidth: slideRect.width,
      slideHeight: slideRect.height,
      fontsReady,
      nodes: Array.from(slide.querySelectorAll<HTMLElement>(".el")).map((node) => renderedNodeSnapshot(node)),
    };
  });
  return assessRenderedLayout(snapshot);
}

async function shotWithReuse(opts: {
  editorBaseUrl: string;
  projectRoot: string;
  pageIndex: number;
  getBrowser: () => Promise<RasterBrowser>;
}): Promise<PageRasterShot> {
  const browser = await opts.getBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    const url = `${opts.editorBaseUrl}/index.html?project=${encodeURIComponent(opts.projectRoot)}&page=${opts.pageIndex}&workspace=0&render=1`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForSelector("#slide .el", { timeout: 20_000 });
    await page.addStyleTag({
      content: ".insert-pill,.pill-handle,.notes-link,.annot-tip,.more-menu,.ctx-bar{visibility:hidden!important}",
    });
    const slide = page.locator("#slide");
    const layout = await readRenderedLayout(page);
    const buf = await slide.screenshot({ type: "png" });
    const box = await slide.boundingBox();
    return {
      bytes: Buffer.from(buf),
      width: Math.round(box?.width ?? 960),
      height: Math.round(box?.height ?? 540),
      layout,
    };
  } finally {
    await page.close();
  }
}

async function launchBrowser(runtimeFile: string): Promise<RasterBrowser> {
  if (!fs.existsSync(runtimeFile)) {
    throw new Error(`Pinned Playwright runtime is missing: ${runtimeFile}`);
  }
  const runtime = (await import(pathToFileURL(runtimeFile).href)) as {
    verifyPinnedRuntime?: () => unknown;
    launchPinnedChromium?: (opts?: { headless?: boolean }) => Promise<unknown>;
  };
  if (typeof runtime.verifyPinnedRuntime !== "function" || typeof runtime.launchPinnedChromium !== "function") {
    throw new Error(`Pinned Playwright runtime API mismatch: ${runtimeFile}`);
  }
  runtime.verifyPinnedRuntime();
  return (await runtime.launchPinnedChromium({ headless: true })) as RasterBrowser;
}

export function createPageRasterPort(opts: PageRasterPortOpts = {}): PageRasterPort {
  const editorBaseUrl = (opts.editorBaseUrl ?? editorUrlFromEnv())?.replace(/\/+$/, "");
  const runtimeFile = opts.pinnedRuntimePath ?? pinnedPlaywrightRuntimePath();
  const available = Boolean(opts.screenshot || editorBaseUrl);
  let browser: RasterBrowser | undefined;
  return {
    available,
    async close() {
      if (!browser) return;
      const b = browser;
      browser = undefined;
      await b.close().catch(() => undefined);
    },
    async render({ projectRoot, pageIndex }) {
      if (!available || (!editorBaseUrl && !opts.screenshot)) {
        return {
          width: 960,
          height: 540,
          kind: "unavailable",
          note: "page raster unavailable — no editor URL and no Playwright shot. You did not see the slide.",
        };
      }
      const root = path.resolve(projectRoot);
      if (!fs.existsSync(path.join(root, "deck.pptd"))) {
        return {
          width: 960,
          height: 540,
          kind: "unavailable",
          note: "page raster unavailable — project has no deck.pptd yet. write_page must persist first.",
        };
      }
      try {
        const shot = opts.screenshot
          ? await opts.screenshot({
              editorBaseUrl: editorBaseUrl ?? "injected",
              projectRoot: root,
              pageIndex,
            })
          : await shotWithReuse({
              editorBaseUrl: editorBaseUrl as string,
              projectRoot: root,
              pageIndex,
              getBrowser: async () => {
                if (!browser) browser = await launchBrowser(runtimeFile);
                return browser;
              },
            });
        if (!shot.bytes || shot.bytes.length < 64) {
          return {
            width: 960,
            height: 540,
            kind: "unavailable",
            note: "page raster returned empty PNG — you did not see the slide.",
          };
        }
        return {
          bytes: shot.bytes,
          width: shot.width,
          height: shot.height,
          kind: "native-slide",
          note: "native #slide screenshot — not official iframe, not background-only exportPageToPng",
          layout: shot.layout,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/Pinned Playwright|Pinned Chromium/i.test(msg)) throw e;
        return {
          width: 960,
          height: 540,
          kind: "unavailable",
          note: `page raster failed (${msg.slice(0, 180)}). You did not see the slide.`,
        };
      }
    },
  };
}
