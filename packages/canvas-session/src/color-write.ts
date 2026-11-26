/**
 * Editor colour writes (M5-SCR-005). The exporter throws for a colour it cannot read and then
 * writes no deck, so every editor setter that stores a colour refuses it first, with the same
 * Chinese reason the agent's write_page receives. The theme is read as it stands at the write.
 */
import { colorRefusal, themeColorRefusals, type Fill, type Theme } from "@open-slidestudio/pptd-v2";

/** Throws the Chinese refusal for a colour the export cannot resolve to #RRGGBB. */
export function assertWritableColor(value: string | null | undefined, theme: Theme | undefined): void {
  const refusal = colorRefusal(value, theme);
  if (refusal) throw new Error(refusal);
}

/** Throws the Chinese refusal for any colour a fill stores: its solid colour or gradient stops. */
export function assertWritableFill(fill: Fill, theme: Theme | undefined): void {
  if (fill.type === "solid") assertWritableColor(fill.color, theme);
  if (fill.type === "gradient" && Array.isArray(fill.stops)) {
    for (const stop of fill.stops) assertWritableColor(stop?.color, theme);
  }
}

/** Throws the Chinese refusal for a theme colour that is not a literal #RRGGBB or #RRGGBBAA. */
export function assertWritableThemeColor(key: string, color: string): void {
  const [issue] = themeColorRefusals({ colors: { [key]: color } });
  if (issue) throw new Error(issue);
}
