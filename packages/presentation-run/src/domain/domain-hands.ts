import { buildToolState, type HandsStateFile } from "./hands-tool-state.js";
import { withWritePageRevision } from "./write-page-result.js";
import { writeTodoResult } from "./todo-hand.js";
import { writeLayoutExecution } from "./layout-hand.js";
import { requireWholePageWriteArgs } from "./whole-page-args.js";
import { listReferencesResult, readReferenceResult } from "./reference-hands.js";
import { recordImageEmitted, recordImagePrepared, recordRaster } from "./run-ledger-raster.js";
import { appendHandsLog, HANDS_LOG_REL, skillStackEvidence, type SkillStackEvidence } from "./skill-stack-evidence.js";
import { pageRewriteGate } from "./page-rewrite-gate.js";
import { pageChromeOnDisk } from "./page-chrome.js";
/**
 * Domain page tools. DSH Host calls these through PresentationRun.
 * No Pi SDK. Host does not paint leftover pages.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { quarantineCorruptFile, writeFileAtomic, writeJsonAtomic } from "./atomic-file.js";
import { explicitComposeMutations, slimComposeResult } from "./compose-receipt.js";
import { writeDeliveryProvenance } from "./delivery-provenance.js";
import {
  executeGenerateTool,
  executeGenerateToolAsync,
  orderComposedPagesByPlan,
  persistWrittenPages,
  type AgentToolState,
  type ToolExecution,
} from "./agent-tools.js";
import { inspectProjectCapabilities } from "../capabilities.js";
import type { WriteAuthorityRunner } from "../types.js";
import { runWithWriteAuthority } from "../write-authority.js";
import type { SkillPageInput } from "./skill-pages.js";
import { resolveRepoRoot } from "../catalog.js";
import {
  listOpenKimiSourceRequirements,
  resolveOpenKimiPresetDesignSourceId,
  verifyOpenKimiPack,
  type DesignDirection,
  type SourceRequirement,
  type VerifiedOpenKimiPack,
} from "./openkimi-source-pack.js";
import {
  MISSING_HOSTED_WEB_SEARCH_RECEIPT,
  briefNeedsLiveWebSearch,
  hostedResearchNeedsWebSearchReceipt,
  ledgerHasSuccessfulWebSearch,
  webSearchQueriesFromArgs,
} from "./hosted-web-search.js";
import { MaterialPackError } from "./material-pack.js";
import { MATERIAL_TOOL_NAMES, materialToolResult } from "./material-hands.js";
import { reviewPageExecution } from "./review-page-hand.js";
import { withReviewProgress } from "./review-progress.js";
import { loggedToolExecution } from "./logged-tool-execution.js";
import { withImagePlanHints } from "./image-placement.js";
import {
  bytesSha256,
  contextFromToolArgs,
  currentPageRevision,
  ensureRunLedger,
  readRunLedger,
  recordCompose,
  recordStructuralReview,
  recordWebSearchExecuted,
  requireComposeReady,
  requireTodo,
  stableSha256,
  type PageLayoutIssue,
  type ReferenceRequirement,
  type RunToolContext,
} from "./run-ledger.js";

export const DOMAIN_TOOL_NAMES = [
  "think",
  "list_references",
  "read_reference",
  "list_materials",
  "read_material",
  "view_material",
  "record_material_notes",
  "query_material",
  "write_todo",
  "write_layout",
  "write_page",
  "render_page",
  "review_page",
  "review_pages",
  "compose_deck",
  "delete_pages",
  "reorder_pages",
  "update_deck",
] as const;

export type DomainToolName = (typeof DOMAIN_TOOL_NAMES)[number];

const OPTIONAL_PORT_TOOLS = ["search_image", "generate_image", "web_search"] as const;
const INTERNAL_TOOLS = ["_mark_image_emitted", "_record_material_overview"] as const;

const HANDS_STATE_REL = path.join("_agent", "hands-state.json");
const RUNTIME_REL = path.join("_agent", "runtime.json");
const OUTLINE_REL = path.join("_agent", "outline.json");

export type DomainRuntime = {
  brief: string;
  categoryId?: string;
  designSystemId?: string;
  editorBaseUrl?: string;
  designDirection?: "self-directed" | "user-design" | "preset";
  strictExecution?: boolean;
  /** Owning browser principal; the internal raster borrows it as a cookie. */
  principal?: string;
};

export function writeDomainRuntime<T extends DomainRuntime>(root: string, runtime: T): void {
  writeJsonAtomic(path.join(root, RUNTIME_REL), runtime);
  if (runtime.strictExecution) initializeRunLedger(root);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function loadRuntime(root: string): DomainRuntime {
  const file = path.join(root, RUNTIME_REL);
  if (fs.existsSync(file)) {
    const rec = readJson(file) as Partial<DomainRuntime>;
    const designDirection =
      rec.designDirection === "self-directed" ||
      rec.designDirection === "user-design" ||
      rec.designDirection === "preset"
        ? rec.designDirection
        : undefined;
    const categoryId = typeof rec.categoryId === "string" ? rec.categoryId.trim() : "";
    const designSystemId = typeof rec.designSystemId === "string" ? rec.designSystemId.trim() : "";
    return {
      brief: String(rec.brief ?? "").trim(),
      categoryId: categoryId || undefined,
      designSystemId: designSystemId || undefined,
      editorBaseUrl: rec.editorBaseUrl,
      designDirection,
      strictExecution: rec.strictExecution === true,
      principal: typeof rec.principal === "string" && rec.principal.trim() ? rec.principal.trim() : undefined,
    };
  }
  const briefFile = path.join(root, "_agent", "brief.txt");
  return {
    brief: fs.existsSync(briefFile) ? fs.readFileSync(briefFile, "utf8").trim() : "",
  };
}

function repositoryRoot(): string {
  return resolveRepoRoot();
}

export function hasExplicitUserDesign(brief: string): boolean {
  return /(?:配色|色系|主色|辅色|颜色|视觉风格|字体|字号|版式|页面比例|16\s*[:：]\s*9|#[0-9a-f]{3,8}|深蓝|海军蓝|藏蓝|琥珀金|金色|白底|黑底)/i.test(
    brief,
  );
}

function resolveDesignDirection(runtime: DomainRuntime, pack: VerifiedOpenKimiPack): DesignDirection {
  if (runtime.designDirection === "self-directed" || runtime.designDirection === "user-design") {
    return { kind: "self-directed" };
  }
  // A color, font, ratio, or layout hint is an override. It is not a complete
  // design system and must never remove the selected OpenKimi design source.
  return {
    kind: "preset",
    sourceId: resolveOpenKimiPresetDesignSourceId(pack, runtime.designSystemId ?? ""),
  };
}

function toLedgerRequirement(pack: VerifiedOpenKimiPack, requirement: SourceRequirement): ReferenceRequirement {
  const entry = pack.entriesById.get(requirement.sourceId);
  if (!entry) throw new Error(`OpenKimi requirement is missing: ${requirement.sourceId}`);
  return {
    sourceId: requirement.sourceId,
    fileSha256: entry.sha256,
    chunkIndexes: requirement.requiredChunkIndexes,
    reason: requirement.kind === "categories" ? "category-guide" : requirement.kind,
  };
}

export function initializeRunLedger(root: string): void {
  const runtime = loadRuntime(root);
  const repoRoot = repositoryRoot();
  const pack = verifyOpenKimiPack(repoRoot);
  const designDirection = resolveDesignDirection(runtime, pack);
  const requirements = listOpenKimiSourceRequirements(pack, {
    ...(runtime.categoryId ? { categoryId: runtime.categoryId } : {}),
    designDirection,
  }).map((requirement) => toLedgerRequirement(pack, requirement));
  const executionPolicy = {
    currentRenderedLayoutRequired: runtime.strictExecution === true && Boolean(runtime.editorBaseUrl?.trim()),
    structuralReviewRequired: runtime.strictExecution === true,
  } as const;
  ensureRunLedger(root, {
    manifestSha256: bytesSha256(fs.readFileSync(pack.manifestPath)),
    requirementsId: stableSha256({ requirements }),
    requirements,
    executionPolicy,
  });
}

function loadHandsState(root: string): HandsStateFile {
  const file = path.join(root, HANDS_STATE_REL);
  if (!fs.existsSync(file)) {
    return { todos: [], writtenPages: [] };
  }
  let rec: Partial<HandsStateFile>;
  try {
    rec = readJson(file) as Partial<HandsStateFile>;
  } catch {
    // A torn buffer is a cache, not authority — quarantine it and start empty
    // rather than poisoning every subsequent tool call. Strict gates still read
    // the ledger, so an empty hands-state denies rather than grants.
    quarantineCorruptFile(file);
    return { todos: [], writtenPages: [] };
  }
  return {
    todos: Array.isArray(rec.todos) ? rec.todos : [],
    writtenPages: Array.isArray(rec.writtenPages) ? rec.writtenPages : [],
    skillDeck: rec.skillDeck,
  };
}

function saveHandsState(root: string, state: HandsStateFile): void {
  writeJsonAtomic(path.join(root, HANDS_STATE_REL), state);
}

function persistFromState(root: string, state: AgentToolState, pageMutations?: readonly SkillPageInput[]): void {
  saveHandsState(root, {
    todos: state.todos,
    writtenPages: state.writtenPages ?? [],
    skillDeck: state.skillDeck,
  });
  if (state.todos.length) {
    writeJsonAtomic(path.join(root, OUTLINE_REL), { items: state.todos });
  }
  // An explicit compose with no appended pages still owns its deck metadata
  // (notably the title), while ordinary tools must not replay prior pages.
  if (pageMutations) persistWrittenPages(state, pageMutations);
  // A compose seal also fixes the reading order: pages land on disk in write
  // order during generation, but the plan order is the deck order.
  if (pageMutations) orderComposedPagesByPlan(root, state.todos);
}

function failedTool(name: string, error: unknown): ToolExecution {
  const detail = error instanceof Error ? error.message : String(error);
  let payload: Record<string, unknown> = { error: detail };
  if (
    name === "review_page" &&
    /image was not emitted|matching raster evidence|stale page revision|delivery token/i.test(detail)
  ) {
    payload = {
      error: "review_page_evidence_missing",
      next: "render_page",
      detail,
    };
  } else if (name === "review_page" && /passing page review cannot contain unresolved issues/i.test(detail)) {
    payload = {
      error: "review_page_issues_conflict",
      next: "review_page",
      issuesContract: "verdict=pass requires issues=[]; verdict=revise requires concrete unresolved defects",
      detail,
    };
  } else if (name === "review_page" && /revise page review must name at least one issue/i.test(detail)) {
    payload = {
      error: "review_page_issues_required",
      next: "review_page",
      issuesContract: "verdict=revise requires one or more concrete unresolved visual defects",
      detail,
    };
  }
  return {
    name,
    ok: false,
    summary: "execution gate rejected",
    detail,
    payload,
  };
}

function safeProjectFile(root: string, relativePath: string): string {
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, relativePath);
  if (candidate === absoluteRoot || !candidate.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`project file escapes the run root: ${relativePath}`);
  }
  return candidate;
}

function issueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return String(item);
    const rec = item as Record<string, unknown>;
    const pageId = typeof rec.pageId === "string" ? `${rec.pageId}: ` : "";
    const message = typeof rec.message === "string" ? rec.message : JSON.stringify(rec);
    return `${pageId}${message}`;
  });
}

function layoutEvidence(value: unknown): {
  status: "pass" | "fail" | "unavailable";
  issues: PageLayoutIssue[];
} {
  if (!value || typeof value !== "object") return { status: "unavailable", issues: [] };
  const rec = value as Record<string, unknown>;
  const issues: PageLayoutIssue[] = [];
  if (Array.isArray(rec.hardIssues)) {
    for (const raw of rec.hardIssues) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const id = typeof item.elementId === "string" ? [item.elementId] : [];
      issues.push({
        code: String(item.kind ?? "rendered-layout-error"),
        severity: "error",
        elementIds: id,
        detail: String(item.detail ?? "rendered layout failed"),
      });
    }
  }
  if (Array.isArray(rec.warnings)) {
    for (const raw of rec.warnings) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const ids = Array.isArray(item.elementIds)
        ? item.elementIds.filter((id): id is string => typeof id === "string")
        : [];
      issues.push({
        code: String(item.kind ?? "rendered-layout-warning"),
        severity: "warning",
        elementIds: ids,
        detail: String(item.detail ?? "rendered layout warning"),
      });
    }
  }
  return {
    status: rec.checked === true ? (rec.ok === true ? "pass" : "fail") : "unavailable",
    issues,
  };
}

function requireHostedWebSearchBeforeWrite(root: string): void {
  const research = inspectProjectCapabilities(root).research;
  if (!hostedResearchNeedsWebSearchReceipt(research)) return;
  if (!briefNeedsLiveWebSearch(loadRuntime(root).brief)) return;
  if (ledgerHasSuccessfulWebSearch(readRunLedger(root))) return;
  throw new Error(MISSING_HOSTED_WEB_SEARCH_RECEIPT);
}

const ASYNC_DOMAIN_TOOLS = new Set(["render_page", "search_image", "generate_image", "web_search"]);
const MUTATING_SYNC_TOOLS = new Set([
  "_mark_image_emitted",
  "write_todo",
  "write_layout",
  "write_page",
  "delete_pages",
  "reorder_pages",
  "update_deck",
  "compose_deck",
  "review_page",
  "review_pages",
  "record_material_notes",
]);

function isLeaseRefusalExecution(result: ToolExecution): boolean {
  if (result.ok || !result.payload || typeof result.payload !== "object") return false;
  const outcome = (result.payload as { outcome?: unknown }).outcome;
  return outcome === "lease-conflict" || outcome === "lease-preempted-by-editor";
}

function isKnownDomainTool(name: string): boolean {
  return (
    DOMAIN_TOOL_NAMES.includes(name as DomainToolName) ||
    OPTIONAL_PORT_TOOLS.includes(name as (typeof OPTIONAL_PORT_TOOLS)[number]) ||
    INTERNAL_TOOLS.includes(name as (typeof INTERNAL_TOOLS)[number])
  );
}

function runStrictPrecheck(
  name: string,
  root: string,
  context: RunToolContext,
  cleanArgs: Record<string, unknown>,
): ToolExecution | undefined {
  if (name === "list_references")
    return loggedToolExecution(root, name, cleanArgs, listReferencesResult(root, context));
  if (name === "read_reference") {
    return loggedToolExecution(root, name, cleanArgs, readReferenceResult(root, context, cleanArgs));
  }
  const material = materialToolResult(root, name, context, cleanArgs);
  if (material) return loggedToolExecution(root, name, cleanArgs, material);
  if (name === "_mark_image_emitted") {
    const deliveryToken = String(cleanArgs.deliveryToken ?? "").trim();
    if (!deliveryToken) throw new Error("deliveryToken is required");
    const fact = recordImageEmitted(root, context, deliveryToken);
    const subject = `${fact.pageId} revision ${fact.revision}`;
    return loggedToolExecution(root, name, cleanArgs, {
      name,
      ok: true,
      summary: `${subject} image emitted`,
      detail: `${subject} image content emitted`,
      payload: fact,
    });
  }
  if (name === "write_todo") return writeTodoResult(root, context, cleanArgs, loadRuntime(root).brief);
  if (name === "write_layout") {
    return loggedToolExecution(root, name, cleanArgs, writeLayoutExecution(root, context, cleanArgs));
  }
  if (name === "write_page") {
    requireTodo(root);
    requireWholePageWriteArgs(cleanArgs);
    requireHostedWebSearchBeforeWrite(root);
    const rewrite = pageRewriteGate(root, String(cleanArgs.id ?? "").trim());
    if (!rewrite.allowed) throw new Error(rewrite.reason);
  }
  if (name === "compose_deck") requireComposeReady(root, context.contextEpochId);
  return undefined;
}

function recordAsyncLedgerFact(
  name: string,
  root: string,
  context: RunToolContext,
  result: ToolExecution,
): ToolExecution {
  if (name === "web_search") {
    const payload = (result.payload ?? {}) as Record<string, unknown>;
    recordWebSearchExecuted(root, context, {
      queries: webSearchQueriesFromArgs(payload),
      factCount: Array.isArray(payload.facts) ? payload.facts.length : 0,
    });
    return result;
  }
  if (name !== "render_page") return result;
  const payload = (result.payload ?? {}) as Record<string, unknown>;
  const { dataUrl: _legacyDataUrl, ...transportPayload } = payload;
  const pageId = String(payload.pageId ?? "").trim();
  const src = String(payload.src ?? "").trim();
  const page = currentPageRevision(root, pageId);
  if (!page || !src) throw new Error("render_page did not return a current page raster");
  const layout = layoutEvidence(payload.layout);
  const recorded = recordRaster(root, page, {
    bytes: fs.readFileSync(safeProjectFile(root, src)),
    src,
    width: Number(payload.width ?? 0),
    height: Number(payload.height ?? 0),
    layoutStatus: layout.status,
    layoutIssues: layout.issues,
    chromeSha256: pageChromeOnDisk(root, pageId),
  });
  recordImagePrepared(root, context, recorded.fact, recorded.deliveryToken);
  const layoutDetail = recorded.fact.layoutIssues.length
    ? recorded.fact.layoutIssues.map((issue) => `- ${issue.code}: ${issue.detail}`).join("\n")
    : "- none";
  return {
    ...result,
    detail: [
      result.detail,
      `revision: ${page.revision}`,
      `rasterSha256: ${recorded.fact.rasterSha256}`,
      `layoutStatus: ${recorded.fact.layoutStatus}`,
      "layoutIssues:",
      layoutDetail,
      `DELIVERY_TOKEN: ${recorded.deliveryToken}`,
    ].join("\n"),
    payload: {
      ...transportPayload,
      pageRevision: page.revision,
      pageSha256: page.pageSha256,
      rasterSha256: recorded.fact.rasterSha256,
      deliveryToken: recorded.deliveryToken,
      layoutStatus: recorded.fact.layoutStatus,
      layoutIssues: recorded.fact.layoutIssues,
    },
  };
}

function recordSyncLedgerFact(
  name: string,
  root: string,
  strict: boolean,
  context: RunToolContext | undefined,
  cleanArgs: Record<string, unknown>,
  result: ToolExecution,
): ToolExecution {
  if (strict && context && result.ok) {
    if (name === "write_page") return withWritePageRevision(root, context, result, cleanArgs);
    if (name === "review_pages") {
      recordStructuralReview(root, true, issueStrings(((result.payload ?? {}) as Record<string, unknown>).issues));
      return result;
    }
    if (name === "compose_deck") {
      const fact = recordCompose(root, context, String(cleanArgs.title ?? "").trim());
      return slimComposeResult(root, result, fact, writeDeliveryProvenance(root, fact));
    }
  } else if (strict && name === "review_pages") {
    recordStructuralReview(root, false, issueStrings(((result.payload ?? {}) as Record<string, unknown>).issues));
  }
  return result;
}

function logDomainResult(
  root: string,
  name: string,
  cleanArgs: Record<string, unknown>,
  result: ToolExecution,
): ToolExecution {
  const enriched = withReviewProgress(root, name, withImagePlanHints(root, name, result));
  const payload =
    name === "write_page"
      ? {
          painted: Boolean((enriched.payload as { painted?: boolean } | undefined)?.painted),
          restamped: Boolean((enriched.payload as { restamped?: boolean } | undefined)?.restamped),
        }
      : name === "review_pages"
        ? {
            ok: enriched.ok,
            issues: (enriched.payload as { issues?: unknown } | undefined)?.issues ?? [],
          }
        : undefined;
  appendHandsLog(root, {
    at: new Date().toISOString(),
    name,
    ok: enriched.ok,
    summary: enriched.summary,
    detail: enriched.ok ? undefined : enriched.detail,
    keys: Object.keys(cleanArgs),
    args: JSON.stringify(cleanArgs).slice(0, 1500),
    payload,
  });
  return enriched;
}

function requiresStrictLedger(name: string): boolean {
  return (
    name === "list_references" ||
    name === "read_reference" ||
    MATERIAL_TOOL_NAMES.has(name) ||
    name === "review_page" ||
    name === "write_layout" ||
    name === "_mark_image_emitted"
  );
}

function prepareHandCall(
  name: string,
  args: Record<string, unknown>,
  root: string,
):
  | { readonly done: true; readonly result: ToolExecution }
  | {
      readonly done: false;
      readonly strict: boolean;
      readonly context?: RunToolContext;
      readonly cleanArgs: Record<string, unknown>;
    } {
  const strict = Boolean(readRunLedger(root));
  // strictExecution is declared by runtime.json; a missing/corrupt ledger must
  // not silently downgrade the run to the permissive path — fail closed.
  if (!strict && loadRuntime(root).strictExecution === true) {
    return {
      done: true,
      result: loggedToolExecution(
        root,
        name,
        args,
        failedTool(name, "strict execution requires an initialized run ledger"),
      ),
    };
  }
  if (!strict) {
    if (requiresStrictLedger(name)) {
      return {
        done: true,
        result: loggedToolExecution(root, name, args, failedTool(name, "run ledger is not initialized")),
      };
    }
    return { done: false, strict: false, cleanArgs: args };
  }
  try {
    const extracted = contextFromToolArgs(args);
    const early = runStrictPrecheck(name, root, extracted.context, extracted.args);
    if (early) return { done: true, result: early };
    return { done: false, strict: true, context: extracted.context, cleanArgs: extracted.args };
  } catch (error) {
    return { done: true, result: loggedToolExecution(root, name, args, failedTool(name, error)) };
  }
}

function runSyncDomainHand(name: string, args: Record<string, unknown>, root: string): ToolExecution {
  const prep = prepareHandCall(name, args, root);
  if (prep.done) return prep.result;
  const { strict, context, cleanArgs } = prep;
  const state = buildToolState(root, loadRuntime(root), loadHandsState(root), context?.contextEpochId);
  let result: ToolExecution;
  try {
    const executionArgs =
      strict && name === "compose_deck" ? { title: String(cleanArgs.title ?? "").trim() } : cleanArgs;
    result =
      name === "review_page" && context
        ? reviewPageExecution(root, context, cleanArgs, state)
        : executeGenerateTool(name, executionArgs, state);
    const pageMutations = name === "compose_deck" && result.ok ? explicitComposeMutations(state, result) : [];
    persistFromState(root, state, name === "compose_deck" && result.ok ? pageMutations : undefined);
    result = recordSyncLedgerFact(name, root, strict, context, cleanArgs, result);
  } catch (error) {
    result = failedTool(name, error);
  }
  return logDomainResult(root, name, cleanArgs, result);
}

async function runAsyncDomainHand(
  name: string,
  args: Record<string, unknown>,
  root: string,
  runAuthorizedWrite?: WriteAuthorityRunner,
): Promise<ToolExecution> {
  const prep = prepareHandCall(name, args, root);
  if (prep.done) return prep.result;
  const { strict, context, cleanArgs } = prep;
  const state = buildToolState(root, loadRuntime(root), loadHandsState(root), context?.contextEpochId);
  if (runAuthorizedWrite) state.runAuthorizedWrite = runAuthorizedWrite;
  let result: ToolExecution;
  try {
    result = await executeGenerateToolAsync(name, cleanArgs, state);
  } catch (error) {
    result = failedTool(name, error);
  } finally {
    await state.raster?.close?.();
  }
  if (isLeaseRefusalExecution(result)) return result;
  const commitAsync = (): ToolExecution => {
    try {
      persistFromState(root, state);
      if (strict && context && result.ok) result = recordAsyncLedgerFact(name, root, context, result);
    } catch (error) {
      result = failedTool(name, error);
    }
    return logDomainResult(root, name, cleanArgs, result);
  };
  const gated = runWithWriteAuthority(root, runAuthorizedWrite, commitAsync);
  return gated.ok
    ? gated.value
    : { name, ok: false, summary: gated.summary, detail: gated.detail, payload: gated.payload };
}

export async function runDomainHand(
  name: string,
  args: Record<string, unknown>,
  root: string,
  opts?: { readonly runAuthorizedWrite?: WriteAuthorityRunner },
): Promise<ToolExecution> {
  if (!isKnownDomainTool(name)) {
    return {
      name,
      ok: false,
      summary: "unknown tool",
      detail: `not a slides domain tool: ${name}`,
      payload: { error: `unknown tool: ${name}` },
    };
  }
  if (ASYNC_DOMAIN_TOOLS.has(name)) {
    return runAsyncDomainHand(name, args, root, opts?.runAuthorizedWrite);
  }
  if (opts?.runAuthorizedWrite && MUTATING_SYNC_TOOLS.has(name)) {
    const gated = runWithWriteAuthority(root, opts.runAuthorizedWrite, () => runSyncDomainHand(name, args, root));
    return gated.ok
      ? gated.value
      : { name, ok: false, summary: gated.summary, detail: gated.detail, payload: gated.payload };
  }
  return runSyncDomainHand(name, args, root);
}

export function skillStackFromHandsLog(root: string): SkillStackEvidence {
  const file = path.join(root, HANDS_LOG_REL);
  if (!fs.existsSync(file)) return skillStackEvidence([]);
  const timed: Array<{ event: string }> = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { name?: string; ok?: boolean };
      if (!row.name) continue;
      if (row.ok === false) continue;
      timed.push({ event: `tool:${row.name}` });
    } catch {
      /* skip a broken line */
    }
  }
  return skillStackEvidence(timed);
}

function diskPageCount(root: string): number {
  const pages = path.join(root, "pages");
  if (!fs.existsSync(pages)) return 0;
  return fs.readdirSync(pages).filter((name) => name.endsWith(".page")).length;
}

function diskRasterCount(root: string): number {
  const dir = path.join(root, "_agent", "rasters");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((name) => name.endsWith(".png")).length;
}

export function mergeSkillStackEvidence(
  timed: Array<{ event: string }>,
  root?: string,
  extra?: { compose?: boolean },
): SkillStackEvidence {
  const fromEvents = skillStackEvidence(timed);
  const fromHands = root ? skillStackFromHandsLog(root) : skillStackEvidence([]);
  const pageWrites = Math.max(fromEvents.pageWrites, fromHands.pageWrites, root ? diskPageCount(root) : 0);
  const renderPages = Math.max(fromEvents.renderPages, fromHands.renderPages, root ? diskRasterCount(root) : 0);
  const outline =
    fromEvents.outline ||
    fromHands.outline ||
    Boolean(root && fs.existsSync(path.join(root, "_agent", "outline.json")));
  const visualOrReview =
    fromEvents.visualOrReview || fromHands.visualOrReview || Boolean(root && diskRasterCount(root) > 0);
  const review = fromEvents.review || fromHands.review;
  const compose = fromEvents.compose || fromHands.compose || Boolean(extra?.compose);
  const oneShotDump = fromEvents.oneShotDump && fromHands.pageWrites === 0;
  const uniquePages = root ? diskPageCount(root) : 0;
  const uniqueRasters = root ? diskRasterCount(root) : 0;
  const renderCoverage = uniquePages >= 2 ? uniqueRasters >= uniquePages : pageWrites >= 2 && renderPages >= pageWrites;
  const ok = outline && pageWrites >= 2 && visualOrReview && review && compose && !oneShotDump;
  return {
    ok,
    outline,
    pageWrites,
    renderPages,
    renderCoverage,
    visualOrReview,
    review,
    compose,
    oneShotDump,
    reason: ok
      ? extra?.compose && !fromEvents.compose
        ? "OpenKimi stack ran as agent tools; host composed after agent_end"
        : "OpenKimi stack ran as agent tools"
      : skillStackEvidence(timed).reason,
  };
}
