/**
 * Skill produce path: compose_deck writes YAML PPTD v2 pages (elements + bounds).
 * This is what open-kimi SKILL.md step 3 means by "produce the presentation".
 * role+bullets IR is a fallback, not the skill output.
 */
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import type {
  Bounds,
  ChartData,
  ChartElement,
  ChartSeries,
  ExhibitRole,
  Fill,
  LayoutRole,
  Page,
  PptdElement,
  PptdProject,
  ShapeElement,
  TableCell,
  TableElement,
  TextContent,
  TextElement,
} from "@open-slidestudio/pptd-v2";
import { isCanonicalWritePageArgs, unescapePlainText } from "@open-slidestudio/pptd-v2";
import { pageFileName, textOf } from "./skill-deck-view.js";
export { skillToCompose } from "./skill-deck-view.js";
import type { Palette } from "./playbook.js";
import { asRecord, asString, coerceElementList, liftBareCopy, parseJsonMaybe } from "./skill-page-dialect.js";

export type SkillPageInput = {
  id: string;
  pageType?: string;
  /** The write_layout id this page inherits its copies from; absent means no layout. */
  layoutId?: string;
  notes?: string;
  background?: Fill;
  animations?: Page["animations"];
  elements: PptdElement[];
};

export type SkillDeckInput = {
  title: string;
  pages: SkillPageInput[];
};

const ELEMENT_TYPES = new Set(["text", "shape", "image", "table", "chart", "line", "icon"]);

function asLayoutRole(value: unknown): LayoutRole | undefined {
  const role = asString(value);
  return role === "footer" || role === "content" || role === "decoration" ? role : undefined;
}

function asExhibitRole(value: unknown): ExhibitRole | undefined {
  const role = asString(value);
  return role === "funnel" ||
    role === "gauge" ||
    role === "pyramid" ||
    role === "matrix" ||
    role === "timeline" ||
    role === "kpi-card" ||
    role === "comparison-card"
    ? role
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function unwrapItemWrapper(raw: unknown): unknown {
  let value = raw;
  for (let i = 0; i < 6; i += 1) {
    const rec = asRecord(value);
    if (!rec || Object.keys(rec).length !== 1 || !("item" in rec)) return value;
    value = rec.item;
  }
  return value;
}

export function parseBounds(raw: unknown): Bounds | null {
  const value = unwrapItemWrapper(parseJsonMaybe(raw));
  if (Array.isArray(value) && value.length >= 4) {
    const left = asNumber(value[0]);
    const top = asNumber(value[1]);
    const width = asNumber(value[2]);
    const height = asNumber(value[3]);
    if (
      left === undefined ||
      top === undefined ||
      width === undefined ||
      height === undefined ||
      width <= 0 ||
      height <= 0
    ) {
      return null;
    }
    return [left, top, width, height];
  }
  const rec = asRecord(value);
  if (!rec) return null;
  const left = asNumber(rec.left ?? rec.x);
  const top = asNumber(rec.top ?? rec.y);
  const width = asNumber(rec.width ?? rec.w);
  const height = asNumber(rec.height ?? rec.h);
  if (
    left === undefined ||
    top === undefined ||
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return [left, top, width, height];
}

function rgbHex(raw: unknown): string | undefined {
  if (!Array.isArray(raw) || raw.length < 3) return undefined;
  const r = asNumber(raw[0]);
  const g = asNumber(raw[1]);
  const b = asNumber(raw[2]);
  if (
    r === undefined ||
    g === undefined ||
    b === undefined ||
    r < 0 ||
    r > 255 ||
    g < 0 ||
    g > 255 ||
    b < 0 ||
    b > 255
  ) {
    return undefined;
  }
  const hex = [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
  return `#${hex}`.toUpperCase();
}

function parseFill(raw: unknown): Fill | undefined {
  if (typeof raw === "string" && /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(raw.trim())) {
    return { type: "solid", color: raw.trim() };
  }
  const rgb = rgbHex(raw);
  if (rgb) return { type: "solid", color: rgb };
  const rec = asRecord(raw);
  if (!rec) return undefined;
  if (rec.type === "image" && asString(rec.src)) {
    return { type: "image", src: asString(rec.src)! };
  }
  if (rec.type === "solid" && asString(rec.color)) {
    return { type: "solid", color: asString(rec.color)! };
  }
  if (rec.type === "gradient" && Array.isArray(rec.stops)) {
    return rec as unknown as Fill;
  }
  if (asString(rec.color)) return { type: "solid", color: asString(rec.color)! };
  const fromColor = rgbHex(rec.color);
  if (fromColor) return { type: "solid", color: fromColor };
  const nested = asString(rec.fill);
  if (nested && /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(nested)) {
    return { type: "solid", color: nested };
  }
  const fromFill = rgbHex(rec.fill);
  if (fromFill) return { type: "solid", color: fromFill };
  return undefined;
}

function parseFontFamily(raw: unknown): TextContent["fontFamily"] | undefined {
  const family = asString(raw);
  if (family) return family;
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const latin = asString(rec.latin);
  const ea = asString(rec.ea);
  if (latin && ea) return { latin, ea };
  return latin ?? ea;
}

function parseTextAlign(raw: unknown): [string, string] | undefined {
  const value = parseJsonMaybe(raw);
  if (Array.isArray(value) && value.length >= 2) {
    return [String(value[0]), String(value[1])];
  }
  const align = asString(value)?.toLowerCase();
  if (align === "center") return ["center", "middle"];
  if (align === "right") return ["right", "top"];
  if (align === "left") return ["left", "top"];
  return undefined;
}

function parseTextList(raw: unknown): TextContent["list"] | undefined {
  const list = asString(raw);
  return list === "bullet" || list === "number" ? list : undefined;
}

function asTextString(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}

function parseTextContent(rec: Record<string, unknown>): TextContent | null {
  const nestedText = asRecord(rec.text);
  const content = asRecord(rec.content) ?? nestedText;
  const style = asRecord(rec.style);
  const text =
    asTextString(content?.text) ??
    asTextString(content?.content) ??
    asTextString(rec.content) ??
    asTextString(rec.text) ??
    asTextString(rec.title) ??
    asTextString(rec.body) ??
    asTextString(rec.heading);
  if (!text) return null;
  const out: TextContent = {
    text: unescapePlainText(text),
    wrap:
      (typeof content?.wrap === "boolean" ? content.wrap : undefined) ??
      (typeof rec.wrap === "boolean" ? rec.wrap : undefined) ??
      (typeof style?.wrap === "boolean" ? style.wrap : undefined) ??
      true,
  };
  const weight =
    content?.fontWeight ?? content?.weight ?? rec.fontWeight ?? rec.weight ?? style?.fontWeight ?? style?.weight;
  const bold =
    (typeof content?.bold === "boolean" ? content.bold : undefined) ??
    (typeof rec.bold === "boolean" ? rec.bold : undefined) ??
    (typeof style?.bold === "boolean" ? style.bold : undefined) ??
    (asString(weight) === "bold" || asString(weight) === "semibold" ? true : undefined) ??
    (typeof weight === "number" && weight >= 600 ? true : undefined) ??
    (typeof weight === "string" && Number(weight) >= 600 ? true : undefined);
  if (bold !== undefined) out.bold = bold;
  const italic =
    (typeof content?.italic === "boolean" ? content.italic : undefined) ??
    (typeof rec.italic === "boolean" ? rec.italic : undefined) ??
    (typeof style?.italic === "boolean" ? style.italic : undefined);
  if (italic !== undefined) out.italic = italic;
  const underline =
    (typeof content?.underline === "boolean" ? content.underline : undefined) ??
    (typeof rec.underline === "boolean" ? rec.underline : undefined) ??
    (typeof style?.underline === "boolean" ? style.underline : undefined);
  if (underline !== undefined) out.underline = underline;
  const fontSize =
    asNumber(content?.fontSize) ??
    asNumber(rec.fontSize) ??
    asNumber(style?.fontSize) ??
    namedFontSize(content?.size ?? rec.size ?? style?.size);
  if (fontSize !== undefined) out.fontSize = fontSize;
  const color =
    asString(content?.color) ??
    rgbHex(content?.color) ??
    asString(rec.color) ??
    rgbHex(rec.color) ??
    asString(style?.color) ??
    rgbHex(style?.color) ??
    asString(rec.textColor) ??
    asString(style?.textColor) ??
    (typeof rec.fill === "string" ? asString(rec.fill) : undefined) ??
    rgbHex(rec.fill);
  if (color) out.color = color;
  const fontFamily =
    parseFontFamily(content?.fontFamily) ?? parseFontFamily(rec.fontFamily) ?? parseFontFamily(style?.fontFamily);
  if (fontFamily) out.fontFamily = fontFamily;
  const namedStyle = asString(content?.style) ?? asString(rec.style);
  if (namedStyle) out.style = namedStyle;
  const backgroundColor =
    asString(content?.backgroundColor) ??
    rgbHex(content?.backgroundColor) ??
    asString(rec.backgroundColor) ??
    rgbHex(rec.backgroundColor) ??
    asString(style?.backgroundColor) ??
    rgbHex(style?.backgroundColor);
  if (backgroundColor) out.backgroundColor = backgroundColor;
  const lineHeight = asNumber(content?.lineHeight) ?? asNumber(rec.lineHeight) ?? asNumber(style?.lineHeight);
  if (lineHeight !== undefined) out.lineHeight = lineHeight;
  const letterSpacing =
    asNumber(content?.letterSpacing) ?? asNumber(rec.letterSpacing) ?? asNumber(style?.letterSpacing);
  if (letterSpacing !== undefined) out.letterSpacing = letterSpacing;
  const align = parseTextAlign(content?.align) ?? parseTextAlign(rec.align) ?? parseTextAlign(style?.align);
  if (align) out.align = align;
  const list = parseTextList(content?.list) ?? parseTextList(rec.list) ?? parseTextList(style?.list);
  if (list) out.list = list;
  const href = asString(content?.href) ?? asString(rec.href) ?? asString(style?.href);
  if (href) out.href = href;
  return out;
}

function namedFontSize(raw: unknown): number | undefined {
  const n = asNumber(raw);
  if (n !== undefined) return n;
  const s = asString(raw)?.toLowerCase();
  if (!s) return undefined;
  const map: Record<string, number> = {
    hero: 40,
    title: 32,
    heading: 22,
    subtitle: 16,
    body: 16,
    caption: 14,
    giant: 48,
    medium: 18,
    small: 14,
  };
  return map[s];
}

function isSlideChrome(type: string | undefined): boolean {
  return type === "slide" || type === "page" || type === "background";
}

function parseAxisLen(raw: unknown, axis: number): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (t.endsWith("%")) {
    const n = Number(t.slice(0, -1));
    if (Number.isFinite(n)) return (n / 100) * axis;
    return undefined;
  }
  return asNumber(t);
}

function styleBox(style: Record<string, unknown> | null): number[] | null {
  if (!style) return null;
  const left = parseAxisLen(style.left ?? style.x, 960);
  const top = parseAxisLen(style.top ?? style.y, 540);
  const width = parseAxisLen(style.width ?? style.w, 960);
  const height = parseAxisLen(style.height ?? style.h, 540);
  if (left === undefined || top === undefined || width === undefined || height === undefined) {
    return null;
  }
  if (width <= 0 || height <= 0) return null;
  return [left, top, width, height];
}

function canvasBounds(rec: Record<string, unknown>): unknown {
  const styled = styleBox(asRecord(rec.style));
  if (styled) return styled;
  return rec.bounds ?? rec.position ?? [rec.x ?? rec.left, rec.y ?? rec.top, rec.w ?? rec.width, rec.h ?? rec.height];
}

/**
 * The agent / OpenKimi writes canvas shorthand
 * `{ type, position|{x,y,w,h}, text|background.fill }` as well as PPTD `{ elementType, bounds }`.
 * Official playbook vocab: text / box / rect / roundRect / ellipse — not a custom Host dialect.
 */
function looksLikeTable(rec: Record<string, unknown>): boolean {
  return rec.rows != null || rec.columnWidths != null || asRecord(rec.table)?.rows != null;
}

function normalizeCanvasElement(rec: Record<string, unknown>): Record<string, unknown> {
  if (asString(rec.elementType)) {
    return { ...rec, bounds: rec.bounds ?? canvasBounds(rec) };
  }
  if (looksLikeTable(rec) && !asString(rec.type)) {
    return { ...rec, elementType: "table", bounds: rec.bounds ?? canvasBounds(rec) };
  }
  const type = asString(rec.type);
  if (!type) return rec;
  if (isSlideChrome(type)) return rec;
  const elementType =
    type === "text" ||
    type === "title" ||
    type === "heading" ||
    type === "subtitle" ||
    type === "body" ||
    type === "label" ||
    type === "header"
      ? "text"
      : type === "image"
        ? "image"
        : type === "line"
          ? "line"
          : type === "table"
            ? "table"
            : type === "chart"
              ? "chart"
              : type === "icon"
                ? "icon"
                : type === "rect" ||
                    type === "roundRect" ||
                    type === "ellipse" ||
                    type === "circle" ||
                    type === "shape" ||
                    type === "box" ||
                    type === "card" ||
                    type === "panel"
                  ? "shape"
                  : undefined;
  if (!elementType) return rec;
  const style = asRecord(rec.style);
  const next: Record<string, unknown> = {
    ...rec,
    elementType,
    bounds: canvasBounds(rec),
  };
  if (style) {
    if (!next.fill && style.fill) next.fill = style.fill;
    if (!next.color && style.color) next.color = style.color;
    if (next.fontSize === undefined && style.fontSize !== undefined) next.fontSize = style.fontSize;
    if (next.fontWeight === undefined && style.fontWeight !== undefined) next.fontWeight = style.fontWeight;
    if (typeof next.content !== "string" && typeof rec.content === "string") next.text = rec.content;
  }
  if (elementType === "shape") {
    const named = asString(rec.shape) ?? asString(rec.shapeName);
    next.shapeName =
      named ??
      (type === "roundRect" ||
      type === "box" ||
      type === "card" ||
      type === "panel" ||
      asNumber(rec.rx) !== undefined ||
      asNumber(rec.radius) !== undefined
        ? "roundRect"
        : type === "ellipse" || type === "circle" || named === "ellipse" || named === "circle"
          ? "ellipse"
          : "rect");
    if (next.shapeName === "circle") next.shapeName = "ellipse";
    if (!next.fill && rec.background) next.fill = rec.background;
  }
  if (elementType === "text" && !next.text && type === "title") next.text = rec.title;
  return next;
}

/** OpenKimi PPTD is `data.cols` + `data.rows`. Models often send `{ chart: { rows, encode } }` without cols. */
export function normalizeChartInput(rec: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(rec.chart);
  const dataRec = asRecord(rec.data) ?? asRecord(nested?.data);
  const encode = asRecord(rec.encode) ?? asRecord(nested?.encode) ?? asRecord(dataRec?.encode);
  const rows = Array.isArray(rec.rows)
    ? rec.rows
    : Array.isArray(dataRec?.rows)
      ? dataRec.rows
      : Array.isArray(nested?.rows)
        ? nested.rows
        : undefined;
  let cols = Array.isArray(rec.cols)
    ? rec.cols
    : Array.isArray(dataRec?.cols)
      ? dataRec.cols
      : Array.isArray(nested?.cols)
        ? nested.cols
        : undefined;
  if ((!cols || cols.length < 2) && Array.isArray(rows) && rows.length) {
    const x = asString(encode?.x);
    const y = asString(encode?.y);
    if (x && y) cols = [x, y];
    else {
      const width = Array.isArray(rows[0]) ? rows[0].length : 0;
      if (width >= 2) cols = width === 2 ? ["项", "值"] : Array.from({ length: width }, (_, i) => `c${i + 1}`);
    }
  }
  const series = rec.series ?? nested?.series ?? dataRec?.series;
  return {
    ...rec,
    ...(cols && rows ? { data: { cols, rows } } : {}),
    ...(series ? { series } : {}),
  };
}

function parseChartData(raw: unknown): ChartData | null {
  const rec = asRecord(parseJsonMaybe(raw));
  if (!rec) return null;
  const normalized = normalizeChartInput(rec);
  const data = asRecord(normalized.data) ?? normalized;
  if (!Array.isArray(data.cols) || !Array.isArray(data.rows)) return null;
  const cols = data.cols.filter((c): c is string => typeof c === "string").slice(0, 8);
  if (cols.length < 2) return null;
  const rows: (string | number | null)[][] = [];
  for (const row of data.rows.slice(0, 12)) {
    if (!Array.isArray(row)) continue;
    rows.push(
      row.slice(0, cols.length).map((cell) => {
        if (typeof cell === "number" && Number.isFinite(cell)) return cell;
        if (typeof cell === "string") return cell;
        return null;
      }),
    );
  }
  return rows.length ? { cols, rows } : null;
}

function parseSeries(raw: unknown, data: ChartData): ChartSeries[] {
  if (Array.isArray(raw) && raw.length) {
    return raw.slice(0, 6).map((item, i) => {
      const rec = asRecord(item) ?? {};
      return {
        type: asString(rec.type) ?? "bar",
        name: asString(rec.name) ?? data.cols[i + 1] ?? `S${i + 1}`,
        encode: asRecord(rec.encode) as ChartSeries["encode"],
        fill: typeof rec.fill === "string" ? rec.fill : undefined,
        axis: rec.axis === "secondary" ? "secondary" : rec.axis === "primary" ? "primary" : undefined,
      };
    });
  }
  return [
    {
      type: "bar",
      name: data.cols[1] ?? "值",
      encode: { x: data.cols[0] ?? "项", y: data.cols[1] ?? "值" },
    },
  ];
}

function unwrapItemBag(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  const rec = asRecord(value);
  if (!rec) return value;
  const keys = Object.keys(rec);
  if (keys.length === 1 && keys[0] === "item") return unwrapItemBag(rec.item, depth + 1);
  return value;
}

function tableRowCells(row: unknown): unknown[] | null {
  const unwrapped = unwrapItemBag(row);
  if (Array.isArray(unwrapped)) return unwrapped;
  const rec = asRecord(unwrapped);
  if (!rec) return null;
  if (Array.isArray(rec.item)) return rec.item;
  if (Array.isArray(rec.cells)) return rec.cells;
  if (Array.isArray(rec.row)) return rec.row;
  return null;
}

function parseTableRows(raw: unknown): TableCell[][] | null {
  const unwrapped = unwrapItemBag(raw);
  const rec = asRecord(unwrapped);
  const list = Array.isArray(unwrapped)
    ? unwrapped
    : Array.isArray(rec?.rows)
      ? rec.rows
      : Array.isArray(rec?.item)
        ? rec.item
        : null;
  if (!list || list.length === 0) return null;
  const rows: TableCell[][] = [];
  for (const row of list.slice(0, 16)) {
    const cells = tableRowCells(row);
    if (!cells) continue;
    rows.push(
      cells.slice(0, 8).map((cell) => {
        if (typeof cell === "string" || typeof cell === "number") {
          return { text: String(cell) };
        }
        const cellRec = asRecord(unwrapItemBag(cell));
        return {
          text: asString(cellRec?.text) ?? "",
          bold: typeof cellRec?.bold === "boolean" ? cellRec.bold : undefined,
          color: asString(cellRec?.color),
          fill: cellRec ? parseFill(cellRec.fill) : undefined,
        };
      }),
    );
  }
  return rows.length ? rows : null;
}

function listItemCopy(item: unknown): { name: string; note: string } {
  if (typeof item === "string") return { name: item.trim(), note: "" };
  const rec = asRecord(item);
  return {
    name: (asString(rec?.name) ?? asString(rec?.text) ?? asString(rec?.title) ?? "").trim(),
    note: (
      asString(rec?.note) ??
      asString(rec?.desc) ??
      asString(rec?.description) ??
      asString(rec?.subtitle) ??
      asString(rec?.body) ??
      ""
    ).trim(),
  };
}

/** Official list / concept / result payloads — columns and steps flatten to list items. */
function playbookListItems(rec: Record<string, unknown>): unknown[] {
  if (Array.isArray(rec.items)) return rec.items;
  if (Array.isArray(rec.steps)) return rec.steps;
  if (!Array.isArray(rec.columns)) return [];
  const items: unknown[] = [];
  for (const col of rec.columns) {
    const c = asRecord(col);
    if (!c) continue;
    const nested = Array.isArray(c.items) ? c.items : [];
    if (nested.length) {
      items.push(...nested);
      continue;
    }
    if (asString(c.title) || asString(c.text)) items.push(c);
  }
  return items;
}

function outHasId(out: unknown[], id: string): boolean {
  return out.some((item) => {
    const rec = asRecord(item);
    return (asString(rec?.elementId) ?? asString(rec?.id)) === id;
  });
}

const RECIPE_INK = {
  title: "#44712E",
  body: "#56687A",
  muted: "#8A9690",
  coral: "#F5987E",
  leaf: "#D7EBCE",
  blush: "#F9DED8",
  white: "#FFFFFF",
} as const;

const RECIPE_KINDS = ["cover", "route", "concept", "method", "demo", "transfer"] as const;

export function inferSkillPageType(rec: Record<string, unknown>): string {
  const explicit = asString(rec.pageType) ?? asString(rec.role);
  if (explicit) return explicit;
  const id = (asString(rec.id) ?? "").toLowerCase();
  for (const kind of RECIPE_KINDS) {
    if (id === kind || id.includes(kind)) return kind;
  }
  return "";
}

function recipePairs(raw: unknown): Array<{ name: string; note: string }> {
  if (Array.isArray(raw)) {
    return raw.map(listItemCopy).filter((item) => item.name);
  }
  const rec = asRecord(raw);
  if (!rec) return [];
  if (Array.isArray(rec.stations)) return recipePairs(rec.stations);
  if (Array.isArray(rec.panels)) {
    return rec.panels
      .map((item) => {
        const p = asRecord(item) ?? {};
        return {
          name: (asString(p.title) ?? asString(p.name) ?? "").trim(),
          note: (asString(p.body) ?? asString(p.note) ?? asString(p.text) ?? "").trim(),
        };
      })
      .filter((item) => item.name);
  }
  if (Array.isArray(rec.rows)) {
    return rec.rows
      .map((item) => {
        const p = asRecord(item) ?? {};
        return {
          name: (asString(p.k) ?? asString(p.title) ?? asString(p.name) ?? "").trim(),
          note: (asString(p.v) ?? asString(p.body) ?? asString(p.note) ?? "").trim(),
        };
      })
      .filter((item) => item.name);
  }
  if (Array.isArray(rec.items)) return recipePairs(rec.items);
  if (Array.isArray(rec.bullets)) {
    return rec.bullets
      .map((item) => ({
        name: typeof item === "string" ? item.trim() : listItemCopy(item).name,
        note: "",
      }))
      .filter((item) => item.name);
  }
  return [];
}

function columnCopy(raw: unknown): { heading: string; body: string } {
  if (typeof raw === "string") return { heading: "", body: raw };
  const rec = asRecord(raw);
  if (!rec) return { heading: "", body: "" };
  const heading = asString(rec.heading) ?? asString(rec.label) ?? asString(rec.title) ?? "";
  const bullets = Array.isArray(rec.bullets)
    ? rec.bullets.map((item) => (typeof item === "string" ? item : listItemCopy(item).name)).filter(Boolean)
    : [];
  const body = asString(rec.body) ?? asString(rec.text) ?? (bullets.length ? bullets.join("\n") : "");
  return { heading, body };
}

function chapterNumber(text: string): string {
  const m = text.match(/(\d{1,2})/);
  return m ? m[1]!.padStart(2, "0") : text.slice(0, 2);
}

/** Official paper-white recipe atoms the agent writes from recipes.md. */
function expandOfficialRecipeItem(rec: Record<string, unknown>, type: string, kind: string, out: unknown[]): boolean {
  if (type === "cover-botanical") {
    if (!outHasId(out, "circle")) {
      out.push({
        type: "ellipse",
        elementId: "circle",
        bounds: [-70, -30, 430, 430],
        fill: RECIPE_INK.blush,
      });
    }
    return true;
  }
  if (type === "title-band") {
    const title = asString(rec.title) ?? asString(rec.text) ?? asString(rec.content);
    const sub = asString(rec.subtitle) ?? asString(rec.tag);
    if (!outHasId(out, "title-band")) {
      out.push({
        type: "box",
        elementId: "title-band",
        bounds: [36, 348, 560, 156],
        fill: RECIPE_INK.leaf,
      });
      out.push({
        type: "rect",
        elementId: "band-mark",
        bounds: [36, 348, 12, 156],
        fill: RECIPE_INK.coral,
      });
    }
    if (!outHasId(out, "chip")) {
      const grade = `${title ?? ""} ${sub ?? ""}`.match(/([一二三四五六七八九十])年级/);
      out.push({
        type: "text",
        elementId: "chip",
        text: grade ? `${grade[1]}年级` : "课堂",
        fontWeight: "bold",
        fontSize: 14,
        color: RECIPE_INK.title,
        bounds: [64, 364, 120, 24],
      });
    }
    if (title && !outHasId(out, "title")) {
      out.push({
        type: "text",
        elementId: "title",
        text: title,
        fontWeight: "bold",
        fontSize: 32,
        color: RECIPE_INK.title,
        bounds: [64, 392, 500, 64],
      });
    }
    if (sub && !outHasId(out, "sub")) {
      out.push({
        type: "text",
        elementId: "sub",
        text: sub.length > 22 ? sub.slice(0, 22) : sub,
        fontSize: 16,
        color: RECIPE_INK.body,
        bounds: [64, 458, 500, 32],
      });
    }
    return true;
  }
  if (type === "coral-rule") {
    if (!outHasId(out, "rule")) {
      out.push({
        type: "rect",
        elementId: "rule",
        bounds: [48, 88, 72, 6],
        fill: RECIPE_INK.coral,
      });
    }
    return true;
  }
  if (type === "chapter") {
    const text = asString(rec.text) ?? asString(rec.content) ?? "";
    if (text && !outHasId(out, "chapter")) {
      out.push({
        type: "text",
        elementId: "chapter",
        text: chapterNumber(text),
        fontWeight: "bold",
        fontSize: 56,
        color: RECIPE_INK.coral,
        bounds: [820, 16, 108, 72],
      });
    }
    return true;
  }
  if (type === "page-title") {
    const text = asString(rec.text) ?? asString(rec.content) ?? asString(rec.title);
    if (text && !outHasId(out, "title")) {
      out.push({
        type: "text",
        elementId: "title",
        text,
        fontWeight: "bold",
        fontSize: 32,
        color: RECIPE_INK.title,
        bounds: [48, 28, 720, 52],
      });
    }
    return true;
  }
  if (type === "subtitle") {
    const text = asString(rec.text) ?? asString(rec.content);
    if (text && !outHasId(out, "lead")) {
      out.push({
        type: "text",
        elementId: "lead",
        text,
        fontSize: 16,
        color: RECIPE_INK.body,
        bounds: [48, 116, 400, 72],
      });
    }
    return true;
  }
  if (type === "route-path") {
    const items = recipePairs(rec.stations ?? rec.items ?? rec).slice(0, 4);
    if (!outHasId(out, "path-spine")) {
      out.push({
        type: "rect",
        elementId: "path-spine",
        bounds: [77, 124, 4, 348],
        fill: RECIPE_INK.coral,
      });
    }
    items.forEach((item, i) => {
      const y = 112 + i * 92;
      out.push({
        type: "ellipse",
        elementId: `step-${i}`,
        bounds: [58, y + 10, 42, 42],
        fill: RECIPE_INK.blush,
      });
      out.push({
        type: "text",
        elementId: `step-n-${i}`,
        text: String(i + 1).padStart(2, "0"),
        fontWeight: "bold",
        fontSize: 14,
        color: RECIPE_INK.coral,
        bounds: [58, y + 16, 42, 28],
      });
      out.push({
        type: "text",
        elementId: `item-n-${i}`,
        text: item.name,
        fontWeight: "bold",
        fontSize: 22,
        color: RECIPE_INK.title,
        bounds: [124, y + 6, 760, 32],
      });
      if (item.note) {
        out.push({
          type: "text",
          elementId: `item-d-${i}`,
          text: item.note,
          fontSize: 16,
          color: RECIPE_INK.body,
          bounds: [124, y + 42, 760, 32],
        });
      }
    });
    return true;
  }
  if (type === "footer-chrome") {
    const left = asString(rec.left) ?? "« »";
    const right = asString(rec.right) ?? "";
    if (!outHasId(out, "guillemets")) {
      out.push({
        type: "text",
        elementId: "guillemets",
        text: left,
        fontSize: 12,
        color: RECIPE_INK.muted,
        bounds: [48, 508, 40, 20],
      });
    }
    if (right && !outHasId(out, "footer")) {
      out.push({
        type: "text",
        elementId: "footer",
        text: right,
        fontSize: 12,
        color: RECIPE_INK.muted,
        bounds: [640, 508, 280, 20],
      });
    }
    return true;
  }
  if (type === "method-panels") {
    const items = recipePairs(rec.panels ?? rec.items ?? rec).slice(0, 3);
    const h = 96;
    items.forEach((item, i) => {
      const y = 120 + i * (h + 10);
      out.push({
        type: "box",
        elementId: `panel-${i}`,
        bounds: [48, y, 864, h],
        fill: i % 2 ? RECIPE_INK.blush : RECIPE_INK.leaf,
      });
      out.push({
        type: "ellipse",
        elementId: `well-${i}`,
        bounds: [68, y + (h - 48) / 2, 48, 48],
        fill: RECIPE_INK.white,
      });
      out.push({
        type: "text",
        elementId: `well-n-${i}`,
        text: String(i + 1).padStart(2, "0"),
        fontWeight: "bold",
        fontSize: 16,
        color: RECIPE_INK.coral,
        bounds: [68, y + (h - 28) / 2, 48, 28],
      });
      out.push({
        type: "text",
        elementId: `item-n-${i}`,
        text: item.name,
        fontWeight: "bold",
        fontSize: 18,
        color: RECIPE_INK.title,
        bounds: [136, y + 12, 740, 28],
      });
      if (item.note) {
        out.push({
          type: "text",
          elementId: `item-d-${i}`,
          text: item.note,
          fontSize: 15,
          color: RECIPE_INK.body,
          bounds: [136, y + 42, 740, 28],
        });
      }
    });
    return true;
  }
  if (type === "two-column-45-55") {
    const left = columnCopy(rec.left);
    const rightPairs = recipePairs(asRecord(rec.right)?.rows ?? rec.right);
    if (left.body && !outHasId(out, "lead")) {
      out.push({
        type: "text",
        elementId: "lead",
        text: left.body,
        fontSize: 16,
        color: RECIPE_INK.body,
        bounds: [48, 116, 400, 72],
      });
    }
    if (left.heading && !outHasId(out, "col-h")) {
      out.push({
        type: "text",
        elementId: "col-h",
        text: left.heading,
        fontWeight: "bold",
        fontSize: 16,
        color: RECIPE_INK.title,
        bounds: [48, 200, 400, 28],
      });
    }
    rightPairs.slice(0, 4).forEach((item, i) => {
      out.push({
        type: "text",
        elementId: `l${i + 1}`,
        text: item.note ? `${item.name}：${item.note}` : item.name,
        fontSize: 16,
        color: RECIPE_INK.body,
        bounds: [48, 236 + i * 56, 400, 52],
      });
    });
    if (!outHasId(out, "aside")) {
      const rightHead = columnCopy(rec.right).heading || "组成，而不是装饰";
      out.push({
        type: "rect",
        elementId: "aside",
        bounds: [480, 116, 432, 360],
        fill: RECIPE_INK.leaf,
      });
      out.push({
        type: "rect",
        elementId: "aside-rule",
        bounds: [480, 116, 432, 8],
        fill: RECIPE_INK.coral,
      });
      out.push({
        type: "text",
        elementId: "aside-h",
        text: rightHead,
        fontWeight: "bold",
        fontSize: 16,
        color: RECIPE_INK.title,
        bounds: [500, 136, 392, 28],
      });
      out.push({
        type: "ellipse",
        elementId: "ring-outer",
        bounds: [560, 196, 200, 140],
        fill: RECIPE_INK.blush,
      });
      out.push({
        type: "ellipse",
        elementId: "ring-mid",
        bounds: [600, 228, 120, 76],
        fill: RECIPE_INK.white,
      });
      out.push({
        type: "ellipse",
        elementId: "ring-in",
        bounds: [636, 248, 48, 36],
        fill: RECIPE_INK.title,
      });
    }
    return true;
  }
  if (type === "demo-band") {
    const title = asString(rec.title) ?? asString(rec.text);
    if (!outHasId(out, "pink-band")) {
      out.push({
        type: "rect",
        elementId: "pink-band",
        bounds: [0, 0, 960, 108],
        fill: RECIPE_INK.blush,
      });
    }
    if (title && !outHasId(out, "title")) {
      out.push({
        type: "text",
        elementId: "title",
        text: title,
        fontWeight: "bold",
        fontSize: 30,
        color: RECIPE_INK.title,
        bounds: [48, 28, 720, 52],
      });
    }
    return true;
  }
  if (type === "two-column-body") {
    const left = columnCopy(rec.left);
    const right = columnCopy(rec.right);
    if (!outHasId(out, "col-l")) {
      out.push({
        type: "rect",
        elementId: "col-l",
        bounds: [48, 128, 420, 236],
        fill: RECIPE_INK.leaf,
      });
      out.push({
        type: "rect",
        elementId: "col-r",
        bounds: [492, 128, 420, 236],
        fill: RECIPE_INK.leaf,
      });
    }
    if (left.heading) {
      out.push({
        type: "text",
        elementId: "lh",
        text: left.heading,
        fontWeight: "bold",
        fontSize: 18,
        color: RECIPE_INK.title,
        bounds: [68, 144, 380, 28],
      });
    }
    if (right.heading) {
      out.push({
        type: "text",
        elementId: "rh",
        text: right.heading,
        fontWeight: "bold",
        fontSize: 18,
        color: RECIPE_INK.title,
        bounds: [512, 144, 380, 28],
      });
    }
    if (left.body) {
      out.push({
        type: "text",
        elementId: "lb",
        text: left.body,
        fontSize: 16,
        color: RECIPE_INK.body,
        bounds: [68, 184, 380, 160],
      });
    }
    if (right.body) {
      out.push({
        type: "text",
        elementId: "rb",
        text: right.body,
        fontSize: 16,
        color: RECIPE_INK.body,
        bounds: [512, 184, 380, 160],
      });
    }
    return true;
  }
  if (type === "result-bar") {
    const text = asString(rec.text) ?? asString(rec.content) ?? asString(rec.title) ?? "";
    const top = kind === "transfer" ? 36 : 384;
    const h = kind === "transfer" ? 120 : 108;
    if (!outHasId(out, "result-bar")) {
      out.push({
        type: "rect",
        elementId: "result-bar",
        bounds: [48, top, 864, h],
        fill: RECIPE_INK.title,
      });
    }
    if (text) {
      out.push({
        type: "text",
        elementId: kind === "transfer" ? "title" : "result-v",
        text,
        fontWeight: "bold",
        fontSize: kind === "transfer" ? 22 : 18,
        color: RECIPE_INK.white,
        bounds: kind === "transfer" ? [72, 84, 800, 52] : [72, 416, 800, 56],
      });
    }
    return true;
  }
  if (type === "next-action") {
    const title = asString(rec.title) ?? "下一步行动";
    const items = recipePairs(rec.items ?? rec);
    const body = items.map((item) => (item.note ? `${item.name}：${item.note}` : item.name)).join("\n");
    if (!outHasId(out, "panel")) {
      out.push({
        type: "rect",
        elementId: "panel",
        bounds: [48, 176, 864, 300],
        fill: RECIPE_INK.leaf,
      });
      out.push({
        type: "rect",
        elementId: "panel-rule",
        bounds: [48, 176, 864, 8],
        fill: RECIPE_INK.coral,
      });
    }
    out.push({
      type: "text",
      elementId: "check-h",
      text: title,
      fontWeight: "bold",
      fontSize: 16,
      color: RECIPE_INK.title,
      bounds: [72, 204, 800, 28],
    });
    if (body) {
      out.push({
        type: "text",
        elementId: "body",
        text: body,
        fontSize: 16,
        color: RECIPE_INK.body,
        bounds: [72, 240, 800, 200],
      });
    }
    return true;
  }
  return false;
}

/** Official playbook vocab: header / list / box / circle / band / group + position. */
export function expandPlaybookElements(raw: unknown[], pageType = ""): unknown[] {
  const kind = pageType.toLowerCase();
  const hasHeroTitle = raw.some((item) => {
    const rec = asRecord(item);
    const type = asString(rec?.type) ?? asString(rec?.elementType);
    return type === "title";
  });
  const out: unknown[] = [];
  raw.forEach((item, index) => {
    const rec = asRecord(item);
    if (!rec) return;
    const type = asString(rec.type) ?? asString(rec.elementType);
    if (type === "group" && Array.isArray(rec.elements)) {
      out.push(...expandPlaybookElements(rec.elements, pageType));
      return;
    }
    if (type && expandOfficialRecipeItem(rec, type, kind, out)) return;
    if (type === "header") {
      const bounds = parseBounds(rec.bounds ?? rec.position) ?? [48, 28, 720, 52];
      const title = asString(rec.content) ?? asString(rec.title) ?? asString(rec.text) ?? asString(rec.heading);
      const sub = asString(rec.subtitle) ?? asString(rec.tag);
      const grade = `${title ?? ""} ${sub ?? ""}`.match(/([一二三四五六七八九十])年级/);
      if (kind === "cover") {
        if (grade && !outHasId(out, "chip")) {
          out.push({
            type: "text",
            elementId: "chip",
            text: `${grade[1]}年级`,
            fontWeight: "bold",
            fontSize: 14,
            color: rec.color ?? "#44712E",
            bounds: [64, 364, 120, 24],
          });
        }
        if (title && !hasHeroTitle && !outHasId(out, "title")) {
          out.push({
            type: "text",
            elementId: "title",
            text: title,
            fontWeight: "bold",
            fontSize: namedFontSize(rec.size) ?? 32,
            color: rec.color ?? "#44712E",
            bounds: [64, 392, 500, 64],
          });
        }
        if (sub && !grade && sub.length <= 16 && !/让我们一起/.test(sub) && !outHasId(out, "sub")) {
          out.push({
            type: "text",
            elementId: "sub",
            text: sub,
            fontSize: 16,
            color: "#56687A",
            bounds: [64, 458, 500, 32],
          });
        }
        return;
      }
      if (title) {
        out.push({
          type: "text",
          elementId: hasHeroTitle ? "chip" : "title",
          text: title,
          fontWeight: "bold",
          fontSize: hasHeroTitle ? 16 : (namedFontSize(rec.size) ?? 32),
          color: rec.color ?? "#44712E",
          bounds: hasHeroTitle ? [bounds[0], 28, bounds[2], 28] : bounds,
        });
      }
      if (sub) {
        out.push({
          type: "text",
          elementId: "sub",
          text: sub,
          fontSize: 16,
          color: "#56687A",
          bounds: [bounds[0], bounds[1] + bounds[3] + 8, bounds[2], 28],
        });
      }
      return;
    }
    if (type === "concept" || type === "result") {
      const items = playbookListItems(rec);
      items.forEach((it, i) => {
        const copy = listItemCopy(it);
        const text = [copy.name, copy.note].filter(Boolean).join(" ");
        if (!text) return;
        out.push({
          type: "text",
          elementId: i === 0 ? "lead" : `line-${i}`,
          text,
          color: "#56687A",
          fontSize: 16,
          bounds: [48, 116 + i * 80, 400, 72],
        });
      });
      return;
    }
    if (type === "list") {
      const items = playbookListItems(rec);
      const bounds = parseBounds(rec.bounds ?? rec.position) ?? [48, 112, 864, 360];
      const count = Math.max(items.length, 1);
      const h = Math.min(96, Math.max(72, Math.floor(bounds[3] / count) - 10));
      items.forEach((it, i) => {
        const copy = listItemCopy(it);
        if (!copy.name) return;
        const y = bounds[1] + i * (h + 10);
        const fill = i % 2 ? "#F9DED8" : "#D7EBCE";
        out.push({
          type: "box",
          elementId: `panel-${i}`,
          position: { x: bounds[0], y, w: bounds[2], h },
          background: { fill },
        });
        out.push({
          type: "ellipse",
          elementId: `well-${i}`,
          position: { x: bounds[0] + 20, y: y + (h - 48) / 2, w: 48, h: 48 },
          fill: "#FFFFFF",
        });
        out.push({
          type: "text",
          elementId: `well-n-${i}`,
          text: String(i + 1).padStart(2, "0"),
          color: "#F5987E",
          fontWeight: "bold",
          fontSize: 16,
          position: { x: bounds[0] + 20, y: y + (h - 28) / 2, w: 48, h: 28 },
        });
        out.push({
          type: "text",
          elementId: `item-n-${i}`,
          text: copy.name,
          color: "#44712E",
          fontWeight: "bold",
          fontSize: 18,
          position: { x: bounds[0] + 88, y: y + 12, w: bounds[2] - 120, h: 28 },
        });
        if (copy.note) {
          out.push({
            type: "text",
            elementId: `item-d-${i}`,
            text: copy.note,
            color: "#56687A",
            fontSize: 15,
            position: { x: bounds[0] + 88, y: y + 42, w: bounds[2] - 120, h: 28 },
          });
        }
      });
      return;
    }
    if (type === "circle") {
      if (kind === "cover") {
        if (outHasId(out, "circle")) return;
        out.push({
          ...rec,
          type: "ellipse",
          elementId: "circle",
          bounds: [-70, -30, 430, 430],
          fill: rec.fill ?? rec.color ?? rec.background ?? "#F9DED8",
        });
        return;
      }
      const sizeN = asNumber(rec.size);
      const x = asNumber(rec.x ?? rec.left);
      const y = asNumber(rec.y ?? rec.top);
      const sized =
        sizeN !== undefined && sizeN > 0 && x !== undefined && y !== undefined ? [x, y, sizeN, sizeN] : null;
      out.push({
        ...rec,
        type: "ellipse",
        elementId: asString(rec.elementId) ?? "circle",
        bounds: rec.bounds ?? rec.position ?? sized ?? [-70, -30, 430, 430],
        fill: rec.fill ?? rec.color ?? rec.background ?? "#F9DED8",
      });
      return;
    }
    if (type === "band") {
      const bounds = kind === "cover" ? [36, 348, 560, 156] : (rec.bounds ?? rec.position ?? [36, 348, 560, 156]);
      out.push({
        ...rec,
        type: "box",
        elementId: asString(rec.elementId) ?? "title-band",
        bounds,
        fill: rec.fill ?? rec.color ?? rec.background ?? "#D7EBCE",
      });
      const text = asString(rec.text) ?? asString(rec.content) ?? asString(rec.title);
      if (text && text.length <= 16 && !/让我们一起/.test(text) && !/[。！]/.test(text) && !outHasId(out, "sub")) {
        const b = parseBounds(bounds) ?? [36, 348, 560, 156];
        out.push({
          type: "text",
          elementId: "sub",
          text,
          fontSize: 16,
          color: "#56687A",
          bounds: [b[0] + 28, b[1] + 110, Math.min(500, b[2] - 48), 32],
        });
      }
      return;
    }
    if (type === "rule") {
      const bounds = parseBounds(rec.bounds ?? rec.position) ?? [48, 88, 72, 6];
      out.push({
        ...rec,
        type: "rect",
        elementId: asString(rec.elementId) ?? "rule",
        bounds,
        fill: rec.fill ?? rec.color ?? rec.background ?? "#F5987E",
      });
      return;
    }
    if (type === "title") {
      out.push({
        ...rec,
        type: "text",
        elementId: asString(rec.elementId) ?? "title",
        bounds: kind === "cover" ? [64, 392, 500, 64] : (rec.bounds ?? rec.position ?? [48, 180, 860, 64]),
        fontWeight: rec.fontWeight ?? "bold",
        fontSize: rec.fontSize ?? namedFontSize(rec.size) ?? 36,
      });
      return;
    }
    out.push(rec);
  });
  return out;
}

export function parseElement(raw: unknown, index: number): PptdElement | null {
  const rec = normalizeCanvasElement(asRecord(parseJsonMaybe(raw)) ?? {});
  if (!asRecord(rec)) return null;
  const elementType = asString(rec.elementType);
  const bounds = parseBounds(rec.bounds) ?? parseBounds(canvasBounds(rec));
  if (elementType === "shape" && !rec.fill && rec.background) rec.fill = rec.background;
  if (!elementType || !ELEMENT_TYPES.has(elementType) || !bounds) return null;
  const elementId = asString(rec.elementId) ?? asString(rec.id) ?? `el-${String(index + 1).padStart(2, "0")}`;
  const base = {
    elementId,
    bounds,
    layoutRole: asLayoutRole(rec.layoutRole),
    exhibitRole: asExhibitRole(rec.exhibitRole),
    rotation: asNumber(rec.rotation),
    opacity: asNumber(rec.opacity),
    hidden: typeof rec.hidden === "boolean" ? rec.hidden : undefined,
  };

  if (elementType === "text") {
    const content = parseTextContent(rec);
    if (!content) return null;
    return { ...base, elementType: "text", content } satisfies TextElement;
  }

  if (elementType === "shape") {
    const shapeName = asString(rec.shapeName) ?? asString(asRecord(rec.shape)?.shapeName) ?? "rect";
    return {
      ...base,
      elementType: "shape",
      shapeName,
      fill: parseFill(rec.fill) ?? parseFill(asRecord(rec.shape)?.fill),
    } satisfies ShapeElement;
  }

  if (elementType === "chart") {
    const chartRec = normalizeChartInput(rec);
    const data = parseChartData(chartRec.data) ?? parseChartData(chartRec);
    if (!data) return null;
    const chart: ChartElement = {
      ...base,
      elementType: "chart",
      data,
      series: parseSeries(chartRec.series ?? rec.series, data),
    };
    if (Array.isArray(rec.colors)) {
      const colors = rec.colors.map((color) => asString(color)).filter((color): color is string => Boolean(color));
      if (colors.length) chart.colors = colors;
    }
    if (asString(rec.title)) chart.title = asString(rec.title);
    if (typeof rec.legend === "boolean") chart.legend = rec.legend;
    if (typeof rec.labels === "boolean") chart.labels = rec.labels;
    const axis = asRecord(rec.axis);
    if (axis) {
      const parsedAxis = {
        x: asString(axis.x),
        y: asString(axis.y),
        secondaryY: asString(axis.secondaryY),
      };
      if (parsedAxis.x || parsedAxis.y || parsedAxis.secondaryY) chart.axis = parsedAxis;
    }
    return chart;
  }

  if (elementType === "table") {
    const rows = parseTableRows(rec.rows) ?? parseTableRows(asRecord(rec.table)?.rows);
    if (!rows) return null;
    const colCount = Math.max(...rows.map((row) => row.length), 1);
    const widths = Array.isArray(rec.columnWidths)
      ? rec.columnWidths.map((n) => asNumber(n) ?? bounds[2] / colCount).slice(0, colCount)
      : Array.from({ length: colCount }, () => bounds[2] / colCount);
    return {
      ...base,
      elementType: "table",
      columnWidths: widths,
      rows,
    } satisfies TableElement;
  }

  if (elementType === "image") {
    const src = asString(rec.src);
    if (!src) return null;
    return { ...base, elementType: "image", src };
  }

  if (elementType === "icon") {
    const iconName = asString(rec.iconName);
    if (!iconName) return null;
    return { ...base, elementType: "icon", iconName, fill: parseFill(rec.fill) };
  }

  if (elementType === "line") {
    const points = asString(rec.points);
    if (!points) return null;
    const viewBox =
      Array.isArray(rec.viewBox) && rec.viewBox.length >= 2
        ? ([asNumber(rec.viewBox[0]) ?? bounds[2], asNumber(rec.viewBox[1]) ?? bounds[3]] as [number, number])
        : ([bounds[2], bounds[3]] as [number, number]);
    return { ...base, elementType: "line", viewBox, points };
  }

  return null;
}

function looseTextPage(rec: Record<string, unknown>, index: number): SkillPageInput | null {
  const title = asString(rec.title) ?? asString(rec.heading) ?? asString(rec.name);
  const body =
    asString(rec.body) ??
    (typeof rec.content === "string" ? asString(rec.content) : undefined) ??
    asString(rec.text) ??
    asString(rec.note);
  const bullets = Array.isArray(rec.bullets)
    ? rec.bullets
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        .map((item) => item.trim())
    : [];
  if (!title && !body && !bullets.length) return null;
  const elements: PptdElement[] = [];
  if (title) {
    elements.push({
      elementId: "title",
      elementType: "text",
      bounds: [40, 36, 880, 48],
      content: { text: title, bold: true, fontSize: 22 },
    });
  }
  const rest = [body, ...bullets].filter(Boolean).join("\n");
  if (rest) {
    elements.push({
      elementId: "body",
      elementType: "text",
      bounds: [40, title ? 100 : 40, 880, title ? 360 : 420],
      content: { text: rest, fontSize: 16 },
    });
  }
  if (!elements.length) return null;
  return {
    id: asString(rec.id) ?? `page-${String(index + 1).padStart(2, "0")}`,
    pageType: asString(rec.pageType) ?? asString(rec.role),
    ...layoutIdPart(rec),
    notes: asString(rec.notes),
    elements,
  };
}

function parsePage(raw: unknown, index: number, opts: { loose?: boolean } = {}): SkillPageInput | null {
  const rec = asRecord(parseJsonMaybe(raw));
  if (!rec) return null;
  // Native pages already satisfy the generation contract. Do not send them
  // through the legacy dialect converters, which intentionally select fields
  // and would discard native formatting, connectors, and editing metadata.
  const native = {
    id: rec.id,
    ...(rec.pageType !== undefined ? { pageType: rec.pageType } : {}),
    ...(rec.notes !== undefined ? { notes: rec.notes } : {}),
    ...(rec.background !== undefined ? { background: rec.background } : {}),
    ...(rec.animations !== undefined ? { animations: rec.animations } : {}),
    ...(rec.layoutId !== undefined ? { layoutId: rec.layoutId } : {}),
    elements: rec.elements,
  };
  if (isCanonicalWritePageArgs(native)) {
    return structuredClone(native);
  }
  const pageType = inferSkillPageType(rec);
  const elementsRaw = expandPlaybookElements(coerceElementList(rec).map(liftBareCopy), pageType);
  let slideFill: Fill | undefined;
  const withoutSlide = elementsRaw.filter((item) => {
    const el = asRecord(item);
    const type = asString(el?.type) ?? asString(el?.elementType);
    if (!isSlideChrome(type)) return true;
    slideFill = slideFill ?? parseFill(el?.background) ?? parseFill(asRecord(el?.background)) ?? parseFill(el?.fill);
    return false;
  });
  const parsed = withoutSlide
    .map((item, elementIndex) => parseElement(item, elementIndex))
    .filter((item): item is PptdElement => Boolean(item));
  const elements = parsed;
  if (elements.length === 0) return opts.loose ? looseTextPage(rec, index) : null;
  const background = parseFill(rec.background) ?? parseFill(asRecord(rec.background)) ?? slideFill;
  return {
    id: asString(rec.id) ?? `page-${String(index + 1).padStart(2, "0")}`,
    pageType: pageType || asString(rec.pageType) || asString(rec.role),
    ...layoutIdPart(rec),
    notes: asString(rec.notes),
    background,
    elements,
  };
}

/** The write_layout id a page names. A blank or absent value means the page has no layout. */
function layoutIdPart(rec: Record<string, unknown>): { layoutId?: string } {
  const layoutId = asString(rec.layoutId);
  return layoutId ? { layoutId } : {};
}

function slidePrefix(id: string): number | null {
  const m = /^(?:slide|page)[-_]?(\d+)/i.exec(id);
  return m ? Number(m[1]) : null;
}

/**
 * The agent sometimes dumps every slide into one canvas `elements[]`.
 * Split on slide-N / page-N ids, else on 540px vertical stacks.
 */
export function pagesFromFlatElements(rec: Record<string, unknown>): unknown[] {
  const elements = Array.isArray(rec.elements) ? rec.elements : [];
  if (!elements.length) return [];
  const groups = new Map<number, unknown[]>();
  for (const el of elements) {
    const item = asRecord(el);
    const n = slidePrefix(asString(item?.id) ?? asString(item?.elementId) ?? "");
    if (n == null) continue;
    const list = groups.get(n) ?? [];
    list.push(el);
    groups.set(n, list);
  }
  if (groups.size >= 2) {
    return [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([n, els]) => ({
        id: `page-${String(n).padStart(2, "0")}`,
        elements: els,
      }));
  }
  const buckets = new Map<number, unknown[]>();
  for (const el of elements) {
    const item = asRecord(el);
    const y = asNumber(item?.y) ?? 0;
    const key = Math.max(0, Math.floor(y / 540));
    const list = buckets.get(key) ?? [];
    list.push(el);
    buckets.set(key, list);
  }
  if (buckets.size >= 2) {
    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([n, els]) => ({
        id: `page-${String(n + 1).padStart(2, "0")}`,
        elements: els,
      }));
  }
  return [
    {
      id: asString(rec.id) ?? "page-01",
      background: rec.background,
      elements,
    },
  ];
}

/** True when the payload already looks like skill PPTD (pages with elements). */
export function hasSkillElements(raw: unknown): boolean {
  const rec = asRecord(parseJsonMaybe(raw));
  if (!rec) return false;
  const pages = Array.isArray(rec.pages)
    ? rec.pages
    : Array.isArray(rec.slides)
      ? rec.slides
      : Array.isArray(rec.elements)
        ? pagesFromFlatElements(rec)
        : [];
  return pages.some((page) => {
    const item = asRecord(page);
    return Array.isArray(item?.elements) && item.elements.length > 0;
  });
}

export function parseSkillPage(raw: unknown, index = 0): SkillPageInput | null {
  return parsePage(raw, index, { loose: true });
}

export function countRawChartElements(elements: unknown): number {
  const list = Array.isArray(elements) ? elements : [];
  let n = 0;
  for (const item of list) {
    const rec = asRecord(item);
    if (!rec) continue;
    const type = String(rec.elementType ?? rec.type ?? "").toLowerCase();
    if (type === "chart" || rec.chart != null || rec.chartType != null) n += 1;
  }
  return n;
}

export const DROPPED_CHART_DETAIL =
  "chart element was sent but not persisted. OpenKimi PPTD charts need data.cols + data.rows. Nested chart.rows + encode is accepted. A chart-typed element with no rows is not a figure. Host will not silently drop charts.";

export function parseSkillDeck(raw: unknown): SkillDeckInput | null {
  const rec = asRecord(parseJsonMaybe(raw));
  if (!rec) return null;
  const pagesRaw = Array.isArray(rec.pages)
    ? rec.pages
    : Array.isArray(rec.slides)
      ? rec.slides
      : Array.isArray(rec.elements)
        ? pagesFromFlatElements(rec)
        : [];
  const pages = pagesRaw
    .map((page, index) => parsePage(page, index))
    .filter((page): page is SkillPageInput => Boolean(page));
  if (pages.length === 0) return null;
  const firstText = pages
    .flatMap((page) => page.elements)
    .map((el) => textOf(el))
    .find((text): text is string => Boolean(text));
  return {
    title: asString(rec.title) ?? firstText ?? "未命名演示",
    pages,
  };
}

export function applySkillDeck(project: PptdProject, deck: SkillDeckInput, pal?: Palette): void {
  if (deck.pages.length === 0) {
    throw new Error("skill deck has no pages with PPTD elements");
  }
  project.presentation.title = deck.title;
  if (pal) {
    project.presentation.theme = {
      colors: {
        primary: pal.primary,
        accent: pal.accent,
        text: pal.text,
        muted: pal.muted,
        background: pal.background,
        danger: pal.danger,
      },
      textStyles: {
        title: { fontSize: 28, bold: true, color: pal.primary },
        body: { fontSize: 15, color: pal.text },
      },
    };
  }
  project.pages = deck.pages.map((page, index) => {
    const next: Page = {
      pageType: page.pageType,
      notes: page.notes,
      background: page.background,
      animations: page.animations,
      elements: page.elements,
    };
    return { path: pageFileName(index, page.pageType), page: next };
  });
  project.presentation.pages = project.pages.map((p) => p.path);

  const agentDir = path.join(project.rootDir, "_agent");
  fs.mkdirSync(agentDir, { recursive: true });
  writeFileAtomic(path.join(agentDir, "skill-deck.json"), `${JSON.stringify(deck, null, 2)}\n`);
}
