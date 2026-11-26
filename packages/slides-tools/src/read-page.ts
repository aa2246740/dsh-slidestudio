/**
 * Read-side helpers for one persisted page: the read_page baseline and the stale-page check that
 * guards editor-scoped rewrites. Split out of tools.ts to keep that module under its budget; the
 * functions are moved verbatim.
 */
import { loadProject, ownPageBody } from "@open-slidestudio/pptd-v2";
import {
  pageIdMatchesFile,
  pageRevisionSha256,
  persistPageKey,
  readActiveReviewGuard,
  reviewWriteTargetForPage,
} from "@open-slidestudio/presentation-run";
import { inheritedSummaryOf } from "./write-page-layout.js";

const REVISION_SNAPSHOT_SUFFIX = /(?:_|\.)rv\d+$/i;

function resolveReadPageMatches(pages: ReturnType<typeof loadProject>["pages"], requestedId: string) {
  const exact = pages.filter((loaded) => pageIdMatchesFile(requestedId, loaded.path));
  if (exact.length > 0) return exact;
  const withoutExt = requestedId.replace(/\.page$/i, "");
  if (!REVISION_SNAPSHOT_SUFFIX.test(withoutExt)) return [];
  const baseId = withoutExt.replace(REVISION_SNAPSHOT_SUFFIX, "").trim();
  if (!baseId) return [];
  const fallback = pages.filter((loaded) => pageIdMatchesFile(baseId, loaded.path));
  return fallback.length === 1 ? fallback : [];
}

/**
 * Read the exact, currently persisted PPTD v2 page body for a bound project.
 *
 * This deliberately does not use `replayOrRun`: recording a receipt would turn
 * a read into a filesystem mutation. The returned body is intentionally shaped
 * as a `write_page` baseline (`id`, `pageSha256`, `pageType`, `elements`, plus
 * every other persisted page field), placing `id` and `pageSha256` first so
 * downstream truncation cannot drop the hash.
 */
export function readPageFromProject(projectRoot: string, pageId: string): Record<string, unknown> {
  const requestedId = pageId.trim();
  if (!requestedId) {
    return { outcome: "rejected", detail: "pageId is required" };
  }

  try {
    const project = loadProject(projectRoot);
    const matches = resolveReadPageMatches(project.pages, requestedId);
    if (matches.length === 0) {
      return {
        outcome: "not-found",
        pageId: requestedId,
        detail: "no persisted PPTD v2 page matches pageId",
      };
    }
    if (matches.length > 1) {
      return {
        outcome: "ambiguous",
        pageId: requestedId,
        detail: "multiple persisted PPTD v2 pages match pageId; refusing to choose one",
      };
    }

    const loaded = matches[0]!;
    // A JSON round trip gives the caller a detached, JSON-safe snapshot. Do not
    // return a loader-owned object that a future tool/runtime could mutate. The body
    // is the page's own content: master and layout copies are summarised, never sent.
    const body = JSON.parse(JSON.stringify(ownPageBody(loaded.page))) as Record<string, unknown>;
    const id = persistPageKey(loaded.path);
    const pageSha256 = pageRevisionSha256(loaded.page, id);
    const inherited = inheritedSummaryOf(loaded.page);
    const { id: _ignoredId, pageSha256: _ignoredSha, ...restBody } = body;
    return {
      id,
      pageSha256,
      ...restBody,
      ...(inherited.length ? { inheritedSummary: inherited } : {}),
    };
  } catch (error) {
    return {
      outcome: "rejected",
      pageId: requestedId,
      detail: error instanceof Error ? error.message : "failed to read persisted PPTD v2 page",
    };
  }
}

function aiReviewLockForPage(projectRoot: string, pagePath: string) {
  const guard = readActiveReviewGuard(projectRoot);
  if (!guard) return undefined;
  const legacySinglePage = !guard.scope && guard.items === undefined && guard.pagePath === pagePath;
  return legacySinglePage || reviewWriteTargetForPage(guard, persistPageKey(pagePath)) ? guard : undefined;
}

/**
 * The editor creates this short-lived lock before asking the agent to revise
 * one selected element. This early check gives the agent a precise conflict;
 * presentation-run repeats the compare-and-swap inside its project write lock.
 */
export function aiReviewPageVersionConflict(
  projectRoot: string,
  pageId: string,
  expectedPageSha256: unknown,
): string | undefined {
  const requestedId = pageId.trim();
  if (!requestedId) return undefined;
  try {
    const project = loadProject(projectRoot);
    const matches = project.pages.filter((loaded) => pageIdMatchesFile(requestedId, loaded.path));
    if (matches.length !== 1) return undefined;
    const loaded = matches[0]!;
    if (!aiReviewLockForPage(projectRoot, loaded.path)) return undefined;
    const actual = pageRevisionSha256(loaded.page, persistPageKey(loaded.path));
    const expected = typeof expectedPageSha256 === "string" ? expectedPageSha256.trim() : "";
    if (expected === actual) return undefined;
    return `stale-page: expectedPageSha256 does not match the current persisted page ${requestedId}; read_page again before editing`;
  } catch (error) {
    return `stale-page: failed to verify the current persisted page ${requestedId}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
