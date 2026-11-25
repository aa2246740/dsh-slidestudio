/** Source-theme disclosure shared by intake and materialization; no mapping table here. */
import { normalizeFontFamily, resolveFontPair, type FontPair } from "./font-policy.js";

export type SourceFontMapping = {
  source: { latin: string; ea: string; hans: string };
  mapped: FontPair;
  note: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Preserve the original declarations, using Hans only when ea is absent. */
export function normalizeSourceFonts(value: unknown): {
  major: SourceFontMapping;
  minor: SourceFontMapping;
} {
  const fonts = record(value);
  const map = (raw: unknown): SourceFontMapping => {
    const font = record(raw);
    const name = (key: string) => (typeof font[key] === "string" ? font[key].trim() : "");
    const source = { latin: name("latin"), ea: name("ea"), hans: name("hans") };
    const normalized = normalizeFontFamily({
      latin: source.latin,
      ea: source.ea || source.hans,
    });
    return {
      source,
      mapped: resolveFontPair(normalized.fontFamily),
      note: normalized.note ?? "字体已在可用列表中；未声明的字体使用默认字体",
    };
  };
  return { major: map(fonts.major), minor: map(fonts.minor) };
}
