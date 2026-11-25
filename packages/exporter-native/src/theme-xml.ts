import type JSZip from "jszip";
import { canonicalFontName, isSlideFont, type Theme } from "@open-slidestudio/pptd-v2";

/** ECMA-376 clrScheme child order. Do not sort or insert. */
export const THEME_SCHEME_COLOR_KEYS = [
  "dk1",
  "lt1",
  "dk2",
  "lt2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
] as const;

export type ThemeSchemeColorKey = (typeof THEME_SCHEME_COLOR_KEYS)[number];

type FontPair = { latin: string; ea: string };

const MAJOR_STYLE_KEYS = ["schemeMajor", "major", "heading", "title"] as const;
const MINOR_STYLE_KEYS = ["schemeMinor", "minor", "body"] as const;

function xmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** `#RRGGBB` or `RRGGBB` only. Tokens such as `$primary` are not scheme colors. */
export function schemeColorsFromTheme(theme: Theme | undefined): Partial<Record<ThemeSchemeColorKey, string>> {
  const colors = theme?.colors;
  const out: Partial<Record<ThemeSchemeColorKey, string>> = {};
  if (!colors) return out;
  for (const key of THEME_SCHEME_COLOR_KEYS) {
    const raw = colors[key];
    if (typeof raw !== "string") continue;
    const match = /^#?([0-9A-Fa-f]{6})$/.exec(raw.trim());
    if (!match?.[1]) continue;
    out[key] = match[1].toUpperCase();
  }
  return out;
}

function pairFromStyle(style: unknown): FontPair | undefined {
  if (!style || typeof style !== "object" || Array.isArray(style)) return undefined;
  const fontFamily = (style as { fontFamily?: unknown }).fontFamily;
  if (!fontFamily || typeof fontFamily !== "object" || Array.isArray(fontFamily)) return undefined;
  const latin = (fontFamily as { latin?: unknown }).latin;
  const ea = (fontFamily as { ea?: unknown }).ea;
  if (typeof latin !== "string" || typeof ea !== "string") return undefined;
  if (!isSlideFont(latin) || !isSlideFont(ea)) return undefined;
  return { latin: canonicalFontName(latin), ea: canonicalFontName(ea) };
}

function pairFromStyles(theme: Theme | undefined, keys: readonly string[]): FontPair | undefined {
  const styles = theme?.textStyles;
  if (!styles) return undefined;
  for (const key of keys) {
    const pair = pairFromStyle(styles[key]);
    if (pair) return pair;
  }
  return undefined;
}

/** Whitelist pairs already stored on the theme. A non-whitelist face is ignored. */
export function themeSchemeFontPairs(theme: Theme | undefined): {
  major?: FontPair;
  minor?: FontPair;
} {
  return {
    major: pairFromStyles(theme, MAJOR_STYLE_KEYS),
    minor: pairFromStyles(theme, MINOR_STYLE_KEYS),
  };
}

function patchClrScheme(xml: string, colors: Partial<Record<ThemeSchemeColorKey, string>>): string {
  return xml.replace(/<a:clrScheme\b[^>]*>[\s\S]*?<\/a:clrScheme>/, (block) => {
    let next = block;
    for (const key of THEME_SCHEME_COLOR_KEYS) {
      const hex = colors[key];
      if (!hex) continue;
      next = next.replace(new RegExp(`(<a:${key}>)[\\s\\S]*?(</a:${key}>)`), `$1<a:srgbClr val="${hex}"/>$2`);
    }
    return next;
  });
}

function replaceTypeface(tag: string, face: string): string {
  const cleaned = tag.replace(/\s+panose="[^"]*"/, "").replace(/\s+typeface="[^"]*"/, "");
  const attrs = cleaned.replace(/^<a:(?:latin|ea)\b/, "").replace(/\/>$/, "");
  const name = tag.startsWith("<a:ea") ? "ea" : "latin";
  return `<a:${name} typeface="${xmlAttr(face)}"${attrs}/>`;
}

function patchFontCollection(xml: string, role: "majorFont" | "minorFont", pair: FontPair): string {
  return xml.replace(
    new RegExp(`(<a:${role}>)([\\s\\S]*?)(</a:${role}>)`),
    (_all, open: string, inner: string, close: string) => {
      const body = inner
        .replace(/<a:latin\b[^>]*\/>/, (tag) => replaceTypeface(tag, pair.latin))
        .replace(/<a:ea\b[^>]*\/>/, (tag) => replaceTypeface(tag, pair.ea));
      return `${open}${body}${close}`;
    },
  );
}

/**
 * Rewrite clrScheme slots that have literal scheme tokens, and major/minor
 * latin+ea when the theme already carries whitelist pairs. With no scheme
 * color token the XML is returned unchanged.
 */
export function patchThemeXml(xml: string, theme: Theme | undefined): string {
  const colors = schemeColorsFromTheme(theme);
  if (Object.keys(colors).length === 0) return xml;
  let next = patchClrScheme(xml, colors);
  const fonts = themeSchemeFontPairs(theme);
  if (fonts.major) next = patchFontCollection(next, "majorFont", fonts.major);
  if (fonts.minor) next = patchFontCollection(next, "minorFont", fonts.minor);
  return next;
}

export async function applyThemeXmlPatch(zip: JSZip, theme: Theme | undefined): Promise<void> {
  if (Object.keys(schemeColorsFromTheme(theme)).length === 0) return;
  const entry = zip.file("ppt/theme/theme1.xml");
  if (!entry) return;
  const xml = await entry.async("string");
  const next = patchThemeXml(xml, theme);
  if (next !== xml) zip.file("ppt/theme/theme1.xml", next);
}
