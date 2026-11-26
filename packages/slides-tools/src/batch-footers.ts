/**
 * 批量删除脚注/页脚工具（v33）：在单个原子 PPTD v2 写锁内扫描目标页与可选版式/母版，
 * 识别并移除脚注元素，严格遵循活跃编辑锁边界（fail-closed），避免误删正文与图表。
 */
import {
  effectiveLayoutRole,
  footerZoneTopForSlide,
  loadProject,
  ownPageBody,
  saveProject,
  stripHtmlToText,
  withProjectWriteLock,
  type LoadedPage,
  type PptdElement,
  type TextElement,
} from "@open-slidestudio/pptd-v2";
import {
  editorTurnAuthorityLost,
  layoutEditGrant,
  pageIdMatchesFile,
  pageRevisionSha256,
  persistPageKey,
  readActiveReviewGuard,
  readRunLedger,
  recordLayoutRevision,
  recordPageRevision,
  reviewWriteTargetForPage,
  reviewWriteTargets,
  stableSha256,
} from "@open-slidestudio/presentation-run";
import { commandHash, lookupToolReceipt, recordToolReceipt } from "./receipts.js";
import { writePageSerial } from "./write-page-serial.js";
import type { SlideToolDefinition } from "./contract.js";
import { result, sessionKeyOf, slideTool, toJsonRecord, type SlideToolRuntimeDeps } from "./tool-kit.js";

const FOOTER_ID_RE = /^footer(?:[_-]|$)/i;
const EXPLICIT_PAGE_NUMBER_TEXT_RE =
  /^(?:第\s*\d+\s*页(?:\s*[/／]\s*共?\s*\d+\s*页)?|\d+\s*[/／]\s*\d+|\{page\}(?:\s*[/／]\s*\{pages\})?|p\.?\s*\d+)$/i;
const BARE_PAGE_NUMBER_RE = /^\d{1,3}$/;
const FOOTER_NOTE_TEXT_RE =
  /^(?:注\s*[：:0-9]|脚注|页脚|备注\s*[：:]|数据来源|资料来源|信息来源|来源\s*[：:]|source\s*:|note\s*:|※|仅供内部|机密|内部资料|版权所有|copyright|©)/i;

export type BatchRemoveFootersInput = {
  readonly pageIds?: readonly string[];
  readonly includeLayouts?: boolean;
};

export type BatchRemoveFootersOutcome =
  | {
      readonly outcome: "applied";
      readonly removedCount: number;
      readonly modifiedPages: readonly string[];
      readonly modifiedLayouts: readonly string[];
      readonly pageRevisions: Readonly<Record<string, string>>;
    }
  | {
      readonly outcome: "rejected";
      readonly error: string;
      readonly detail: string;
      readonly painted: false;
    };

/** 判断单个元素是否为脚注/页脚/页码元素，谨慎避免误删正文、图表、图例与非文本装饰。 */
/** Small bottom-zone text that reads as a page number or footnote. */
function isFooterText(
  plainText: string,
  x: number,
  y: number,
  w: number,
  footerZoneTop: number,
  slideWidth: number,
): boolean {
  const lines = plainText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (plainText.length > 160 || lines.length > 2) return false;
  if (EXPLICIT_PAGE_NUMBER_TEXT_RE.test(plainText) || FOOTER_NOTE_TEXT_RE.test(plainText)) return true;
  if (!BARE_PAGE_NUMBER_RE.test(plainText) || y < footerZoneTop) return false;
  return x <= 120 || x + w >= slideWidth - 120;
}

function isFooterZoneText(element: PptdElement, slideHeight: number, slideWidth: number): boolean {
  const bounds = element.bounds;
  if (!Array.isArray(bounds) || bounds.length < 4) return false;
  const [x, y, w, h] = bounds;
  const footerZoneTop = footerZoneTopForSlide(slideHeight);
  if (y < footerZoneTop - 12 || h > Math.max(54, slideHeight * 0.11)) return false;
  const content = (element as TextElement).content;
  if (content?.field === "pageNumber" || effectiveLayoutRole(element) === "footer") return true;
  if ((content?.fontSize ?? 12) > 12) return false;
  const plainText = stripHtmlToText(content?.text ?? "").trim();
  return Boolean(plainText) && isFooterText(plainText, x, y, w, footerZoneTop, slideWidth);
}

export function isFooterElement(element: PptdElement, slideHeight = 540, slideWidth = 960): boolean {
  if (element.layoutRole === "footer") return true;
  if (element.elementType !== "text") return false;
  if (FOOTER_ID_RE.test(String(element.elementId ?? "").trim())) return true;
  if (element.layoutRole === "content") return false;
  return isFooterZoneText(element, slideHeight, slideWidth);
}

/** 检查项目磁盘上是否存在任何可清理的脚注元素（含页面、版式与母版）。 */
export function projectHasFooterElements(projectRoot: string): boolean {
  try {
    const project = loadProject(projectRoot);
    const w = project.presentation.size[0] || 960;
    const h = project.presentation.size[1] || 540;
    const anyFooter = (els: readonly PptdElement[]) => els.some((el) => isFooterElement(el, h, w));
    if ((project.presentation.masters ?? []).some((m) => anyFooter(m.elements))) return true;
    if ((project.presentation.layouts ?? []).some((l) => anyFooter(l.elements))) return true;
    return project.pages.some((loaded) => anyFooter(ownPageBody(loaded.page).elements));
  } catch {
    return false;
  }
}

const reject = (error: string, detail: string): BatchRemoveFootersOutcome => ({
  outcome: "rejected",
  error,
  detail,
  painted: false,
});

function guardViolation(
  projectRoot: string,
  targetPages: readonly LoadedPage[],
): BatchRemoveFootersOutcome | undefined {
  if (editorTurnAuthorityLost(projectRoot)) {
    return reject("review_scope_violation", "编辑授权已过期或已失效，本轮不能执行 batch_remove_footers。");
  }
  const guard = readActiveReviewGuard(projectRoot);
  if (!guard) return undefined;
  const rawScope =
    guard.scope && typeof guard.scope === "object" && !Array.isArray(guard.scope)
      ? (guard.scope as Record<string, unknown>)
      : undefined;
  if (rawScope?.metaOnly === true || layoutEditGrant(projectRoot)) {
    return reject("review_scope_violation", "当前编辑锁仅授权元数据或版式修改，拒绝执行 batch_remove_footers。");
  }
  if (!guard.scope && guard.items === undefined) {
    if (typeof guard.elementId === "string" && guard.elementId.trim()) {
      return reject("review_scope_violation", "当前编辑锁限定为单元素修改，拒绝批量删除脚注。");
    }
    const lockedPath = typeof guard.pagePath === "string" ? guard.pagePath.trim() : "";
    if (!lockedPath || targetPages.some((loaded) => loaded.path !== lockedPath)) {
      return reject("review_scope_violation", "目标页超出当前单页编辑锁授权范围，拒绝执行 batch_remove_footers。");
    }
    return undefined;
  }
  const targets = reviewWriteTargets(guard);
  if (!targets.length) {
    return reject("review_scope_violation", "当前编辑锁无效，拒绝执行 batch_remove_footers。");
  }
  for (const loaded of targetPages) {
    const pageId = persistPageKey(loaded.path);
    const target = reviewWriteTargetForPage(guard, pageId);
    if (!target) {
      return reject(
        "review_scope_violation",
        `页面 ${pageId} 不在当前编辑锁授权范围内，拒绝执行 batch_remove_footers。`,
      );
    }
    if (target.scope.kind === "elements") {
      return reject("review_scope_violation", `页面 ${pageId} 当前仅授权修改指定元素，拒绝执行 batch_remove_footers。`);
    }
  }
  return undefined;
}

/** 扫描并批量删除目标页与可选版式/母版上的脚注元素，通过规范 pptd-v2 序列化落盘。 */
type FooterSweep = {
  removedCount: number;
  readonly modifiedPages: string[];
  readonly modifiedLayouts: string[];
  readonly changedMasters: { readonly id: string; readonly payload: unknown }[];
  readonly changedLayouts: { readonly id: string; readonly payload: unknown }[];
};

type LoadedProject = ReturnType<typeof loadProject>;

function resolveTargetPages(project: LoadedProject, pageIds: readonly string[] | undefined) {
  if (pageIds === undefined) return { pages: [...project.pages] };
  const requested = pageIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  if (!requested.length) {
    return { refusal: reject("INVALID_PAGE_IDS", "pageIds 不能为空数组；如需全稿清理请省略 pageIds。") };
  }
  const matched = new Map<string, LoadedPage>();
  for (const reqId of requested) {
    const hits = project.pages.filter((loaded) => pageIdMatchesFile(reqId, loaded.path));
    if (hits.length === 0) return { refusal: reject("PAGE_NOT_FOUND", `未找到目标页面 ${reqId}，未修改任何文件。`) };
    if (hits.length > 1) return { refusal: reject("PAGE_AMBIGUOUS", `目标页面 ${reqId} 匹配多个文件，拒绝猜测。`) };
    matched.set(hits[0]!.path, hits[0]!);
  }
  return { pages: [...matched.values()] };
}

function sweepElements<T extends { elements: PptdElement[] }>(owner: T, size: readonly [number, number]): number {
  const kept = owner.elements.filter((el) => !isFooterElement(el, size[1], size[0]));
  const delta = owner.elements.length - kept.length;
  if (delta > 0) owner.elements = kept;
  return delta;
}

function sweepPages(targetPages: readonly LoadedPage[], size: readonly [number, number], sweep: FooterSweep): void {
  for (const loaded of targetPages) {
    const own = ownPageBody(loaded.page);
    const kept = own.elements.filter((el) => !isFooterElement(el, size[1], size[0]));
    const delta = own.elements.length - kept.length;
    if (delta <= 0) continue;
    loaded.page = { ...own, elements: kept };
    sweep.removedCount += delta;
    sweep.modifiedPages.push(persistPageKey(loaded.path));
  }
}

function sweepLayouts(
  project: LoadedProject,
  targetPages: readonly LoadedPage[],
  allPagesTargeted: boolean,
  size: readonly [number, number],
  sweep: FooterSweep,
): void {
  const targetPaths = new Set(targetPages.map((loaded) => loaded.path));
  const layoutIdsOf = (pages: readonly LoadedPage[]) =>
    new Set(pages.filter((loaded) => loaded.page.layoutId).map((loaded) => loaded.page.layoutId!));
  const targetLayouts = layoutIdsOf(targetPages);
  const nonTargetLayouts = layoutIdsOf(project.pages.filter((loaded) => !targetPaths.has(loaded.path)));
  if (allPagesTargeted) {
    for (const master of project.presentation.masters ?? []) {
      const removed = sweepElements(master, size);
      if (!removed) continue;
      sweep.removedCount += removed;
      sweep.modifiedLayouts.push(`master:${master.id}`);
      sweep.changedMasters.push({ id: master.id, payload: master });
    }
  }
  for (const layout of project.presentation.layouts ?? []) {
    if (!allPagesTargeted && (!targetLayouts.has(layout.id) || nonTargetLayouts.has(layout.id))) continue;
    const removed = sweepElements(layout, size);
    if (!removed) continue;
    sweep.removedCount += removed;
    sweep.modifiedLayouts.push(layout.id);
    sweep.changedLayouts.push({ id: layout.id, payload: layout });
  }
}

function recordFooterRevisions(
  projectRoot: string,
  project: LoadedProject,
  sweep: FooterSweep,
  ledgerContext: { readonly commandId: string; readonly contextEpochId: string } | undefined,
): Record<string, string> {
  const hasLedger = Boolean(readRunLedger(projectRoot));
  const revCtx = ledgerContext ?? { commandId: "batch_remove_footers", contextEpochId: "batch-remove-footers" };
  if (hasLedger) {
    const rows = [
      ...sweep.changedMasters.map((item) => ({ scope: "master" as const, item })),
      ...sweep.changedLayouts.map((item) => ({ scope: "layout" as const, item })),
    ];
    for (const { scope, item } of rows) {
      recordLayoutRevision(projectRoot, revCtx, {
        scope,
        layoutId: item.id,
        layoutSha256: stableSha256(item.payload),
        source: "agent",
      });
    }
  }
  const pageRevisions: Record<string, string> = {};
  const modifiedSet = new Set(sweep.modifiedPages);
  for (const loaded of project.pages) {
    const pageId = persistPageKey(loaded.path);
    if (!modifiedSet.has(pageId)) continue;
    const own = ownPageBody(loaded.page);
    pageRevisions[pageId] = pageRevisionSha256(loaded.page, pageId);
    if (!hasLedger) continue;
    recordPageRevision(projectRoot, revCtx, pageId, {
      id: pageId,
      pageType: own.pageType,
      elements: own.elements,
      background: own.background,
    });
  }
  return pageRevisions;
}

function removeFootersLocked(
  projectRoot: string,
  input: BatchRemoveFootersInput,
  ledgerContext: { readonly commandId: string; readonly contextEpochId: string } | undefined,
): BatchRemoveFootersOutcome {
  const project = loadProject(projectRoot);
  const size = [project.presentation.size[0] || 960, project.presentation.size[1] || 540] as const;
  const target = resolveTargetPages(project, input.pageIds);
  if (!target.pages) return target.refusal;
  const violation = guardViolation(projectRoot, target.pages);
  if (violation) return violation;
  // 存在活跃页面编辑锁且无版式授权时，严禁修改任何母版或版式。
  const hasActiveGuard = Boolean(readActiveReviewGuard(projectRoot));
  if (hasActiveGuard && input.includeLayouts === true) {
    return reject(
      "review_scope_violation",
      "当前页面编辑锁未授权修改版式或母版，拒绝带 includeLayouts=true 执行 batch_remove_footers。",
    );
  }
  const sweep: FooterSweep = {
    removedCount: 0,
    modifiedPages: [],
    modifiedLayouts: [],
    changedMasters: [],
    changedLayouts: [],
  };
  sweepPages(target.pages, size, sweep);
  const allPagesTargeted = input.pageIds === undefined && target.pages.length === project.pages.length;
  if (!hasActiveGuard && input.includeLayouts !== false) {
    sweepLayouts(project, target.pages, allPagesTargeted, size, sweep);
  }
  let pageRevisions: Record<string, string> = {};
  if (sweep.removedCount > 0) {
    saveProject(project);
    pageRevisions = recordFooterRevisions(projectRoot, project, sweep, ledgerContext);
  }
  const { removedCount, modifiedPages, modifiedLayouts } = sweep;
  return { outcome: "applied", removedCount, modifiedPages, modifiedLayouts, pageRevisions };
}

export function batchRemoveFooters(
  projectRoot: string,
  input: BatchRemoveFootersInput = {},
  ledgerContext?: { readonly commandId: string; readonly contextEpochId: string },
): BatchRemoveFootersOutcome {
  try {
    return withProjectWriteLock(projectRoot, () => removeFootersLocked(projectRoot, input, ledgerContext));
  } catch (error) {
    return reject("BATCH_REMOVE_FOOTERS_FAILED", error instanceof Error ? error.message : String(error));
  }
}

/** Canonical batch_remove_footers tool. */
export function batchRemoveFootersTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "batch_remove_footers",
    description:
      "Batch-remove footer elements (layoutRole=footer, footer* elementIds, or bottom footer-zone page numbers and small footnotes) across all persisted pages or a named pageIds subset, optionally including masters and layouts (includeLayouts defaults to true). Preserves body text, titles, charts, and tables, and fails closed under restricted editor review locks. Prefer this tool over rewriting every page when removing footers.",
    schema: {
      type: "object",
      properties: {
        pageIds: { type: "array", items: { type: "string" } },
        includeLayouts: { type: "boolean" },
      },
    },
    closed: true,
    readOnly: false,
    async execute(args, ctx) {
      const sessionId = sessionKeyOf(ctx);
      const { projectRoot, callId: toolCallId } = ctx;
      const clean: BatchRemoveFootersInput = {
        ...(Array.isArray(args.pageIds) ? { pageIds: args.pageIds.map(String) } : {}),
        ...(typeof args.includeLayouts === "boolean" ? { includeLayouts: args.includeLayouts } : {}),
      };
      return writePageSerial.enqueue(sessionId, async () => {
        const hash = commandHash("batch_remove_footers", clean as Record<string, unknown>);
        const prior = lookupToolReceipt(projectRoot, toolCallId);
        if (prior) {
          return prior.commandHash !== hash
            ? result({ outcome: "conflict", toolCallId, detail: "toolCallId reused with different arguments" })
            : { data: toJsonRecord(prior.outcome) };
        }
        const outcome = batchRemoveFooters(projectRoot, clean, {
          commandId: toolCallId,
          contextEpochId: deps.presentation.epochFor(sessionId),
        });
        recordToolReceipt(projectRoot, { toolCallId, commandHash: hash, outcome });
        return result(outcome);
      });
    },
  });
}
