import type { Theme } from "./types.js";

/**
 * Follow a `$token` reference through `theme.colors`, one link at a time. A chain that loops
 * back on a key (`$a -> $b -> $a`) never reaches a literal, so it is reported as cyclic and the
 * value that started the walk is kept. Other strings are returned as they are.
 */
function followThemeColor(value: string, theme: Theme | undefined): { value: string; cyclic: boolean } {
  const seen = new Set<string>();
  let current = value;
  while (current.startsWith("$") && theme?.colors) {
    const key = current.slice(1);
    // A key such as `constructor` reaches Object.prototype, which is not a colour string.
    const next = theme.colors[key];
    if (typeof next !== "string" || !next) break;
    if (seen.has(key)) return { value, cyclic: true };
    seen.add(key);
    current = next;
  }
  return { value: current, cyclic: false };
}

/**
 * Resolve `$primary` style theme color refs; leave other strings as-is. An unknown or cyclic
 * reference comes back unchanged, so `toRgbHex` refuses it instead of inventing a colour.
 */
export function resolveThemeColor(value: string | undefined, theme: Theme | undefined, fallback = "#000000"): string {
  if (!value) return fallback;
  return followThemeColor(value, theme).value;
}

/** True when a `$token` chain loops back on itself, so no literal colour is reachable. */
export function themeColorIsCyclic(value: string, theme: Theme | undefined): boolean {
  return followThemeColor(value, theme).cyclic;
}

/**
 * Official PPTD Color (`reference/pptd.md` Shared Types):
 * HEX6 `#RRGGBB`, HEX8 `#RRGGBBAA`, or `$theme`. Unprefixed `RRGGBB` is not listed.
 */
export type OfficialPptdColorKind = "omitted" | "hash" | "theme" | "unprefixed" | "invalid";

export function officialPptdColorKind(value: string | undefined | null): OfficialPptdColorKind {
  if (value == null) return "omitted";
  const v = String(value).trim();
  if (v === "") return "omitted";
  if (/^\$[A-Za-z][A-Za-z0-9_-]*$/.test(v)) return "theme";
  if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(v)) return "hash";
  if (/^[0-9A-Fa-f]{3}$/.test(v) || /^[0-9A-Fa-f]{6}$/.test(v) || /^[0-9A-Fa-f]{8}$/.test(v)) {
    return "unprefixed";
  }
  return "invalid";
}

export class InvalidPptdColorError extends Error {
  readonly input: string;
  readonly kind: OfficialPptdColorKind;
  constructor(input: string, kind: OfficialPptdColorKind = officialPptdColorKind(input)) {
    super(
      `PPTD Color requires #RRGGBB, #RRGGBBAA, or a Theme.colors $token that exists (reference/pptd.md). ${JSON.stringify(input)} is ${kind}; it must not become #000000.`,
    );
    this.name = "InvalidPptdColorError";
    this.input = input;
    this.kind = kind;
  }
}

function normalizeOfficialHash(v: string): string | undefined {
  if (!v.startsWith("#")) return undefined;
  let h = v.slice(1);
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6 || !/^[0-9A-Fa-f]{6}$/.test(h)) return undefined;
  return `#${h.toUpperCase()}`;
}

/**
 * Normalize official PPTD color to #RRGGBB (drop alpha).
 * Omitted values use `fallback`. Present unprefixed RRGGBB and unresolved
 * `$theme` are rejected — never invented as #000000 / #FFFFFF.
 */
export function toRgbHex(value: string | undefined, theme?: Theme, fallback = "#000000"): string {
  if (value == null || String(value).trim() === "") {
    return normalizeOfficialHash(fallback) ?? "#000000";
  }
  const resolved = resolveThemeColor(value, theme, "").trim();
  const kind = officialPptdColorKind(resolved);
  if (kind === "hash") {
    const hex = normalizeOfficialHash(resolved);
    if (hex) return hex;
  }
  if (kind === "unprefixed" || kind === "invalid" || kind === "theme") {
    throw new InvalidPptdColorError(String(value).trim(), kind);
  }
  return normalizeOfficialHash(fallback) ?? "#000000";
}

/** Extract alpha 0–1 from #RRGGBBAA if present. */
export function colorAlpha(value: string | undefined, theme?: Theme): number | undefined {
  const v = resolveThemeColor(value, theme, "").trim();
  if (!v.startsWith("#")) return undefined;
  const h = v.slice(1);
  if (h.length === 8) {
    return parseInt(h.slice(6, 8), 16) / 255;
  }
  return undefined;
}
