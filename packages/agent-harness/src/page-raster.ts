/**
 * Native page raster: Playwright screenshot of editor #slide.
 * Not official iframe. Not exporter-native background-only PNG.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mediaId } from "./media-store.js";
import { footerZoneTopForSlide } from "@open-slidestudio/pptd-v2";
import { resolvePlaywrightRuntime } from "@open-slidestudio/presentation-run";

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

export type RenderedLayoutIssueKind =
  | "text-overflow-x"
  | "text-overflow-y"
  | "text-contrast"
  | "text-contrast-unresolved"
  | "text-collision"
  | "line-text-intersection"
  | "line-text-clearance"
  | "element-outside-slide"
  | "non-footer-text-in-footer-zone"
  | "footer-outside-footer-zone"
  | "font-not-ready";

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
  screenshot?: (opts: {
    editorBaseUrl: string;
    projectRoot: string;
    pageIndex: number;
  }) => Promise<PageRasterShot>;
};

/**
 * Same resolution contract as packages/presentation-run domain/playwright-runtime
 * (env → repo .runtime → managed dir under the DSH data root → self-consistent
 * ~/.codex seed → machine discovery → managed pending path). Keep aligned.
 */
export function pinnedPlaywrightRuntimePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolvePlaywrightRuntime(env).path;
}

export function editorUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const url = env.SLIDESTUDIO_EDITOR_URL?.trim();
  return url ? url.replace(/\/+$/, "") : undefined;
}

export function savePageRaster(
  projectRoot: string,
  id: string,
  bytes: Buffer,
): { src: string; abs: string } {
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

/**
 * Classify high-confidence layout faults from one rendered DOM snapshot.
 * This compares text with text, not labels with their diagram shapes, so a
 * material overlap is a real compose blocker. Sub-pixel contact stays a
 * warning to avoid renderer-noise failures.
 */
export function assessRenderedLayout(snapshot: RenderedLayoutSnapshot): PageLayoutDiagnostics {
  const footerZoneTop = footerZoneTopForSlide(snapshot.slideHeight);
  const hardIssues: RenderedLayoutIssue[] = [];
  const warnings: RenderedLayoutWarning[] = [];
  const epsilon = 0.5;

  if (!snapshot.fontsReady) {
    hardIssues.push({
      kind: "font-not-ready",
      detail: "document fonts were not ready; rendered text measurements are not trustworthy",
    });
  }

  for (const node of snapshot.nodes) {
    if (node.left < -epsilon || node.top < -epsilon ||
      node.right > snapshot.slideWidth + epsilon || node.bottom > snapshot.slideHeight + epsilon) {
      hardIssues.push({
        kind: "element-outside-slide",
        elementId: node.id,
        detail: `rendered bounds ${node.left.toFixed(1)},${node.top.toFixed(1)}–${node.right.toFixed(1)},${node.bottom.toFixed(1)} exceed ${snapshot.slideWidth}×${snapshot.slideHeight}`,
      });
    }
    if (node.contrastUnresolvedSource) {
      hardIssues.push({
        kind: "text-contrast-unresolved",
        elementId: node.id,
        detail: `contrast could not be measured against ${node.contrastUnresolvedSource}; strict compose requires a deterministic contrast result`,
      });
    } else if (
      node.contrastRatio !== undefined &&
      node.requiredContrast !== undefined &&
      node.contrastRatio + 0.01 < node.requiredContrast
    ) {
      hardIssues.push({
        kind: "text-contrast",
        elementId: node.id,
        detail: `contrast ${node.contrastRatio.toFixed(2)} is below ${node.requiredContrast.toFixed(2)} (${node.textColor ?? "unknown"} on ${node.backgroundColor ?? "unknown"}${node.backgroundSource ? ` via ${node.backgroundSource}` : ""})`,
      });
    }
    if (node.type !== "text") continue;
    if (node.scrollWidth > node.clientWidth + epsilon) {
      hardIssues.push({
        kind: "text-overflow-x",
        elementId: node.id,
        detail: `scrollWidth ${node.scrollWidth} exceeds clientWidth ${node.clientWidth}`,
      });
    }
    if (node.scrollHeight > node.clientHeight + epsilon) {
      hardIssues.push({
        kind: "text-overflow-y",
        elementId: node.id,
        detail: `scrollHeight ${node.scrollHeight} exceeds clientHeight ${node.clientHeight}`,
      });
    }
    if (node.layoutRole === "footer" && node.top < footerZoneTop - epsilon) {
      hardIssues.push({
        kind: "footer-outside-footer-zone",
        elementId: node.id,
        detail: `footer begins at ${node.top.toFixed(1)} above the footer reserve starting at ${footerZoneTop.toFixed(1)}; move the whole footer into the reserve`,
      });
    } else if (node.layoutRole !== "footer" && node.bottom > footerZoneTop + epsilon) {
      hardIssues.push({
        kind: "non-footer-text-in-footer-zone",
        elementId: node.id,
        detail: `text reaches ${node.bottom.toFixed(1)} inside footer reserve starting at ${footerZoneTop.toFixed(1)}; mark an intentional footer as layoutRole=footer or move body text above the reserve`,
      });
    }
  }

  const texts = snapshot.nodes.filter(
    (node) => node.type === "text" && node.layoutRole !== "decoration",
  );
  const slideScale = snapshot.slideWidth > 0 ? snapshot.slideWidth / 960 : 1;
  const minimumRuleClearance = 14 * slideScale;
  const minimumRuleOverlap = Math.max(4, 8 * slideScale);
  const rules = snapshot.nodes.filter((node) => node.type === "rule");
  for (const rule of rules) {
    for (const text of texts) {
      const overlapWidth = Math.min(rule.right, text.right) - Math.max(rule.left, text.left);
      if (overlapWidth < minimumRuleOverlap) continue;
      const overlapHeight = Math.min(rule.bottom, text.bottom) - Math.max(rule.top, text.top);
      if (overlapHeight > epsilon) {
        hardIssues.push({
          kind: "line-text-intersection",
          elementId: `${rule.id},${text.id}`,
          detail: `${rule.id} crosses ${text.id} by ${overlapWidth.toFixed(1)}×${overlapHeight.toFixed(1)} rendered pixels`,
        });
        continue;
      }
      const clearance = text.top - rule.bottom;
      if (clearance >= -epsilon && clearance + epsilon < minimumRuleClearance) {
        hardIssues.push({
          kind: "line-text-clearance",
          elementId: `${rule.id},${text.id}`,
          detail: `${rule.id} leaves only ${(clearance / slideScale).toFixed(1)} slide pixels above ${text.id}; at least 14.0 are required to remain legible after scaling`,
        });
      }
    }
  }
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i]!;
      const b = texts[j]!;
      const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlapWidth >= 4 && overlapHeight >= 4) {
        hardIssues.push({
          kind: "text-collision",
          elementId: `${a.id},${b.id}`,
          detail: `${a.id} and ${b.id} overlap by ${overlapWidth.toFixed(1)}×${overlapHeight.toFixed(1)}`,
        });
      } else if (overlapWidth > epsilon && overlapHeight > epsilon) {
        warnings.push({
          kind: "text-collision",
          elementIds: [a.id, b.id],
          detail: `text bounds overlap by ${overlapWidth.toFixed(1)}×${overlapHeight.toFixed(1)}`,
        });
      }
    }
  }

  return {
    checked: true,
    fontsReady: snapshot.fontsReady,
    footerZoneTop,
    hardIssues,
    warnings,
    ok: hardIssues.length === 0,
  };
}

export async function readRenderedLayout(page: RasterPage): Promise<PageLayoutDiagnostics> {
  const snapshot = await page.evaluate<RenderedLayoutSnapshot>(async () => {
    const fonts = document.fonts;
    if (fonts) await fonts.ready;
    const slide = document.querySelector("#slide");
    if (!slide) {
      return { slideWidth: 0, slideHeight: 0, fontsReady: false, nodes: [] };
    }
    const slideRect = slide.getBoundingClientRect();
    const fontNodes = Array.from(
      slide.querySelectorAll(".el.text, .el.chart text, .el.table td, .el.table th"),
    );
    const fontsReady = !fonts || (
      fonts.status === "loaded" &&
      fontNodes.every((node) => fonts.check(`12px ${getComputedStyle(node).fontFamily}`))
    );
    type Rgba = { r: number; g: number; b: number; a: number };
    const parseColor = (value: string): Rgba | undefined => {
      const match = value.match(
        /rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i,
      );
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
    const resolvePaintStack = (
      candidates: readonly Element[],
    ): ResolvedPaint | UnresolvedPaint | undefined => {
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
          (layer, index) => index < ownLayers.length &&
            (layer.element === runElement || layer.element.contains(runElement)),
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
            foregroundOnlyOpacity: shared.opacity > 0
              ? clampAlpha(opacityThrough(runElement) / shared.opacity)
              : 0,
          },
        };
      } finally {
        styledTarget.style.visibility = priorVisibility;
      }
    };
    return {
      slideWidth: slideRect.width,
      slideHeight: slideRect.height,
      fontsReady,
      nodes: Array.from(slide.querySelectorAll<HTMLElement>(".el")).map((node) => {
        const rect = node.getBoundingClientRect();
        const isText = node.classList.contains("text");
        const slideScale = slideRect.width > 0 ? slideRect.width / 960 : 1;
        const isHorizontalRule =
          node.classList.contains("shape") &&
          rect.width >= 16 * slideScale &&
          rect.height <= 4 * slideScale;
        const hasContrastText =
          isText || node.classList.contains("chart") || node.classList.contains("table");
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
            const run: Element = textRun.parentElement ?? node;
            const computed = getComputedStyle(run);
            const foregroundCss = run.namespaceURI === "http://www.w3.org/2000/svg"
              ? computed.fill
              : computed.color;
            const range = document.createRange();
            range.selectNodeContents(textRun);
            const rects = Array.from(range.getClientRects()).filter(
              (rect) => rect.width > 0.5 && rect.height > 0.5,
            );
            if (rects.length === 0) continue;
            if (/^url\(/i.test(foregroundCss)) {
              contrastUnresolvedSource ??= `${run.tagName.toLowerCase()}:foreground-image`;
              continue;
            }
            const foreground = parseColor(foregroundCss);
            if (!foreground) {
              contrastUnresolvedSource ??= `${run.tagName.toLowerCase()}:foreground-${foregroundCss || "unknown"}`;
              continue;
            }
            const fontSize = Number.parseFloat(computed.fontSize) || 0;
            const parsedWeight = Number.parseInt(computed.fontWeight, 10);
            const fontWeight = Number.isFinite(parsedWeight)
              ? parsedWeight
              : computed.fontWeight === "bold"
                ? 700
                : 400;
            const required = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700)
              ? 3
              : 4.5;
            for (const runRect of rects) {
              const points: Array<[number, number]> = [
                [runRect.left + runRect.width * 0.5, runRect.top + runRect.height * 0.5],
                [runRect.left + Math.min(runRect.width * 0.2, 8), runRect.top + runRect.height * 0.5],
              ];
              for (const [x, y] of points) {
                const background = backgroundAt(node, run, x, y);
                if (!background) continue;
                if (background.kind === "unresolved") {
                  contrastUnresolvedSource ??= background.source;
                  continue;
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
                      a: clampAlpha(
                        background.textGroup.rawBackground.a * background.textGroup.commonOpacity,
                      ),
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
                if (!worstContrast || ratio - required < worstContrast.ratio - worstContrast.required) {
                  worstContrast = {
                    ratio,
                    required,
                    foreground: colorCss(visibleForeground),
                    background: colorCss(visibleBackground),
                    source: background.source,
                  };
                }
              }
            }
          }
        }
        return {
          id: node.dataset.id || "unknown",
          type: isText ? "text" : isHorizontalRule ? "rule" : "element",
          layoutRole: (["footer", "content", "decoration"] as const).includes(
            node.dataset.layoutRole as "footer" | "content" | "decoration",
          )
            ? node.dataset.layoutRole as "footer" | "content" | "decoration"
            : undefined,
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
      }),
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
      content:
        ".insert-pill,.pill-handle,.notes-link,.annot-tip,.more-menu,.ctx-bar{visibility:hidden!important}",
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

export function createPageRasterPort(
  opts: PageRasterPortOpts = {},
): PageRasterPort {
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
      if (!available || !editorBaseUrl && !opts.screenshot) {
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
