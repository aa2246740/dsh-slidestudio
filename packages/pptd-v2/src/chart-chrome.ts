/**
 * Chart ink and grid pairs. Kept beside chart-layout so the browser can load
 * this sibling from /runtime/chart-chrome.js when chart-layout.js re-exports it.
 */

export const CHART_INK = { light: "#626976", dark: "#CBD5E1" } as const;
export const CHART_GRID = { light: "#E5E7EB", dark: "#475569" } as const;
export const CHART_INK_NEUTRAL = { light: "#626976", dark: "#D4D4D4" } as const;
export const CHART_GRID_NEUTRAL = { light: "#E5E5E5", dark: "#525252" } as const;

export type ChartChrome = Readonly<{
  ink: Readonly<{ light: string; dark: string }>;
  grid: Readonly<{ light: string; dark: string }>;
}>;

/** Chart ink and grid for a deck. Only `neutralChrome: true` selects the neutral pair. */
export function chartChrome(theme?: { neutralChrome?: boolean } | null): ChartChrome {
  return theme?.neutralChrome === true
    ? { ink: CHART_INK_NEUTRAL, grid: CHART_GRID_NEUTRAL }
    : { ink: CHART_INK, grid: CHART_GRID };
}
