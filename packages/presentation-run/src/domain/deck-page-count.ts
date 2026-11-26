/**
 * Delivery gate for a composed skill deck. The user's page-count requirement
 * (exact equality or an explicit range) is authoritative here; the legacy
 * minimum remains a structural floor for callers that still supply one.
 */
import { pageCountDeliveryHint, type PageCountRequirement } from "./page-count-requirement.js";
import type { SkillDeckInput } from "./skill-pages.js";

export function assertSkillDeck(
  deck: SkillDeckInput,
  opts: { minPages?: number; pageCount?: PageCountRequirement } = {},
): void {
  const minPages = opts.minPages ?? 4;
  const countProblem = pageCountDeliveryHint(opts.pageCount ?? { kind: "unspecified" }, deck.pages.length);
  if (countProblem) throw new Error(countProblem);
  if (deck.pages.length < minPages) {
    throw new Error(`skill PPTD needs at least ${minPages} pages with elements, got ${deck.pages.length}`);
  }
  for (const [i, page] of deck.pages.entries()) {
    if (page.elements.length === 0) {
      throw new Error(`skill page ${i + 1} has no PPTD elements`);
    }
  }
}
