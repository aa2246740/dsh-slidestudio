/**
 * The update_deck theme guard (M5-SCR-005). The exporter throws for a colour it cannot read and
 * then writes no deck, so a theme is refused before it is saved. Each colour must be a literal
 * #RRGGBB or #RRGGBBAA, and no page colour may stop resolving. Only colours the new theme breaks
 * are refused, so a page that was already broken does not block an unrelated theme change.
 */
import path from "node:path";
import { themeColorRefusals, type PptdProject, type Theme } from "@open-slidestudio/pptd-v2";
import { storedPageColorIssues } from "./layout-qa.js";

/** Chinese refusals for saving `next` as the deck theme; an empty list means the save may proceed. */
export function updateDeckThemeRefusals(project: PptdProject, next: Theme): string[] {
  const malformed = themeColorRefusals(next);
  if (malformed.length) return malformed;
  const resolvedBefore = new Set<string>();
  for (const entry of project.pages) {
    for (const issue of storedPageColorIssues(entry.page, entry.path, project.presentation.theme)) {
      resolvedBefore.add(`${entry.path}\n${issue.message}`);
    }
  }
  const refusals: string[] = [];
  for (const entry of project.pages) {
    for (const issue of storedPageColorIssues(entry.page, entry.path, next)) {
      if (resolvedBefore.has(`${entry.path}\n${issue.message}`)) continue;
      refusals.push(`页面 ${path.basename(entry.path, ".page")}，${issue.message}`);
    }
  }
  return refusals;
}
