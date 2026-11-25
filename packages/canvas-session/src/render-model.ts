/**
 * Render model: the pure-data snapshot the editor, thumbnails, play view and
 * native DOM canvas paint from. No DOM and no editing commands live here.
 */
import {
  PAGE_COUNT_TOKEN,
  PAGE_NUMBER_TOKEN,
  fillPageNumberTokens,
  fontCss,
  isPlainRectShape,
  resolveTextStyle,
  resolvedLineBorder,
  tableCellSolidHex,
  tableCellTextHex,
  toCssColor,
  type AdjustHandle,
  type Bounds,
  type ChartElement,
  type ChartSeries,
  type ElementShadow,
  type IconElement,
  type ImageElement,
  type LineElement,
  type PptdElement,
  type Presentation,
  type RichTextRun,
  type ShapeElement,
  type SmartArtMeta,
  type TableElement,
  type Theme,
  type TextContent,
  type TextElement,
} from "@open-slidestudio/pptd-v2";
import { chartRenderFields, type ChartRenderFields } from "./chart-render-model.js";
import { fillCss } from "./fill-css.js";
import { paintColors } from "./paint-colors.js";
import { renderPageSurface } from "./page-surface.js";
import { pictureClipFields, shapeImageFillFields, type ImageFillRender } from "./image-clip-model.js";
import { renderShadow, type RenderShadow } from "./shadow-model.js";
import { shapeRenderFields } from "./shape-model.js";
import { pageCount, type CanvasSession } from "./session-model.js";
import { layoutPanel, layoutViewCopies, paintedBody } from "./layout-surface.js";

/** A layout has no page number yet, so its number field shows this mark. */
const LAYOUT_NUMBER_MARK = "‹#›";

/**
 * A master or layout copy on a page: its scope, the name of the master or layout it came from, and
 * the owner and element it copies. A double-click uses the ids to open that layout.
 */
export type RenderInherited = {
  scope: "master" | "layout";
  name: string;
  ownerId: string;
  elementId: string;
};

/** The stored text of a page-number field, which the editor edits while `text`/`runs` show the number. */
export type RenderEdit = { text: string; runs: RichTextRun[] };

export type RenderElement = {
  id: string;
  type: string;
  bounds: Bounds;
  rotation: number;
  opacity: number;
  /** Set only on a master or layout copy. Such copies are not selectable on the page. */
  inherited?: RenderInherited;
  /** Set only on a text whose shown text differs from its stored text. Editing offsets are in this text. */
  edit?: RenderEdit;
  flipH?: boolean;
  flipV?: boolean;
  text?: string;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  fontSize?: number;
  /** CSS font stack from the resolved {latin, ea} pair. */
  fontFamily?: string;
  /** Latin face of the pair, for the font menu. */
  fontLatin?: string;
  /** East Asian face of the pair, for the font menu. */
  fontEastAsian?: string;
  letterSpacing?: number;
  lineHeight?: number;
  align?: [string, string];
  list?: "bullet" | "number";
  href?: string;
  wrap?: boolean;
  runs?: RichTextRun[];
  shapeName?: string;
  adjustments?: number[];
  pathD?: string;
  /** Coordinate space of pathD for a custom path (geometry.viewBox). */
  viewBox?: [number, number];
  fillCss?: string;
  /** The shape's one opaque solid colour (pptd-v2 `opaqueSolidHex`); a plain panel's colour is the surface a chart takes. */
  solidCss?: string;
  /** A shape that is a plain preset rectangle (pptd-v2 `isPlainRectShape`); the only shape a chart takes its surface from. */
  plainRect?: boolean;
  border?: { style?: string; width?: number; color?: string };
  src?: string;
  fit?: string;
  crop?: { left?: number; top?: number; right?: number; bottom?: number };
  cropShape?: { shapeName: string; adjustments?: number[] };
  /** CSS clip-path for a picture clip, in the element's px box. */
  clipPath?: string;
  /** Picture fill of a shape: the source, stretch or tile, and the fill crop. */
  imageFill?: ImageFillRender;
  lineCurve?: string;
  table?: boolean;
  tableRows?: {
    text: string;
    bold?: boolean;
    color?: string;
    fill?: string;
    rowSpan?: number;
    colSpan?: number;
    align?: [string, string];
  }[][];
  columnWidths?: number[];
  chart?: boolean;
  chartTitle?: string;
  chartType?: string;
  chartData?: { cols: string[]; rows: (number | string | null)[][] };
  chartSeries?: ChartSeries[];
  chartLegend?: boolean | Record<string, unknown>;
  chartBackgroundCss?: string;
  chartColors?: string[];
  line?: boolean;
  linePoints?: string;
  connects?: [string, string];
  icon?: boolean;
  iconName?: string;
  underline?: boolean;
  backgroundColor?: string;
  lineArrow?: [string | null, string | null];
  lineLabel?: string;
  animation?: string;
  pathStroke?: string;
  adjustHandles?: AdjustHandle[];
  locked?: boolean;
  hidden?: boolean;
  groupId?: string;
  smartArt?: SmartArtMeta;
  shadow?: RenderShadow;
  chartLabels?: boolean;
  chartAxis?: { x?: string; y?: string; secondaryY?: string };
  chartGrouping?: ChartRenderFields["chartGrouping"];
};

/** The copy marker of a master or layout copy; undefined for the page's own element. */
function inheritedMark(element: PptdElement, presentation: Presentation): RenderInherited | undefined {
  const from = element.inherited;
  if (from === undefined) return undefined;
  const owners: { id: string; name: string }[] =
    (from.scope === "master" ? presentation.masters : presentation.layouts) ?? [];
  const owner = owners.find((item) => item.id === from.ownerId);
  return {
    scope: from.scope,
    name: owner?.name ?? from.ownerId,
    ownerId: from.ownerId,
    elementId: from.elementId,
  };
}

/**
 * The text a page shows: a pageNumber field reads its own position and the page count. A layout or
 * the master has no page, so its field shows ‹#› for the page's number.
 */
function shownContent(content: TextContent, session: CanvasSession): TextContent {
  if (content.field !== "pageNumber") return content;
  if (session.surface.kind !== "page") {
    const mark = LAYOUT_NUMBER_MARK;
    const text = content.text.split(PAGE_NUMBER_TOKEN).join(mark).split(PAGE_COUNT_TOKEN).join(mark);
    return { ...content, text };
  }
  const text = fillPageNumberTokens(content.text, session.pageIndex, pageCount(session));
  return { ...content, text };
}

function cssRuns(runs: RichTextRun[], theme: Theme | undefined): RichTextRun[] {
  return runs.map((run) => ({
    ...run,
    color: run.color ? toCssColor(run.color, theme) : undefined,
  }));
}

/** Snapshot for thumbnails / play / native DOM canvas: pure data, no DOM. */
export function renderModel(session: CanvasSession) {
  const { page, theme } = paintColors(paintedBody(session), session.project.presentation.theme);
  const size = session.project.presentation.size;
  const { backgroundCss, backgroundImage } = renderPageSurface(page, size, theme);
  // On a layout the master's elements show beneath it as view-only copies.
  const drawn = [...layoutViewCopies(session), ...page.elements];

  const elements: RenderElement[] = drawn.map((e) => {
    const inherited = inheritedMark(e, session.project.presentation);
    const base: RenderElement = {
      id: e.elementId,
      type: e.elementType,
      bounds: e.bounds as Bounds,
      rotation: e.rotation ?? 0,
      opacity: e.opacity ?? 1,
      ...(inherited ? { inherited } : {}),
      flipH: Boolean((e as { flipH?: boolean }).flipH),
      flipV: Boolean((e as { flipV?: boolean }).flipV),
      locked: Boolean((e as { locked?: boolean }).locked),
      hidden: Boolean((e as { hidden?: boolean }).hidden),
      groupId: (e as { groupId?: string }).groupId,
      smartArt: (e as { smartArt?: SmartArtMeta }).smartArt,
      shadow: renderShadow((e as { shadow?: ElementShadow }).shadow, theme),
    };
    if (e.elementType === "text") {
      const stored = (e as TextElement).content ?? { text: "" };
      const content = shownContent(stored, session);
      const st = resolveTextStyle(content, theme);
      // The editor edits and styles the stored text; `text`/`runs` carry the number it paints.
      const editing = content.text === stored.text ? undefined : resolveTextStyle(stored, theme);
      return {
        ...base,
        ...(editing ? { edit: { text: editing.text, runs: cssRuns(editing.runs, theme) } } : {}),
        text: st.text,
        bold: st.bold,
        italic: st.italic,
        color: st.color,
        fontSize: st.fontSize,
        fontFamily: fontCss(st.fontFamily),
        fontLatin: st.fontFamily.latin,
        fontEastAsian: st.fontFamily.ea,
        letterSpacing: st.letterSpacing,
        lineHeight: st.lineHeight,
        align: st.align,
        underline: st.underline,
        backgroundColor: st.backgroundColor,
        list: st.list,
        href: st.href,
        wrap: st.wrap,
        runs: cssRuns(st.runs, theme),
      };
    }
    if (e.elementType === "shape") {
      const shapeFields = shapeRenderFields(e as ShapeElement, theme);
      return {
        ...base,
        ...shapeFields,
        ...shapeImageFillFields(e as ShapeElement, session.project.rootDir, shapeFields.viewBox),
        plainRect: isPlainRectShape(e),
      };
    }
    if (e.elementType === "image") {
      const im = e as ImageElement;
      return {
        ...base,
        src: im.src,
        fit: im.fit?.mode,
        crop: im.crop,
        cropShape: im.cropShape,
        ...pictureClipFields(im),
      };
    }
    if (e.elementType === "table") {
      const tb = e as TableElement;
      return {
        ...base,
        table: true,
        columnWidths: tb.columnWidths,
        tableRows: tb.rows.map((row) =>
          row.map((c) => ({
            text: c.text ?? "",
            bold: c.bold,
            // The export's text colour and solid fill, so the editor paints the same hex.
            color: tableCellTextHex(c.color, theme),
            fill: tableCellSolidHex(c.fill, theme),
            rowSpan: c.rowSpan,
            colSpan: c.colSpan,
            align: c.align,
          })),
        ),
      };
    }
    if (e.elementType === "chart") {
      return { ...base, ...chartRenderFields(e as ChartElement, theme) };
    }
    if (e.elementType === "line") {
      const ln = e as LineElement;
      return {
        ...base,
        line: true,
        linePoints: ln.points,
        lineCurve: ln.curve || "round",
        border: resolvedLineBorder(ln.border, theme),
        lineArrow: ln.arrow ?? [null, null],
        lineLabel: ln.label,
        connects: ln.connects,
      };
    }
    if (e.elementType === "icon") {
      const ic = e as IconElement;
      return {
        ...base,
        icon: true,
        iconName: ic.iconName,
        fillCss: fillCss(ic.fill, theme, "icon"),
      };
    }
    return base;
  });

  return {
    title: session.project.presentation.title ?? "Untitled",
    rootDir: session.project.rootDir,
    size,
    pageIndex: session.pageIndex,
    pageCount: pageCount(session),
    pagePaths: session.project.pages.map((p) => p.path),
    background: page.background,
    backgroundCss,
    backgroundImage,
    elements,
    selection: session.selection,
    canUndo: session.undoStack.length > 0,
    canRedo: session.redoStack.length > 0,
    allowedControlIds: [...session.allowedControlIds],
    zoomPercent: session.zoomPercent,
    pageRailOpen: session.pageRailOpen,
    notesOpen: session.notesOpen,
    presenting: session.presenting,
    notes: page.notes ?? "",
    themeColors: theme?.colors ?? {},
    // Table rules and chart chrome switch to the neutral set only for palette-adopted decks.
    neutralChrome: theme?.neutralChrome === true,
    animations: page.animations ?? [],
    layoutPanel: layoutPanel(session),
  };
}

/** List all pages' render models for thumbnails (read-only projection). Thumbnails always show pages. */
export function renderAllPages(session: CanvasSession) {
  const saved = session.pageIndex;
  const savedSurface = session.surface;
  const out = [];
  session.surface = { kind: "page" };
  try {
    for (let i = 0; i < session.project.pages.length; i++) {
      session.pageIndex = i;
      out.push(renderModel(session));
    }
  } finally {
    session.pageIndex = saved;
    session.surface = savedSurface;
  }
  return out;
}
