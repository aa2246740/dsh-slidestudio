import { sanitizeDeckColors, type Page, type Theme } from "@open-slidestudio/pptd-v2";

/**
 * The page and theme the editor paints. A stored colour the exporter cannot resolve gets the same
 * fallback the export writes (pptd-v2 color-fallback.ts), so the canvas and the exported file show
 * one colour. The session's project is not changed.
 */
export function paintColors(page: Page, theme: Theme | undefined): { page: Page; theme: Theme | undefined } {
  const clean = sanitizeDeckColors([page], theme);
  return { page: clean.pages[0]!, theme: clean.theme };
}
