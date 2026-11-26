/**
 * Stored colours the exporter cannot resolve: an unknown `$token`, a `$a -> $b -> $a` cycle, an
 * unprefixed hex that is not six digits, or a named colour in run HTML. Decks saved before the
 * write refusal can carry them. Each one is replaced by the colour the element would inherit
 * without it, or by the documented default, so the export never throws on a stored colour and the
 * editor paints the same result. A string of exactly six hex digits without `#` is not a fallback:
 * it is read first as the `#RRGGBB` it spells. The stored project is never changed: callers get
 * copies plus the list of what was replaced, and the export records one `color-fallback`
 * degradation per element.
 */
import { unstyledLineColor } from "./line-border.js";
import { parseRichText, serializeRichText, toRgbHex, unescapePlainText } from "./theme.js";
import type { Fill, GradientFill, GradientStop, Page, PptdElement, PptdProject, TextElement, Theme } from "./types.js";

/** An element whose stored colour was replaced. Without `elementId` it is the page background. */
export type ColorFallback = { pageIndex: number; elementId?: string };

export type SanitizedDeckColors = {
  pages: Page[];
  theme: Theme | undefined;
  fallbacks: ColorFallback[];
};

type Draft = Record<string, unknown>;

function isObject(value: unknown): value is Draft {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exactly six hex digits: a colour written without its `#`. */
const UNPREFIXED_RRGGBB = /^[0-9A-Fa-f]{6}$/;

/**
 * The `#RRGGBB` (uppercase) that a six-digit unprefixed hex spells. Any other value comes back
 * unchanged, so it still falls back when it cannot resolve.
 */
export function readableColor(value: string): string {
  return UNPREFIXED_RRGGBB.test(value) ? `#${value.toUpperCase()}` : value;
}

/**
 * Keys whose string is one colour: the leaves the write guard checks (`visitWritePageColors` in
 * presentation-run layout-qa.ts). A `colors` array holds a chart's swatches.
 */
const COLOUR_KEYS = new Set(["color", "backgroundColor", "fill", "colors"]);

/**
 * `value` with every colour string spelled as `#RRGGBB`. Objects and arrays are copied only when
 * something inside them changes. Every string under a `colors` object is a theme palette colour.
 */
function readColours(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    return key !== undefined && COLOUR_KEYS.has(key) ? readableColor(value) : value;
  }
  if (Array.isArray(value)) {
    const list = value as unknown[];
    const items = list.map((item) => readColours(item, key));
    return items.some((item, index) => item !== list[index]) ? items : value;
  }
  if (!isObject(value)) return value;
  const palette = key === "colors";
  let next: Draft | undefined;
  for (const [name, nested] of Object.entries(value)) {
    const read = palette && typeof nested === "string" ? readableColor(nested) : readColours(nested, name);
    if (read === nested) continue;
    if (!next) next = { ...value };
    next[name] = read;
  }
  return next ?? value;
}

/**
 * The run HTML with every run colour spelled as `#RRGGBB`. Text without such a run comes back as
 * it is, so plain and canonical text keep their bytes in the copy.
 */
function readRunColours(text: string): string {
  const runs = parseRichText(unescapePlainText(text), { readBareHex: true });
  const spelled = runs.some((run) => run.color !== undefined && readableColor(run.color) !== run.color);
  if (!spelled) return text;
  return serializeRichText(
    runs.map((run) => (run.color === undefined ? run : { ...run, color: readableColor(run.color) })),
  );
}

/** A text element with its run colours read. The same element comes back when none change. */
function readTextRuns(element: PptdElement): PptdElement {
  const content = (element as Partial<TextElement>).content;
  if (element.elementType !== "text" || typeof content?.text !== "string") return element;
  const text = readRunColours(content.text);
  if (text === content.text) return element;
  return { ...element, content: { ...content, text } } as PptdElement;
}

/** A page with its colours read. The same page comes back when nothing in it changes. */
function readPage(page: Page): Page {
  const styled = readColours(page) as Page;
  const elements = styled.elements.map(readTextRuns);
  return elements.some((element, index) => element !== styled.elements[index]) ? { ...styled, elements } : styled;
}

/** True for a colour `toRgbHex` refuses. A missing colour is not refused: it takes the default. */
function unresolvable(value: unknown, theme: Theme | undefined): boolean {
  if (value == null) return false;
  try {
    toRgbHex(String(value), theme);
    return false;
  } catch {
    return true;
  }
}

/**
 * A fill without its refused colours. A solid fill with a refused colour is dropped. Gradient stops
 * are filtered: a gradient left with one stop becomes that stop's solid fill, the paint the exporter
 * writes for a one-stop gradient, and one left with no stop is dropped.
 */
function cleanFill(fill: Fill, theme: Theme | undefined): { value: Fill | undefined; changed: boolean } {
  const loose = fill as { type?: string; color?: unknown; stops?: GradientStop[] };
  if (loose.type === "gradient" && Array.isArray(loose.stops)) {
    const stops = loose.stops.filter((stop) => !unresolvable(stop?.color, theme));
    if (stops.length === loose.stops.length) return { value: fill, changed: false };
    if (stops.length === 1) {
      return { value: { type: "solid", color: stops[0]!.color }, changed: true };
    }
    const gradient = { ...(fill as GradientFill), stops };
    return { value: stops.length ? gradient : undefined, changed: true };
  }
  const solid = loose.type === "solid" || (!loose.type && typeof loose.color === "string");
  if (solid && unresolvable(loose.color, theme)) return { value: undefined, changed: true };
  return { value: fill, changed: false };
}

/** Clean the fill stored under `key` on a copy. Returns true when it changed. */
function cleanFillKey(draft: Draft, key: string, theme: Theme | undefined): boolean {
  const fill = draft[key];
  if (!isObject(fill)) return false;
  const cleaned = cleanFill(fill as Fill, theme);
  if (!cleaned.changed) return false;
  if (cleaned.value) draft[key] = cleaned.value;
  else delete draft[key];
  return true;
}

/** An unresolvable border colour becomes the unstyled line colour, as the line renderers draw it. */
function cleanBorder(draft: Draft, theme: Theme | undefined): boolean {
  const border = draft.border;
  if (!isObject(border) || !unresolvable(border.color, theme)) return false;
  draft.border = { ...border, color: unstyledLineColor(theme) };
  return true;
}

/** A shadow without its colour keeps blur and offsets and takes the default shadow colour. */
function cleanShadow(draft: Draft, theme: Theme | undefined): boolean {
  const shadow = draft.shadow;
  if (!isObject(shadow) || !unresolvable(shadow.color, theme)) return false;
  const next = { ...shadow };
  delete next.color;
  draft.shadow = next;
  return true;
}

/**
 * Text colour, highlight and run colours. An inherited theme text style that cannot resolve also
 * counts: the element takes the next colour in the chain once the theme copy drops that value.
 */
function cleanText(draft: Draft, theme: Theme | undefined): boolean {
  const content = draft.content;
  if (!isObject(content)) return false;
  const styleName = typeof content.style === "string" ? content.style.replace(/^\$/, "") : "";
  const style = styleName ? theme?.textStyles?.[styleName] : undefined;
  const next: Draft = { ...content };
  let changed = false;
  if (unresolvable(content.color, theme)) {
    delete next.color;
    changed = true;
  } else if (content.color == null && unresolvable(style?.color, theme)) {
    changed = true;
  }
  if (unresolvable(content.backgroundColor, theme)) {
    delete next.backgroundColor;
    changed = true;
  } else if (content.backgroundColor == null && unresolvable(style?.backgroundColor, theme)) {
    changed = true;
  }
  if (typeof content.text === "string") {
    const runs = parseRichText(unescapePlainText(content.text));
    if (runs.some((run) => unresolvable(run.color, theme))) {
      next.text = serializeRichText(
        runs.map((run) => (unresolvable(run.color, theme) ? { ...run, color: undefined } : run)),
      );
      changed = true;
    }
  }
  if (changed) draft.content = next;
  return changed;
}

function cleanTable(draft: Draft, theme: Theme | undefined): boolean {
  if (!Array.isArray(draft.rows)) return false;
  let changed = false;
  const rows = (draft.rows as unknown[]).map((row) => {
    if (!Array.isArray(row)) return row;
    return (row as unknown[]).map((cell) => {
      if (!isObject(cell)) return cell;
      const next: Draft = { ...cell };
      let cellChanged = false;
      if (unresolvable(cell.color, theme)) {
        delete next.color;
        cellChanged = true;
      }
      if (cleanFillKey(next, "fill", theme)) cellChanged = true;
      if (!cellChanged) return cell;
      changed = true;
      return next;
    });
  });
  if (changed) draft.rows = rows;
  return changed;
}

/**
 * A refused swatch becomes "", which `chartSwatch` reads as missing, so the series fill or the
 * palette takes its place on both the canvas and the exporter.
 */
function cleanChart(draft: Draft, theme: Theme | undefined): boolean {
  let changed = false;
  if (Array.isArray(draft.colors)) {
    const original = draft.colors as unknown[];
    const colors = original.map((color) => (unresolvable(color, theme) ? "" : color));
    if (colors.some((color, index) => color !== original[index])) {
      draft.colors = colors;
      changed = true;
    }
  }
  if (Array.isArray(draft.series)) {
    const original = draft.series as unknown[];
    let seriesChanged = false;
    const series = original.map((item) => {
      if (!isObject(item)) return item;
      const next: Draft = { ...item };
      let itemChanged = false;
      if (typeof item.fill === "string") {
        if (unresolvable(item.fill, theme)) {
          delete next.fill;
          itemChanged = true;
        }
      } else if (cleanFillKey(next, "fill", theme)) {
        itemChanged = true;
      }
      if (!itemChanged) return item;
      seriesChanged = true;
      return next;
    });
    if (seriesChanged) {
      draft.series = series;
      changed = true;
    }
  }
  if (cleanFillKey(draft, "background", theme)) changed = true;
  return changed;
}

function cleanByType(draft: Draft, theme: Theme | undefined): boolean {
  switch (draft.elementType) {
    case "text":
      return cleanText(draft, theme);
    case "shape": {
      const fill = cleanFillKey(draft, "fill", theme);
      const border = cleanBorder(draft, theme);
      return fill || border;
    }
    case "line":
      return cleanBorder(draft, theme);
    case "table":
      return cleanTable(draft, theme);
    case "chart":
      return cleanChart(draft, theme);
    case "icon":
      return cleanFillKey(draft, "fill", theme);
    default:
      return false;
  }
}

function cleanElement(source: PptdElement, theme: Theme | undefined): { element: PptdElement; changed: boolean } {
  const draft: Draft = { ...source };
  const byType = cleanByType(draft, theme);
  const shadow = cleanShadow(draft, theme);
  if (!byType && !shadow) return { element: source, changed: false };
  return { element: draft as PptdElement, changed: true };
}

function fallbackFor(pageIndex: number, elementId?: string): ColorFallback {
  return elementId === undefined ? { pageIndex } : { pageIndex, elementId };
}

function sanitizePage(page: Page, pageIndex: number, theme: Theme | undefined, fallbacks: ColorFallback[]): Page {
  let background = page.background;
  let changed = false;
  if (page.background) {
    const cleaned = cleanFill(page.background, theme);
    if (cleaned.changed) {
      // The documented page default is white, so a refused background becomes that solid fill.
      background = cleaned.value ?? { type: "solid", color: "#FFFFFF" };
      changed = true;
      fallbacks.push(fallbackFor(pageIndex));
    }
  }
  const elements = page.elements.map((element) => {
    const cleaned = cleanElement(element, theme);
    if (!cleaned.changed) return element;
    changed = true;
    fallbacks.push(fallbackFor(pageIndex, element.elementId));
    return cleaned.element;
  });
  if (!changed) return page;
  const next: Page = { ...page, elements };
  if (background) next.background = background;
  else delete next.background;
  return next;
}

/** The theme with unresolvable text style colours removed. The same object when none are refused. */
function sanitizeTextStyles(theme: Theme | undefined): Theme | undefined {
  const styles = theme?.textStyles;
  if (!theme || !styles) return theme;
  let changed = false;
  const next: Record<string, Record<string, unknown>> = {};
  for (const [name, style] of Object.entries(styles)) {
    let cleaned = style;
    for (const key of ["color", "backgroundColor"]) {
      if (!unresolvable(style?.[key], theme)) continue;
      if (cleaned === style) cleaned = { ...style };
      delete cleaned[key];
      changed = true;
    }
    next[name] = cleaned;
  }
  return changed ? { ...theme, textStyles: next } : theme;
}

/**
 * Read and replace stored colours, on copies. A six-digit unprefixed hex is first read as the
 * `#RRGGBB` it spells, which is no fallback. Then every colour that still cannot resolve is
 * replaced: a page background with a refused colour becomes white; a shape or line border takes
 * the unstyled line colour; text takes the colour it inherits; a fill or swatch that cannot resolve
 * is removed. Pages, elements and theme come back as the same objects when nothing in them changes.
 */
export function sanitizeDeckColors(pages: readonly Page[], theme: Theme | undefined): SanitizedDeckColors {
  const read = readColours(theme) as Theme | undefined;
  const fallbacks: ColorFallback[] = [];
  const cleanPages = pages.map((page, pageIndex) => sanitizePage(readPage(page), pageIndex, read, fallbacks));
  return { pages: cleanPages, theme: sanitizeTextStyles(read), fallbacks };
}

/** `sanitizeDeckColors` for a whole loaded project, with the project itself left untouched. */
export function sanitizeProjectColors(project: PptdProject): {
  project: PptdProject;
  fallbacks: ColorFallback[];
} {
  const result = sanitizeDeckColors(
    project.pages.map((loaded) => loaded.page),
    project.presentation.theme,
  );
  const unchanged =
    result.theme === project.presentation.theme &&
    result.pages.every((page, index) => page === project.pages[index]?.page);
  if (unchanged) return { project, fallbacks: result.fallbacks };
  return {
    project: {
      ...project,
      presentation: { ...project.presentation, theme: result.theme },
      pages: project.pages.map((loaded, index) =>
        result.pages[index] === loaded.page ? loaded : { ...loaded, page: result.pages[index]! },
      ),
    },
    fallbacks: result.fallbacks,
  };
}
