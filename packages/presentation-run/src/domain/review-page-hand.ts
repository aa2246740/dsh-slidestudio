import type { ToolExecution } from "./agent-tools.js";
import { diskSkillPages, pageExhibitContracts } from "./agent-page-review.js";
import { requestedExhibitIssues } from "./layout-qa.js";
import { persistPageKey } from "./page-identity.js";
import { currentPageRevision, readRunLedger, recordVisualReview, type RunToolContext } from "./run-ledger.js";
import type { AgentToolState } from "./agent-tools.js";

/** Validate and persist one page's model-authored visual verdict. */
export function reviewPageExecution(
  root: string,
  context: RunToolContext,
  args: Record<string, unknown>,
  state: AgentToolState,
): ToolExecution {
  const pageId = String(args.pageId ?? "").trim();
  const revision = Number(args.revision);
  const deliveryToken = String(args.deliveryToken ?? "").trim();
  const verdict = args.verdict;
  const issues = Array.isArray(args.issues)
    ? args.issues.filter((issue): issue is string => typeof issue === "string")
    : [];
  if (!pageId || !Number.isSafeInteger(revision) || revision < 1 || !deliveryToken) {
    throw new Error("review_page requires pageId, revision, and deliveryToken");
  }
  if (verdict !== "pass" && verdict !== "revise") {
    throw new Error("review_page verdict must be pass or revise");
  }
  const current = currentPageRevision(root, pageId);
  const matchingEmission = readRunLedger(root)?.facts.some(
    (fact) =>
      fact.type === "page.image-content-emitted" &&
      fact.pageId === pageId &&
      fact.revision === revision &&
      fact.pageSha256 === current?.pageSha256 &&
      fact.deliveryToken === deliveryToken,
  );
  if (!current || current.revision !== revision || !matchingEmission) {
    // Preserve the ledger's canonical stale/token error before loading PPTD.
    // Invalid review evidence must stay actionable even if the project is unreadable.
    recordVisualReview(root, context, {
      pageId,
      revision,
      deliveryToken,
      verdict,
      issues,
    });
  }
  const pages = diskSkillPages(state);
  const pageIndex = pages.findIndex((page) => persistPageKey(page.id) === persistPageKey(pageId));
  if (pageIndex >= 0) {
    const page = pages[pageIndex]!;
    const contract = pageExhibitContracts(state, pages)[pageIndex];
    const exhibitIssues = requestedExhibitIssues(page, contract);
    if (exhibitIssues.length) {
      // Persist the Host's rejection so an older model pass cannot remain effective.
      recordVisualReview(root, context, {
        pageId,
        revision,
        deliveryToken,
        verdict: "revise",
        issues: exhibitIssues.map((issue) => `${issue.code}: ${issue.message}`),
      });
      return {
        name: "review_page",
        ok: false,
        summary: `${pageId} missing requested exhibit`,
        detail: exhibitIssues.map((issue) => issue.message).join("\n"),
        payload: { error: "missing_requested_exhibit", issues: exhibitIssues },
      };
    }
  }
  const fact = recordVisualReview(root, context, {
    pageId,
    revision,
    deliveryToken,
    verdict,
    issues,
  });
  return {
    name: "review_page",
    ok: true,
    summary: `${pageId} ${verdict}`,
    detail:
      verdict === "pass"
        ? `${pageId} revision ${revision} visual review passed`
        : `${pageId} revision ${revision} must be rewritten: ${issues.join("; ")}`,
    payload: fact,
  };
}
