/** User palette variants mix the source with white/black at these percentages. */
export const USER_DESIGN_TINT_SHADE_PERCENTAGES = [20, 40, 60] as const;

function hexChannels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

export function mixHex(hex: string, target: 0 | 255, percentage: number): string {
  const ratio = percentage / 100;
  const mixed = hexChannels(hex).map((channel) => Math.round(channel * (1 - ratio) + target * ratio));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** The documented lighter (white mix) and darker (black mix) variants of one colour. */
export function hexVariants(hex: string): { tints: string[]; shades: string[] } {
  return {
    tints: USER_DESIGN_TINT_SHADE_PERCENTAGES.map((percentage) => mixHex(hex, 255, percentage)),
    shades: USER_DESIGN_TINT_SHADE_PERCENTAGES.map((percentage) => mixHex(hex, 0, percentage)),
  };
}

export function userPaletteWithVariants(hexes: ReadonlySet<string>): Set<string> {
  const out = new Set(hexes);
  for (const hex of hexes) {
    const { tints, shades } = hexVariants(hex);
    for (const variant of [...tints, ...shades]) out.add(variant);
  }
  return out;
}
