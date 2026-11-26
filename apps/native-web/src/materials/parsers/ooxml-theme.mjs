/**
 * Theme colour scheme and font scheme (`a:theme`), shared by the PPTX/POTX
 * parser and the standalone `.thmx` theme parser. Colours resolve `sysClr`
 * through its `lastClr`; fonts carry the Latin, East Asian and Hans-script
 * variants.
 */
import { attrOf, descendantsOf, firstOf, normalizeHex, parseXml } from "./ooxml.mjs";

export const COLOR_KEYS = [
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
];

/** @typedef {{name: string|null, colors: Record<string, string|null>, fonts: {major: ThemeFont|null, minor: ThemeFont|null}}} Theme */

/** @typedef {{latin: string|null, ea: string|null, hans: string|null}} ThemeFont */

/** @returns {Record<string, string|null>} */
export function emptyColors() {
  return Object.fromEntries(COLOR_KEYS.map((key) => [key, null]));
}

/**
 * Theme colour scheme + font scheme.
 * @param {import("./ooxml.mjs").PackageReader} pkg @param {string} part
 * @returns {Theme|null}
 */
export function parseTheme(pkg, part) {
  const text = pkg.text(part);
  if (text === undefined) return null;
  const root = parseXml(text, part);
  const scheme = descendantsOf(root, "clrScheme")[0];
  /** @type {Record<string, string|null>} */
  const colors = emptyColors();
  if (scheme) {
    for (const key of COLOR_KEYS) {
      const el = firstOf(scheme, key);
      if (!el) continue;
      const srgb = firstOf(el, "srgbClr");
      if (srgb) {
        colors[key] = normalizeHex(attrOf(srgb, "val"));
        continue;
      }
      const sys = firstOf(el, "sysClr");
      if (sys) colors[key] = normalizeHex(attrOf(sys, "lastClr") ?? attrOf(sys, "val"));
    }
  }
  /** @param {string} tag @returns {ThemeFont|null} */
  const fontOf = (tag) => {
    const block = descendantsOf(root, tag)[0];
    if (!block) return null;
    const latin = firstOf(block, "latin");
    const ea = firstOf(block, "ea");
    const hans = descendantsOf(block, "font").find((f) => attrOf(f, "script") === "Hans");
    return {
      latin: latin ? attrOf(latin, "typeface") || null : null,
      ea: ea ? attrOf(ea, "typeface") || null : null,
      hans: hans ? attrOf(hans, "typeface") || null : null,
    };
  };
  return {
    name: attrOf(root, "name") ?? null,
    colors,
    fonts: { major: fontOf("majorFont"), minor: fontOf("minorFont") },
  };
}
