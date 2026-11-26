/**
 * An editor edit writes the whole page again without a provenance block, so the source statement the
 * agent made for the previous revision would be lost even when no figure changed. The statement
 * describes the page's numbers, not its wording, so it is kept for an edit that leaves every number
 * as it was and for nothing else.
 */
import { parseProvenanceDeclaration, type ProvenanceDeclaration } from "@open-slidestudio/pptd-v2";
import { editorTurnRecorded } from "./editor-turn-authority.js";
import { pageRevisionSha256 } from "./hashing.js";
import { recordPageProvenanceFact, type PageProvenanceFact, type PageRevisionRef } from "./material-figures.js";
import { numberTokens, pageNumbersSha256 } from "./page-figure-text.js";
import { persistPageKey } from "./page-identity.js";
import { readActiveReviewGuard, reviewWriteTargets } from "./review-write-scope.js";
import { readRunLedger, type RunToolContext } from "./run-ledger.js";

export type CarriedDeclaration = Readonly<{
  declaration: ProvenanceDeclaration;
  carriedFromRevision: number;
}>;

function sameNumbers(left: unknown, right: unknown): boolean {
  const a = numberTokens(left);
  const b = numberTokens(right);
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

/**
 * The declaration the new revision of an edited page inherits, or undefined. It needs an accepted
 * editor turn with a live lease that still holds this page's baseline, a declaration on the revision
 * just before this one, and the same numbers on that revision and the new page.
 */
export function carriedEditorDeclaration(
  root: string,
  revision: PageRevisionRef,
  page: unknown,
): CarriedDeclaration | undefined {
  if (!editorTurnRecorded(root)) return undefined;
  const pageKey = persistPageKey(revision.pageId);
  const target = reviewWriteTargets(readActiveReviewGuard(root)).find(
    ({ scope }) => persistPageKey(String(scope.pageId)) === pageKey,
  );
  const baseline = target?.pageBody;
  if (!baseline) return undefined;
  const previous = readRunLedger(root)
    ?.facts.filter(
      (fact): fact is PageProvenanceFact =>
        fact.type === "page.provenance-declared" &&
        fact.pageId === revision.pageId &&
        fact.revision === revision.revision - 1,
    )
    .at(-1);
  if (!previous) return undefined;
  if (!numbersUnchanged(previous, baseline, revision, page)) return undefined;
  return { declaration: previous.declaration, carriedFromRevision: previous.revision };
}

/**
 * A declaration that recorded its own revision's numbers is compared with the new page directly, so a
 * statement the agent wrote for an earlier edit under this lease keeps applying. An older one has only
 * the lease baseline to stand on: it must describe that baseline, or have been carried to it.
 */
function numbersUnchanged(
  previous: PageProvenanceFact,
  baseline: unknown,
  revision: PageRevisionRef,
  page: unknown,
): boolean {
  if (previous.numbersSha256 !== undefined) return previous.numbersSha256 === pageNumbersSha256(page);
  const describesBaseline =
    previous.pageSha256 === pageRevisionSha256(baseline, revision.pageId) || previous.carriedFromRevision !== undefined;
  return describesBaseline && sameNumbers(baseline, page);
}

/**
 * Records the inherited declaration on the new revision unless the write stated one itself. Only
 * the statement moves: the figure checks that follow an agent's own declaration are not rerun for
 * numbers this edit did not touch.
 */
export function carryEditorDeclaration(
  root: string,
  context: RunToolContext,
  revision: PageRevisionRef,
  page: unknown,
  args: Record<string, unknown>,
): void {
  if (parseProvenanceDeclaration(args.provenance)) return;
  const carried = carriedEditorDeclaration(root, revision, page);
  if (!carried) return;
  recordPageProvenanceFact(root, context, {
    pageId: revision.pageId,
    revision: revision.revision,
    pageSha256: revision.pageSha256,
    declaration: carried.declaration,
    carriedFromRevision: carried.carriedFromRevision,
    numbersSha256: pageNumbersSha256(page),
  });
}
