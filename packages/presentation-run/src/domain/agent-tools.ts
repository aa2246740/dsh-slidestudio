import {
  executePageStructureTool,
  structuralEditGuard,
  rewriteEditGuard,
} from "./page-structure-tools.js";
import { planWriteFeedback, reviewPlanCoverage } from "./plan-coverage.js";
export { rewriteLockActive } from "./page-structure-tools.js";
/**
 * Allowlisted generate tools. The model may only call these —
 * no shell, no iframe, no public web fetch.
 */
import fs from "node:fs";
import path from "node:path";
import {
  createEmptyProject,
  loadProject,
  ownPageBody,
  saveProject,
  withProjectWriteLock,
  type Page,
  type Theme,
} from "@open-slidestudio/pptd-v2";
import {
  composeBodyRules,
  extractReferenceLines,
  finalizeComposeDeck,
  isNamedClassroomFact,
  type ComposeDeck,
} from "./compose-ir.js";
import { parseCanonicalPagePlan } from "./page-plan.js";
import { diskSkillPages, reviewCurrent } from "./agent-page-review.js";
import { aspectFromSlot, type ImagePort } from "./image-port.js";
import type { ImageSearchPort } from "./image-search-port.js";
import type { GrokWebSearchResult } from "./grok-hosted.js";
import { EMPTY_HOSTED_WEB_SEARCH, webSearchQueriesFromArgs } from "./hosted-web-search.js";
import { stableSha256 } from "./run-ledger.js";
import { pageRevisionSha256 } from "./hashing.js";
import {
  isPageLayoutRefusalCode,
  pageLayoutRefusal,
  type PageLayoutRefusalCode,
} from "./page-layout-refusal.js";
import {
  readActiveReviewGuard,
  reviewWriteTargetForPage,
  reviewWriteScopeViolation,
} from "./review-write-scope.js";
import { backgroundColorWriteAuthority } from "./background-color-authority.js";
import { EDITOR_AUTHORITY_LOST_DETAIL, editorTurnAuthorityLost } from "./editor-turn-authority.js";
import {
  isTodoExhibitKind,
  isCloserPage,
  pageHasReadableCopy,
  pageHasVisibleContent,
  persistPageKey,
  persistPagePathFromId,
  pageIdMatchesFile,
  writePageSchemaIssues,
  writePageSchemaError,
  composedPageLeftoverIssues,
  EMPTY_CLOSER_PRODUCE_NEXT,
  type LayoutReview,
  type TodoExhibitKind,
} from "./layout-qa.js";
import { listMedia, saveMediaFile } from "./media-store.js";
import {
  createPageRasterPort,
  rasterToDataUrl,
  savePageRaster,
  type PageRasterPort,
  type PageRasterResult,
} from "./page-raster.js";
import type { PlaybookBundle } from "./playbook.js";
import {
  parseSkillDeck,
  parseSkillPage,
  countRawChartElements,
  DROPPED_CHART_DETAIL,
  skillToCompose,
  type SkillDeckInput,
  type SkillPageInput,
} from "./skill-pages.js";
import { assertSkillDeck } from "./deck-page-count.js";
import type { PageCountRequirement } from "./page-count-requirement.js";
import { missingOperatingFactsReason } from "./report-facts.js";
import { inspectProjectCapabilities } from "../capabilities.js";
import { packColorSourceIds } from "./pack-color-context.js";
import { effectiveCatalogPackId } from "./design-authority.js";
import { adoptedSourceIdsForState, refuseIfKindThemePack } from "./adopted-source-guard.js";
import { packColorWriteContext, PACK_COLOR_ERROR } from "./theme-pack.js";
import { holdsOnlyTemplateComponents } from "./template-component-paint.js";

export type AgentTodo = {
  pageId?: string;
  title: string;
  layoutFamily?: string;
  note?: string;
  /** Optional only for loading outlines created before the exhibit contract. */
  exhibits?: TodoExhibitKind[];
};

export type ResearchResult = {
  source: "attachment" | "classroom_common" | "intranet" | "pi-xai-hosted" | "none";
  citations: string[];
  facts: string[];
  note: string;
  gap?: string;
};

export function researchExecution(result: ResearchResult): ToolExecution {
  const detail = [
    `来源：${result.source}`,
    result.citations.length ? `引用：${result.citations.join("、")}` : "",
    result.note,
    result.gap ?? "",
    ...result.facts,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    name: "research",
    ok: true,
    summary: result.gap ? "缺口" : result.source,
    detail,
    payload: result,
  };
}

export type ToolExecution = {
  name: string;
  ok: boolean;
  summary: string;
  detail: string;
  payload: unknown;
};

export type AgentToolState = {
  brief: string;
  requestedPageCount?: number;
  pageCountRequirement?: PageCountRequirement;
  /** The context epoch that decides which native question answers are current. */
  contextEpochId?: string;
  playbook: PlaybookBundle;
  referenceText?: string;
  todos: AgentTodo[];
  researchNotes: ResearchResult[];
  deck?: ComposeDeck;
  skillDeck?: SkillDeckInput;
  writtenPages?: SkillPageInput[];
  projectRoot?: string;
  image?: ImagePort;
  imageSearch?: ImageSearchPort;
  webSearch?: { search: (query: string) => Promise<GrokWebSearchResult> };
  raster?: PageRasterPort;
  lastReview?: LayoutReview;
  lastRaster?: PageRasterResult & { pageId?: string; src?: string };
  userExplicitPack?: boolean;
  /** Run ledger active: compose must not fall back to role+bullets IR. */
  strictLedger?: boolean;
};

function writtenPages(state: AgentToolState): SkillPageInput[] {
  if (!state.writtenPages) state.writtenPages = [];
  return state.writtenPages;
}

/** Authoritative page set for review/compose: disk first, buffer only as legacy fallback. */
function reviewablePages(state: AgentToolState): { pages: SkillPageInput[]; loadError?: string } {
  if (state.projectRoot) {
    try {
      const disk = diskSkillPages(state);
      if (disk.length || state.strictLedger) return { pages: disk };
    } catch (e) {
      return {
        pages: state.strictLedger ? [] : writtenPages(state),
        loadError: e instanceof Error ? e.message : String(e),
      };
    }
  }
  const buffered = writtenPages(state);
  return { pages: buffered.length ? buffered : (state.skillDeck?.pages ?? []) };
}

function syncSkillDeckPage(state: AgentToolState, page: SkillPageInput): void {
  if (!state.skillDeck?.pages.length) return;
  const list = state.skillDeck.pages;
  const idx = list.findIndex((item) => persistPageKey(item.id) === persistPageKey(page.id));
  if (idx >= 0) list[idx] = page;
}

function wouldWipeWrittenCopy(
  existing: ReturnType<typeof loadProject>["pages"][number],
  incoming: SkillPageInput,
): boolean {
  return (
    pageHasReadableCopy({ elements: existing.page.elements }) && !pageHasReadableCopy(incoming)
  );
}

function matchExistingPageIndex(
  project: ReturnType<typeof loadProject>,
  page: SkillPageInput,
): number {
  return project.pages.findIndex((loaded) => pageIdMatchesFile(page.id, loaded.path));
}

function persistNewPagePath(page: SkillPageInput, index: number, used: Set<string>): string {
  const byId = persistPagePathFromId(page.id);
  if (byId) return byId;
  let next = index;
  let candidate = persistPageFileName(next, page.pageType);
  while (used.has(candidate)) {
    next += 1;
    candidate = persistPageFileName(next, page.pageType);
  }
  return candidate;
}

function asPersistedPage(page: SkillPageInput): {
  pageType: SkillPageInput["pageType"];
  notes: SkillPageInput["notes"];
  background: SkillPageInput["background"];
  animations: SkillPageInput["animations"];
  elements: SkillPageInput["elements"];
  layoutId?: string;
} {
  return {
    pageType: page.pageType,
    notes: page.notes,
    background: page.background,
    animations: page.animations,
    elements: page.elements,
    // The layout is stored; saveProject materialises its copies onto the page file.
    ...(page.layoutId !== undefined ? { layoutId: page.layoutId } : {}),
  };
}

/** Patch matching YAML in place. Never unlink leftover pages. Never invent copy. */
function patchPagesInPlace(
  project: ReturnType<typeof loadProject>,
  pages: readonly SkillPageInput[],
): void {
  for (const page of pages) {
    const idx = matchExistingPageIndex(project, page);
    if (idx < 0) continue;
    const existing = project.pages[idx]!;
    if (wouldWipeWrittenCopy(existing, page)) continue;
    project.pages[idx] = {
      path: existing.path,
      page: asPersistedPage(page),
    };
  }
}

function persistPageFileName(index: number, pageType?: string): string {
  const role = (pageType || "page").replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 24) || "page";
  return `pages/${String(index + 1).padStart(2, "0")}_${role}.page`;
}

type PersistRefusal = {
  ok: false;
  error:
    | "page_revision_required"
    | "page_revision_conflict"
    | "review_scope_violation"
    | PageLayoutRefusalCode;
  detail?: string;
  pageId: string;
  expectedPageSha256?: string;
  actualPageSha256?: string;
};

/**
 * Persist by page id onto the matching file. Never remap by index, first
 * `*_final`, or leftover last. Never let a staler skillDeck wipe writtenPages.
 * Unmatched pages with copy append as `pages/{persistPageKey(id)}.page`.
 * Empty pages are not appended. A newly created project has zero composed
 * pages; the first write_page lists the agent id. Host does not paint leftover YAML.
 */
function editorTurnWriteRefusal(
  state: AgentToolState,
  pages: readonly SkillPageInput[],
): PersistRefusal | undefined {
  if (!editorTurnAuthorityLost(state.projectRoot!)) return undefined;
  return {
    ok: false,
    error: "review_scope_violation",
    pageId: persistPageKey(pages[0]?.id ?? "unknown"),
    detail: EDITOR_AUTHORITY_LOST_DETAIL,
  };
}

function loadOrCreateWriteProject(
  state: AgentToolState,
  pages: readonly SkillPageInput[],
): { project: ReturnType<typeof loadProject>; title: string } | undefined {
  const root = state.projectRoot!;
  const title = state.skillDeck?.title || state.brief.slice(0, 40) || "生成中";
  const hasPptd = fs.existsSync(root) && fs.readdirSync(root).some((name) => name.endsWith(".pptd"));
  if (!hasPptd && !pages.length) return undefined;
  return {
    project: hasPptd ? loadProject(root) : createEmptyProject(root, { title }),
    title,
  };
}

function pageRevisionWriteRefusal(
  project: ReturnType<typeof loadProject>,
  pages: readonly SkillPageInput[],
  projectRoot: string,
  opts: { expectedPageSha256?: string },
): PersistRefusal | undefined {
  const expectedPageSha256 = String(opts.expectedPageSha256 ?? "").trim();
  const guard = readActiveReviewGuard(projectRoot);
  const structural = structuralEditGuard(guard);
  const rewrite = rewriteEditGuard(guard);
  const targetPageId = pages.length === 1 ? persistPageKey(pages[0]!.id) : "";
  const current = targetPageId
    ? project.pages.find((loaded) => pageIdMatchesFile(targetPageId, loaded.path))
    : undefined;
  const actualPageSha256 = current
    ? pageRevisionSha256(current.page, persistPageKey(current.path))
    : undefined;
  const singleMissingPage = pages.length === 1 && !current;
  const structuralNewPage = structural !== undefined && singleMissingPage;
  const rewriteNewPage = rewrite !== undefined && singleMissingPage;
  if (
    guard &&
    (!expectedPageSha256 || pages.length !== 1 || !current) &&
    !structuralNewPage &&
    !rewriteNewPage
  ) {
    return {
      ok: false,
      error: "page_revision_required",
      pageId: persistPageKey(pages[0]?.id ?? "unknown"),
      actualPageSha256,
    };
  }
  if (expectedPageSha256 && (!targetPageId || actualPageSha256 !== expectedPageSha256)) {
    return {
      ok: false,
      error: "page_revision_conflict",
      pageId: targetPageId || persistPageKey(pages[0]?.id ?? "unknown"),
      expectedPageSha256,
      actualPageSha256,
    };
  }
  return undefined;
}

function structuralScopeRefusal(
  project: ReturnType<typeof loadProject>,
  pages: readonly SkillPageInput[],
  structural: NonNullable<ReturnType<typeof structuralEditGuard>>,
): PersistRefusal | undefined {
  for (const proposed of pages) {
    const pageId = persistPageKey(proposed.id);
    const existing = project.pages.find((loaded) => pageIdMatchesFile(proposed.id, loaded.path));
    if (existing && !structural.editablePageIds.has(pageId)) {
      return {
        ok: false,
        error: "review_scope_violation",
        pageId,
        detail: `Page ${pageId} is an existing page outside the structural edit's editable set`,
      };
    }
  }
  return undefined;
}

function rewriteScopeRefusal(
  project: ReturnType<typeof loadProject>,
  pages: readonly SkillPageInput[],
  rewrite: NonNullable<ReturnType<typeof rewriteEditGuard>>,
): PersistRefusal | undefined {
  for (const proposed of pages) {
    const pageId = persistPageKey(proposed.id);
    const existing = project.pages.find((loaded) => pageIdMatchesFile(proposed.id, loaded.path));
    if (existing && !rewrite.baselinePageIds.has(pageId)) {
      return {
        ok: false,
        error: "review_scope_violation",
        pageId,
        detail: `Page ${pageId} is not part of the rewrite baseline`,
      };
    }
  }
  return undefined;
}

function guardedScopeRefusal(
  project: ReturnType<typeof loadProject>,
  pages: readonly SkillPageInput[],
  guard: NonNullable<ReturnType<typeof readActiveReviewGuard>>,
): PersistRefusal | undefined {
  for (const proposed of pages) {
    const pageId = persistPageKey(proposed.id);
    const target = reviewWriteTargetForPage(guard, pageId);
    if (!target) {
      return {
        ok: false,
        error: "review_scope_violation",
        pageId,
        detail: `Page ${pageId} is outside the authorized existing pages`,
      };
    }
    const elementGuard = target.scope.kind === "elements";
    if (elementGuard && !target.pageBody) {
      return {
        ok: false,
        error: "review_scope_violation",
        pageId,
        detail: "The original element review baseline is missing; create a new review",
      };
    }
    const existing = project.pages.find((loaded) => pageIdMatchesFile(proposed.id, loaded.path));
    const violation = reviewWriteScopeViolation(
      target.scope,
      pageId,
      elementGuard ? ownPageBody(target.pageBody as unknown as Page) : existing && ownPageBody(existing.page),
      asPersistedPage(proposed),
    );
    if (violation) return { ok: false, error: "review_scope_violation", pageId, detail: violation };
  }
  return undefined;
}

function reviewScopeWriteRefusal(
  project: ReturnType<typeof loadProject>,
  pages: readonly SkillPageInput[],
  projectRoot: string,
): PersistRefusal | undefined {
  const guard = readActiveReviewGuard(projectRoot);
  const structural = structuralEditGuard(guard);
  if (structural) return structuralScopeRefusal(project, pages, structural);
  const rewrite = rewriteEditGuard(guard);
  if (rewrite) return rewriteScopeRefusal(project, pages, rewrite);
  if (guard && (guard.scope || guard.items !== undefined)) {
    return guardedScopeRefusal(project, pages, guard);
  }
  return undefined;
}

function layoutWriteRefusal(
  project: ReturnType<typeof loadProject>,
  pages: readonly SkillPageInput[],
): PersistRefusal | undefined {
  for (const proposed of pages) {
    const refusal = pageLayoutRefusal(project.presentation, asPersistedPage(proposed));
    if (!refusal) continue;
    return {
      ok: false,
      error: refusal.error,
      pageId: persistPageKey(proposed.id),
      detail: refusal.detail,
    };
  }
  return undefined;
}

function commitWrittenPages(
  project: ReturnType<typeof loadProject>,
  pages: readonly SkillPageInput[],
  state: AgentToolState,
  title: string,
): void {
  const root = state.projectRoot!;
  const guard = readActiveReviewGuard(root);
  const structural = structuralEditGuard(guard);
  if (!guard && !project.presentation.title?.trim()) project.presentation.title = title;
  if (project.pages.length > 0) patchPagesInPlace(project, pages);
  const used = new Set(project.pages.map((loaded) => loaded.path));
  const added: typeof project.pages = [];
  for (const [index, page] of pages.entries()) {
    if (matchExistingPageIndex(project, page) >= 0) continue;
    if ([...used].some((listed) => pageIdMatchesFile(page.id, listed))) continue;
    if (
      !pageHasVisibleContent(page) &&
      !pageHasReadableCopy(page) &&
      !holdsOnlyTemplateComponents(page, root)
    ) {
      continue;
    }
    const nextPath = persistNewPagePath(page, project.pages.length + index, used);
    if (!nextPath || used.has(nextPath)) continue;
    used.add(nextPath);
    const entry = { path: nextPath, page: asPersistedPage(page) };
    if (structural) added.push(entry);
    else project.pages.push(entry);
  }
  if (structural && added.length) {
    const baselineIds = new Set(
      (Array.isArray(guard?.projectPages) ? guard.projectPages : [])
        .map((entry) => persistPageKey(String((entry as Record<string, unknown>)?.pageId ?? "")))
        .filter((id) => id.length > 0),
    );
    const alreadyAdded = baselineIds.size
      ? project.pages.filter((loaded) => !baselineIds.has(persistPageKey(loaded.path))).length
      : 0;
    const pos = Math.max(
      0,
      Math.min((structural.insertIndex ?? project.pages.length) + alreadyAdded, project.pages.length),
    );
    project.pages.splice(pos, 0, ...added);
  }
  project.presentation.pages = project.pages.map((page) => page.path);
  saveProject(project);
}

function persistPagesUnderLock(
  state: AgentToolState,
  pages: readonly SkillPageInput[],
  opts: { expectedPageSha256?: string },
): PersistRefusal | undefined {
  const lost = editorTurnWriteRefusal(state, pages);
  if (lost) return lost;
  const opened = loadOrCreateWriteProject(state, pages);
  if (!opened) return undefined;
  const root = state.projectRoot!;
  const revision = pageRevisionWriteRefusal(opened.project, pages, root, opts);
  if (revision) return revision;
  const scope = reviewScopeWriteRefusal(opened.project, pages, root);
  if (scope) return scope;
  const layout = layoutWriteRefusal(opened.project, pages);
  if (layout) return layout;
  commitWrittenPages(opened.project, pages, state, opened.title);
  return undefined;
}

/**
 * Persist only the pages mutated by the current tool call when a scope is
 * supplied. Replaying hands-state's historical writtenPages would otherwise
 * overwrite an editor change to p1 while DSH is writing an unrelated p2.
 */
export function persistWrittenPages(
  state: AgentToolState,
  pageScope?: readonly SkillPageInput[],
  opts: { expectedPageSha256?: string } = {},
): { ok: true } | PersistRefusal {
  if (!state.projectRoot) return { ok: true };
  const pages = pageScope ?? writtenPages(state);
  let conflict: PersistRefusal | undefined;
  withProjectWriteLock(state.projectRoot, () => {
    conflict = persistPagesUnderLock(state, pages, opts);
  });
  return conflict ?? { ok: true };
}

/**
 * Order the composed manifest by the plan the agent committed in write_todo.
 * Pages are appended in write order during generation, but the plan — not the
 * write sequence — is the intended reading order. Pages a todo does not name
 * keep their relative order after the planned ones.
 */
export function orderComposedPagesByPlan(root: string, todos: readonly AgentTodo[]): void {
  const wanted = todos
    .map((todo) => persistPageKey(todo.pageId ?? todo.title))
    .filter((key) => key.length > 0);
  if (!wanted.length) return;
  withProjectWriteLock(root, () => {
    // A turn whose editor lease lapsed keeps the page order it was given.
    if (editorTurnAuthorityLost(root)) return;
    const project = loadProject(root);
    const remaining = [...project.pages];
    const ordered: typeof project.pages = [];
    for (const key of wanted) {
      const index = remaining.findIndex((loaded) => pageIdMatchesFile(key, loaded.path));
      if (index < 0) continue;
      ordered.push(...remaining.splice(index, 1));
    }
    ordered.push(...remaining);
    const sameOrder =
      ordered.length === project.pages.length &&
      ordered.every((loaded, index) => loaded.path === project.pages[index]?.path);
    if (sameOrder) return;
    project.pages = ordered;
    project.presentation.pages = ordered.map((loaded) => loaded.path);
    saveProject(project);
  });
}

function lastDiskBasename(state: AgentToolState): string | undefined {
  if (!state.projectRoot) return undefined;
  const manifest = path.join(state.projectRoot, "deck.pptd");
  if (!fs.existsSync(manifest)) return undefined;
  try {
    const last = loadProject(state.projectRoot).pages.at(-1);
    return last ? path.basename(last.path, ".page") : undefined;
  } catch {
    return undefined;
  }
}

function siblingImageSrcsForWrite(
  state: AgentToolState,
  pageId: string,
): { pageId: string; src: string }[] {
  const rows: { pageId: string; src: string }[] = [];
  const seen = new Set<string>();
  const add = (id: string, src: string) => {
    if (persistPageKey(id) === persistPageKey(pageId) || !src) return;
    const key = `${persistPageKey(id)}\0${src}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ pageId: id, src });
  };
  let diskPages: ReturnType<typeof loadProject>["pages"] = [];
  if (state.projectRoot && fs.existsSync(path.join(state.projectRoot, "deck.pptd"))) {
    try {
      diskPages = loadProject(state.projectRoot).pages;
    } catch {
      diskPages = [];
    }
  }
  for (const loaded of diskPages) {
    const rec = loaded.page as Record<string, unknown>;
    const id =
      path.basename(loaded.path, ".page") || (typeof rec.id === "string" ? rec.id.trim() : "");
    if (!id) continue;
    for (const el of loaded.page.elements) {
      if (el.elementType === "image" && typeof el.src === "string") add(id, el.src);
    }
  }
  for (const page of writtenPages(state)) {
    for (const el of page.elements) {
      if (el.elementType === "image" && typeof el.src === "string") add(page.id, el.src);
    }
  }
  return rows;
}

function leftoverComposeIssue(state: AgentToolState) {
  if (!state.projectRoot) return undefined;
  const manifest = path.join(state.projectRoot, "deck.pptd");
  if (!fs.existsSync(manifest)) return undefined;
  try {
    return composedPageLeftoverIssues(loadProject(state.projectRoot).pages)[0];
  } catch {
    return undefined;
  }
}

function refuseIfNoReportFacts(
  name: string,
  state: AgentToolState,
): ReturnType<typeof executeGenerateTool> | undefined {
  const reason = missingOperatingFactsReason(state.brief, state.referenceText);
  if (!reason) return undefined;
  return {
    name,
    ok: false,
    summary: "要数据",
    detail: reason,
    payload: { error: "need_data" },
  };
}

function refuseIfMissingHostedWebSearch(
  _name: string,
  _state: AgentToolState,
  _phase: "write" | "compose",
): ReturnType<typeof executeGenerateTool> | undefined {
  // Grok search is dsh-oauth native hosted tools on the produce request.
  return undefined;
}

/**
 * The pack-colour context of the agent write and compose checks (one of the four pack_color callers).
 * The playbook keeps the Hub pack as history; a saved style decision may have replaced it since.
 */
export function packColorSchemaContext(state: AgentToolState, _args: Record<string, unknown> = {}) {
  const designSystemId = state.projectRoot
    ? effectiveCatalogPackId(state.projectRoot, state.playbook.designSystemId || undefined)
    : state.playbook.designSystemId;
  const ids = packColorSourceIds(state.projectRoot, designSystemId);
  return packColorWriteContext(ids, state.projectRoot);
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

export function parseToolArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim() || "{}";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return asRecord(parsed);
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
      try {
        return asRecord(JSON.parse(fence[1]!.trim()));
      } catch {
        return {};
      }
    }
    return {};
  }
}

function playbookSection(bundle: PlaybookBundle, section: string): string {
  switch (section) {
    case "skill":
      return bundle.skillExcerpt;
    case "images": {
      const start = bundle.skillExcerpt.indexOf("##### Images and Visual Materials");
      const host = bundle.skillExcerpt.slice(0, bundle.skillExcerpt.indexOf("\n\n"));
      const images =
        start >= 0
          ? bundle.skillExcerpt.slice(start, bundle.skillExcerpt.indexOf("##### Content", start))
          : "";
      return [host, images.trim()].filter(Boolean).join("\n\n");
    }
    case "pptd":
      return bundle.pptdExcerpt;
    case "category":
      return bundle.categoryMarkdown;
    case "guide":
      return bundle.categoryGuideExcerpt;
    case "design":
      return `design_system: ${bundle.designSystemId}\n\n${bundle.designMarkdown.slice(0, 2000)}`;
    case "recipes":
      return bundle.recipesMarkdown;
    case "catalog":
      return JSON.stringify(
        {
          categoryId: bundle.categoryId,
          designSystemId: bundle.designSystemId,
          sections: ["skill", "images", "pptd", "category", "guide", "design", "recipes"],
          note: "Read recipes before write_page. Media is optional. search_image / generate_image only if those ports are YES. Otherwise official no-image layouts.",
        },
        null,
        2,
      );
    default:
      return "Unknown section. Use catalog, skill, images, pptd, category, guide, design, or recipes.";
  }
}

function filterLines(lines: string[], query?: string): string[] {
  const q = query?.trim();
  if (!q) return lines;
  const tokens = q
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  return lines.filter((line) => {
    const low = line.toLowerCase();
    return low.includes(q.toLowerCase()) || tokens.some((t) => low.includes(t));
  });
}

export function runResearch(query: string, brief: string, referenceText?: string): ResearchResult {
  const refs = extractReferenceLines(referenceText);
  const hits = filterLines(refs.lines, query);
  if (hits.length) {
    return {
      source: "attachment",
      citations: refs.names,
      facts: hits.slice(0, 8),
      note: "只引用附件原文，不是网络检索。",
    };
  }
  if (refs.lines.length) {
    return {
      source: "attachment",
      citations: refs.names,
      facts: refs.lines.slice(0, 5),
      note: "查询无精确命中，退回附件摘录。",
    };
  }
  if (isNamedClassroomFact(`${brief} ${query}`)) {
    return {
      source: "classroom_common",
      citations: [],
      facts: [
        "直角对着的边叫斜边，另外两边叫直角边。",
        "勾股关系：两直角边的平方和等于斜边的平方。3、4、5 是课堂练习数，不是统计。",
      ],
      note: "课堂常识，不是出处，不是调查数据。",
    };
  }
  return {
    source: "none",
    citations: [],
    facts: [],
    note: "没有可引用的来源。",
    gap: "没有可引用的来源。页上必须标占位，禁止编造机构名、网址或精确统计。",
  };
}

export function executeGenerateTool(
  name: string,
  args: Record<string, unknown>,
  state: AgentToolState,
): ToolExecution {
  if (name === "think") {
    const summary = String(args.summary ?? "").trim() || "思考";
    const detail = String(args.detail ?? "").trim();
    if (!detail) {
      return {
        name,
        ok: false,
        summary: "think.detail required",
        detail: "think.detail required",
        payload: { error: "detail required" },
      };
    }
    return { name, ok: true, summary, detail, payload: { summary, detail } };
  }

  if (name === "read_playbook") {
    const section = String(args.section ?? "catalog").trim() || "catalog";
    const text = playbookSection(state.playbook, section);
    return {
      name,
      ok: true,
      summary: section,
      detail: text,
      payload: { section, text },
    };
  }

  if (name === "read_file") {
    const refs = extractReferenceLines(state.referenceText);
    if (!refs.names.length && !refs.lines.length) {
      const payload = { names: [], lines: [], note: "没有上传参考资料。" };
      return {
        name,
        ok: true,
        summary: "无附件",
        detail: payload.note,
        payload,
      };
    }
    const query = typeof args.query === "string" ? args.query : undefined;
    const lines = filterLines(refs.lines, query).slice(0, 20);
    const detail = [`来源：${refs.names.join("、") || "未命名"}`, ...lines].join("\n");
    return {
      name,
      ok: true,
      summary: `${refs.names.length} 份`,
      detail,
      payload: { names: refs.names, lines, query: query ?? null },
    };
  }

  if (name === "research") {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return {
        name,
        ok: false,
        summary: "query required",
        detail: "research.query required",
        payload: { error: "query required" },
      };
    }
    const result = runResearch(query, state.brief, state.referenceText);
    state.researchNotes.push(result);
    return researchExecution(result);
  }

  if (name === "write_todo") {
    const blocked = refuseIfNoReportFacts(name, state) ?? refuseIfKindThemePack(name, state, args);
    if (blocked) return blocked;
    let items: AgentTodo[];
    try {
      items = parseCanonicalPagePlan(args.items).map((page) => ({
        ...page,
        exhibits: [...page.exhibits],
      }));
    } catch (error) {
      return {
        name,
        ok: false,
        summary: "incomplete plan",
        detail: error instanceof Error ? error.message : String(error),
        payload: { error: "incomplete_plan" },
      };
    }
    const feedback = planWriteFeedback(state.projectRoot, items, state.brief, state.contextEpochId);
    if (feedback.countMismatch) {
      return {
        name,
        ok: false,
        summary: "page count mismatch",
        detail: feedback.countMismatch,
        payload: {
          error: "page_count_mismatch",
          plannedCount: items.length,
          next: "write_todo",
        },
      };
    }
    state.todos = items;
    const detail = items
      .map(
        (it, i) =>
          `${it.pageId ?? String(i + 1).padStart(2, "0")}  ${it.title}${it.layoutFamily ? `  <${it.layoutFamily}>` : ""}  [${it.exhibits?.join(", ") ?? "none"}]${it.note ? `  · ${it.note}` : ""}`,
      )
      .join("\n");
    return {
      name,
      ok: true,
      summary: `${items.length} 页`,
      detail: [detail, ...feedback.hints].join("\n"),
      payload: { items, ...feedback },
    };
  }

  const structureResult = executePageStructureTool(name, args, state);
  if (structureResult) return structureResult;

  if (name === "write_page") {
    const blocked =
      refuseIfNoReportFacts(name, state) ??
      refuseIfKindThemePack(name, state, args) ??
      refuseIfMissingHostedWebSearch(name, state, "write");
    if (blocked) return blocked;
    const parsed = parseSkillPage(args, writtenPages(state).length);
    if (!parsed) {
      return {
        name,
        ok: false,
        summary: "invalid page",
        detail: `write_page needs official vocab: cover-botanical|title-band|coral-rule|chapter|page-title|route-path|method-panels|two-column-45-55|demo-band|two-column-body|result-bar|next-action|footer-chrome, or header|list|box|circle|band|text with position/bounds. keys=${Object.keys(args).join(",")}`,
        payload: { error: "invalid page" },
      };
    }
    const page = parsed;
    const rawCharts = countRawChartElements(args.elements);
    const keptCharts = page.elements.filter((el) => el.elementType === "chart").length;
    if (rawCharts > keptCharts) {
      return {
        name,
        ok: false,
        summary: "chart dropped",
        detail: DROPPED_CHART_DETAIL,
        payload: { error: "dropped_chart", painted: false },
      };
    }
    const list = writtenPages(state);
    const planKeys = (state.todos ?? [])
      .map((todo) => (todo.pageId ? persistPageKey(todo.pageId) : ""))
      .filter((key) => key.length > 0);
    const rewriteLock = state.projectRoot
      ? rewriteEditGuard(readActiveReviewGuard(state.projectRoot))
      : undefined;
    // A rewrite's committed plan is the verify contract — writing before
    // write_todo would be rolled back wholesale, so refuse it up front.
    if (rewriteLock && !planKeys.length) {
      return {
        name,
        ok: false,
        summary: "not in plan",
        detail: "a rewrite must commit its new outline via write_todo before any write_page",
        payload: { error: "not_in_plan", painted: false },
      };
    }
    if ((state.todos ?? []).length > 0 && planKeys.length > 0) {
      const key = persistPageKey(page.id);
      const persisted = list.some((p) => persistPageKey(p.id) === key);
      // A structural page-list lock deliberately creates pages the committed
      // plan does not know; a rewrite's new ids ARE in the freshly committed
      // plan, so only a structural lock bypasses this check.
      const structuralLock = state.projectRoot
        ? structuralEditGuard(readActiveReviewGuard(state.projectRoot))
        : undefined;
      if (!persisted && !planKeys.includes(key) && structuralLock === undefined) {
        return {
          name,
          ok: false,
          summary: "not in plan",
          detail: `page ${page.id} is not in the current plan — call write_todo first to add it (title/exhibits), then write_page`,
          payload: { error: "not_in_plan", painted: false },
        };
      }
    }
    const existingIdx = list.findIndex((p) => persistPageKey(p.id) === persistPageKey(page.id));
    const index = existingIdx >= 0 ? existingIdx : list.length;
    const last = existingIdx >= 0 ? list.length - 1 : list.length;
    const diskLast = lastDiskBasename(state);
    let diskPageCount: number | undefined;
    let theme: Theme | undefined;
    let persistedBackgroundColor: string | undefined;
    if (state.projectRoot) {
      try {
        const project = loadProject(state.projectRoot);
        diskPageCount = project.pages.length;
        theme = project.presentation.theme;
        const persistedPage = project.pages.find((loaded) =>
          pageIdMatchesFile(page.id, loaded.path),
        );
        if (persistedPage?.page.background?.type === "solid") {
          persistedBackgroundColor = persistedPage.page.background.color;
        }
      } catch {
        diskPageCount = undefined;
      }
    }
    const siblingImageSrcs = siblingImageSrcsForWrite(state, page.id);
    const todoExhibits = (state.todos ?? []).find(
      (todo) => todo.pageId && persistPageKey(todo.pageId) === persistPageKey(page.id),
    )?.exhibits;
    let photoExhibit: boolean | undefined;
    if (todoExhibits?.includes("photo") && state.projectRoot) {
      const caps = inspectProjectCapabilities(state.projectRoot, process.env);
      if (caps.imageSearch.configured || caps.imageGenerate.configured) photoExhibit = true;
    }
    const schemaCtx = {
      writtenIndex: index,
      writtenLast: last,
      ...(planKeys.length ? { planLast: planKeys.at(-1) === persistPageKey(page.id) } : {}),
      lastDiskBasename: diskLast,
      diskPageCount: diskLast ? diskPageCount : undefined,
      theme,
      ...packColorSchemaContext(state, args),
      ...backgroundColorWriteAuthority({
        projectRoot: state.projectRoot,
        pageId: page.id,
        persistedBackgroundColor,
      }),
      ...(siblingImageSrcs.length ? { siblingImageSrcs } : {}),
      projectRoot: state.projectRoot,
      ...(photoExhibit ? { photoExhibit } : {}),
    };
    const schemaIssues = writePageSchemaIssues(page, schemaCtx, args);
    const schemaError = writePageSchemaError(schemaIssues, page, schemaCtx);
    if (schemaError) {
      return {
        name,
        ok: false,
        summary: schemaError.error === "empty_closer" ? "empty closer" : schemaError.error,
        detail: schemaError.detail,
        payload: {
          error: schemaError.error,
          pageId: schemaError.pageId,
          painted: false,
          next: schemaError.error === "empty_closer" ? "write_page" : undefined,
        },
      };
    }
    const kinds = [...new Set(page.elements.map((el) => el.elementType))].join("+");
    const persisted = persistWrittenPages(state, [page], {
      expectedPageSha256: String(args.expectedPageSha256 ?? "").trim() || undefined,
    });
    if (!persisted.ok && isPageLayoutRefusalCode(persisted.error)) {
      return {
        name,
        ok: false,
        summary: persisted.error,
        detail: persisted.detail ?? persisted.error,
        payload: { ...persisted, painted: false },
      };
    }
    if (!persisted.ok) {
      return {
        name,
        ok: false,
        summary:
          persisted.error === "review_scope_violation"
            ? "edit outside selected target"
            : "page changed",
        detail:
          persisted.error === "review_scope_violation"
            ? `write_page rejected before saving: ${persisted.detail}. Read the page again and change only the authorized target; preserve all other elements and page settings exactly.`
            : `write_page rejected because ${persisted.pageId} changed after read_page; read the page again and reapply the requested edit`,
        payload: { ...persisted, painted: false },
      };
    }
    const idx = list.findIndex((p) => p.id === page.id);
    if (idx >= 0) list[idx] = page;
    else list.push(page);
    syncSkillDeckPage(state, page);
    return {
      name,
      ok: true,
      summary: `${page.id} · ${page.elements.length} el`,
      detail: `${page.id}  ${page.pageType ?? "page"}  ${kinds}\n${list.length} pages on disk\nwrite_page kept agent elements; host did not restamp`,
      payload: { page, pageCount: list.length, applied: false, painted: false, restamped: false },
    };
  }

  if (name === "review_pages") {
    const { pages, loadError } = reviewablePages(state);
    if (loadError && state.strictLedger) {
      return {
        name,
        ok: false,
        summary: "project unreadable",
        detail: `loadProject failed: ${loadError}. Disk is the SSOT; review cannot grade a stale buffer.`,
        payload: { error: "project_unreadable" },
      };
    }
    if (!pages.length && !state.todos.length) {
      return {
        name,
        ok: false,
        summary: "need pages",
        detail: "write_page first. A one-page plan is valid.",
        payload: { error: "need pages" },
      };
    }
    const review = reviewPlanCoverage(
      state.projectRoot,
      state.todos,
      reviewCurrent(state, pages, "compose"),
    );
    const ok = review.ok;
    const rasterNote = state.lastRaster
      ? `last render_page: ${state.lastRaster.kind} ${state.lastRaster.src ?? ""} — ${state.lastRaster.note}`
      : "no render_page yet — you have not seen the native #slide";
    return {
      name,
      ok,
      summary: ok ? `${pages.length} 页通过` : `${review.issues.length} 个问题`,
      detail: ok
        ? `${rasterNote}\nstructural QA only unless render_page returned native-slide.\n${review.pages.map((p) => `${p.id} cover=${p.coverage.toFixed(2)} exhibit=${p.exhibit ?? "none"}`).join("\n")}`
        : [review.hint, ...review.issues.map((i) => `${i.pageId}: ${i.message}`)]
            .filter(Boolean)
            .join("\n"),
      payload: { ...review, lastRaster: state.lastRaster ?? null },
    };
  }

  if (name === "compose_deck") {
    const blocked =
      refuseIfNoReportFacts(name, state) ??
      refuseIfKindThemePack(name, state, args) ??
      refuseIfMissingHostedWebSearch(name, state, "compose");
    if (blocked) return blocked;
    const leftover = leftoverComposeIssue(state);
    if (leftover) {
      return {
        name,
        ok: false,
        summary: leftover.kind === "host_seed" ? "host seed leftover" : "empty closer",
        detail: leftover.message,
        payload: {
          error: leftover.kind === "host_seed" ? "host_seed" : "empty_closer",
          pageId: leftover.pageId,
          next: "write_page",
        },
      };
    }
    const rules = composeBodyRules(
      state.brief,
      state.playbook.categoryId,
      state.pageCountRequirement ?? state.requestedPageCount,
    );
    try {
      const buffered = writtenPages(state);
      const incoming = parseSkillDeck(args);
      let diskPages: SkillPageInput[] = [];
      let diskLoadError = "";
      if (state.projectRoot) {
        try {
          diskPages = diskSkillPages(state);
        } catch (e) {
          diskLoadError = e instanceof Error ? e.message : String(e);
        }
      }
      if (state.strictLedger && diskLoadError) {
        return {
          name,
          ok: false,
          summary: "project unreadable",
          detail: `loadProject failed: ${diskLoadError}. Disk is the SSOT; compose cannot grade a stale buffer.`,
          payload: { error: "project_unreadable" },
        };
      }
      let skill = diskPages.length
        ? {
            title: String(args.title ?? state.skillDeck?.title ?? "未命名演示"),
            pages: diskPages,
          }
        : (incoming ??
          (buffered.length
            ? {
                title: String(args.title ?? state.skillDeck?.title ?? "未命名演示"),
                pages: buffered,
              }
            : null));
      if (skill) {
        let composeTheme: Theme | undefined;
        let composeProject: ReturnType<typeof loadProject> | undefined;
        if (state.projectRoot) {
          try {
            composeProject = loadProject(state.projectRoot);
            composeTheme = composeProject.presentation.theme;
          } catch {
            composeTheme = undefined;
          }
        }
        const packCtx = { theme: composeTheme, ...packColorSchemaContext(state, args) };
        for (const page of skill.pages) {
          const persistedPage = composeProject?.pages.find((loaded) =>
            pageIdMatchesFile(page.id, loaded.path),
          );
          const persistedBackgroundColor =
            persistedPage?.page.background?.type === "solid"
              ? persistedPage.page.background.color
              : undefined;
          const pagePackCtx = {
            ...packCtx,
            ...backgroundColorWriteAuthority({
              pageId: page.id,
              persistedBackgroundColor,
              includeActiveOverride: false,
            }),
          };
          const packErr = writePageSchemaError(
            writePageSchemaIssues(page, pagePackCtx),
            page,
            pagePackCtx,
          );
          if (packErr?.error === PACK_COLOR_ERROR) {
            return {
              name,
              ok: false,
              summary: "pack color",
              detail: packErr.detail,
              payload: {
                error: PACK_COLOR_ERROR,
                pageId: packErr.pageId,
                painted: false,
              },
            };
          }
        }
        const todoN = state.todos?.length ?? 0;
        const writtenN = skill.pages.length;
        // Match plan→page by persisted key, not array position/count: a renamed
        // pageId must still satisfy its own todo line, and duplicate keys must
        // not let one written page cover two planned pages.
        const writtenKeys = new Set(skill.pages.map((p) => persistPageKey(p.id)));
        const missingTodos = state.todos.filter((todo) => {
          const key = persistPageKey(todo.pageId ?? todo.title);
          return key && !writtenKeys.has(key);
        });
        if (todoN >= 3 && (writtenN < todoN || missingTodos.length)) {
          return {
            name,
            ok: false,
            summary: `还差 ${Math.max(todoN - writtenN, missingTodos.length)} 页`,
            detail: `write_todo has ${todoN} pages; write_page landed ${writtenN}.${missingTodos.length ? ` Missing: ${missingTodos.map((t) => t.pageId ?? t.title).join(", ")}.` : ""} Keep calling write_page. The host will not paint the rest.`,
            payload: {
              error: "compose_before_todo_done",
              todo: todoN,
              written: writtenN,
              missing: missingTodos.map((t) => t.pageId ?? t.title),
            },
          };
        }
        // The closer is the last page in reading order. A middle page merely
        // typed or named "closing" is not the deck's closer — thin closers are
        // already rejected at write_page time, so compose checks position only.
        const last = skill.pages[skill.pages.length - 1];
        if (last && skill.pages.length > 1 && !pageHasReadableCopy(last)) {
          return {
            name,
            ok: false,
            summary: "empty closer",
            detail: `page "${last.id}" is the last page: ${EMPTY_CLOSER_PRODUCE_NEXT}`,
            payload: { error: "empty_closer", pageId: last.id, next: "write_page" },
          };
        }
        const review = reviewCurrent(state, skill.pages, "compose");
        const reportBlocks = review.issues.filter(
          (i) =>
            i.code === "unnamed_gap" ||
            i.code === "missing_column" ||
            i.code === "missing_locked_fact" ||
            i.code === "missing_requested_exhibit" ||
            i.code === "empty_cell" ||
            i.code === "overflow" ||
            i.code === "overlap" ||
            i.code === "overlap_layout" ||
            i.code === "zero_area" ||
            i.code === "bounds_omitted",
        );
        if (reportBlocks.length) {
          return {
            name,
            ok: false,
            summary: "report facts QA failed",
            detail: reportBlocks.map((i) => `${i.pageId}: ${i.message}`).join("\n"),
            payload: { error: "report facts QA failed", review },
          };
        }
        if (!review.ok) {
          const closerEmpty = review.issues.find(
            (issue) => issue.code === "empty" && /closer|readable copy|结束页/.test(issue.message),
          );
          if (closerEmpty) {
            return {
              name,
              ok: false,
              summary: "empty closer",
              detail: EMPTY_CLOSER_PRODUCE_NEXT,
              payload: {
                error: "empty_closer",
                pageId: closerEmpty.pageId,
                next: "write_page",
              },
            };
          }
          return {
            name,
            ok: false,
            summary: "layout QA failed",
            detail: review.issues.map((i) => `${i.pageId}: ${i.message}`).join("\n"),
            payload: { error: "layout QA failed", review },
          };
        }
        assertSkillDeck(skill, {
          minPages: rules.minPages,
          pageCount: rules.pageCount,
        });
        state.skillDeck = skill;
        state.deck = skillToCompose(skill);
        // The strict path grades disk pages but never runs applySkillDeck, so
        // the manifest keeps its brief-derived title forever — stamp the
        // finalized compose title so chrome/export name the deck properly.
        const composedTitle = skill.title?.trim();
        if (composedTitle && state.projectRoot) {
          withProjectWriteLock(state.projectRoot, () => {
            // An editor turn whose lease lapsed keeps its deck title.
            if (editorTurnAuthorityLost(state.projectRoot!)) return;
            const project = loadProject(state.projectRoot!);
            if ((project.presentation.title ?? "") !== composedTitle) {
              project.presentation.title = composedTitle;
              saveProject(project);
            }
          });
        }
        const detail = skill.pages
          .map((p, i) => {
            const kinds = [...new Set(p.elements.map((el) => el.elementType))].join("+");
            return `${String(i + 1).padStart(2, "0")}  ${p.pageType ?? "page"}  ${p.id}  · ${p.elements.length} el (${kinds})`;
          })
          .join("\n");
        return {
          name,
          ok: true,
          summary: `${skill.pages.length} 页 PPTD`,
          detail,
          payload: skill,
        };
      }
      if (state.strictLedger) {
        return {
          name,
          ok: false,
          summary: "no written pages",
          detail:
            "The run ledger is active: compose only accepts pages persisted through write_page. The role+bullets IR fallback is disabled because it bypasses every gate.",
          payload: { error: "ir_fallback_disabled", next: "write_page" },
        };
      }
      const deck = finalizeComposeDeck(args, state.todos, rules);
      state.skillDeck = undefined;
      state.deck = deck;
      const detail = deck.pages
        .map((p, i) => {
          const n = (p.bullets?.length ?? 0) + (p.items?.length ?? 0);
          const extra = p.chart ? "  · chart" : n ? `  · ${n} 条` : "";
          return `${String(i + 1).padStart(2, "0")}  ${p.role}  ${p.title}${extra}`;
        })
        .join("\n");
      return {
        name,
        ok: true,
        summary: `${deck.pages.length} 页 · IR fallback`,
        detail: `role+bullets only — skill did not write PPTD elements.\n${detail}`,
        payload: deck,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        name,
        ok: false,
        summary: "invalid compose",
        detail: msg,
        payload: { error: msg },
      };
    }
  }

  return {
    name,
    ok: false,
    summary: "unknown tool",
    detail: `Tool not allowed: ${name}`,
    payload: { error: `unknown tool: ${name}` },
  };
}

export function toolStepMeta(name: string): { tool: string; label: string } {
  switch (name) {
    case "think":
      return { tool: "think", label: "Think" };
    case "read_playbook":
    case "read_file":
      return { tool: "read_file", label: "Read" };
    case "research":
      return { tool: "research", label: "Research" };
    case "web_search":
      return { tool: "web_search", label: "Web Search" };
    case "write_todo":
      return { tool: "write_todo", label: "Write Todo" };
    case "compose_deck":
      return { tool: "compose_deck", label: "Compose Deck" };
    case "generate_image":
      return { tool: "generate_image", label: "Image" };
    case "search_image":
      return { tool: "search_image", label: "Search Image" };
    case "write_page":
      return { tool: "write_page", label: "Write Page" };
    case "write_layout":
      return { tool: "write_layout", label: "Write Layout" };
    case "render_page":
      return { tool: "render_page", label: "Render" };
    case "review_pages":
      return { tool: "review_pages", label: "Review" };
    default:
      return { tool: name, label: name };
  }
}

export async function executeGenerateToolAsync(
  name: string,
  args: Record<string, unknown>,
  state: AgentToolState,
): Promise<ToolExecution> {
  if (name === "web_search") {
    const queries = webSearchQueriesFromArgs(args);
    if (!queries.length) {
      return {
        name,
        ok: false,
        summary: "queries required",
        detail: "web_search needs queries[]",
        payload: { error: "queries required" },
      };
    }
    if (!state.webSearch) {
      return {
        name,
        ok: false,
        summary: "not configured",
        detail: "web_search is a Grok hosted tool; inspect_capabilities.research is off",
        payload: { error: "web_search is not configured" },
      };
    }
    const facts: string[] = [];
    const citations: string[] = [];
    const texts: string[] = [];
    for (const query of queries) {
      const result = await state.webSearch.search(query);
      facts.push(...result.facts);
      citations.push(...result.citations);
      if (result.text.trim()) texts.push(result.text.trim());
    }
    const uniqueFacts = [...new Set(facts)];
    const uniqueCitations = [...new Set(citations)];
    if (uniqueFacts.length === 0 && uniqueCitations.length === 0) {
      return {
        name,
        ok: false,
        summary: "empty search",
        detail: EMPTY_HOSTED_WEB_SEARCH,
        payload: { error: EMPTY_HOSTED_WEB_SEARCH, queries },
      };
    }
    state.researchNotes.push({
      source: "pi-xai-hosted",
      citations: uniqueCitations,
      facts: uniqueFacts,
      note: "xAI web_search — live hosted search, not assistant prose.",
    });
    return {
      name,
      ok: true,
      summary: uniqueFacts.length ? `${uniqueFacts.length} facts` : "searched",
      detail: [...texts, ...uniqueCitations.map((url) => `source: ${url}`)]
        .filter(Boolean)
        .join("\n"),
      payload: {
        queries,
        query: queries[0],
        text: texts.join("\n\n"),
        facts: uniqueFacts,
        citations: uniqueCitations,
        source: "pi-xai-hosted",
      },
    };
  }
  if (name === "generate_image") {
    const id = String(args.id ?? "").trim();
    const prompt = String(args.prompt ?? "").trim();
    if (!id || !prompt) {
      return {
        name,
        ok: false,
        summary: "id+prompt required",
        detail: "generate_image needs id and prompt",
        payload: { error: "id and prompt required" },
      };
    }
    if (!state.projectRoot) {
      return {
        name,
        ok: false,
        summary: "no project",
        detail: "generate_image needs a project root to write media/",
        payload: { error: "no projectRoot" },
      };
    }
    if (!state.image) {
      return {
        name,
        ok: false,
        summary: "not configured",
        detail: "generate_image is not configured; refusing to write a placeholder PNG",
        payload: { error: "generate_image is not configured" },
      };
    }
    const slotW = Number(args.width);
    const slotH = Number(args.height);
    const namedAspect = typeof args.aspect === "string" ? args.aspect.trim() : "";
    let aspect: string | undefined;
    if (slotW > 0 && slotH > 0) {
      try {
        aspect = aspectFromSlot(slotW, slotH);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          name,
          ok: false,
          summary: "bad slot",
          detail,
          payload: { error: detail },
        };
      }
    } else if (namedAspect) {
      aspect = namedAspect;
    } else {
      return {
        name,
        ok: false,
        summary: "frame size required",
        detail:
          "generate_image needs the planned photo frame width and height in page pixels so the file matches the slot. Do not omit them and default to 16:9.",
        payload: { error: "width and height required" },
      };
    }
    try {
      const image = await state.image.generate(prompt, aspect);
      const ext = image.mime === "image/jpeg" ? "jpg" : "png";
      const saved = saveMediaFile(state.projectRoot, id, image.bytes, ext);
      return {
        name,
        ok: true,
        summary: `${saved.src} · ${image.kind}`,
        detail: [
          `src: ${saved.src}`,
          `size: ${image.width}×${image.height}`,
          `aspect: ${aspect}`,
          `kind: ${image.kind}`,
          image.note,
          `media: ${listMedia(state.projectRoot).join(", ")}`,
        ].join("\n"),
        payload: {
          src: saved.src,
          width: image.width,
          height: image.height,
          aspect,
          kind: image.kind,
          note: image.note,
        },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        name,
        ok: false,
        summary: "generate failed",
        detail,
        payload: { error: detail, painted: false },
      };
    }
  }
  if (name === "search_image") {
    const id = String(args.id ?? "").trim();
    const query = String(args.query ?? "").trim();
    if (!id || !query) {
      return {
        name,
        ok: false,
        summary: "id+query required",
        detail: "search_image needs id and query",
        payload: { error: "id and query required" },
      };
    }
    if (!state.imageSearch) {
      return {
        name,
        ok: true,
        summary: "no search port",
        detail: "imageSearch is not configured — do not write src. Design without a bitmap.",
        payload: { kind: "none", note: "no image search port" },
      };
    }
    const hit = await state.imageSearch.search(query);
    if ("kind" in hit && hit.kind === "none") {
      return {
        name,
        ok: true,
        summary: "no image",
        detail: hit.note,
        payload: { kind: "none", note: hit.note },
      };
    }
    if (!state.projectRoot) {
      return {
        name,
        ok: false,
        summary: "no project",
        detail: "search_image needs a project root to write media/",
        payload: { error: "no projectRoot" },
      };
    }
    const found = hit as {
      bytes: Buffer;
      mime: string;
      width?: number;
      height?: number;
      attribution?: string;
      note: string;
    };
    const ext = found.mime === "image/jpeg" ? "jpg" : found.mime === "image/webp" ? "webp" : "png";
    const saved = saveMediaFile(state.projectRoot, id, found.bytes, ext);
    return {
      name,
      ok: true,
      summary: `${saved.src} · search`,
      detail: [
        `src: ${saved.src}`,
        found.width && found.height ? `size: ${found.width}×${found.height}` : "",
        found.note,
        `media: ${listMedia(state.projectRoot).join(", ")}`,
      ]
        .filter(Boolean)
        .join("\n"),
      payload: {
        src: saved.src,
        width: found.width,
        height: found.height,
        kind: "search",
        note: found.note,
        attribution: found.attribution,
      },
    };
  }
  if (name === "render_page") {
    const pages = writtenPages(state);
    if (!pages.length) {
      return {
        name,
        ok: false,
        summary: "need pages",
        detail: "write_page first",
        payload: { error: "need pages" },
      };
    }
    let index = typeof args.pageIndex === "number" ? Math.floor(args.pageIndex) : -1;
    const pageId = String(args.pageId ?? "").trim();
    if (index < 0 && pageId) {
      index = pages.findIndex((p) => p.id === pageId);
    }
    if (index < 0) index = pages.length - 1;
    if (index < 0 || index >= pages.length) {
      return {
        name,
        ok: false,
        summary: "bad page",
        detail: "render_page pageId / pageIndex not found",
        payload: { error: "page not found" },
      };
    }
    const port = state.raster ?? createPageRasterPort();
    const shot = await port.render({
      projectRoot: state.projectRoot ?? "",
      pageIndex: index,
    });
    let src: string | undefined;
    let dataUrl: string | undefined;
    if (shot.kind === "native-slide" && shot.bytes && state.projectRoot) {
      const saved = savePageRaster(state.projectRoot, pages[index]!.id, shot.bytes);
      src = saved.src;
      dataUrl = rasterToDataUrl(shot.bytes);
    }
    state.lastRaster = { ...shot, pageId: pages[index]!.id, src };
    return {
      name,
      ok: shot.kind === "native-slide",
      summary:
        shot.kind === "native-slide"
          ? `${pages[index]!.id} · native #slide`
          : "did not see the slide",
      detail: [shot.note, src ? `src: ${src}` : "", `page: ${pages[index]!.id}`]
        .filter(Boolean)
        .join("\n"),
      payload: {
        pageId: pages[index]!.id,
        pageIndex: index,
        src,
        width: shot.width,
        height: shot.height,
        kind: shot.kind,
        note: shot.note,
        dataUrl,
        layout: shot.layout,
      },
    };
  }
  return executeGenerateTool(name, args, state);
}
