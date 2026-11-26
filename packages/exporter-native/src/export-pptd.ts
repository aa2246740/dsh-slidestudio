import fs from "node:fs";
import path from "node:path";
import type JSZip from "jszip";
import pptxgenjs from "pptxgenjs";
import type PptxGenJS from "pptxgenjs";
import { iconOutline } from "./icon-outline.js";
import {
  loadProject,
  chartKind,
  canonicalShapeName,
  CUSTOM_SHAPE_NAME,
  DEFAULT_BORDER_WIDTH_PX,
  resolvedLineBorder,
  parseRichText,
  resolveTextStyle,
  scatterChartModel,
  elementFillPaint,
  pageSurface,
  probeImageSize,
  sanitizeProjectColors,
  tableCellSolidHex,
  tableCellTextHex,
  TABLE_BODY_FILL,
  TABLE_HEADER_FILL,
  toRgbHex,
  type ChartElement,
  type Fill,
  type IconElement,
  type LineElement,
  type Page,
  type PptdElement,
  type PptdProject,
  type ShapeElement,
  type TableElement,
  type TextElement,
  CHART_FONT_FACE,
  CHART_TEXT_PX,
  chartChrome,
  chartZeroHiddenFormatCode,
  isDarkChartSurface,
  type Rect,
} from "@open-slidestudio/pptd-v2";
import { hexNoHash, mapChartElement } from "./chart-map.js";
import { colorFallbackDegradations } from "./export-color-fallback.js";
import { barLabelPosition, chartKindOptions, chartSeriesFills, SLICE_LABEL_FORMAT_CODE } from "./export-chart-kinds.js";
import { exportedChartSurface } from "./export-chart-surface.js";
import { fractionOfChart, mapScatterChart, mapWaterfallChart } from "./export-chart-special.js";
import { patchChartXml, type ChartPatch } from "./export-chart-xml.js";
import { customPathForExport, patchCustomGeometry, type CustomGeometryPatch } from "./export-custom-geometry.js";
import {
  applyShadowPatches,
  pageBackgroundFill,
  patchPageBackground,
  shadowPatchFor,
  type BackgroundPatch,
  type ShadowPatch,
} from "./export-effects.js";
import {
  applyImageClipPatches,
  pictureClipPatch,
  shapeBaseFill,
  shapeImageFillPatch,
  type SlideImageClipPatch,
} from "./export-image-clip.js";
import {
  encodeXmlName,
  fillToPptx,
  ooxmlGradientFill,
  pptxInk,
  pptxSolidFill,
  type PptxGradientFill,
} from "./export-fill.js";
import {
  layoutExportOf,
  layoutMasterName,
  ownColorFallbacks,
  pageElementsToDraw,
  pageMasterName,
  transplantLayouts,
  type LayoutExport,
} from "./export-layouts.js";
import {
  applyPageNumberPatches,
  isPageNumberText,
  isPageOwnNumber,
  pageNumberNotes,
  pageNumberPatchFor,
  type PageNumberPatch,
} from "./export-page-number.js";
import { presetPrst } from "./export-preset-names.js";
import { patchSlideXml } from "./export-slide-xml.js";
import { applyNoStrokePatches, type NoStrokePatch } from "./export-stroke.js";
import { pinPackageTimestamps } from "./export-timestamps.js";
import {
  buildEmbeddedFonts,
  embedFontsIntoPptx,
  type EmbeddedFontInfo,
  type FontEmbedOptions,
  type SkippedFont,
} from "./font-embed.js";
import { pxToIn } from "./export-units.js";
import { AREA_OUTLINE_PT, cssPxToPt, HAIRLINE_PT, LINE_SERIES_PT } from "./stroke-units.js";
import { applyThemeXmlPatch } from "./theme-xml.js";

export type Degradation = {
  slideIndex: number;
  elementId?: string;
  kind: string;
  reason: string;
};

export const HARD_DEGRADATION_KINDS = [
  "missing-image",
  "error",
  "chart-export-failed",
  "line-geometry",
  "full-page-raster",
] as const;

export type ExportReportValidation =
  { ok: true; report: ExportReport } | { ok: false; reason: string; hardDegradation?: Degradation };

export function validateExportReport(raw: unknown, options: { minSlideCount?: number } = {}): ExportReportValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "export report is not an object" };
  }
  const report = raw as ExportReport;
  if (report.ok !== true) {
    return { ok: false, reason: "export report.ok is not true" };
  }
  if (typeof report.slideCount !== "number" || !Number.isFinite(report.slideCount)) {
    return { ok: false, reason: "export report slideCount is missing or invalid" };
  }
  const minSlides = options.minSlideCount ?? 1;
  if (report.slideCount < minSlides) {
    return {
      ok: false,
      reason: `export report slideCount ${report.slideCount} is less than required ${minSlides}`,
    };
  }
  if (typeof report.bytes !== "number" || !Number.isFinite(report.bytes) || report.bytes <= 0) {
    return { ok: false, reason: "export report bytes is zero or invalid" };
  }
  if (Array.isArray(report.editDataCharts?.failed) && report.editDataCharts.failed.length > 0) {
    return {
      ok: false,
      reason: `export report has failed editDataCharts: ${report.editDataCharts.failed.join(", ")}`,
    };
  }
  if (Array.isArray(report.degradations)) {
    for (const d of report.degradations) {
      if (
        (HARD_DEGRADATION_KINDS as readonly string[]).includes(d.kind) ||
        /full-page|raster slide|screenshot slide/i.test(d.reason ?? "")
      ) {
        return {
          ok: false,
          reason: `hard degradation in slide ${d.slideIndex} (${d.kind}): ${d.reason}`,
          hardDegradation: d,
        };
      }
    }
  }
  return { ok: true, report };
}

export type ExportReport = {
  ok: boolean;
  slideCount: number;
  nativeCoverage: number;
  degradations: Degradation[];
  editDataCharts: { ok: string[]; failed: string[] };
  editableLines: EditableLineEvidence[];
  bytes: number;
  embeddedFonts?: EmbeddedFontInfo[];
  skippedFonts?: SkippedFont[];
};

export type ExportPptxOptions = {
  embedFonts?: FontEmbedOptions;
};

export type EditableLineEvidence = {
  slideIndex: number;
  elementId: string;
  source: {
    bounds: [number, number, number, number];
    viewBox: [number, number];
    points: string;
    rotation?: number;
    opacity?: number;
    flipH?: boolean;
    flipV?: boolean;
  };
  output: {
    kind: "custom-geometry" | "axis-fallback";
    objectName: string;
    segmentCount: number;
  };
  preserved: boolean;
};

export type ExportResult = {
  data: Buffer;
  report: ExportReport;
  filename: string;
};

function createPptx(): PptxGenJS {
  type Ctor = new () => PptxGenJS;
  const mod = pptxgenjs as unknown as Ctor | { default: Ctor };
  const Ctor = typeof mod === "function" ? mod : mod.default;
  return new Ctor();
}

function hex(color: string, theme?: PptdProject["presentation"]["theme"]): string {
  return toRgbHex(color, theme).replace("#", "");
}

/**
 * The page surface the chart ink reads, as `#RRGGBB`. The rule is pptd-v2 `pageSurface`, the one the
 * editor paints (ruling 131): a picture page background, its own or inherited, reads as its
 * placeholder colour, and a gradient as its first stop, so a dark overlay still counts as dark.
 * The colour is the shared element paint of that fill, as every other exported fill takes it.
 */
function pageSurfaceColor(
  page: PptdProject["pages"][number]["page"],
  theme: PptdProject["presentation"]["theme"],
  size: [number, number],
): string {
  const surface = pageSurface(page, size);
  const paint = surface ? elementFillPaint("shape", surface.fill, undefined, theme) : undefined;
  return paint?.type === "solid" ? paint.hex : "#FFFFFF";
}

type ImageSrcRectPatch = {
  slideIndex: number;
  objectName: string;
  /** Fractions of the source image to crop away: left/top/right/bottom 0..1. */
  crop: { l: number; t: number; r: number; b: number };
};

type GradientPatch = {
  slideIndex: number;
  objectName: string;
  fill: PptxGradientFill;
};

function patchShapeGradient(xml: string, objectName: string, fill: PptxGradientFill): string {
  const name = encodeXmlName(objectName);
  const chunks = xml.split(/(?=<p:sp>)/);
  let found = false;
  const next = chunks.map((chunk) => {
    if (!chunk.startsWith("<p:sp>")) return chunk;
    const nv = chunk.match(/<p:cNvPr\b[^>]*>/)?.[0] ?? "";
    if (!nv.includes(`name="${name}"`)) return chunk;
    const grad = ooxmlGradientFill(fill);
    const patched = chunk.replace(
      /(<a:(?:prstGeom|custGeom)\b[\s\S]*?<\/a:(?:prstGeom|custGeom)>)(<a:solidFill>[\s\S]*?<\/a:solidFill>|<a:noFill\/>)/,
      `$1${grad}`,
    );
    if (patched === chunk) {
      throw new Error(`gradient overlay ${objectName} has no shape fill to patch`);
    }
    found = true;
    return patched;
  });
  if (!found) throw new Error(`gradient overlay ${objectName} missing from slide xml`);
  return next.join("");
}

/**
 * Insert or replace the <a:srcRect> inside the named <p:pic>'s blipFill.
 * pptxgenjs writes one itself when `sizing` is used, so replace whatever is
 * there — a second srcRect would corrupt the part.
 */
function patchImageSrcRect(xml: string, objectName: string, crop: ImageSrcRectPatch["crop"]): string {
  const name = encodeXmlName(objectName);
  const chunks = xml.split(/(?=<p:pic>)/);
  let found = false;
  const attr = (v: number) => `="${Math.round(Math.max(0, Math.min(1, v)) * 100000)}"`;
  const srcRect = `<a:srcRect l${attr(crop.l)} t${attr(crop.t)} r${attr(crop.r)} b${attr(crop.b)}/>`;
  const next = chunks.map((chunk) => {
    if (!chunk.startsWith("<p:pic>")) return chunk;
    const nv = chunk.match(/<p:cNvPr\b[^>]*\/?>/)?.[0] ?? "";
    if (!nv.includes(`name="${name}"`)) return chunk;
    let patched = chunk;
    if (/<a:srcRect\b[^>]*\/>/.test(patched)) {
      patched = patched.replace(/<a:srcRect\b[^>]*\/>/, srcRect);
    } else {
      patched = patched.replace(/(<a:blip\b[\s\S]*?)(<a:stretch>)/, `$1${srcRect}$2`);
    }
    if (patched === chunk) {
      throw new Error(`image srcRect ${objectName} has no blipFill to patch`);
    }
    found = true;
    return patched;
  });
  if (!found) throw new Error(`image ${objectName} missing from slide xml`);
  return next.join("");
}

type PostProcessPatches = {
  /** Applied before gradients: a custom path replaces the placeholder geometry first. */
  customGeometries?: CustomGeometryPatch[];
  gradients?: GradientPatch[];
  srcRects?: ImageSrcRectPatch[];
  /** Picture clips and shape image fills, applied after srcRects so clipped pictures keep their crop. */
  imageClips?: SlideImageClipPatch[];
  /** Zero-width outlines drawn as no fill, applied before the shadows that add their effect list. */
  noStrokes?: NoStrokePatch[];
  /** Shape and picture shadows, applied after the clips so a clipped picture keeps its effect. */
  shadows?: ShadowPatch[];
  /** Gradient page backgrounds, replacing the solid p:bg that pptxgenjs writes. */
  backgrounds?: BackgroundPatch[];
  /** A page's own number text, filled after the shape patches and before the slide-level patch. */
  pageNumbers?: PageNumberPatch[];
  /** Masters and layouts: their carrier slides are moved into the layout parts after every patch. */
  layouts?: LayoutExport;
  /** docProps and zip entry timestamps pinned for reproducible output (export-timestamps.ts). */
  fixedTimestamps?: boolean;
  /** One entry per addChart call, in slide order (chart1.xml..chartN.xml). */
  charts?: ChartPatch[];
  theme?: PptdProject["presentation"]["theme"];
};

async function postProcessPptx(buffer: Buffer, patches: PostProcessPatches): Promise<Buffer> {
  const customGeometries = patches.customGeometries ?? [];
  const gradients = patches.gradients ?? [];
  const srcRects = patches.srcRects ?? [];
  const charts = patches.charts ?? [];
  const imageClips = patches.imageClips ?? [];
  const noStrokes = patches.noStrokes ?? [];
  const shadows = patches.shadows ?? [];
  const backgrounds = patches.backgrounds ?? [];
  const pageNumbers = patches.pageNumbers ?? [];
  // Every slide part goes through patchSlideXml, patched or not, so no picture keeps its path.
  const { default: JSZipCtor } = await import("jszip");
  const zip = await JSZipCtor.loadAsync(buffer);
  const bySlide = new Map<
    number,
    {
      customGeometries: CustomGeometryPatch[];
      gradients: GradientPatch[];
      srcRects: ImageSrcRectPatch[];
      imageClips: SlideImageClipPatch[];
      noStrokes: NoStrokePatch[];
      shadows: ShadowPatch[];
      backgrounds: BackgroundPatch[];
      pageNumbers: PageNumberPatch[];
    }
  >();
  const bucket = (slideIndex: number) => {
    let entry = bySlide.get(slideIndex);
    if (!entry) {
      entry = {
        customGeometries: [],
        gradients: [],
        srcRects: [],
        imageClips: [],
        noStrokes: [],
        shadows: [],
        backgrounds: [],
        pageNumbers: [],
      };
      bySlide.set(slideIndex, entry);
    }
    return entry;
  };
  groupSlidePatches(bucket, {
    customGeometries,
    gradients,
    srcRects,
    imageClips,
    noStrokes,
    shadows,
    backgrounds,
    pageNumbers,
  });
  for (const [slideIndex, slidePatches] of bySlide) {
    const rel = `ppt/slides/slide${slideIndex + 1}.xml`;
    const file = zip.file(rel);
    if (!file) {
      throw new Error(`native exporter: ${rel} missing while patching slides`);
    }
    let xml = await file.async("string");
    for (const patch of slidePatches.customGeometries) {
      xml = patchCustomGeometry(xml, patch);
    }
    for (const patch of slidePatches.gradients) {
      xml = patchShapeGradient(xml, patch.objectName, patch.fill);
    }
    for (const patch of slidePatches.srcRects) {
      xml = patchImageSrcRect(xml, patch.objectName, patch.crop);
    }
    xml = applyImageClipPatches(xml, slidePatches.imageClips);
    xml = applyNoStrokePatches(xml, slidePatches.noStrokes);
    xml = applyShadowPatches(xml, slidePatches.shadows);
    for (const patch of slidePatches.backgrounds) {
      xml = patchPageBackground(xml, patch.fill);
    }
    xml = applyPageNumberPatches(xml, slidePatches.pageNumbers);
    xml = patchSlideXml(xml);
    zip.file(rel, xml);
  }
  await patchUntouchedSlides(zip, bySlide);
  if (charts.length) {
    await patchChartXml(zip, charts);
  }
  if (patches.layouts) await transplantLayouts(zip, patches.layouts);
  if (patches.fixedTimestamps) await pinPackageTimestamps(zip);
  await applyThemeXmlPatch(zip, patches.theme);
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) delete zip.files[name];
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  }) as Promise<Buffer>;
}

type SlidePatchBucket = {
  customGeometries: CustomGeometryPatch[];
  gradients: GradientPatch[];
  srcRects: ImageSrcRectPatch[];
  imageClips: SlideImageClipPatch[];
  noStrokes: NoStrokePatch[];
  shadows: ShadowPatch[];
  backgrounds: BackgroundPatch[];
  pageNumbers: PageNumberPatch[];
};

function groupSlidePatches(bucket: (slideIndex: number) => SlidePatchBucket, patches: SlidePatchBucket): void {
  for (const patch of patches.customGeometries) bucket(patch.slideIndex).customGeometries.push(patch);
  for (const patch of patches.gradients) bucket(patch.slideIndex).gradients.push(patch);
  for (const patch of patches.srcRects) bucket(patch.slideIndex).srcRects.push(patch);
  for (const patch of patches.imageClips) bucket(patch.slideIndex).imageClips.push(patch);
  for (const patch of patches.noStrokes) bucket(patch.slideIndex).noStrokes.push(patch);
  for (const patch of patches.shadows) bucket(patch.slideIndex).shadows.push(patch);
  for (const patch of patches.backgrounds) bucket(patch.slideIndex).backgrounds.push(patch);
  for (const patch of patches.pageNumbers) bucket(patch.slideIndex).pageNumbers.push(patch);
}

async function patchUntouchedSlides(zip: JSZip, bySlide: Map<number, SlidePatchBucket>): Promise<void> {
  const slideParts = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  for (const rel of slideParts) {
    if (bySlide.has(Number(rel.match(/slide(\d+)\.xml/)?.[1]) - 1)) continue;
    const file = zip.file(rel);
    if (!file) continue;
    zip.file(rel, patchSlideXml(await file.async("string")));
  }
}

/** `latin***ea` survives pptxgenjs as one fontFace; export-slide-xml.ts writes latin and ea. */
function singleFontFace(family: string | { latin: string; ea: string } | undefined): string | undefined {
  if (!family) return undefined;
  const pair = typeof family === "string" ? { latin: family, ea: family } : family;
  const clean = (name: string) =>
    name
      .replace(/[<>&"'|*]/g, "")
      .trim()
      .slice(0, 64);
  const latin = clean(pair.latin);
  const ea = clean(pair.ea);
  if (!latin && !ea) return undefined;
  return `${latin}***${ea || latin}`;
}

function textBullet(list: string | undefined): PptxGenJS.TextPropsOptions["bullet"] {
  if (list === "number") return { type: "number" };
  if (list === "bullet") return true;
  return undefined;
}

function isMicroscopicHiddenChart(element: PptdElement): boolean {
  if (element.elementType !== "chart") return false;
  const [, , width, height] = element.bounds;
  return width <= 4 && height <= 4 && (element.opacity ?? 1) <= 0.05;
}

function mapText(
  slide: PptxGenJS.Slide,
  el: TextElement,
  theme: PptdProject["presentation"]["theme"],
  size: [number, number],
  layout: { w: number; h: number },
): void {
  const [x, y, w, h] = el.bounds;
  const st = resolveTextStyle(el.content ?? { text: "" }, theme);
  const lineFontSizePx = Math.max(st.fontSize, ...st.runs.map((run) => run.fontSize ?? st.fontSize));
  const opts: PptxGenJS.TextPropsOptions = {
    x: pxToIn(x, size[0], layout.w),
    y: pxToIn(y, size[1], layout.h),
    w: pxToIn(w, size[0], layout.w),
    h: pxToIn(h, size[1], layout.h),
    fontSize: cssPxToPt(st.fontSize),
    color: hex(st.colorHex, theme),
    bold: st.bold,
    italic: st.italic,
    align: (st.align[0] as PptxGenJS.HAlign) ?? "left",
    valign: (st.align[1] as PptxGenJS.VAlign) ?? "top",
    wrap: st.wrap,
    // PPTD bounds match the native canvas content box. PowerPoint otherwise
    // applies its own insets and wraps short labels/numbers that fit in CSS.
    margin: 0,
    // Browser and Office font metrics are not byte-identical. Keep the
    // authored bounds authoritative and let the target renderer reduce text
    // only when its own wrapping would otherwise escape the box.
    fit: "shrink",
    // OOXML percentage spacing multiplies Office's own font leading, so a
    // CSS 1.2 line-height becomes visibly taller than 1.2. Use the authored
    // CSS line box as an absolute point value instead.
    lineSpacing: cssPxToPt(lineFontSizePx * st.lineHeight),
    underline: st.underline ? { style: "sng" } : undefined,
    // A page-number box is named by its element ID, so its own number can be written into it.
    ...(isPageNumberText(el) ? { objectName: el.elementId } : {}),
  };
  const face = singleFontFace(st.fontFamily);
  if (face) opts.fontFace = face;
  if (st.letterSpacing) opts.charSpacing = cssPxToPt(st.letterSpacing);
  const bullet = textBullet(st.list);
  if (bullet !== undefined) opts.bullet = bullet;
  if (st.href) opts.hyperlink = { url: st.href };
  const runs = parseRichText(el.content?.text ?? "");
  const styledRuns: PptxGenJS.TextProps[] = [];
  for (const run of runs) {
    const runOptions: PptxGenJS.TextPropsOptions = {
      fontSize: cssPxToPt(run.fontSize ?? st.fontSize),
      color: hex(run.color ?? st.colorHex, theme),
      bold: run.bold ?? st.bold,
      italic: run.italic ?? st.italic,
      fontFace: face,
      charSpacing: st.letterSpacing ? cssPxToPt(st.letterSpacing) : undefined,
      underline: (run.underline ?? st.underline) ? { style: "sng" } : undefined,
    };
    const parts = run.text.split("\n");
    parts.forEach((text, index) => {
      if (index > 0 && styledRuns.length === 0) {
        styledRuns.push({ text: "", options: runOptions });
      }
      styledRuns.push({
        text,
        options: {
          ...runOptions,
          // CSS `white-space: pre-wrap` treats LF as a line break inside the
          // same block. PptxGenJS otherwise turns every LF into a paragraph,
          // whose target-renderer metrics can overflow the authored box.
          softBreakBefore: index > 0,
        },
      });
    });
  }
  const needsRuns =
    runs.length > 1 || st.text.includes("\n") || Boolean(runs[0] && (runs[0].fontSize || runs[0].color));
  if (needsRuns && !st.list) {
    slide.addText(styledRuns, opts);
    return;
  }
  slide.addText(st.text, opts);
}

/** Adds the shape to the slide. Returns false when nothing visible is drawn, so no shape exists. */
function mapShape(
  slide: PptxGenJS.Slide,
  nativeShapeTypes: Readonly<Record<string, PptxGenJS.SHAPE_NAME>>,
  el: ShapeElement,
  theme: PptdProject["presentation"]["theme"],
  size: [number, number],
  layout: { w: number; h: number },
  deg: Degradation[],
  slideIndex: number,
  gradientPatches: GradientPatch[],
  customPatches: CustomGeometryPatch[],
  strokePatches: NoStrokePatch[],
): boolean {
  const [x, y, w, h] = el.bounds;
  // An image fill starts as a placeholder; shapeImageFillPatch writes the picture over it.
  const fill = fillToPptx(shapeBaseFill(el.fill, theme), theme, deg, slideIndex, el.elementId, el.opacity, "shape");
  const decor = shapeDecor(el, theme);
  if (fill.type === "none" && !decor.drawn) return false;
  // A custom path is written as a rectangle at its bounds; export-custom-geometry.ts swaps in the path.
  const custom = el.shapeName === CUSTOM_SHAPE_NAME ? customPathForExport(el.geometry) : undefined;
  if (custom && "issue" in custom) {
    deg.push({
      slideIndex,
      elementId: el.elementId,
      kind: "shape-as-rect",
      reason: `custom path exported as rect: ${custom.issue}`,
    });
  }
  const path = custom && "segments" in custom ? custom : undefined;
  const shapeName = custom ? "rect" : canonicalShapeName(el.shapeName ?? "rect");
  const type = presetPrst(shapeName, nativeShapeTypes);
  if (!type) {
    deg.push({
      slideIndex,
      elementId: el.elementId,
      kind: "shape-as-rect",
      reason: `preset ${shapeName} exported as rect`,
    });
  }
  slide.addShape((type || "rect") as PptxGenJS.SHAPE_NAME, {
    x: pxToIn(x, size[0], layout.w),
    y: pxToIn(y, size[1], layout.h),
    w: pxToIn(w, size[0], layout.w),
    h: pxToIn(h, size[1], layout.h),
    fill: pptxSolidFill(fill),
    ...decor.props,
    objectName: el.elementId,
  });
  // pptxgenjs would draw a zero width as 1 pt, so the outline is patched to no fill instead.
  if (el.border?.width === 0) strokePatches.push({ slideIndex, objectName: el.elementId });
  if (fill.type === "gradient") {
    gradientPatches.push({ slideIndex, objectName: el.elementId, fill });
  }
  if (path) customPatches.push({ slideIndex, objectName: el.elementId, path });
  return true;
}

function shapeDecor(
  el: ShapeElement,
  theme: PptdProject["presentation"]["theme"],
): { drawn: boolean; props: Partial<PptxGenJS.ShapeProps> } {
  // border.width is PPTD px for every shape kind (ruling 112): a:ln w = width × 9 525 EMU.
  const hasLine = Boolean(el.border?.color) && (el.border?.width ?? 1) > 0;
  const line = hasLine
    ? {
        color: hex(el.border!.color!, theme),
        width: cssPxToPt(el.border?.width ?? DEFAULT_BORDER_WIDTH_PX),
        dashType: lineDashType(el.border!.style),
        ...(el.opacity !== undefined
          ? { transparency: Math.round((1 - Math.max(0, Math.min(1, el.opacity))) * 100) }
          : {}),
      }
    : undefined;
  return {
    drawn: hasLine,
    props: {
      // The authored border must survive the export — a shape with a border
      // but no fill previously dropped the stroke entirely.
      ...(line ? { line } : {}),
      ...(el.rotation ? { rotate: el.rotation } : {}),
      ...(el.flipH ? { flipH: true } : {}),
      ...(el.flipV ? { flipV: true } : {}),
    },
  };
}

function mapTable(
  slide: PptxGenJS.Slide,
  el: TableElement,
  theme: PptdProject["presentation"]["theme"],
  size: [number, number],
  layout: { w: number; h: number },
): void {
  const [x, y, w, h] = el.bounds;
  const tableW = pxToIn(w, size[0], layout.w);
  const tableH = pxToIn(h, size[1], layout.h);
  const colSum = (el.columnWidths ?? []).reduce((a, b) => a + b, 0);
  const rowSum = (el.rowHeights ?? []).reduce((a, b) => a + b, 0);
  // PPTD keeps covered cells as placeholders in the grid; pptxgenjs wants
  // them omitted so the colspan bookkeeping stays consistent. Mark coverage.
  const covered = new Set<string>();
  el.rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      const rs = Math.max(1, Math.floor(Number(cell.rowSpan) || 1));
      const cs = Math.max(1, Math.floor(Number(cell.colSpan) || 1));
      for (let dr = 0; dr < rs; dr += 1) {
        for (let dc = 0; dc < cs; dc += 1) {
          if (dr || dc) covered.add(`${r + dr}:${c + dc}`);
        }
      }
    }),
  );
  const rows = el.rows.map((row, r) =>
    row
      .map((cell, c) => {
        // Row 0 gets the canvas's is-header defaults when the author did not
        // pin explicit cell paint/bold.
        const isHeader = r === 0;
        const fillHex = tableCellSolidHex(cell.fill, theme) ?? (isHeader ? TABLE_HEADER_FILL : TABLE_BODY_FILL);
        const options: PptxGenJS.TableCellProps = {
          bold: cell.bold ?? isHeader,
          color: tableCellTextHex(cell.color, theme).replace("#", ""),
          fill: { color: fillHex.replace("#", "") },
          valign: "middle",
          align: (cell.align?.[0] as PptxGenJS.HAlign) ?? "left",
          // CSS .el-table td pads 4px vertical / 6px horizontal at 96 CSS px
          // per inch. pptxgenjs TableCellProps.margin is in inches here.
          margin: [4 / 96, 6 / 96, 4 / 96, 6 / 96],
          fontFace: CHART_FONT_FACE,
          fontSize: cssPxToPt(13),
        };
        // Merged regions: the origin cell carries the span; covered cells are
        // placeholders in the PPTD grid and must be omitted from the row.
        if (typeof cell.colSpan === "number" && cell.colSpan > 1) {
          options.colspan = Math.floor(cell.colSpan);
        }
        if (typeof cell.rowSpan === "number" && cell.rowSpan > 1) {
          options.rowspan = Math.floor(cell.rowSpan);
        }
        return { text: cell.text ?? "", options, covered: covered.has(`${r}:${c}`) };
      })
      .filter((cell) => !cell.covered)
      .map(({ text, options }) => ({ text, options })),
  );
  // Decks without the neutral flag keep the cool .el-table grey.
  const rule = theme?.neutralChrome ? "CCCCCC" : "D1D5DB";
  slide.addTable(rows, {
    x: pxToIn(x, size[0], layout.w),
    y: pxToIn(y, size[1], layout.h),
    w: tableW,
    h: tableH,
    colW: colSum > 0 ? el.columnWidths!.map((c) => (c / colSum) * tableW) : undefined,
    rowH:
      rowSum > 0 && el.rowHeights!.length === el.rows.length
        ? el.rowHeights!.map((r) => (r / rowSum) * tableH)
        : undefined,
    border: [
      { type: "solid", pt: HAIRLINE_PT, color: rule },
      { type: "solid", pt: HAIRLINE_PT, color: rule },
      { type: "solid", pt: HAIRLINE_PT, color: rule },
      { type: "solid", pt: HAIRLINE_PT, color: rule },
    ],
    fontFace: CHART_FONT_FACE,
    fontSize: cssPxToPt(13),
    valign: "middle",
  });
}

function comboChartPlan(mapped: {
  series: { axis?: string; pptxType: string }[];
  grouping?: string;
  barDir?: string;
}): { combo: boolean; hasSecondary: boolean; seriesKinds: Set<string> } {
  const hasSecondary = mapped.series.some((series) => series.axis === "secondary");
  const seriesKinds = new Set(mapped.series.map((series) => series.pptxType));
  const clusteredBarLine =
    !hasSecondary &&
    mapped.grouping === "clustered" &&
    mapped.barDir !== "bar" &&
    seriesKinds.size === 2 &&
    seriesKinds.has("bar") &&
    seriesKinds.has("line");
  const combo = (seriesKinds.size >= 2 && (hasSecondary || mapped.grouping !== "clustered")) || clusteredBarLine;
  return { combo, hasSecondary, seriesKinds };
}

function mapChart(
  slide: PptxGenJS.Slide,
  el: ChartElement,
  theme: PptdProject["presentation"]["theme"],
  size: [number, number],
  layout: { w: number; h: number },
  deg: Degradation[],
  slideIndex: number,
  editData: { ok: string[]; failed: string[] },
  surface: string,
  chartPatches: ChartPatch[],
): void {
  const [x, y, w, h] = el.bounds;
  try {
    if (el.background) {
      const fill = fillToPptx(el.background, theme, deg, slideIndex, el.elementId, el.opacity, "chart");
      if (fill.type !== "none") {
        slide.addShape("rect", {
          x: pxToIn(x, size[0], layout.w),
          y: pxToIn(y, size[1], layout.h),
          w: pxToIn(w, size[0], layout.w),
          h: pxToIn(h, size[1], layout.h),
          fill: pptxSolidFill(fill),
          line: { color: pptxInk(fill), transparency: 100 },
        });
      }
    }
    // The surface the editor reads its ink against (exportedChartSurface), so both sides agree.
    const chartSurfaceDark = isDarkChartSurface(surface);
    const chrome = chartChrome(theme);
    const ink = (chartSurfaceDark ? chrome.ink.dark : chrome.ink.light).slice(1);
    const grid = (chartSurfaceDark ? chrome.grid.dark : chrome.grid.light).slice(1);
    const kind = chartKind(el);
    const fontPt = (px: number) => Math.round(cssPxToPt(px) * 100) / 100;
    const tickPt = fontPt(CHART_TEXT_PX.tick);
    const catPt = fontPt(CHART_TEXT_PX.category);
    const labelPt = fontPt(CHART_TEXT_PX.dataLabel);
    const legendPt = fontPt(CHART_TEXT_PX.legend);
    const titlePt = fontPt(CHART_TEXT_PX.title);
    const axisTitlePt = fontPt(CHART_TEXT_PX.axisTitle);

    if (kind === "waterfall") {
      mapWaterfallChart(
        slide,
        el,
        size,
        layout,
        { ink, grid, background: surface },
        tickPt,
        catPt,
        labelPt,
        axisTitlePt,
      );
      chartPatches.push({
        slideIndex,
        elementId: el.elementId,
        seriesFormatCodes: [],
        seriesNames: ["基线", "增加", "减少", "合计"],
        fontFace: CHART_FONT_FACE,
      });
      editData.ok.push(el.elementId);
      return;
    }
    if (kind === "scatter") {
      mapScatterChart(slide, el, size, layout, { ink, grid, background: surface }, tickPt, catPt, axisTitlePt);
      chartPatches.push({
        slideIndex,
        elementId: el.elementId,
        seriesFormatCodes: [],
        seriesNames: [el.series[0]?.name ?? scatterChartModel(el).yName],
        fontFace: CHART_FONT_FACE,
      });
      editData.ok.push(el.elementId);
      return;
    }
    const mapped = mapChartElement(el);
    const type = (el.series[0]?.type ?? "bar").toLowerCase();
    // Pie and doughnut slices both label as "name pct%", so both take the separator and the
    // percent format (a value format would print "0" for a share).
    const sliced = mapped.pptxType === "pie" || mapped.pptxType === "doughnut";
    const patch: ChartPatch = {
      slideIndex,
      elementId: el.elementId,
      seriesFormatCodes: mapped.series.map((s) => (sliced ? SLICE_LABEL_FORMAT_CODE : s.formatCode)),
      seriesNames: mapped.series.map((s) => s.name),
      fontFace: CHART_FONT_FACE,
      pie: sliced,
      radar: mapped.pptxType === "radar",
      labels: mapped.showValue,
      barHorizontal: mapped.barDir === "bar",
      seriesFills: chartSeriesFills(mapped, theme),
      plotLayout: {
        x: fractionOfChart(mapped.layout.plot.x, w),
        y: fractionOfChart(mapped.layout.plot.y, h),
        w: fractionOfChart(mapped.layout.plot.w, w),
        h: fractionOfChart(mapped.layout.plot.h, h),
      },
    };
    if (mapped.showLegend && mapped.layout.legend) {
      patch.legend = {
        position: mapped.legend.position,
        layout: {
          x: fractionOfChart(mapped.layout.legend.area.x, w),
          y: fractionOfChart(mapped.layout.legend.area.y, h),
          w: fractionOfChart(mapped.layout.legend.area.w, w),
          h: fractionOfChart(mapped.layout.legend.area.h, h),
        },
      };
    }
    const opts: PptxGenJS.IChartOpts = {
      x: pxToIn(x, size[0], layout.w),
      y: pxToIn(y, size[1], layout.h),
      w: pxToIn(w, size[0], layout.w),
      h: pxToIn(h, size[1], layout.h),
      layout: patch.plotLayout,
      showTitle: false,
      showLegend: mapped.showLegend,
      legendPos: ({ top: "t", bottom: "b", left: "l", right: "r" } as const)[mapped.legend.position],
      showValue: mapped.showValue,
      dataLabelFormatCode: mapped.dataLabelFormatCode,
      dataLabelColor: ink,
      dataLabelFontFace: CHART_FONT_FACE,
      dataLabelFontSize: labelPt,
      chartColors: mapped.colors.map(hexNoHash),
      catAxisLabelColor: ink,
      catAxisLabelFontFace: CHART_FONT_FACE,
      catAxisLabelFontSize: catPt,
      catAxisLineColor: grid,
      catAxisLineSize: HAIRLINE_PT,
      catAxisTitleColor: ink,
      catAxisTitleFontFace: CHART_FONT_FACE,
      catAxisTitleFontSize: axisTitlePt,
      catGridLine: { style: "none" },
      valAxisLabelColor: ink,
      valAxisLabelFontFace: CHART_FONT_FACE,
      valAxisLabelFontSize: tickPt,
      valAxisLineColor: grid,
      valAxisLineSize: HAIRLINE_PT,
      valAxisTitleColor: ink,
      valAxisTitleFontFace: CHART_FONT_FACE,
      valAxisTitleFontSize: axisTitlePt,
      valGridLine: { color: grid, size: HAIRLINE_PT },
      valAxisLabelFormatCode:
        "#,##0" + (mapped.scale.tickDecimals > 0 ? `.${"0".repeat(mapped.scale.tickDecimals)}` : ""),
      valAxisMinVal: mapped.scale.min,
      valAxisMaxVal: mapped.scale.max,
      valAxisMajorUnit: mapped.scale.step,
      legendColor: ink,
      legendFontFace: CHART_FONT_FACE,
      legendFontSize: legendPt,
      showCatAxisTitle: Boolean(el.axis?.x),
      catAxisTitle: el.axis?.x,
      showValAxisTitle: Boolean(el.axis?.y),
      valAxisTitle: el.axis?.y,
      titleColor: ink,
      titleFontFace: CHART_FONT_FACE,
      titleFontSize: titlePt,
      barGapWidthPct: 50,
      barOverlapPct: -8,
    };
    if (mapped.pptxType === "line" || mapped.pptxType === "area") {
      opts.lineSize = mapped.pptxType === "area" ? AREA_OUTLINE_PT : LINE_SERIES_PT;
      opts.lineDataSymbol = "none";
    }
    if (mapped.barDir) opts.barDir = mapped.barDir;
    if (mapped.barDir === "bar") {
      // Written as inEnd so pptxgenjs emits a dLblPos at all;
      // patchDataLabelPositions turns clustered bars into outEnd.
      opts.dataLabelPosition = "inEnd";
      // OOXML supports maxMin for a top-to-bottom category order, while the
      // PptxGenJS 3.x declaration exposes only minMax. The writer forwards the
      // valid OOXML value unchanged.
      (opts as unknown as Record<string, unknown>).catAxisOrientation = "maxMin";
    } else if (mapped.pptxType === "bar") {
      // pptxgenjs drops `outEnd` from clustered bars; see
      // patchDataLabelPositions for the post-write correction.
      opts.dataLabelPosition = "inEnd";
    }
    // Radar, doughnut and stacked bar settings win over the shared defaults above.
    Object.assign(opts, chartKindOptions(mapped, grid));
    if (mapped.grouping === "percentStacked") {
      deg.push({
        slideIndex,
        elementId: el.elementId,
        kind: "chart-percent-labels-as-values",
        reason: "percent-stacked data labels show source values, not shares",
      });
    }
    // pptxgenjs only splits a chart into parts for a secondary axis, and it
    // rejects the split otherwise. A stacked bar with lines keeps one axis pair,
    // because the editor draws those lines on the bars' own scale. So does a
    // clustered column chart with lines; the single-chart path would write them as bars.
    const { combo, hasSecondary, seriesKinds } = comboChartPlan(mapped);
    // The chart title is a native text box on the shared layout rect: the
    // canvas paints it identically, and pptxgenjs' titlePos math is broken.
    const addChartTitle = () => {
      if (!mapped.title || !mapped.layout.title) return;
      const t = mapped.layout.title;
      slide.addText(mapped.title, {
        x: pxToIn(x + t.x, size[0], layout.w),
        y: pxToIn(y + t.y, size[1], layout.h),
        w: pxToIn(t.w, size[0], layout.w),
        h: pxToIn(t.h, size[1], layout.h),
        fontFace: CHART_FONT_FACE,
        fontSize: titlePt,
        color: ink,
        align: "left",
        valign: "middle",
        margin: 0,
        wrap: false,
      });
    };
    if (combo) {
      const groups = new Map<string, typeof mapped.series>();
      for (const series of mapped.series) {
        const key = `${series.pptxType}:${series.axis}`;
        const group = groups.get(key) ?? [];
        group.push(series);
        groups.set(key, group);
      }
      // The part lists series group by group and the format patch walks it in that
      // order, so a bar, line, bar declaration must not hand the line the bars' format.
      const written = [...groups.values()].flat();
      patch.seriesFormatCodes = written.map((series) => patch.seriesFormatCodes[mapped.series.indexOf(series)]!);
      // pptxgenjs numbers c:idx/c:order over the concatenated groups, which
      // renumbers an interleaved declaration; the XML patch restores the
      // model's declared order per written series.
      patch.seriesIndexes = written.map((series) => mapped.series.indexOf(series));
      const multi: PptxGenJS.IChartMulti[] = [...groups.values()].map((group) => ({
        type: group[0]!.pptxType as PptxGenJS.CHART_NAME,
        data: group.map((series) => ({
          name: series.name,
          labels: series.labels,
          values: series.values,
        })),
        options: {
          secondaryValAxis: group[0]!.axis === "secondary",
          secondaryCatAxis: group[0]!.axis === "secondary",
          showValue: mapped.showValue,
          // A zero-only category is common in bar/line combinations. A blank
          // zero section keeps those labels off the category axis while the
          // source values remain editable in the embedded workbook.
          dataLabelFormatCode: chartZeroHiddenFormatCode(mapped.dataLabelFormatCode),
          dataLabelColor: ink,
          dataLabelFontFace: CHART_FONT_FACE,
          dataLabelFontSize: labelPt,
          // pptxgenjs shares one position across all parts and validates it
          // against the first; patchDataLabelPositions then sets outEnd on
          // the bar part and `t` on the line part.
          dataLabelPosition: group[0]!.pptxType === "bar" ? barLabelPosition(mapped.grouping) : "inEnd",
          chartColors: group.map((series) => hexNoHash(series.color)),
          ...(group[0]!.pptxType === "bar" ? { barDir: "col" as const } : {}),
          ...(group[0]!.pptxType === "bar" && mapped.grouping !== "clustered"
            ? { barGrouping: mapped.grouping, barOverlapPct: 100 }
            : {}),
          ...(group[0]!.pptxType === "line" || group[0]!.pptxType === "area"
            ? {
                lineSize: group[0]!.pptxType === "area" ? AREA_OUTLINE_PT : LINE_SERIES_PT,
                lineDataSymbol: "none" as const,
              }
            : {}),
        },
      }));
      const primaryCatAxis: PptxGenJS.IChartPropsAxisCat = {
        catAxisLabelColor: ink,
        catAxisLineColor: grid,
        catAxisLineSize: HAIRLINE_PT,
        catAxisLabelFontSize: catPt,
        catAxisLabelFontFace: CHART_FONT_FACE,
        catAxisLabelPos: "low",
        catAxisTitleFontFace: CHART_FONT_FACE,
        catAxisTitleFontSize: axisTitlePt,
      };
      const secondaryCatAxis: PptxGenJS.IChartPropsAxisCat = {
        catAxisHidden: true,
        catAxisLabelPos: "none",
        catAxisLineShow: false,
      };
      const secondaryScale = mapped.secondaryScale ?? mapped.scale;
      const primaryValAxis: PptxGenJS.IChartPropsAxisVal = {
        valAxisMinVal: mapped.scale.min,
        valAxisMaxVal: mapped.scale.max,
        valAxisMajorUnit: mapped.scale.step,
        valAxisLabelFormatCode: opts.valAxisLabelFormatCode,
        valAxisLabelFontSize: tickPt,
        valAxisLabelFontFace: CHART_FONT_FACE,
        valAxisLineSize: HAIRLINE_PT,
        showValAxisTitle: Boolean(el.axis?.y),
        valAxisTitle: el.axis?.y,
        valAxisTitleFontFace: CHART_FONT_FACE,
        valAxisTitleFontSize: axisTitlePt,
      };
      const secondaryValAxis: PptxGenJS.IChartPropsAxisVal = {
        valAxisMinVal: secondaryScale.min,
        valAxisMaxVal: secondaryScale.max,
        valAxisMajorUnit: secondaryScale.step,
        valAxisLabelPos: "high",
        valAxisLineSize: HAIRLINE_PT,
        valGridLine: { style: "none" },
        // Plain numbers. The top-level percent format of a percent-stacked bar must not reach it.
        valAxisLabelFormatCode: "General",
        valAxisLabelFontSize: tickPt,
        valAxisLabelFontFace: CHART_FONT_FACE,
        showValAxisTitle: Boolean(el.axis?.secondaryY),
        valAxisTitle: el.axis?.secondaryY,
        valAxisTitleFontFace: CHART_FONT_FACE,
        valAxisTitleFontSize: axisTitlePt,
      };
      // One axis pair unless a series sits on the secondary axis.
      opts.catAxes = hasSecondary ? [primaryCatAxis, secondaryCatAxis] : [primaryCatAxis];
      opts.valAxes = hasSecondary ? [primaryValAxis, secondaryValAxis] : [primaryValAxis];
      const addMultiChart = slide.addChart.bind(slide) as unknown as (
        chartTypes: PptxGenJS.IChartMulti[],
        options: PptxGenJS.IChartOpts,
      ) => void;
      addMultiChart(multi, opts);
      addChartTitle();
      chartPatches.push(patch);
      editData.ok.push(el.elementId);
      return;
    }

    slide.addChart(
      mapped.pptxType as PptxGenJS.CHART_NAME,
      mapped.series.map((s) => ({
        name: s.name,
        labels: s.labels,
        values: s.values,
      })),
      opts,
    );
    chartPatches.push(patch);
    if (["bar", "line", "pie", "area", "column", "radar", "doughnut"].includes(type)) {
      editData.ok.push(el.elementId);
    } else {
      editData.failed.push(el.elementId);
      deg.push({
        slideIndex,
        elementId: el.elementId,
        kind: "chart-type-fallback",
        reason: `chart type ${type} may lack full Edit Data fidelity`,
      });
    }
    addChartTitle();
  } catch (e) {
    editData.failed.push(el.elementId);
    deg.push({
      slideIndex,
      elementId: el.elementId,
      kind: "chart-export-failed",
      reason: e instanceof Error ? e.message : String(e),
    });
  }
}

function parsePolylinePoints(points: string): Array<[number, number]> | undefined {
  const source = points.trim();
  if (!source || /[ml]/.test(source)) return undefined;
  const numberSource = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";
  const tokenPattern = new RegExp(`M|L|${numberSource}`, "g");
  const tokens: string[] = source.match(tokenPattern) ?? [];
  const residue = source.replace(tokenPattern, "").replace(/[,\s]/g, "");
  if (residue) return undefined;

  const parsed: Array<[number, number]> = [];
  if (tokens.includes("M") || tokens.includes("L")) {
    if (tokens[0] !== "M" || tokens.length < 6 || (tokens.length - 3) % 3 !== 0) {
      return undefined;
    }
    const startX = Number(tokens[1]);
    const startY = Number(tokens[2]);
    if (!Number.isFinite(startX) || !Number.isFinite(startY)) return undefined;
    parsed.push([startX, startY]);
    for (let index = 3; index < tokens.length; index += 3) {
      if (tokens[index] !== "L") return undefined;
      const pointX = Number(tokens[index + 1]);
      const pointY = Number(tokens[index + 2]);
      if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) return undefined;
      parsed.push([pointX, pointY]);
    }
    return parsed.length >= 2 ? parsed : undefined;
  }

  const numbers = tokens.map(Number);
  if (numbers.length < 4 || numbers.length % 2 !== 0) return undefined;
  if (numbers.some((value) => !Number.isFinite(value))) return undefined;
  for (let index = 0; index < numbers.length; index += 2) {
    parsed.push([numbers[index]!, numbers[index + 1]!]);
  }
  return parsed;
}

function lineDashType(style: string | undefined): PptxGenJS.ShapeLineProps["dashType"] {
  switch (style?.trim().toLowerCase()) {
    case "dash":
    case "dashed":
      return "dash";
    case "dot":
    case "dotted":
      return "sysDot";
    case "dash-dot":
    case "dashdot":
      return "dashDot";
    default:
      return "solid";
  }
}

/** Preserve PPTD bounds/viewBox/points as one editable OOXML custom-geometry path. */
function mapLine(
  slide: PptxGenJS.Slide,
  el: LineElement,
  theme: PptdProject["presentation"]["theme"],
  size: [number, number],
  layout: { w: number; h: number },
  degradations: Degradation[],
  slideIndex: number,
  strokePatches: NoStrokePatch[],
): EditableLineEvidence {
  const [x, y, w, h] = el.bounds;
  // Unstyled-line defaults (rulings 100, 112) come from pptd-v2, the same values the canvas paints.
  const lineBorder = resolvedLineBorder(el.border, theme);
  const color = hex(lineBorder.color, theme);
  const pt = cssPxToPt(lineBorder.width);
  const objectName = `PPTD line ${el.elementId}`;
  const source = {
    bounds: [...el.bounds] as [number, number, number, number],
    viewBox: [...el.viewBox] as [number, number],
    points: el.points,
    ...(el.rotation !== undefined ? { rotation: el.rotation } : {}),
    ...(el.opacity !== undefined ? { opacity: el.opacity } : {}),
    ...(el.flipH !== undefined ? { flipH: el.flipH } : {}),
    ...(el.flipV !== undefined ? { flipV: el.flipV } : {}),
  };
  const points = parsePolylinePoints(el.points);
  const [viewWidth, viewHeight] = el.viewBox;
  const viewBoxValid = Number.isFinite(viewWidth) && Number.isFinite(viewHeight) && viewWidth > 0 && viewHeight > 0;
  const curve = el.curve?.trim().toLowerCase();
  const curvePreserved = !points || points.length <= 2 || !curve || curve === "straight" || curve === "sharp";
  const line: PptxGenJS.ShapeLineProps = {
    color,
    width: pt,
    dashType: lineDashType(el.border?.style),
    ...(el.opacity !== undefined ? { transparency: Math.round((1 - Math.max(0, Math.min(1, el.opacity))) * 100) } : {}),
    ...(el.arrow?.[0] ? { beginArrowType: el.arrow[0] } : {}),
    ...(el.arrow?.[1] ? { endArrowType: el.arrow[1] } : {}),
  };
  // A zero width draws no outline, and so no arrowhead, as the editor paints it. pptxgenjs would
  // draw a zero width as 1 pt, so such a line gets no line option and a no-fill outline patch.
  const drawn = lineBorder.width > 0;
  const outline = drawn ? { line } : {};
  const patchOutline = () => {
    if (!drawn) strokePatches.push({ slideIndex, objectName });
  };

  if (points && viewBoxValid) {
    const widthInches = pxToIn(w, size[0], layout.w);
    const heightInches = pxToIn(h, size[1], layout.h);
    slide.addShape("custGeom" as PptxGenJS.SHAPE_NAME, {
      x: pxToIn(x, size[0], layout.w),
      y: pxToIn(y, size[1], layout.h),
      w: widthInches,
      h: heightInches,
      objectName,
      fill: { type: "none" },
      ...outline,
      ...(el.rotation !== undefined ? { rotate: el.rotation } : {}),
      ...(el.flipH !== undefined ? { flipH: el.flipH } : {}),
      ...(el.flipV !== undefined ? { flipV: el.flipV } : {}),
      points: points.map(([pointX, pointY], index) => ({
        x: (pointX / viewWidth) * widthInches,
        y: (pointY / viewHeight) * heightInches,
        ...(index === 0 ? { moveTo: true } : {}),
      })),
    });
    patchOutline();
    if (!curvePreserved) {
      degradations.push({
        slideIndex,
        elementId: el.elementId,
        kind: "line-geometry",
        reason: `curve mode ${el.curve} exported as an editable sharp polyline`,
      });
    }
    return {
      slideIndex,
      elementId: el.elementId,
      source,
      output: {
        kind: "custom-geometry",
        objectName,
        segmentCount: points.length - 1,
      },
      preserved: curvePreserved,
    };
  }

  degradations.push({
    slideIndex,
    elementId: el.elementId,
    kind: "line-geometry",
    reason: viewBoxValid
      ? "points could not be parsed as a straight/polyline path"
      : "viewBox must contain two positive finite dimensions",
  });
  if (w >= h) {
    slide.addShape("line" as PptxGenJS.SHAPE_NAME, {
      x: pxToIn(x, size[0], layout.w),
      y: pxToIn(y + h / 2, size[1], layout.h),
      w: pxToIn(w, size[0], layout.w),
      h: 0,
      objectName,
      ...outline,
      ...(el.rotation !== undefined ? { rotate: el.rotation } : {}),
      ...(el.flipH !== undefined ? { flipH: el.flipH } : {}),
      ...(el.flipV !== undefined ? { flipV: el.flipV } : {}),
    });
  } else {
    slide.addShape("line" as PptxGenJS.SHAPE_NAME, {
      x: pxToIn(x + w / 2, size[0], layout.w),
      y: pxToIn(y, size[1], layout.h),
      w: 0,
      h: pxToIn(h, size[1], layout.h),
      objectName,
      ...outline,
      ...(el.rotation !== undefined ? { rotate: el.rotation } : {}),
      ...(el.flipH !== undefined ? { flipH: el.flipH } : {}),
      ...(el.flipV !== undefined ? { flipV: el.flipV } : {}),
    });
  }
  patchOutline();
  return {
    slideIndex,
    elementId: el.elementId,
    source,
    output: { kind: "axis-fallback", objectName, segmentCount: 1 },
    preserved: false,
  };
}

async function mapIcon(
  slide: PptxGenJS.Slide,
  el: IconElement,
  theme: PptdProject["presentation"]["theme"],
  size: [number, number],
  layout: { w: number; h: number },
  degradations: Degradation[],
  slideIndex: number,
): Promise<void> {
  const [x, y, w, h] = el.bounds;
  const fill = fillToPptx(el.fill, theme, degradations, slideIndex, el.elementId, el.opacity, "icon");
  const color = pptxInk(fill);
  const transparency =
    fill.type === "solid" ? fill.transparency : fill.type === "gradient" ? fill.fallback.transparency : undefined;
  const width = pxToIn(w, size[0], layout.w);
  const height = pxToIn(h, size[1], layout.h);
  const points = await iconOutline(el.iconName || "fas:star", width, height);
  slide.addShape("custGeom" as PptxGenJS.SHAPE_NAME, {
    x: pxToIn(x, size[0], layout.w),
    y: pxToIn(y, size[1], layout.h),
    w: width,
    h: height,
    objectName: `icon:${el.elementId}`,
    points,
    fill: { type: "solid", color, transparency },
    line: { color, transparency: 100 },
    ...(el.rotation !== undefined ? { rotate: el.rotation } : {}),
    ...(el.flipH !== undefined ? { flipH: el.flipH } : {}),
    ...(el.flipV !== undefined ? { flipV: el.flipV } : {}),
  });
}

const clamp01 = (v: number | undefined) =>
  Math.max(0, Math.min(1, typeof v === "number" && Number.isFinite(v) ? v : 0));

/**
 * Convert element-relative crop fractions into a source-image srcRect.
 * The editor applies crop to the *cover-fitted* image, so under cover fit the
 * crop window composes with the visible center region of the source.
 */
function srcRectForCrop(
  crop: { left?: number; top?: number; right?: number; bottom?: number },
  fitMode: "fill" | "contain" | "cover",
  natural: { w: number; h: number } | undefined,
  boxW: number,
  boxH: number,
): ImageSrcRectPatch["crop"] {
  const l = clamp01(crop.left);
  const t = clamp01(crop.top);
  const r = clamp01(crop.right);
  const b = clamp01(crop.bottom);
  if (l + r >= 1 || t + b >= 1) return { l: 0.5, t: 0.5, r: 0.5, b: 0.5 };
  if (fitMode === "cover" && natural && natural.w > 0 && natural.h > 0 && boxW > 0 && boxH > 0) {
    const scale = Math.max(boxW / natural.w, boxH / natural.h);
    // Fraction of the source that the cover fit shows.
    const fw = Math.min(1, boxW / (natural.w * scale));
    const fh = Math.min(1, boxH / (natural.h * scale));
    const x0 = (1 - fw) / 2;
    const y0 = (1 - fh) / 2;
    const left = x0 + l * fw;
    const right = x0 + (1 - r) * fw;
    const top = y0 + t * fh;
    const bottom = y0 + (1 - b) * fh;
    return { l: left, t: top, r: 1 - right, b: 1 - bottom };
  }
  // fill stretches the whole source into the box, so box fractions equal
  // source fractions; contain approximates the same (letterbox margins are
  // treated as image area — close enough for an edge crop).
  return { l, t, r, b };
}

function locatedImage(
  src: string,
  rootDir: string,
): { src: string; natural?: { w: number; h: number }; missing?: true } {
  if (src.startsWith("http")) return { src };
  if (src.startsWith("data:")) {
    const comma = src.indexOf(",");
    try {
      return { src, natural: probeImageSize(Buffer.from(src.slice(comma + 1), "base64")) };
    } catch {
      return { src };
    }
  }
  const local = path.join(rootDir, src);
  if (!fs.existsSync(local)) return { src, missing: true };
  try {
    return { src: local, natural: probeImageSize(fs.readFileSync(local)) };
  } catch {
    return { src: local };
  }
}

function mapImage(
  slide: PptxGenJS.Slide,
  el: Extract<PptdElement, { elementType: "image" }>,
  rootDir: string,
  size: [number, number],
  layout: { w: number; h: number },
  deg: Degradation[],
  slideIndex: number,
  srcRectPatches: ImageSrcRectPatch[],
  clipPatches: SlideImageClipPatch[],
  nativeShapeTypes: Readonly<Record<string, string>>,
): void {
  const [x, y, w, h] = el.bounds;
  const resolved = locatedImage(el.src, rootDir);
  if (resolved.missing) {
    deg.push({
      slideIndex,
      elementId: el.elementId,
      kind: "missing-image",
      reason: `image not found: ${el.src}`,
    });
    return;
  }
  const src = resolved.src;
  const natural = resolved.natural;
  const boxW = pxToIn(w, size[0], layout.w);
  const boxH = pxToIn(h, size[1], layout.h);
  const fitMode = el.fit?.mode ?? "cover";
  const hasCrop = Boolean(el.crop && (el.crop.left || el.crop.top || el.crop.right || el.crop.bottom));
  const image: PptxGenJS.ImageProps = {
    path: src.startsWith("data:") ? undefined : src,
    data: src.startsWith("data:") ? src : undefined,
    x: pxToIn(x, size[0], layout.w),
    y: pxToIn(y, size[1], layout.h),
    w: boxW,
    h: boxH,
    objectName: el.elementId,
    ...(el.rotation ? { rotate: el.rotation } : {}),
    ...(el.flipH ? { flipH: true } : {}),
    ...(el.flipV ? { flipV: true } : {}),
    ...(el.opacity !== undefined && el.opacity < 1
      ? { transparency: Math.round((1 - Math.max(0, el.opacity)) * 100) }
      : {}),
  };
  if (hasCrop) {
    // When we own the srcRect we must not let pptxgenjs write one too — the
    // post-pass composes cover fit and crop into a single source rect.
    const rect = srcRectForCrop(el.crop!, fitMode, natural, w, h);
    srcRectPatches.push({
      slideIndex,
      objectName: el.elementId,
      crop: rect,
    });
    if (fitMode === "contain") {
      deg.push({
        slideIndex,
        elementId: el.elementId,
        kind: "image-crop-approx",
        reason: "contain-fit crop exported without letterbox margins",
      });
    }
  } else if (fitMode === "contain" || fitMode === "cover") {
    image.sizing = { type: fitMode, w: boxW, h: boxH };
  }
  slide.addImage(image);
  const clip = pictureClipPatch(el, slideIndex, deg, nativeShapeTypes);
  if (clip) clipPatches.push(clip);
}

export async function exportProjectToPptx(
  source: string | PptdProject,
  opts: ExportPptxOptions = {},
): Promise<ExportResult> {
  // A stored colour the exporter cannot resolve is written as its inherited or default colour and
  // reported as a degradation; it never fails the export. The loaded project itself is unchanged.
  const colors = sanitizeProjectColors(typeof source === "string" ? loadProject(source) : source);
  const project = colors.project;
  const size = project.presentation.size;
  const layout = { w: 10, h: (10 * size[1]) / size[0] };
  const pptx = createPptx();
  pptx.defineLayout({ name: "PPTD", width: layout.w, height: layout.h });
  pptx.layout = "PPTD";
  pptx.author = "DSH SlideStudio native exporter";
  pptx.title = project.presentation.title ?? "Deck";

  const layoutExport = layoutExportOf(project);
  const degradations: Degradation[] = [
    ...colorFallbackDegradations(ownColorFallbacks(project.pages, colors.fallbacks)),
    ...(layoutExport?.notes ?? []),
    ...pageNumberNotes(project.pages),
  ];
  const gradientPatches: GradientPatch[] = [];
  const customGeometryPatches: CustomGeometryPatch[] = [];
  const srcRectPatches: ImageSrcRectPatch[] = [];
  const imageClipPatches: SlideImageClipPatch[] = [];
  const strokePatches: NoStrokePatch[] = [];
  const shadowPatches: ShadowPatch[] = [];
  const backgroundPatches: BackgroundPatch[] = [];
  const pageNumberPatches: PageNumberPatch[] = [];
  const nativeShapeTypes = pptx.ShapeType as unknown as Readonly<Record<string, string>>;
  const chartPatches: ChartPatch[] = [];
  const editDataCharts = { ok: [] as string[], failed: [] as string[] };
  const editableLines: EditableLineEvidence[] = [];
  let mapped = 0;
  let failed = 0;

  // PptxGenJS binds a page to its layout by name when the page is added, so layouts come first.
  for (const definition of project.presentation.layouts ?? []) {
    pptx.defineSlideMaster({ title: layoutMasterName(definition.id) });
  }
  const drawBackground = (slide: PptxGenJS.Slide, fill: Fill | undefined, slideIndex: number): void => {
    const bg = fill as
      | {
          type?: string;
          color?: string;
          src?: string;
          stops?: { color?: string }[];
        }
      | undefined;
    if (bg) {
      if (bg.type === "solid" || (!bg.type && typeof bg.color === "string")) {
        slide.background = {
          color: hex(bg.color ?? "#FFFFFF", project.presentation.theme),
        };
      } else if (bg.type === "image" && bg.src) {
        let src = bg.src;
        if (!src.startsWith("http") && !src.startsWith("data:")) {
          const local = path.join(project.rootDir, src);
          if (fs.existsSync(local)) src = local;
          else {
            degradations.push({
              slideIndex,
              kind: "missing-image",
              reason: `page background not found: ${bg.src}`,
            });
            src = "";
          }
        }
        if (src) {
          try {
            slide.background = {
              path: src.startsWith("data:") ? undefined : src,
              data: src.startsWith("data:") ? src : undefined,
            } as PptxGenJS.BackgroundProps;
          } catch {
            degradations.push({
              slideIndex,
              kind: "image-fill-as-solid",
              reason: "page background image failed; solid fallback",
            });
            slide.background = { color: "111111" };
          }
        }
      } else if (bg.type === "gradient") {
        const page = pageBackgroundFill(bg as Fill, project.presentation.theme, degradations, slideIndex);
        slide.background = { color: page.color };
        if (page.gradient) backgroundPatches.push({ slideIndex, fill: page.gradient });
      }
    }
  };
  const drawElements = async (
    slide: PptxGenJS.Slide,
    elements: readonly PptdElement[],
    page: Page,
    slideIndex: number,
  ): Promise<void> => {
    const pageSurface = pageSurfaceColor(page, project.presentation.theme, size);
    for (const el of elements) {
      if (isMicroscopicHiddenChart(el)) continue;
      const shadow = shadowPatchFor(el, slideIndex, project.presentation.theme, degradations);
      if (shadow) shadowPatches.push(shadow);
      try {
        switch (el.elementType) {
          case "text":
            mapText(slide, el as TextElement, project.presentation.theme, size, layout);
            mapped++;
            // Only a page's own slide takes its number; carrier slides follow the pages.
            if (slideIndex < project.pages.length && isPageOwnNumber(el)) {
              pageNumberPatches.push(pageNumberPatchFor(el, slideIndex, project.pages.length));
            }
            break;
          case "shape": {
            const drawn = mapShape(
              slide,
              pptx.ShapeType as unknown as Readonly<Record<string, PptxGenJS.SHAPE_NAME>>,
              el as ShapeElement,
              project.presentation.theme,
              size,
              layout,
              degradations,
              slideIndex,
              gradientPatches,
              customGeometryPatches,
              strokePatches,
            );
            // The picture patch needs the shape's p:sp, so it exists only where mapShape drew one.
            const imageFill = drawn
              ? shapeImageFillPatch(slide, el as ShapeElement, project.rootDir, slideIndex, degradations)
              : undefined;
            if (imageFill) imageClipPatches.push(imageFill);
            mapped++;
            break;
          }
          case "table":
            mapTable(slide, el as TableElement, project.presentation.theme, size, layout);
            mapped++;
            break;
          case "chart":
            mapChart(
              slide,
              el as ChartElement,
              project.presentation.theme,
              size,
              layout,
              degradations,
              slideIndex,
              editDataCharts,
              exportedChartSurface(page.elements, el as ChartElement, pageSurface, project.presentation.theme),
              chartPatches,
            );
            mapped++;
            break;
          case "image":
            mapImage(
              slide,
              el as Extract<PptdElement, { elementType: "image" }>,
              project.rootDir,
              size,
              layout,
              degradations,
              slideIndex,
              srcRectPatches,
              imageClipPatches,
              nativeShapeTypes,
            );
            mapped++;
            break;
          case "line": {
            const evidence = mapLine(
              slide,
              el as LineElement,
              project.presentation.theme,
              size,
              layout,
              degradations,
              slideIndex,
              strokePatches,
            );
            // A line on a layout or master lives in that part, so it is not evidence about a slide.
            if (slideIndex < project.pages.length) editableLines.push(evidence);
            mapped++;
            break;
          }
          case "icon": {
            const ic = el as IconElement;
            await mapIcon(slide, ic, project.presentation.theme, size, layout, degradations, slideIndex);
            mapped++;
            break;
          }
          default:
            degradations.push({
              slideIndex,
              elementId: el.elementId,
              kind: "unsupported-element",
              reason: `elementType ${el.elementType} not mapped in shell exporter`,
            });
            failed++;
        }
      } catch (e) {
        failed++;
        degradations.push({
          slideIndex,
          elementId: el.elementId,
          kind: "error",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };
  for (const [slideIndex, lp] of project.pages.entries()) {
    const masterName = pageMasterName(project.presentation, lp.page);
    const slide = pptx.addSlide(masterName === undefined ? undefined : { masterName });
    // An inherited background is drawn by the layout, so the page's own slide leaves it out.
    if (lp.page.backgroundInherited !== true) drawBackground(slide, lp.page.background, slideIndex);
    await drawElements(slide, pageElementsToDraw(lp.page, layoutExport), lp.page, slideIndex);
    if (lp.page.notes) {
      slide.addNotes(lp.page.notes);
    }
  }
  // The carrier slides follow the pages, in the order layoutExportOf numbered them.
  for (const carrier of layoutExport?.carriers ?? []) {
    const slide = pptx.addSlide(
      carrier.layoutId === undefined ? undefined : { masterName: layoutMasterName(carrier.layoutId) },
    );
    const content = { elements: carrier.elements, background: carrier.background };
    drawBackground(slide, carrier.background, carrier.slideIndex);
    await drawElements(slide, carrier.elements, content, carrier.slideIndex);
  }

  let raw = await postProcessPptx((await pptx.write({ outputType: "nodebuffer" })) as Buffer, {
    customGeometries: customGeometryPatches,
    gradients: gradientPatches,
    srcRects: srcRectPatches,
    imageClips: imageClipPatches,
    noStrokes: strokePatches,
    shadows: shadowPatches,
    backgrounds: backgroundPatches,
    pageNumbers: pageNumberPatches,
    layouts: layoutExport,
    fixedTimestamps: true,
    charts: chartPatches,
    theme: project.presentation.theme,
  });
  let embeddedFonts: EmbeddedFontInfo[] | undefined;
  let skippedFonts: SkippedFont[] | undefined;
  if (opts.embedFonts) {
    // One bad face must never abort the export: plan-level failures degrade
    // to an empty embed set instead.
    const plan = await buildEmbeddedFonts(project, opts.embedFonts.families, opts.embedFonts.fontsDir).catch(
      (error) => ({
        fonts: [],
        skipped: [
          {
            typeface: "*",
            reason: error instanceof Error ? error.message : String(error),
          },
        ],
      }),
    );
    const packed = await embedFontsIntoPptx(raw, plan);
    raw = packed.data;
    embeddedFonts = packed.embedded;
    skippedFonts = plan.skipped;
  }
  const total = mapped + failed;
  const hard = degradations.filter(
    (d) =>
      (HARD_DEGRADATION_KINDS as readonly string[]).includes(d.kind) ||
      /full-page|raster slide|screenshot slide/i.test(d.reason ?? ""),
  );
  const report: ExportReport = {
    ok: hard.length === 0 && editDataCharts.failed.length === 0,
    slideCount: project.pages.length,
    nativeCoverage: total === 0 ? 1 : mapped / total,
    degradations,
    editDataCharts,
    editableLines,
    bytes: raw.byteLength,
    ...(embeddedFonts ? { embeddedFonts } : {}),
    ...(skippedFonts ? { skippedFonts } : {}),
  };

  const filename = `${(project.presentation.title ?? "deck").replace(/[^\w\u4e00-\u9fff-]+/g, "_")}.pptx`;
  return { data: raw, report, filename };
}

export async function exportProjectToFile(
  source: string | PptdProject,
  outPath: string,
  opts: ExportPptxOptions = {},
): Promise<ExportResult> {
  const result = await exportProjectToPptx(source, opts);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, result.data);
  return result;
}
