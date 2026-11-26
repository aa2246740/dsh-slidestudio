import { layoutReferenceIssues, type PptdProject } from "@open-slidestudio/pptd-v2";
import { persistPageKey } from "./page-identity.js";
import { renderedLayoutBlocksCompose } from "./layout-qa.js";
import type { PageEvidenceStatus, RasterFact, RunLedgerV1 } from "./run-ledger.js";

/**
 * Compose blockers for masters and layouts (masters-layouts §3.20). A layout edit makes the pages
 * that show it stale: they need render_page again, and no page review is asked for. Split out of
 * run-ledger.ts to keep that module under its budget.
 */

/** The rendered-layout blocker of each page whose current raster is not stale. */
export function renderedLayoutBlockers(
  ledger: RunLedgerV1,
  pages: readonly PageEvidenceStatus[],
  currentRenderedLayoutRequired: boolean,
  layoutGateVersion: string,
): string[] {
  const blockers: string[] = [];
  for (const page of pages) {
    if (page.chromeStale) continue;
    const raster = [...ledger.facts]
      .reverse()
      .find(
        (fact): fact is RasterFact =>
          fact.type === "page.raster-committed" &&
          fact.pageId === page.pageId &&
          fact.revision === page.revision &&
          fact.pageSha256 === page.pageSha256 &&
          fact.layoutGateVersion === layoutGateVersion,
      );
    const layout = raster?.layoutStatus ?? "missing";
    if (renderedLayoutBlocksCompose(layout, currentRenderedLayoutRequired)) {
      const codes = (raster?.layoutIssues ?? [])
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.code);
      const extra = codes.length ? ` (${codes.join(",")})` : "";
      const required =
        currentRenderedLayoutRequired && layout !== "fail" ? " (current deterministic raster pass required)" : "";
      blockers.push(`${page.pageId}: rendered layout ${layout}${extra}${required}`);
    }
  }
  return blockers;
}

function hasLayoutRevision(ledger: RunLedgerV1, scope: "master" | "layout", layoutId: string): boolean {
  return ledger.facts.some(
    (fact) => fact.type === "layout.revision-committed" && fact.scope === scope && fact.layoutId === layoutId,
  );
}

/**
 * Unresolved layoutIds, layouts and referenced masters with no agent or editor revision, and pages
 * whose chrome changed since their last render. A page with an unresolved layout reports only that.
 */
export function layoutComposeBlockers(
  project: PptdProject | undefined,
  ledger: RunLedgerV1,
  pages: readonly PageEvidenceStatus[],
): string[] {
  if (!project) return [];
  const blockers: string[] = [];
  const unresolved = new Set<string>();
  for (const entry of project.pages) {
    const issue = layoutReferenceIssues(project.presentation, entry.page)[0];
    if (!issue) continue;
    const pageId = persistPageKey(entry.path);
    unresolved.add(pageId);
    blockers.push(`${pageId}: ${issue.detail}`);
  }
  for (const layout of project.presentation.layouts ?? []) {
    if (!hasLayoutRevision(ledger, "layout", layout.id)) {
      blockers.push(`版式「${layout.name}」还没有定义记录，请先定义该版式后再合成`);
    }
  }
  // Only a master that a layout names reaches a page, so an unused stored master needs no revision.
  const referencedMasters = new Set(
    (project.presentation.layouts ?? []).flatMap((layout) => (layout.masterId === undefined ? [] : [layout.masterId])),
  );
  for (const master of project.presentation.masters ?? []) {
    if (referencedMasters.has(master.id) && !hasLayoutRevision(ledger, "master", master.id)) {
      blockers.push(`母版「${master.name}」还没有定义记录，请先定义该母版后再合成`);
    }
  }
  for (const page of pages) {
    if (page.chromeStale && !unresolved.has(page.pageId)) {
      blockers.push(`${page.pageId}: 版式已变更，需要重新渲染`);
    }
  }
  return blockers;
}
