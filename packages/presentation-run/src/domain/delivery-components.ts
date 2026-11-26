/**
 * Which template components the delivered deck reuses (VAL-KIT-008). Built from
 * `template.component-used` facts only: the Host writes one after it expanded a reference into a
 * page or a layout and the write succeeded. Reading the kit proves nothing about reuse, so a kit
 * read alone lists nothing.
 *
 * A fact describes one revision. A page or layout that was rewritten since no longer carries what
 * the earlier revision referenced unless the rewrite referenced it again, so only facts for the
 * revision the deck was sealed with are listed. A layout fact written without a revision cannot be
 * tied to a revision and is left out rather than guessed.
 */
import type { DeliveryLayout } from "./delivery-layouts.js";
import { latestLayoutFacts } from "./layout-ledger.js";
import { latestPageFacts } from "./page-revision-ledger.js";
import type { RunLedgerV1 } from "./run-ledger.js";
import { templateComponentFacts } from "./template-component-ledger.js";

/** `layoutId` is set for a layout use; `pages` then stays empty (the layout entry lists its pages). */
export type DeliveryComponent = Readonly<{
  ref: string;
  pages: readonly string[];
  layoutId?: string;
}>;

/**
 * @param pageIds sealed page ids in deck order
 * @param layoutIds ids of the layouts some page shows, in delivery order
 */
export function deliveryComponents(
  ledger: RunLedgerV1,
  pageIds: readonly string[],
  layoutIds: readonly string[],
): DeliveryComponent[] {
  const pageRevisions = latestPageFacts(ledger);
  const layoutRevisions = new Map<string, number>();
  for (const fact of latestLayoutFacts(ledger).values()) {
    if (fact.scope === "layout") layoutRevisions.set(fact.layoutId, fact.revision);
  }
  const pageOrder = new Map(pageIds.map((id, index) => [id, index]));
  const layoutOrder = new Map(layoutIds.map((id, index) => [id, index]));
  const pagesByRef = new Map<string, Set<string>>();
  const refsByLayout = new Map<string, Set<string>>();
  for (const fact of templateComponentFacts(ledger)) {
    if (fact.layoutId) {
      if (!layoutOrder.has(fact.layoutId)) continue;
      if (layoutRevisions.get(fact.layoutId) !== fact.revision) continue;
      const refs = refsByLayout.get(fact.layoutId) ?? new Set<string>();
      refs.add(fact.ref);
      refsByLayout.set(fact.layoutId, refs);
      continue;
    }
    if (!pageOrder.has(fact.pageId)) continue;
    if (pageRevisions.get(fact.pageId)?.revision !== fact.revision) continue;
    const pages = pagesByRef.get(fact.ref) ?? new Set<string>();
    pages.add(fact.pageId);
    pagesByRef.set(fact.ref, pages);
  }
  const deckOrder = (pages: ReadonlySet<string>): string[] =>
    [...pages].sort((left, right) => pageOrder.get(left)! - pageOrder.get(right)!);
  const pageEntries = [...pagesByRef]
    .map(([ref, pages]) => ({ ref, pages: deckOrder(pages) }))
    .sort(
      (left, right) =>
        pageOrder.get(left.pages[0]!)! - pageOrder.get(right.pages[0]!)! || left.ref.localeCompare(right.ref),
    );
  const layoutEntries = [...refsByLayout]
    .sort(([left], [right]) => layoutOrder.get(left)! - layoutOrder.get(right)!)
    .flatMap(([layoutId, refs]) => [...refs].map((ref) => ({ ref, pages: [], layoutId })));
  return [...pageEntries, ...layoutEntries];
}

/** The layouts with the refs their own entries carry; the input list is left untouched. */
export function withComponentRefs(
  layouts: readonly DeliveryLayout[],
  components: readonly DeliveryComponent[],
): DeliveryLayout[] {
  return layouts.map((layout) => ({
    ...layout,
    componentRefs: components.filter((component) => component.layoutId === layout.id).map((component) => component.ref),
  }));
}
