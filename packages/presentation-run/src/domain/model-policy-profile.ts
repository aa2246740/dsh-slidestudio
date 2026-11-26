/**
 * Host-neutral model policy. Strict mode keeps palette checks closed.
 * SLIDESTUDIO_MODEL_POLICY=permissive also allows the frozen status palette.
 * SLIDESTUDIO_EXTRA_PALETTE_HEXES adds comma-separated #RRGGBB colors in either mode.
 */

/** 20 frozen neutral and status colors: white/gray/charcoal plus success, warning, danger, and info. */
export const SEMANTIC_STATUS_PALETTE_HEXES: readonly string[] = Object.freeze([
  "#FFFFFF",
  "#F5F5F5",
  "#E5E7EB",
  "#9CA3AF",
  "#666666",
  "#333333",
  "#111827",
  "#000000",
  "#16A34A",
  "#15803D",
  "#DCFCE7",
  "#D97706",
  "#EA580C",
  "#FEF3C7",
  "#DC2626",
  "#B91C1C",
  "#FEE2E2",
  "#2563EB",
  "#1D4ED8",
  "#DBEAFE",
]);

const PALETTE_HEX = /^#[0-9A-F]{6}$/;

export type ModelPolicyProfile = {
  mode: "strict" | "permissive";
  extraAllowedPaletteHexes: readonly string[];
  maxToolResultChars?: number;
  retryableHttpStatuses?: readonly number[];
};

function uniqueHexes(hexes: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hex of hexes) {
    if (seen.has(hex)) continue;
    seen.add(hex);
    out.push(hex);
  }
  return out;
}

/** Keep only tokens that are valid #RRGGBB after trimming and uppercasing. */
export function parseExtraPaletteHexes(raw: string | undefined): readonly string[] {
  if (!raw?.trim()) return [];
  const accepted: string[] = [];
  for (const part of raw.split(",")) {
    const hex = part.trim().toUpperCase();
    if (PALETTE_HEX.test(hex)) accepted.push(hex);
  }
  return uniqueHexes(accepted);
}

export function resolveModelPolicyProfile(env: NodeJS.ProcessEnv = process.env): ModelPolicyProfile {
  const permissive = env.SLIDESTUDIO_MODEL_POLICY === "permissive";
  const configured = parseExtraPaletteHexes(env.SLIDESTUDIO_EXTRA_PALETTE_HEXES);
  const extraAllowedPaletteHexes = permissive
    ? uniqueHexes([...SEMANTIC_STATUS_PALETTE_HEXES, ...configured])
    : configured;
  return {
    mode: permissive ? "permissive" : "strict",
    extraAllowedPaletteHexes,
  };
}

export function modelPolicyExtraPaletteHexes(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return resolveModelPolicyProfile(env).extraAllowedPaletteHexes;
}
