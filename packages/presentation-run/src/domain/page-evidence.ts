import { persistPageKey } from "./page-identity.js";
import type {
  ImageEmittedFact,
  PageEvidenceStatus,
  PageRevisionFact,
  RasterFact,
  RunLedgerV1,
  TodoFact,
  VisualReviewFact,
} from "./run-ledger.js";

function exhibitContractKey(todo: TodoFact | undefined, pageId: string): string {
  const item = todo?.pagePlan?.find((page) => persistPageKey(page.pageId) === pageId);
  // Historical id-only plans cannot prove exhibit equality across replanning.
  if (!item?.exhibits) return `legacy:${todo?.todoSha256 ?? "unplanned"}`;
  return JSON.stringify([...new Set(item.exhibits.length ? item.exhibits : ["none"])].sort());
}

/** Rasters from before layouts were recorded carry no chrome and show "none". */
export function rasterChrome(raster: Pick<RasterFact, "chromeSha256">): string {
  return raster.chromeSha256 ?? "none";
}

/** Latest verdict wins; changed declarations retire evidence, not historical facts. */
function effectiveReview(ledger: RunLedgerV1, page: PageRevisionFact): VisualReviewFact | undefined {
  let todo: TodoFact | undefined;
  let review: VisualReviewFact | undefined;
  for (const fact of ledger.facts) {
    if (fact.type === "todo.committed") {
      if (exhibitContractKey(todo, page.pageId) !== exhibitContractKey(fact, page.pageId)) {
        review = undefined;
      }
      todo = fact;
    } else if (
      fact.type === "page.visual-review-recorded" &&
      fact.pageId === page.pageId &&
      fact.revision === page.revision &&
      fact.pageSha256 === page.pageSha256
    ) {
      review = fact;
    }
  }
  return review;
}

/**
 * Whether a review still covers the current raster. A review of the same page revision stays valid
 * when a re-render changed only the chrome (a layout edit); any other change needs a new review.
 */
export function reviewCoversRaster(
  ledger: RunLedgerV1,
  review: Pick<VisualReviewFact, "pageId" | "revision" | "pageSha256" | "rasterSha256">,
  raster: RasterFact,
): boolean {
  if (review.rasterSha256 === raster.rasterSha256) return true;
  const reviewed = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is RasterFact =>
        fact.type === "page.raster-committed" &&
        fact.rasterSha256 === review.rasterSha256 &&
        fact.pageId === review.pageId &&
        fact.revision === review.revision &&
        fact.pageSha256 === review.pageSha256,
    );
  return reviewed !== undefined && rasterChrome(reviewed) !== rasterChrome(raster);
}

/** Shared by model-facing progress and the compose readiness gate. */
export function inspectPageEvidence(
  ledger: RunLedgerV1,
  currentPages: Iterable<PageRevisionFact>,
  layoutGateVersion: string,
  chromes: ReadonlyMap<string, string>,
): PageEvidenceStatus[] {
  const pages: PageEvidenceStatus[] = [];
  for (const page of currentPages) {
    const latest = [...ledger.facts]
      .reverse()
      .find(
        (fact): fact is RasterFact =>
          fact.type === "page.raster-committed" &&
          fact.pageId === page.pageId &&
          fact.revision === page.revision &&
          fact.pageSha256 === page.pageSha256 &&
          fact.layoutGateVersion === layoutGateVersion,
      );
    // A raster rendered under other chrome shows a layout the deck has since changed.
    const shownChrome = chromes.get(page.pageId);
    const chromeStale = latest !== undefined && shownChrome !== undefined && rasterChrome(latest) !== shownChrome;
    const raster = chromeStale ? undefined : latest;
    const emitted = raster
      ? [...ledger.facts]
          .reverse()
          .find(
            (fact): fact is ImageEmittedFact =>
              fact.type === "page.image-content-emitted" &&
              fact.pageId === page.pageId &&
              fact.revision === page.revision &&
              fact.pageSha256 === page.pageSha256 &&
              fact.rasterSha256 === raster.rasterSha256,
          )
      : undefined;
    const review = effectiveReview(ledger, page);
    const covered = Boolean(emitted && review && raster && reviewCoversRaster(ledger, review, raster));
    const visualReview = review?.verdict === "revise" ? "revise" : covered && review ? review.verdict : "missing";
    pages.push({
      pageId: page.pageId,
      revision: page.revision,
      pageSha256: page.pageSha256,
      raster: Boolean(raster),
      imageEmitted: Boolean(emitted),
      visualReview,
      layout: raster?.layoutStatus ?? "missing",
      chromeStale,
    });
  }
  return pages.sort((a, b) => a.pageId.localeCompare(b.pageId));
}
