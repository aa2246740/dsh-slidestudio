/**
 * Page rewrite gate: whether the Agent may rewrite one committed page revision, read from the run
 * ledger's raster, review, editor-authorization and structural-review facts. Split out of
 * run-ledger.ts to keep that module under its budget; the functions are moved verbatim.
 */
import { reviewCoversRaster } from "./page-evidence.js";
import {
  currentRevisionSnapshot,
  latestPageFacts,
  readRunLedger,
  RENDERED_LAYOUT_GATE_VERSION,
  sameRevisionSnapshot,
  STRUCTURAL_REVIEW_GATE_VERSION,
  type PageEditAuthorizationFact,
  type RasterFact,
  type StructuralReviewFact,
  type VisualReviewFact,
} from "./run-ledger.js";

export type PageRewriteGate = Readonly<{
  allowed: boolean;
  pageId: string;
  revision?: number;
  reason: string;
}>;

type PageRewriteLifecycle =
  | { state: "no-revision" }
  | { state: "layout-open"; revision: number; reason: string }
  | { state: "editor-auth"; revision: number; authorizationId: string }
  | { state: "visual-revise"; revision: number }
  | { state: "structural-fail"; revision: number }
  | { state: "structural-pass"; revision: number }
  | { state: "open"; revision: number };

function structuralPassLockReason(pageId: string, revision: number): string {
  return (
    `${pageId} revision ${revision} already has a structural review pass. ` +
    "Do not rewrite or append to this page. Move to the next committed todo page. " +
    "A later write is allowed only when review_pages names this page as failing, or review_page explicitly returns revise for this current revision."
  );
}

function namesPageForRepair(pageId: string, issues: readonly string[]): boolean {
  return issues.some((issue) => issue === pageId || issue.startsWith(`${pageId}:`) || issue.includes(`[${pageId}]`));
}

function classifyPageRewrite(root: string, pageId: string): PageRewriteLifecycle {
  const ledger = readRunLedger(root);
  const current = ledger ? latestPageFacts(ledger).get(pageId) : undefined;
  if (!ledger || !current) return { state: "no-revision" };

  const raster = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is RasterFact =>
        fact.type === "page.raster-committed" &&
        fact.pageId === current.pageId &&
        fact.revision === current.revision &&
        fact.pageSha256 === current.pageSha256 &&
        fact.layoutGateVersion === RENDERED_LAYOUT_GATE_VERSION,
    );
  if (!raster || raster.layoutStatus !== "pass") {
    return {
      state: "layout-open",
      revision: current.revision,
      reason: raster
        ? `current deterministic layout is ${raster.layoutStatus}`
        : "current revision has no deterministic raster",
    };
  }

  const editorAuthorization = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is PageEditAuthorizationFact =>
        fact.type === "page.edit-authorized" &&
        fact.source === "editor-agent" &&
        fact.pageId === current.pageId &&
        fact.revision === current.revision &&
        fact.pageSha256 === current.pageSha256 &&
        Date.parse(fact.expiresAt) > Date.now(),
    );
  if (editorAuthorization) {
    return {
      state: "editor-auth",
      revision: current.revision,
      authorizationId: editorAuthorization.authorizationId,
    };
  }

  const pageReview = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is VisualReviewFact =>
        fact.type === "page.visual-review-recorded" &&
        fact.pageId === current.pageId &&
        fact.revision === current.revision &&
        fact.pageSha256 === current.pageSha256 &&
        reviewCoversRaster(ledger, fact, raster),
    );
  if (pageReview?.verdict === "revise") {
    return { state: "visual-revise", revision: current.revision };
  }

  const snapshot = currentRevisionSnapshot(ledger, root);
  const structuralFail = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is StructuralReviewFact =>
        fact.type === "deck.structural-review-recorded" &&
        fact.reviewGateVersion === STRUCTURAL_REVIEW_GATE_VERSION &&
        !fact.ok &&
        sameRevisionSnapshot(fact.pageRevisions, snapshot),
    );
  if (structuralFail && namesPageForRepair(current.pageId, structuralFail.issues)) {
    return { state: "structural-fail", revision: current.revision };
  }
  const structuralPass = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is StructuralReviewFact =>
        fact.type === "deck.structural-review-recorded" &&
        fact.reviewGateVersion === STRUCTURAL_REVIEW_GATE_VERSION &&
        fact.ok &&
        sameRevisionSnapshot(fact.pageRevisions, snapshot) &&
        fact.pageRevisions[current.pageId] === current.pageSha256,
    );
  if (structuralPass) {
    return { state: "structural-pass", revision: current.revision };
  }
  return { state: "open", revision: current.revision };
}

function gateFromRewriteLifecycle(pageId: string, life: PageRewriteLifecycle): PageRewriteGate {
  switch (life.state) {
    case "no-revision":
      return { allowed: true, pageId, reason: "page has no committed revision" };
    case "layout-open":
      return { allowed: true, pageId, revision: life.revision, reason: life.reason };
    case "editor-auth":
      return {
        allowed: true,
        pageId,
        revision: life.revision,
        reason: `editor Agent edit ${life.authorizationId} authorized this exact revision`,
      };
    case "visual-revise":
      return {
        allowed: true,
        pageId,
        revision: life.revision,
        reason: "current image review explicitly requires revision",
      };
    case "structural-fail":
      return {
        allowed: true,
        pageId,
        revision: life.revision,
        reason: "current structural review explicitly names this page for repair",
      };
    case "structural-pass":
      return {
        allowed: false,
        pageId,
        revision: life.revision,
        reason: structuralPassLockReason(pageId, life.revision),
      };
    case "open":
      return {
        allowed: true,
        pageId,
        revision: life.revision,
        reason: "current revision has no structural review pass",
      };
  }
}

export function pageRewriteGate(root: string, pageId: string): PageRewriteGate {
  return gateFromRewriteLifecycle(pageId, classifyPageRewrite(root, pageId));
}
