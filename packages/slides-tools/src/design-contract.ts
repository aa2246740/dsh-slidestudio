/**
 * The compact design contract card returned by a committed `commit_design`.
 * It restates the adopted design decisions in a small, stable shape so a host
 * can pin it as a plan anchor that survives context compaction. Everything is
 * read back from the committed state; nothing here decides or changes design.
 */
import { loadProject, toRgbHex, type Theme } from "@open-slidestudio/pptd-v2";
import { catalogPackPaletteHexes, effectiveCatalogPackId } from "@open-slidestudio/presentation-run";

export const DESIGN_CONTRACT_KIND = "design-contract.v1";

export type DesignContractCard = {
  readonly kind: typeof DESIGN_CONTRACT_KIND;
  /** Effective catalog design system, or null when the style comes from materials or the agent. */
  readonly designSystemId: string | null;
  readonly adoptedSourceIds: readonly string[];
  /** Theme colour roles resolved to #RRGGBB. */
  readonly palette: Readonly<Record<string, string>>;
  /** The adopted catalog pack's declared palette, when one is in force. */
  readonly packHexes?: readonly string[];
  readonly userColors?: readonly string[];
  readonly fonts?: { readonly major?: unknown; readonly minor?: unknown };
  /** Theme text style sizes in slide px (title, body, ...). */
  readonly typeScale: Readonly<Record<string, number>>;
  readonly layoutRules: readonly string[];
};

const MAX_COLORS = 8;
const MAX_STYLES = 6;

function layoutRules(size: readonly number[] | undefined): string[] {
  const [width, height] = size?.length === 2 ? size : [960, 540];
  return [
    `every element inside the ${width}x${height} slide`,
    "text boxes never overlap",
    ">= 14px between a rule/line and the text below it",
    "text contrast >= 4.5:1 (3:1 at >= 24px or bold >= 18.66px)",
    "footer text only in the footer zone",
  ];
}

function safeHex(value: unknown, theme: Theme | undefined): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return toRgbHex(value, theme, "").toUpperCase() || undefined;
  } catch {
    return undefined;
  }
}

function themePalette(theme: Theme | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [role, value] of Object.entries(theme?.colors ?? {}).slice(0, MAX_COLORS)) {
    const hex = safeHex(value, theme);
    if (hex) out[role] = hex;
  }
  return out;
}

function themeTypeScale(theme: Theme | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, style] of Object.entries(theme?.textStyles ?? {})) {
    if (Object.keys(out).length >= MAX_STYLES) break;
    const size = (style as { fontSize?: unknown }).fontSize;
    if (typeof size === "number" && Number.isFinite(size)) out[name] = size;
  }
  return out;
}

function themeFonts(theme: Theme | undefined): DesignContractCard["fonts"] {
  const styles = theme?.textStyles ?? {};
  const family = (key: string): unknown => (styles[key] as { fontFamily?: unknown } | undefined)?.fontFamily;
  const major = family("schemeMajor") ?? family("title");
  const minor = family("schemeMinor") ?? family("body");
  if (major === undefined && minor === undefined) return undefined;
  return { ...(major !== undefined ? { major } : {}), ...(minor !== undefined ? { minor } : {}) };
}

function readTheme(projectRoot: string): { theme?: Theme; size?: readonly number[] } {
  try {
    const { presentation } = loadProject(projectRoot);
    return { theme: presentation.theme, size: presentation.size };
  } catch {
    return {};
  }
}

function stringList(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, limit) : [];
}

function packId(projectRoot: string): string | undefined {
  try {
    return effectiveCatalogPackId(projectRoot)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Build the card for a committed plan payload (`adoptedSourceIds`, `userColors`) and the project on disk. */
export function designContractCard(projectRoot: string, payload: Record<string, unknown>): DesignContractCard {
  const { theme, size } = readTheme(projectRoot);
  const designSystemId = packId(projectRoot) ?? null;
  const packHexes = designSystemId
    ? [...(catalogPackPaletteHexes().get(designSystemId) ?? [])].slice(0, MAX_COLORS).map((hex) => hex.toUpperCase())
    : [];
  const userColors = stringList(payload.userColors, MAX_COLORS);
  const fonts = themeFonts(theme);
  return {
    kind: DESIGN_CONTRACT_KIND,
    designSystemId,
    adoptedSourceIds: stringList(payload.adoptedSourceIds, MAX_COLORS),
    palette: themePalette(theme),
    ...(packHexes.length ? { packHexes } : {}),
    ...(userColors.length ? { userColors } : {}),
    ...(fonts ? { fonts } : {}),
    typeScale: themeTypeScale(theme),
    layoutRules: layoutRules(size),
  };
}
