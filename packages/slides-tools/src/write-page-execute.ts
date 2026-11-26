/**
 * The single canonical write_page persistence path shared by write_page,
 * edit_elements and edit_page_background: plan membership, stale-hash and
 * identity decisions, the domain write, then the deterministic auto-render.
 */
import { loadProject, withProjectWriteLock } from "@open-slidestudio/pptd-v2";
import {
  applySkippedWritePageProvenance,
  currentPageRevision,
  listSourceReceipts,
  pageIdMatchesFile,
  persistPageKey,
  readCommittedPagePlan,
  readRunLedger,
  type CommandReceipt,
  type SkillPageInput,
} from "@open-slidestudio/presentation-run";
import type { SlideToolContext } from "./contract.js";
import { rejectKindThemePack } from "./kind-theme-gate.js";
import type { WritePageDecision, WritePageOutcome } from "./outcome.js";
import { structuralEditScope } from "./produce-edit-scope.js";
import { withProjectLeaseLock } from "./project-lease.js";
import { aiReviewPageVersionConflict, readPageFromProject } from "./read-page.js";
import { commandHash, lookupToolReceipt, recordToolReceipt } from "./receipts.js";
import { droppedFieldsHint, editTurnPageBaseline, savedPageSha256 } from "./saved-page.js";
import { yamlExistsForPage } from "./page-files.js";
import { normalizeScopedTemplateFonts } from "./template-font-write-scope.js";
import {
  isLeaseRefusalData,
  leaseRefusal,
  present,
  sessionKeyOf,
  toJsonRecord,
  type SlideToolRuntimeDeps,
} from "./tool-kit.js";
import { missingDeclaredExhibitWarnings } from "./write-page-feedback.js";
import { decideWritePage, readWritePageDisk, type WritePageDiskView } from "./write-page.js";

/** Replay a receipt for a reused callId, or run once and record the outcome. */
export async function replayOrRun(
  projectRoot: string,
  name: string,
  args: Record<string, unknown>,
  toolCallId: string,
  run: () => Promise<unknown>,
  guardReceiptWrite?: (write: () => void) => void,
): Promise<Record<string, unknown>> {
  const hash = commandHash(name, args);
  const prior = lookupToolReceipt(projectRoot, toolCallId);
  if (prior) {
    if (prior.commandHash !== hash) {
      return { outcome: "conflict", toolCallId, detail: "toolCallId reused with different arguments" };
    }
    return toJsonRecord(prior.outcome);
  }
  const outcome = await run();
  if (!isLeaseRefusalData(outcome)) {
    const commit = () => recordToolReceipt(projectRoot, { toolCallId, commandHash: hash, outcome });
    if (guardReceiptWrite) guardReceiptWrite(commit);
    else commit();
  }
  return toJsonRecord(outcome);
}

function lastReviewVerdict(projectRoot: string, pageId: string): "pass" | "revise" | undefined {
  const ledger = readRunLedger(projectRoot);
  if (!ledger) return undefined;
  const fact = [...ledger.facts]
    .reverse()
    .find((row) => row.type === "page.visual-review-recorded" && row.pageId === pageId);
  if (fact?.type !== "page.visual-review-recorded") return undefined;
  return fact.verdict;
}

type RenderCommandReceipt = { ok: boolean; detail: string; payload: Record<string, unknown> };

export async function autoRenderWriteOutcome(
  outcome: Extract<WritePageOutcome, { outcome: "written" | "skipped-identical" | "replayed" }>,
  pageId: string,
  render: (pageId: string) => Promise<RenderCommandReceipt>,
): Promise<WritePageOutcome> {
  const receipt = await render(pageId);
  const rawStatus = receipt.payload.layoutStatus;
  const layoutStatus =
    receipt.ok && (rawStatus === "pass" || rawStatus === "fail" || rawStatus === "unavailable")
      ? rawStatus
      : "unavailable";
  const layoutIssues = Array.isArray(receipt.payload.layoutIssues) ? receipt.payload.layoutIssues : [];
  const renderNote = String(receipt.payload.note ?? receipt.detail ?? "").trim();
  return { ...outcome, layoutStatus, layoutIssues, ...(renderNote ? { renderNote } : {}) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reject a new page that is neither on disk, in the committed plan, nor structurally authorized. */
function planMembershipRefusal(projectRoot: string, pageId: string): WritePageOutcome | undefined {
  try {
    const onDisk = pageId
      ? loadProject(projectRoot).pages.some((loaded) => pageIdMatchesFile(pageId, loaded.path))
      : false;
    // A structural edit lock authorizes creating pages outside the committed
    // plan; existing disk pages stay writable regardless of plan membership.
    if (onDisk || structuralEditScope(projectRoot) !== undefined) return undefined;
    if (readCommittedPagePlan(projectRoot).some((page) => page.pageId === persistPageKey(pageId))) return undefined;
    return {
      outcome: "rejected",
      error: "not_in_plan",
      painted: false,
      detail: `page ${pageId} is not in the current plan — commit the updated complete plan before write_page`,
    };
  } catch (error) {
    return { outcome: "rejected", detail: errorText(error), painted: false };
  }
}

function preWriteRefusal(projectRoot: string, clean: Record<string, unknown>, pageId: string) {
  const adopted = listSourceReceipts(projectRoot)
    .filter((row) => row.state === "adopted" || row.state === "executed")
    .map((row) => row.sourceId);
  const packRejected = rejectKindThemePack(projectRoot, { adoptedSourceIds: adopted });
  if (packRejected) return packRejected;
  const membership = planMembershipRefusal(projectRoot, pageId);
  if (membership) return membership;
  const versionConflict = aiReviewPageVersionConflict(projectRoot, pageId, clean.expectedPageSha256);
  if (versionConflict) return { outcome: "rejected" as const, detail: versionConflict, painted: false as const };
  return undefined;
}

function decideFor(projectRoot: string, clean: Record<string, unknown>, pageId: string, disk?: WritePageDiskView) {
  const currentRev = pageId ? currentPageRevision(projectRoot, pageId) : undefined;
  return decideWritePage(
    clean,
    currentRev
      ? {
          pageId: currentRev.pageId,
          revision: currentRev.revision,
          pageSha256: currentRev.pageSha256,
          lastVerdict: lastReviewVerdict(projectRoot, pageId),
          yamlExists: yamlExistsForPage(projectRoot, pageId),
          savedPageSha256: savedPageSha256(projectRoot, pageId),
        }
      : undefined,
    disk,
  );
}

async function skippedOutcome(
  deps: SlideToolRuntimeDeps,
  ctx: SlideToolContext,
  clean: Record<string, unknown>,
  skipped: Extract<WritePageDecision, { action: "skip" }>["outcome"],
): Promise<WritePageOutcome> {
  const { projectRoot } = ctx;
  const page = readPageFromProject(projectRoot, skipped.pageId);
  const pageBody = !("outcome" in page) ? page : undefined;
  const warnings =
    page.outcome === "not-found"
      ? []
      : missingDeclaredExhibitWarnings(projectRoot, skipped.pageId, page as unknown as SkillPageInput);
  // A NEW declaration on an unchanged page is still checked and recorded
  // against the CURRENT revision; the page YAML and revision stay untouched.
  const provenanceCommit = withProjectWriteLock(projectRoot, () =>
    withProjectLeaseLock(projectRoot, () => {
      const refusal = leaseRefusal(deps, ctx);
      if (refusal) return { ok: false as const, refusal };
      const hint = pageBody
        ? applySkippedWritePageProvenance(
            projectRoot,
            { commandId: ctx.callId, contextEpochId: deps.presentation.epochFor(sessionKeyOf(ctx)) },
            { pageId: skipped.pageId, revision: skipped.revision, pageSha256: skipped.pageSha256 },
            pageBody,
            clean,
          )
        : undefined;
      return { ok: true as const, hint };
    }),
  );
  if (!provenanceCommit.ok) return provenanceCommit.refusal.data as unknown as WritePageOutcome;
  const hint = provenanceCommit.hint;
  const outcome = { ...skipped, ...(warnings.length ? { warnings } : {}), ...(hint ? { hint } : {}) };
  return autoRenderWriteOutcome(outcome, skipped.pageId, (target) =>
    present(deps, ctx, "render_page", { pageId: target }),
  );
}

function fontNotesOf(fixes: readonly { from: unknown; to: unknown }[]): string[] {
  return fixes.map((entry) => `字体 ${JSON.stringify(entry.from)} 改成 ${JSON.stringify(entry.to)}`);
}

function writtenFeedbackHint(projectRoot: string, receipt: CommandReceipt, writtenId: string, baseline: unknown) {
  const parts = [
    typeof receipt.payload.hint === "string" ? receipt.payload.hint.trim() : "",
    droppedFieldsHint(projectRoot, writtenId, baseline as Parameters<typeof droppedFieldsHint>[2]) ?? "",
  ];
  return parts.filter(Boolean).join("\n") || undefined;
}

async function performWrite(
  deps: SlideToolRuntimeDeps,
  ctx: SlideToolContext,
  clean: Record<string, unknown>,
  decision: Extract<WritePageDecision, { action: "write" }>,
  disk: WritePageDiskView | undefined,
): Promise<WritePageOutcome> {
  const { projectRoot } = ctx;
  const pageId = String(clean.id ?? "").trim();
  const fontFixes = normalizeScopedTemplateFonts(clean, disk?.templateFontPolicy, projectRoot);
  const editBaseline = editTurnPageBaseline(projectRoot, pageId);
  const receipt = await present(deps, ctx, "write_page", clean);
  if (!receipt.ok) {
    if (isLeaseRefusalData(receipt.payload)) return receipt.payload as unknown as WritePageOutcome;
    return {
      outcome: "rejected",
      error: String(receipt.payload.error ?? "rejected"),
      detail: receipt.detail,
      painted: false,
    };
  }
  const page = receipt.payload.page as { id?: string } | undefined;
  const writtenId = String(page?.id ?? receipt.payload.pageId ?? decision.pageId);
  const after = currentPageRevision(projectRoot, writtenId);
  const fontNotes = fontNotesOf(fontFixes);
  const warnings = missingDeclaredExhibitWarnings(projectRoot, writtenId, page as unknown as SkillPageInput);
  const hint = writtenFeedbackHint(projectRoot, receipt, writtenId, editBaseline);
  const outcome = {
    outcome: "written",
    pageId: writtenId,
    revision: after?.revision ?? 1,
    pageSha256: after?.pageSha256 ?? decision.pageSha256,
    ...(fontNotes.length ? { fontNotes } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(hint ? { hint } : {}),
  } satisfies WritePageOutcome;
  return autoRenderWriteOutcome(outcome, writtenId, (target) => present(deps, ctx, "render_page", { pageId: target }));
}

/** Persist one complete canonical page through the domain write path. */
export async function executeWritePageOnce(
  deps: SlideToolRuntimeDeps,
  ctx: SlideToolContext,
  clean: Record<string, unknown>,
): Promise<WritePageOutcome> {
  const { projectRoot } = ctx;
  const pageId = String(clean.id ?? "").trim();
  const refused = preWriteRefusal(projectRoot, clean, pageId);
  if (refused) return refused;
  const disk = readWritePageDisk(projectRoot);
  const decision = decideFor(projectRoot, clean, pageId, disk);
  if (decision.action === "skip") return skippedOutcome(deps, ctx, clean, decision.outcome);
  if (decision.action === "reject") return decision.outcome;
  return performWrite(deps, ctx, clean, decision, disk);
}
