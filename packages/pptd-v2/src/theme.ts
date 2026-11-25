import type { Theme } from "./types.js";
import { resolveFontPair } from "./font-policy.js";
import { DEFAULT_TEXT_LINE_HEIGHT } from "./text-layout.js";
import { colorAlpha, resolveThemeColor, toRgbHex } from "./official-color.js";
import { solidFillColor } from "./solid-fill.js";

export {
  InvalidPptdColorError,
  colorAlpha,
  officialPptdColorKind,
  resolveThemeColor,
  themeColorIsCyclic,
  toRgbHex,
  type OfficialPptdColorKind,
} from "./official-color.js";

function srgbChannelToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance 0–1 from sRGB hex (WCAG). */
export function relativeLuminance(hex: string, theme?: Theme): number {
  const value = toRgbHex(hex, theme).replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16) / 255;
  const green = Number.parseInt(value.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(value.slice(4, 6), 16) / 255;
  return 0.2126 * srgbChannelToLinear(red) + 0.7152 * srgbChannelToLinear(green) + 0.0722 * srgbChannelToLinear(blue);
}

/** WCAG contrast ratio of two sRGB colors (1–21). */
export function contrastRatio(a: string, b: string, theme?: Theme): number {
  const left = relativeLuminance(a, theme);
  const right = relativeLuminance(b, theme);
  const hi = Math.max(left, right);
  const lo = Math.min(left, right);
  return (hi + 0.05) / (lo + 0.05);
}

export type ShapePaintFill = {
  hex: string;
  alpha: number;
};

type LooseFill = {
  type?: string;
  color?: string;
  stops?: { color?: string }[];
};

/**
 * Paint the native canvas actually draws for a shape fill.
 * Missing fill / type none is no paint — opacity does not invent a color.
 */
export function shapePaintFill(
  fill: LooseFill | undefined,
  opacity?: number,
  theme?: Theme,
): ShapePaintFill | undefined {
  if (!fill || fill.type === "none") return undefined;
  // One solid colour, or the first stop of a multi-stop gradient, which the export records as a degrade.
  const raw = solidFillColor(fill) ?? (fill.type === "gradient" ? fill.stops?.[0]?.color : undefined);
  if (!raw) return undefined;
  const elementOpacity = opacity == null || Number.isNaN(opacity) ? 1 : Math.max(0, Math.min(1, opacity));
  const alpha = Math.max(0, Math.min(1, (colorAlpha(raw, theme) ?? 1) * elementOpacity));
  if (alpha <= 0) return undefined;
  return { hex: toRgbHex(raw, theme), alpha };
}

export type ElementFillPaint = { type: "none" } | { type: "solid"; hex: string; alpha: number };

/**
 * Single paint decision for Hub SVG and hybrid PPTX.
 * Official PPTD (`reference/pptd.md`):
 * - Shape / table / chart `fill` default is "not applied" (no paint).
 * - Icon `fill` default is black solid.
 * Opacity does not invent a color.
 */
export function elementFillPaint(
  elementType: string,
  fill: LooseFill | undefined,
  opacity?: number,
  theme?: Theme,
): ElementFillPaint {
  const kind = (elementType || "shape").toLowerCase();
  if (!fill) {
    if (kind === "icon") {
      const elementOpacity = opacity == null || Number.isNaN(opacity) ? 1 : Math.max(0, Math.min(1, opacity));
      if (elementOpacity <= 0) return { type: "none" };
      return { type: "solid", hex: "#000000", alpha: elementOpacity };
    }
    return { type: "none" };
  }
  const paint = shapePaintFill(fill, opacity, theme);
  if (!paint) return { type: "none" };
  return { type: "solid", hex: paint.hex, alpha: paint.alpha };
}

/**
 * The paint of a fill that shows one solid colour (`solidFillColor`), with element opacity applied
 * as `shapePaintFill` applies it. Any other fill has no solid paint here, so the caller falls back.
 */
export function solidFillPaint(
  fill: LooseFill | undefined,
  opacity?: number,
  theme?: Theme,
): ElementFillPaint | undefined {
  if (solidFillColor(fill) === undefined) return undefined;
  const paint = shapePaintFill(fill, opacity, theme);
  return paint ? { type: "solid", hex: paint.hex, alpha: paint.alpha } : { type: "none" };
}

/** SVG `fill` attribute for Hub. Missing CSS is no paint — never invent a color. */
export function svgFillFromFillCss(fillCss: string | undefined): string {
  if (!fillCss || fillCss === "none" || fillCss === "transparent") return "none";
  return fillCss;
}

export type ResolvedTextStyle = {
  text: string;
  color: string;
  /** Official #RRGGBB for hybrid PPTX. Never CSS rgba — that used to become 000000. */
  colorHex: string;
  fontSize: number;
  /**
   * Always a pair. `latin` draws ASCII, `ea` draws CJK; `fontCss` in
   * font-policy turns the pair into the canvas font stack, and the exporter
   * writes one `<a:latin>` and one `<a:ea>` from it.
   */
  fontFamily: { latin: string; ea: string };
  bold: boolean;
  italic: boolean;
  underline: boolean;
  backgroundColor?: string;
  lineHeight: number;
  letterSpacing?: number;
  align: [string, string];
  wrap: boolean;
  list?: "bullet" | "number";
  href?: string;
  runs: RichTextRun[];
};

/** One styled span inside PPTD HTML (`<p><span style="font-size:36px">…`). */
export type RichTextRun = {
  text: string;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
};

/** Patch applied to a plain-text offset range. `null` clears the field. */
export type RangeStylePatch = {
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: boolean | null;
  color?: string | null;
  fontSize?: number | null;
};

function decodeEntities(s: string): string {
  return (
    s
      // Line endings normalize to \n — a pasted or hand-edited CRLF must not
      // survive into run text and round-trip as a literal \r.
      .replace(/\r\n?/g, "\n")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (m, d) => {
        const n = Number(d);
        return n <= 0x10ffff ? String.fromCodePoint(n) : m;
      })
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => {
        const n = parseInt(h, 16);
        return n <= 0x10ffff ? String.fromCodePoint(n) : m;
      })
      // &amp; decodes LAST: a double-escaped entity like &amp;lt; must stay the
      // literal text "&lt;", not collapse to "<".
      .replace(/&amp;/g, "&")
  );
}

function applyInlineCss(run: Omit<RichTextRun, "text">, css: string, bareHex: boolean): void {
  for (const part of css.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim();
    if (key === "font-size") {
      const n = parseFloat(val);
      // Slide font sizes live in a sane point range; anything else is a
      // malformed clipboard fragment, not a style.
      if (Number.isFinite(n) && n > 0 && n <= 400) run.fontSize = n;
    } else if (key === "color") {
      // Whitelist color syntax — a hostile clipboard style like
      // url(javascript:…) or expression(…) must not become a run color.
      // A bare six-digit colour is kept only for a stored-text read (`bareHex`).
      if (
        /^(#[0-9a-fA-F]{3,8}|rgba?\([^()]{1,60}\)|hsla?\([^()]{1,60}\)|[a-zA-Z]{1,20})$/.test(val) ||
        (bareHex && /^[0-9a-fA-F]{6}$/.test(val))
      ) {
        run.color = val;
      }
    } else if (key === "font-weight") {
      const n = parseInt(val, 10);
      run.bold = val === "bold" || (Number.isFinite(n) && n >= 600);
    } else if (key === "font-style") {
      run.italic = val === "italic";
    } else if (key === "text-decoration") {
      const lower = val.toLowerCase();
      if (lower.includes("underline")) run.underline = true;
      else if (lower.includes("none")) run.underline = false;
    }
  }
}

const SKIP_TEXT_TAGS = new Set(["script", "style", "iframe", "object", "noscript"]);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function runStyle(run: Omit<RichTextRun, "text">): Omit<RichTextRun, "text"> {
  const out: Omit<RichTextRun, "text"> = {};
  if (run.fontSize != null) out.fontSize = run.fontSize;
  if (run.color != null && run.color !== "") out.color = run.color;
  if (run.bold) out.bold = true;
  if (run.italic) out.italic = true;
  if (run.underline) out.underline = true;
  return out;
}

function runHasStyle(run: Omit<RichTextRun, "text">): boolean {
  return (
    run.fontSize != null ||
    (run.color != null && run.color !== "") ||
    Boolean(run.bold) ||
    Boolean(run.italic) ||
    Boolean(run.underline)
  );
}

function styleKey(run: Omit<RichTextRun, "text">): string {
  const s = runStyle(run);
  return JSON.stringify({
    fontSize: s.fontSize ?? null,
    color: s.color ?? null,
    bold: Boolean(s.bold),
    italic: Boolean(s.italic),
    underline: Boolean(s.underline),
  });
}

function mergeRuns(runs: RichTextRun[]): RichTextRun[] {
  const out: RichTextRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const styled = { ...runStyle(run), text: run.text };
    const prev = out[out.length - 1];
    if (prev && styleKey(prev) === styleKey(styled)) {
      prev.text += styled.text;
    } else {
      out.push(styled);
    }
  }
  return out;
}

function appendText(runs: RichTextRun[], style: Omit<RichTextRun, "text">, text: string): void {
  if (!text) return;
  const last = runs[runs.length - 1];
  const next = { ...runStyle(style), text };
  if (last && styleKey(last) === styleKey(next)) last.text += text;
  else runs.push(next);
}

function styleCss(run: Omit<RichTextRun, "text">): string {
  const parts: string[] = [];
  if (run.fontSize != null) parts.push(`font-size:${run.fontSize}px`);
  if (run.color != null && run.color !== "") parts.push(`color:${run.color}`);
  if (run.bold) parts.push("font-weight:700");
  if (run.italic) parts.push("font-style:italic");
  if (run.underline) parts.push("text-decoration:underline");
  return parts.join(";");
}

function applyPatch(style: Omit<RichTextRun, "text">, patch: RangeStylePatch): Omit<RichTextRun, "text"> {
  const next: Omit<RichTextRun, "text"> = { ...style };
  const keys = ["bold", "italic", "underline", "color", "fontSize"] as const;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const val = patch[key];
    if (val === null) delete next[key];
    else (next[key] as boolean | string | number) = val as boolean | string | number;
  }
  return runStyle(next);
}

/**
 * Parse Kimi PPTD HTML fragments into styled runs.
 * Official decks store metric labels as `<p><span style=…>`.
 * Canonical serialize form (style-only spans) round-trips losslessly after merge.
 * `readBareHex` is for the stored-text read in color-fallback.ts only: a run colour of six hex
 * digits without `#` is kept, so it can be read as `#RRGGBB`. Writes use the default parse.
 */
export function parseRichText(html: string, options: { readBareHex?: boolean } = {}): RichTextRun[] {
  if (!html) return [];
  if (!/<[a-z][\s\S]*>/i.test(html)) {
    return mergeRuns([{ text: decodeEntities(html) }]);
  }
  const runs: RichTextRun[] = [];
  const stack: Array<Omit<RichTextRun, "text">> = [{}];
  let skipDepth = 0;
  // Comments (incl. clipboard <!--StartFragment--> markers) are matched first
  // and dropped — otherwise the comment body leaks in as literal text.
  const tokenRe = /<!--[\s\S]*?-->|<\/?([a-z0-9]+)([^>]*)>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html))) {
    if (m[1] == null && m[2] == null && m[3] == null) continue; // comment
    if (m[3] != null) {
      if (skipDepth) continue;
      const text = decodeEntities(m[3]);
      if (!text) continue;
      appendText(runs, stack[stack.length - 1]!, text);
      continue;
    }
    const tag = m[1]!.toLowerCase();
    const closing = m[0]!.startsWith("</");
    const selfClosing = /\/>$/.test(m[0]!);
    if (SKIP_TEXT_TAGS.has(tag)) {
      if (closing) skipDepth = Math.max(0, skipDepth - 1);
      else skipDepth += 1;
      continue;
    }
    if (tag === "br") {
      if (!skipDepth) appendText(runs, stack[stack.length - 1]!, "\n");
      continue;
    }
    if (tag === "p" && closing) {
      // Paragraph break belongs to the preceding run so styled wraps
      // like </span></p><p><span> round-trip as one "\n" with that style.
      if (!skipDepth) {
        if (runs.length) runs[runs.length - 1]!.text += "\n";
        else appendText(runs, stack[stack.length - 1]!, "\n");
      }
    }
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    // Self-closing tags (<span/>, <b/>) wrap no text — pushing a frame would
    // leak their style into everything that follows.
    if (selfClosing) continue;
    const next: Omit<RichTextRun, "text"> = { ...stack[stack.length - 1] };
    const style = /style\s*=\s*"([^"]*)"/i.exec(m[2] ?? "")?.[1] ?? "";
    applyInlineCss(next, style, options.readBareHex === true);
    if (tag === "b" || tag === "strong") next.bold = true;
    if (tag === "i" || tag === "em") next.italic = true;
    if (tag === "u") next.underline = true;
    stack.push(next);
  }
  // Final </p> always contributes one terminator newline — drop exactly one.
  if (runs.length) {
    const last = runs[runs.length - 1]!;
    if (last.text.endsWith("\n")) {
      last.text = last.text.slice(0, -1);
      if (!last.text) runs.pop();
    }
  }
  return mergeRuns(runs);
}

/**
 * Canonical Kimi-style HTML: plain escaped string when there is a single
 * unstyled paragraph; otherwise `<p>` per line with style-only
 * `<span style="font-size:__px;color:__;font-weight:700;font-style:italic;text-decoration:underline">`.
 */
export function serializeRichText(runs: RichTextRun[]): string {
  if (!runs.length) return "";
  const hasStyle = runs.some(runHasStyle);
  const joined = runs.map((r) => r.text).join("");
  if (!hasStyle && !joined.includes("\n")) return escapeHtml(joined);

  const paragraphs: Array<Array<{ style: Omit<RichTextRun, "text">; text: string }>> = [[]];
  for (const run of runs) {
    const style = runStyle(run);
    const parts = run.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) paragraphs.push([]);
      if (parts[i]!.length) {
        paragraphs[paragraphs.length - 1]!.push({ style, text: parts[i]! });
      }
    }
  }
  return paragraphs
    .map((para) => {
      const inner = para
        .map(({ style, text }) => {
          const css = styleCss(style);
          const escaped = escapeHtml(text);
          return css ? `<span style="${css}">${escaped}</span>` : escaped;
        })
        .join("");
      return `<p>${inner}</p>`;
    })
    .join("");
}

/**
 * Split runs at plain-text offsets `[start, end)` over concatenated run text
 * (paragraph breaks count as one `"\n"`), apply `patch`, and merge adjacent
 * identical styles.
 */
export function applyRangeStyle(
  runs: RichTextRun[],
  start: number,
  end: number,
  patch: RangeStylePatch,
): RichTextRun[] {
  const total = runs.reduce((n, r) => n + r.text.length, 0);
  const lo = Math.max(0, Math.min(start, end, total));
  const hi = Math.max(0, Math.min(Math.max(start, end), total));
  if (lo === hi) return mergeRuns(runs.map((r) => ({ ...r, text: r.text })));

  const out: RichTextRun[] = [];
  let cursor = 0;
  for (const run of runs) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    cursor = runEnd;
    if (runEnd <= lo || runStart >= hi) {
      out.push({ ...runStyle(run), text: run.text });
      continue;
    }
    const leftLen = Math.max(0, lo - runStart);
    const midEnd = Math.min(run.text.length, hi - runStart);
    if (leftLen > 0) {
      out.push({ ...runStyle(run), text: run.text.slice(0, leftLen) });
    }
    const mid = run.text.slice(leftLen, midEnd);
    if (mid) {
      out.push({ ...applyPatch(run, patch), text: mid });
    }
    if (midEnd < run.text.length) {
      out.push({ ...runStyle(run), text: run.text.slice(midEnd) });
    }
  }
  return mergeRuns(out);
}

/** Strip HTML to plain text (PPTD often stores `<p><span style=…>` rich text). */
export function stripHtmlToText(html: string): string {
  return parseRichText(html)
    .map((r) => r.text)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** CSS color that keeps 8-digit hex alpha (`#FFFFFFB3` → rgba). */
export function toCssColor(value: string | undefined, theme?: Theme, fallback = "#000000"): string {
  const raw = resolveThemeColor(value, theme, fallback);
  const hex = toRgbHex(raw, theme, fallback);
  const a = colorAlpha(raw, theme);
  if (a == null || a >= 0.995) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

/**
 * Models often put JSON-style \\n into YAML plain scalars.
 * Those two characters are not a newline until we unescape them.
 */
export function unescapePlainText(text: string): string {
  return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

/**
 * Resolve text style chain: content fields > theme textStyles[style] > defaults.
 * `style` may be `"$pageTitle"` or `"pageTitle"`.
 */
export function resolveTextStyle(
  content: {
    text?: string;
    style?: string;
    color?: string;
    fontSize?: number;
    fontFamily?: string | { latin: string; ea: string };
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    backgroundColor?: string;
    lineHeight?: number;
    letterSpacing?: number;
    align?: [string, string];
    wrap?: boolean;
    list?: "bullet" | "number";
    href?: string;
  },
  theme?: Theme,
): ResolvedTextStyle {
  const styleKey = content.style?.replace(/^\$/, "");
  const fromTheme =
    styleKey && theme?.textStyles?.[styleKey] ? (theme.textStyles[styleKey] as Record<string, unknown>) : {};

  const runs = parseRichText(unescapePlainText(content.text ?? ""));
  const colorRaw =
    (content.color as string | undefined) ?? (fromTheme.color as string | undefined) ?? runs[0]?.color ?? "#000000";
  const fontSize =
    content.fontSize ??
    (typeof fromTheme.fontSize === "number" ? fromTheme.fontSize : undefined) ??
    runs[0]?.fontSize ??
    18;
  const bold =
    content.bold ?? (typeof fromTheme.bold === "boolean" ? fromTheme.bold : undefined) ?? Boolean(runs[0]?.bold);
  const italic =
    content.italic ??
    (typeof fromTheme.italic === "boolean" ? fromTheme.italic : undefined) ??
    Boolean(runs[0]?.italic);
  const underline =
    content.underline ??
    (typeof fromTheme.underline === "boolean" ? fromTheme.underline : undefined) ??
    Boolean(runs[0]?.underline);
  const lineHeight =
    content.lineHeight ?? (typeof fromTheme.lineHeight === "number" ? fromTheme.lineHeight : DEFAULT_TEXT_LINE_HEIGHT);
  const letterSpacing =
    content.letterSpacing ?? (typeof fromTheme.letterSpacing === "number" ? fromTheme.letterSpacing : undefined);
  const highlightRaw =
    (content.backgroundColor as string | undefined) ??
    (typeof fromTheme.backgroundColor === "string" ? fromTheme.backgroundColor : undefined);
  const backgroundColor = highlightRaw ? toCssColor(highlightRaw, theme) : undefined;

  const themeFont = fromTheme.fontFamily as string | { latin: string; ea: string } | undefined;
  const fontFamily = resolveFontPair(content.fontFamily ?? themeFont);

  return {
    text: runs.map((r) => r.text).join(""),
    color: toCssColor(colorRaw, theme),
    colorHex: toRgbHex(colorRaw, theme),
    fontSize,
    fontFamily,
    bold,
    italic,
    underline,
    backgroundColor,
    lineHeight,
    letterSpacing,
    align: content.align ?? ["left", "top"],
    wrap: content.wrap !== false,
    list: content.list,
    href: content.href,
    runs,
  };
}
