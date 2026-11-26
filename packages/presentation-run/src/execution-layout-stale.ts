import type { ExecutionBlocker } from "./types.js";
import type { RunLedgerInspection, RunLedgerV1 } from "./domain/run-ledger.js";

export type LayoutStaleAfterComposeInput = Readonly<{
  ledger: RunLedgerV1 | undefined;
  inspection: RunLedgerInspection;
  blockers: readonly ExecutionBlocker[];
  /** Ordered page ids of the complete plan. */
  planPageIds: readonly string[];
  /** The current attempt's recorded start. */
  attemptStartedAt: string | null | undefined;
}>;

// Only a full ISO timestamp counts; Date.parse alone accepts values such as "0".
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : undefined;
}

function sameKeys(expected: Readonly<Record<string, string>>, actual: Readonly<Record<string, string>>): boolean {
  const names = Object.keys(expected);
  return names.length === Object.keys(actual).length && names.every((name) => actual[name] === expected[name]);
}

/**
 * Whether the only reason the deck is not delivered is that a manual editor layout change made
 * the composition stale after this attempt had composed it. The caller has already established an
 * idle Host with no scheduled retry, no current fault and resolved page identities.
 *
 * The state is deliberately narrow: a complete plan whose only blockers are the pending
 * composition or the re-render of pages whose layout chrome changed; a `deck.composed` fact of the
 * current epoch that this attempt wrote and that still covers every page's own content; and, after
 * it, nothing but exports and at least one `source:"editor"` layout revision. Anything else, such
 * as an earlier attempt's composition, Agent layout, page or plan work, or unreadable evidence,
 * leaves genuine unfinished generation recoverable.
 */
export function layoutStaleAfterCompose(input: LayoutStaleAfterComposeInput): boolean {
  const { ledger, inspection, blockers, planPageIds } = input;
  const epoch = inspection.contextEpochId;
  const attemptStart = instant(input.attemptStartedAt);
  if (!ledger || !epoch || attemptStart === undefined || inspection.composed) return false;
  if (!planPageIds.length || !blockers.length) return false;

  const staleChrome = new Set(inspection.pages.filter((page) => page.chromeStale).map((page) => page.pageId));
  const rerenderOnly = (blocker: ExecutionBlocker) =>
    ["page_render_needed", "page_image_needed"].includes(blocker.code) &&
    blocker.pageIds.length > 0 &&
    blocker.pageIds.every((pageId) => staleChrome.has(pageId));
  if (!blockers.every((blocker) => blocker.code === "compose_needed" || rerenderOnly(blocker))) {
    return false;
  }

  let composedIndex = -1;
  ledger.facts.forEach((fact, index) => {
    if (fact.type === "deck.composed") composedIndex = index;
  });
  const composed = ledger.facts[composedIndex];
  if (composed?.type !== "deck.composed" || composed.contextEpochId !== epoch) return false;
  const composedAt = instant(composed.at);
  if (composedAt === undefined || composedAt <= attemptStart) return false;

  const ownContent = Object.fromEntries(inspection.pages.map((page) => [page.pageId, page.pageSha256]));
  const planned = Object.fromEntries(planPageIds.map((pageId) => [pageId, ownContent[pageId] ?? ""]));
  if (!sameKeys(composed.pageRevisions, ownContent) || !sameKeys(composed.pageRevisions, planned)) {
    return false;
  }

  let editorLayoutRevisions = 0;
  for (const fact of ledger.facts.slice(composedIndex + 1)) {
    if (fact.type === "export.succeeded") continue;
    if (fact.type !== "layout.revision-committed" || fact.source !== "editor" || fact.contextEpochId !== epoch) {
      return false;
    }
    editorLayoutRevisions += 1;
  }
  return editorLayoutRevisions > 0;
}
