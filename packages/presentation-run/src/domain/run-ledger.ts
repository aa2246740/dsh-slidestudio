import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { parseCanonicalPagePlan, type CanonicalPlanPage } from "./page-plan.js";
import { currentDiskPageFacts, planCoverageBlockers } from "./plan-coverage.js";
import { isCloserPage, isPlaceholderReviewIssue, pageHasReadableCopy } from "./layout-qa.js";
import { inspectProjectCapabilities } from "../capabilities.js";
import { executionPolicyFor, leftoverComposeBlockers, yamlStructureBlockers } from "./run-ledger-policy.js";
import { latestPageFacts } from "./page-revision-ledger.js";
import type { LayoutRevisionFact } from "./layout-ledger.js";
import type { TemplateComponentUsedFact } from "./template-component-ledger.js";
import {
  MISSING_HOSTED_WEB_SEARCH_RECEIPT,
  hostedResearchNeedsWebSearchReceipt,
  ledgerHasSuccessfulWebSearch,
} from "./hosted-web-search.js";
import { spinWait, writeFileAtomic } from "./atomic-file.js";
import { bytesSha256, stableSha256 } from "./hashing.js";
import { inspectPageEvidence } from "./page-evidence.js";
import { diskProject, layoutChromes, pageChromes } from "./page-chrome.js";
import { composeLayoutChromes, composePageChromes } from "./compose-chromes.js";
import { layoutComposeBlockers, renderedLayoutBlockers } from "./layout-compose-gate.js";
import type { MaterialChunkFact, MaterialReadFact } from "./material-read-progress.js";
export type { MaterialChunkFact } from "./material-read-progress.js";
import type { MaterialFiguresFact, PageProvenanceFact } from "./material-figures.js";
export type { MaterialFiguresFact, PageProvenanceFact } from "./material-figures.js";
import { isReferenceReadFact, type ReferenceChunkPreparedFact, type ReferenceEpochCarriedFact } from "./reference-facts.js";
export type { ReferenceChunkPreparedFact, ReferenceEpochCarriedFact } from "./reference-facts.js";
import { OPENKIMI_SECTIONED_REFERENCE_LAYOUT } from "./openkimi-pptd-sections.js";

export const RUN_LEDGER_REL = path.join("_agent", "run-ledger.v1.json");
/** Bump whenever rendered layout acceptance semantics change. */
export const RENDERED_LAYOUT_GATE_VERSION = "rendered-layout-gate-v8";
/** Bump whenever structural review rules change. */
export const STRUCTURAL_REVIEW_GATE_VERSION = "structural-review-gate-v6";

export type RunToolContext = Readonly<{
  commandId: string;
  contextEpochId: string;
}>;

export type ReferenceRequirement = Readonly<{
  sourceId: string;
  fileSha256: string;
  chunkIndexes: readonly number[];
  reason: "skill" | "pptd" | "category-guide" | "scenario" | "preset-design";
}>;

export type ReferenceChunkFact = Readonly<{
  type: "reference.chunk-returned";
  factId: string;
  at: string;
  contextEpochId: string;
  sourceId: string;
  fileSha256: string;
  chunkIndex: number;
  chunkSha256: string;
}>;

export type TodoFact = Readonly<{
  type: "todo.committed";
  factId: string;
  at: string;
  contextEpochId: string;
  todoSha256: string;
  itemCount: number;
  pageIds?: readonly string[];
  pagePlan?: readonly CanonicalPlanPage[];
}>;

export type PageRevisionFact = Readonly<{
  type: "page.revision-committed";
  factId: string;
  at: string;
  contextEpochId: string;
  pageId: string;
  revision: number;
  pageSha256: string;
}>;

export type PageEditAuthorizationFact = Readonly<{
  type: "page.edit-authorized";
  factId: string;
  at: string;
  authorizationId: string;
  source: "editor-agent";
  pageId: string;
  revision: number;
  pageSha256: string;
  expiresAt: string;
}>;

export type PageEditAuthorizationInput = Readonly<{
  authorizationId: string;
  pageId: string;
  revision: number;
  pageSha256: string;
  ttlMs?: number;
}>;

export type PageLayoutIssue = Readonly<{
  code: string;
  severity: "error" | "warning";
  elementIds: readonly string[];
  detail: string;
}>;

export type RasterFact = Readonly<{
  type: "page.raster-committed";
  factId: string;
  at: string;
  pageId: string;
  revision: number;
  pageSha256: string;
  rasterSha256: string;
  src: string;
  width: number;
  height: number;
  layoutGateVersion?: string;
  layoutStatus: "pass" | "fail" | "unavailable";
  layoutIssues: readonly PageLayoutIssue[];
  /** Chrome fingerprint of the masters and layouts shown when rendered ("none" without one). */
  chromeSha256?: string;
}>;

export type ImagePreparedFact = Readonly<{
  type: "page.image-result-prepared";
  factId: string;
  at: string;
  contextEpochId: string;
  pageId: string;
  revision: number;
  pageSha256: string;
  rasterSha256: string;
  deliveryToken: string;
}>;

export type ImageEmittedFact = Readonly<{
  type: "page.image-content-emitted";
  factId: string;
  at: string;
  contextEpochId: string;
  commandId: string;
  pageId: string;
  revision: number;
  pageSha256: string;
  rasterSha256: string;
  deliveryToken: string;
}>;

export type VisualReviewFact = Readonly<{
  type: "page.visual-review-recorded";
  factId: string;
  at: string;
  contextEpochId: string;
  pageId: string;
  revision: number;
  pageSha256: string;
  rasterSha256: string;
  deliveryToken: string;
  verdict: "pass" | "revise";
  issues: readonly string[];
}>;

export type StructuralReviewFact = Readonly<{
  type: "deck.structural-review-recorded";
  factId: string;
  at: string;
  reviewGateVersion?: string;
  pageRevisions: Readonly<Record<string, string>>;
  ok: boolean;
  issues: readonly string[];
}>;

export type DeckComposedFact = Readonly<{
  type: "deck.composed";
  factId: string;
  at: string;
  contextEpochId: string;
  title: string;
  deckSha256: string;
  pageRevisions: Readonly<Record<string, string>>;
  /** Chrome of the pages that showed a layout at compose time; absent when none did. */
  pageChromes?: Readonly<Record<string, string>>;
}>;

export type WebSearchExecutedFact = Readonly<{
  type: "web-search.executed";
  factId: string;
  at: string;
  contextEpochId: string;
  commandId: string;
  queries: readonly string[];
  factCount: number;
  source: "pi-xai-hosted";
  ok: true;
}>;

export type ExportSucceededFact = Readonly<{
  type: "export.succeeded";
  factId: string;
  at: string;
  contextEpochId: string;
  commandId: string;
  artifactPath: string;
  artifactSha256: string;
  artifactBytes: number;
  reportPath: string;
  reportSha256: string;
  slideCount: number;
  materialFingerprint: string;
  producer: "agent-tool";
}>;

export type RunFact =
  | ReferenceChunkFact
  | ReferenceChunkPreparedFact
  | ReferenceEpochCarriedFact
  | MaterialReadFact
  | TodoFact
  | PageRevisionFact
  | PageEditAuthorizationFact
  | RasterFact
  | ImagePreparedFact
  | ImageEmittedFact
  | VisualReviewFact
  | StructuralReviewFact
  | DeckComposedFact
  | WebSearchExecutedFact
  | ExportSucceededFact
  | PageProvenanceFact
  | MaterialFiguresFact
  | LayoutRevisionFact
  | TemplateComponentUsedFact;

export type RunLedgerV1 = Readonly<{
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  updatedAt: string;
  sourcePack: Readonly<{
    manifestSha256: string;
    requirementsId: string;
    requirements: readonly ReferenceRequirement[];
    /** Immutable production acceptance policy. Optional only for pre-policy ledgers. */
    executionPolicy?: Readonly<{
      currentRenderedLayoutRequired: boolean;
      structuralReviewRequired: boolean;
    }>;
    /** Sectioned (v2) reference requirements. Absent on v1 ledgers, which stay whole-file. */
    referenceLayout?: typeof OPENKIMI_SECTIONED_REFERENCE_LAYOUT;
  }>;
  facts: readonly RunFact[];
}>;

export type PageEvidenceStatus = Readonly<{
  pageId: string;
  revision: number;
  pageSha256: string;
  raster: boolean;
  imageEmitted: boolean;
  visualReview: "pass" | "revise" | "missing";
  layout: "pass" | "fail" | "unavailable" | "missing";
  /** The latest raster showed other masters or layouts than the deck now has; render again. */
  chromeStale: boolean;
}>;

export type RunLedgerInspection = Readonly<{
  initialized: boolean;
  contextEpochId?: string;
  referencesComplete: boolean;
  missingReferenceChunks: readonly { sourceId: string; chunkIndex: number }[];
  todoCount: number;
  pages: readonly PageEvidenceStatus[];
  structuralReview: "pass" | "fail" | "missing";
  composeReady: boolean;
  composeBlockers: readonly string[];
  composed: boolean;
}>;

export function nowIso(): string {
  return new Date().toISOString();
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

export { bytesSha256, stableSha256 };

export function factId(type: RunFact["type"], payload: unknown): string {
  return `${type}:${stableSha256(payload)}`;
}

function parseRequirements(raw: unknown): ReferenceRequirement[] {
  if (!Array.isArray(raw)) throw new Error("run ledger source requirements must be an array");
  return raw.map((item) => {
    const rec = asRecord(item);
    if (!rec) throw new Error("invalid run ledger source requirement");
    const sourceId = typeof rec.sourceId === "string" ? rec.sourceId : "";
    const fileSha256 = typeof rec.fileSha256 === "string" ? rec.fileSha256 : "";
    const reason = rec.reason;
    const chunkIndexes = Array.isArray(rec.chunkIndexes)
      ? rec.chunkIndexes.filter((n): n is number => Number.isInteger(n) && Number(n) >= 0)
      : [];
    if (!sourceId || !fileSha256 || !chunkIndexes.length) {
      throw new Error("invalid run ledger source requirement fields");
    }
    if (
      reason !== "skill" &&
      reason !== "pptd" &&
      reason !== "category-guide" &&
      reason !== "scenario" &&
      reason !== "preset-design"
    ) {
      throw new Error("invalid run ledger source requirement reason");
    }
    return { sourceId, fileSha256, chunkIndexes, reason };
  });
}

function parseExecutionPolicy(
  raw: unknown,
): RunLedgerV1["sourcePack"]["executionPolicy"] | undefined {
  if (raw === undefined) return undefined;
  const rec = asRecord(raw);
  if (
    !rec ||
    typeof rec.currentRenderedLayoutRequired !== "boolean" ||
    typeof rec.structuralReviewRequired !== "boolean"
  ) {
    throw new Error("invalid run ledger execution policy");
  }
  return {
    currentRenderedLayoutRequired: rec.currentRenderedLayoutRequired,
    structuralReviewRequired: rec.structuralReviewRequired,
  };
}

function parseLedger(raw: unknown): RunLedgerV1 {
  const rec = asRecord(raw);
  if (!rec || rec.schemaVersion !== 1) throw new Error("invalid run ledger schema");
  const pack = asRecord(rec.sourcePack);
  if (!pack) throw new Error("invalid run ledger source pack");
  if (!Array.isArray(rec.facts)) throw new Error("invalid run ledger facts");
  return {
    schemaVersion: 1,
    runId: String(rec.runId ?? ""),
    createdAt: String(rec.createdAt ?? ""),
    updatedAt: String(rec.updatedAt ?? ""),
    sourcePack: {
      manifestSha256: String(pack.manifestSha256 ?? ""),
      requirementsId: String(pack.requirementsId ?? ""),
      requirements: parseRequirements(pack.requirements),
      executionPolicy: parseExecutionPolicy(pack.executionPolicy),
      ...(pack.referenceLayout === OPENKIMI_SECTIONED_REFERENCE_LAYOUT
        ? { referenceLayout: OPENKIMI_SECTIONED_REFERENCE_LAYOUT }
        : {}),
    },
    facts: rec.facts as RunFact[],
  };
}

function ledgerFile(root: string): string {
  return path.join(root, RUN_LEDGER_REL);
}

export function readRunLedger(root: string): RunLedgerV1 | undefined {
  const file = ledgerFile(root);
  if (!fs.existsSync(file)) return undefined;
  try {
    return parseLedger(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
  } catch {
    // A crash or power loss can leave the atomic write as a zero-filled stub.
    // Quarantine it so one damaged deck reads as "ledger not initialized"
    // instead of throwing through every inspect/derive caller.
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // best effort — an unreadable dir still must not throw here
    }
    return undefined;
  }
}

function acquireLock(root: string): () => void {
  const dir = path.join(root, "_agent");
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, "run-ledger.lock");
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }), "utf8");
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lock);
        } catch {
          // Another recovery path may already have removed a stale lock.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > 30_000) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (attempt === 39) throw new Error("run ledger is locked by another process", { cause: error });
      spinWait(5);
    }
  }
  throw new Error("run ledger lock unavailable");
}

function writeLedger(root: string, ledger: RunLedgerV1): void {
  writeFileAtomic(ledgerFile(root), `${JSON.stringify(ledger, null, 2)}\n`);
}

export function mutateLedger(
  root: string,
  apply: (current: RunLedgerV1) => RunLedgerV1,
): RunLedgerV1 {
  const release = acquireLock(root);
  try {
    const current = readRunLedger(root);
    if (!current) throw new Error("run ledger is not initialized");
    const next = apply(current);
    writeLedger(root, next);
    return next;
  } finally {
    release();
  }
}

function mergeCompatibleSourcePack(
  current: RunLedgerV1,
  sourcePack: RunLedgerV1["sourcePack"],
): RunLedgerV1 {
  if (
    current.sourcePack.manifestSha256 !== sourcePack.manifestSha256 ||
    current.sourcePack.requirementsId !== sourcePack.requirementsId ||
    (current.sourcePack.executionPolicy !== undefined &&
      stableSha256(current.sourcePack.executionPolicy) !== stableSha256(sourcePack.executionPolicy))
  ) {
    throw new Error("run ledger source requirements changed for an active run");
  }
  if (current.sourcePack.executionPolicy || !sourcePack.executionPolicy) return current;
  return {
    ...current,
    updatedAt: nowIso(),
    sourcePack: { ...current.sourcePack, executionPolicy: sourcePack.executionPolicy },
  };
}

export function ensureRunLedgerExecutionPolicy(
  root: string,
  executionPolicy: NonNullable<RunLedgerV1["sourcePack"]["executionPolicy"]>,
): RunLedgerV1 | undefined {
  const existing = readRunLedger(root);
  if (!existing) return undefined;
  return mutateLedger(root, (current) => {
    const currentPolicy = current.sourcePack.executionPolicy;
    if (currentPolicy && stableSha256(currentPolicy) !== stableSha256(executionPolicy)) {
      throw new Error("run ledger execution policy changed for an active run");
    }
    if (currentPolicy) return current;
    return {
      ...current,
      updatedAt: nowIso(),
      sourcePack: { ...current.sourcePack, executionPolicy },
    };
  });
}

export function ensureRunLedger(root: string, sourcePack: RunLedgerV1["sourcePack"]): RunLedgerV1 {
  const existing = readRunLedger(root);
  if (existing) {
    const merged = mergeCompatibleSourcePack(existing, sourcePack);
    return merged === existing
      ? existing
      : mutateLedger(root, (current) => mergeCompatibleSourcePack(current, sourcePack));
  }
  const release = acquireLock(root);
  try {
    const raced = readRunLedger(root);
    if (raced) {
      const merged = mergeCompatibleSourcePack(raced, sourcePack);
      if (merged !== raced) writeLedger(root, merged);
      return merged;
    }
    const at = nowIso();
    const created: RunLedgerV1 = {
      schemaVersion: 1,
      runId: crypto.randomUUID(),
      createdAt: at,
      updatedAt: at,
      sourcePack,
      facts: [],
    };
    writeLedger(root, created);
    return created;
  } finally {
    release();
  }
}

/** Append-only ledger write with factId dedupe; shared by every fact recorder. */
export function appendFact(root: string, fact: RunFact): RunLedgerV1 {
  return mutateLedger(root, (current) => {
    if (current.facts.some((item) => item.factId === fact.factId)) return current;
    return { ...current, updatedAt: fact.at, facts: [...current.facts, fact] };
  });
}

export function recordReferenceChunk(
  root: string,
  context: RunToolContext,
  input: Omit<ReferenceChunkFact, "type" | "factId" | "at" | "contextEpochId">,
): void {
  const payload = { ...input, contextEpochId: context.contextEpochId };
  appendFact(root, {
    type: "reference.chunk-returned",
    factId: factId("reference.chunk-returned", payload),
    at: nowIso(),
    ...payload,
  });
}

export function recordMaterialChunk(
  root: string,
  context: RunToolContext,
  input: Omit<MaterialChunkFact, "type" | "factId" | "at" | "contextEpochId">,
): void {
  const { chunkCount, ...identity } = input;
  const payload = { ...identity, contextEpochId: context.contextEpochId };
  appendFact(root, {
    type: "material.chunk-returned",
    factId: factId("material.chunk-returned", payload),
    at: nowIso(),
    ...payload,
    ...(chunkCount !== undefined ? { chunkCount } : {}),
  });
}

/** `material:<id>` design-source chunks already returned in this context epoch. */
export function materialChunksRead(root: string, contextEpochId: string): ReadonlySet<string> {
  const ledger = readRunLedger(root);
  if (!ledger) return new Set();
  return new Set(
    ledger.facts
      .filter(
        (fact): fact is MaterialChunkFact =>
          fact.type === "material.chunk-returned" &&
          (!contextEpochId || fact.contextEpochId === contextEpochId),
      )
      .map((fact) => `${fact.materialId}#${fact.chunkIndex}`),
  );
}

export function recordTodo(
  root: string,
  context: RunToolContext,
  items: readonly unknown[],
): readonly CanonicalPlanPage[] {
  const pagePlan = parseCanonicalPagePlan(items);
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const pageIds = pagePlan.map((item) => item.pageId);
  const payload = {
    contextEpochId: context.contextEpochId,
    todoSha256: stableSha256(pagePlan),
    itemCount: pagePlan.length,
    ...(pageIds.length ? { pageIds } : {}),
    pagePlan,
  };
  // Returning to an earlier declaration is still a new ordered planning event.
  appendFact(root, {
    type: "todo.committed",
    factId: factId("todo.committed", { ...payload, precedingFactId: ledger.facts.at(-1)?.factId }),
    at: nowIso(),
    ...payload,
  });
  return pagePlan;
}

export {
  currentPageRevision,
  latestPageFacts,
  recordPageRevision,
} from "./page-revision-ledger.js";

/**
 * Authorize one editor-originated Agent rewrite of an exact page revision.
 * The grant is deliberately short-lived and revision-bound: after the first
 * successful write changes the revision, the same grant cannot unlock another
 * write. Generation-time repaint protection therefore remains intact.
 */
export { authorizePageEdit, authorizePageEdits } from "./page-edit-authorization.js";

export function recordVisualReview(
  root: string,
  context: RunToolContext,
  input: Readonly<{
    pageId: string;
    revision: number;
    deliveryToken: string;
    verdict: "pass" | "revise";
    issues: readonly string[];
  }>,
  env: NodeJS.ProcessEnv = process.env,
): VisualReviewFact {
  if (inspectProjectCapabilities(root, env).vision.mode === "none") {
    throw new Error(
      "review_page cannot claim a visual pass: no vision reviewer is configured and MiniMax text did not see the page raster. Do not send verdict=pass.",
    );
  }
  const realIssues = input.issues.filter((issue) => !isPlaceholderReviewIssue(issue));
  if (input.verdict === "pass" && input.issues.some((issue) => isPlaceholderReviewIssue(issue))) {
    throw new Error(
      'review_page cannot pass with issues:["none"] — that is not pixel proof. MiniMax text has not seen the raster.',
    );
  }
  if (input.verdict === "pass" && realIssues.length) {
    throw new Error(
      `a passing page review cannot contain unresolved issues: ${realIssues.join("; ")}. Fix them and render again, or send verdict=revise.`,
    );
  }
  if (input.verdict === "revise" && !realIssues.length) {
    throw new Error("a revise page review must name at least one issue");
  }
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const current = latestPageFacts(ledger).get(input.pageId);
  if (!current || current.revision !== input.revision) {
    throw new Error("page review targets a stale page revision");
  }
  const emitted = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is ImageEmittedFact =>
        fact.type === "page.image-content-emitted" &&
        fact.pageId === input.pageId &&
        fact.revision === input.revision &&
        fact.pageSha256 === current.pageSha256 &&
        fact.deliveryToken === input.deliveryToken,
    );
  if (!emitted) {
    throw new Error(
      `page image was not emitted for ${input.pageId} revision ${input.revision} with that delivery token. ` +
        "Call render_page for this page again, wait for the successful image result, and copy its exact full DELIVERY_TOKEN.",
    );
  }
  const raster = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is RasterFact =>
        fact.type === "page.raster-committed" &&
        fact.pageId === input.pageId &&
        fact.revision === input.revision &&
        fact.pageSha256 === current.pageSha256 &&
        fact.rasterSha256 === emitted.rasterSha256 &&
        fact.layoutGateVersion === RENDERED_LAYOUT_GATE_VERSION,
    );
  if (!raster) throw new Error("page review has no matching raster evidence");
  if (input.verdict === "pass" && raster.layoutStatus !== "pass") {
    const issues = raster.layoutIssues.map((issue) => `${issue.code}: ${issue.detail}`).join("; ");
    throw new Error(
      `review_page cannot pass while rendered layout is ${raster.layoutStatus}: ${issues || "no trustworthy layout result"}. ` +
        "Record verdict=revise with these issues, rewrite the page, render it again, and review the new revision.",
    );
  }
  if (input.verdict === "pass" && isCloserPage({ id: input.pageId })) {
    const project = loadProject(root);
    const last = project.pages.at(-1);
    if (last && !pageHasReadableCopy({ elements: last.page.elements })) {
      throw new Error(
        "review_page cannot pass an empty closer — write_page a 结束页 with title, recap, and next-month ask, then render again",
      );
    }
  }
  const payload = {
    contextEpochId: context.contextEpochId,
    pageId: current.pageId,
    revision: current.revision,
    pageSha256: current.pageSha256,
    rasterSha256: emitted.rasterSha256,
    deliveryToken: input.deliveryToken,
    verdict: input.verdict,
    issues: input.issues,
  };
  // A pass after a revise must not deduplicate into the older, superseded pass.
  const fact: VisualReviewFact = {
    type: "page.visual-review-recorded",
    factId: factId("page.visual-review-recorded", {
      ...payload,
      precedingFactId: ledger.facts.at(-1)?.factId,
    }),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

export function currentRevisionSnapshot(ledger: RunLedgerV1, root: string): Record<string, string> {
  return Object.fromEntries(
    [...currentDiskPageFacts(root, ledger).values()]
      .sort((a, b) => a.pageId.localeCompare(b.pageId))
      .map((page) => [page.pageId, page.pageSha256]),
  );
}

export function recordStructuralReview(
  root: string,
  ok: boolean,
  issues: readonly string[],
): StructuralReviewFact {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const payload = {
    reviewGateVersion: STRUCTURAL_REVIEW_GATE_VERSION,
    pageRevisions: currentRevisionSnapshot(ledger, root),
    ok,
    issues,
  };
  const fact: StructuralReviewFact = {
    type: "deck.structural-review-recorded",
    factId: factId("deck.structural-review-recorded", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

export function sameRevisionSnapshot(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): boolean {
  return stableSha256(expected) === stableSha256(actual);
}

/** True when a vision reviewer is configured and a current page still lacks an image-backed pass. */
export function currentVisualReviewsMissing(
  root: string,
  pageCount: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (pageCount < 1) return false;
  if (inspectProjectCapabilities(root, env).vision.mode === "none") return false;
  const inspection = inspectRunLedger(root, undefined, env);
  if (inspection.pages.length === 0) return true;
  return inspection.pages.some((page) => page.visualReview !== "pass");
}

export function inspectRunLedger(
  root: string,
  contextEpochId?: string,
  env: NodeJS.ProcessEnv = process.env,
  ledgerOverride?: RunLedgerV1,
): RunLedgerInspection {
  const ledger = ledgerOverride ?? readRunLedger(root);
  if (!ledger) {
    return {
      initialized: false,
      contextEpochId: undefined,
      referencesComplete: false,
      missingReferenceChunks: [],
      todoCount: 0,
      pages: [],
      structuralReview: "missing",
      composeReady: false,
      composeBlockers: ["run ledger is not initialized"],
      composed: false,
    };
  }
  const epoch =
    contextEpochId ??
    [...ledger.facts]
      .reverse()
      .map((fact) => ("contextEpochId" in fact ? fact.contextEpochId : ""))
      .find((candidate) => Boolean(candidate)) ??
    "";
  const reads = new Set(
    ledger.facts
      .filter(isReferenceReadFact)
      .map((fact) => `${fact.sourceId}:${fact.fileSha256}:${fact.chunkIndex}:${fact.chunkSha256}`),
  );
  const missingReferenceChunks: { sourceId: string; chunkIndex: number }[] = [];
  for (const requirement of ledger.sourcePack.requirements) {
    for (const chunkIndex of requirement.chunkIndexes) {
      const match = ledger.facts.some(
        (fact) =>
          isReferenceReadFact(fact) &&
          (!epoch || fact.contextEpochId === epoch) &&
          fact.sourceId === requirement.sourceId &&
          fact.fileSha256 === requirement.fileSha256 &&
          fact.chunkIndex === chunkIndex &&
          reads.has(`${fact.sourceId}:${fact.fileSha256}:${fact.chunkIndex}:${fact.chunkSha256}`),
      );
      if (!match) missingReferenceChunks.push({ sourceId: requirement.sourceId, chunkIndex });
    }
  }
  const todo = [...ledger.facts]
    .reverse()
    .find((fact): fact is TodoFact => fact.type === "todo.committed");
  const currentPages = currentDiskPageFacts(root, ledger);
  const project = diskProject(root);
  const chromes = pageChromes(project);
  const pages = inspectPageEvidence(
    ledger,
    currentPages.values(),
    RENDERED_LAYOUT_GATE_VERSION,
    chromes,
  );
  const revisionSnapshot = currentRevisionSnapshot(ledger, root);
  const structural = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is StructuralReviewFact =>
        fact.type === "deck.structural-review-recorded" &&
        fact.reviewGateVersion === STRUCTURAL_REVIEW_GATE_VERSION &&
        sameRevisionSnapshot(fact.pageRevisions, revisionSnapshot),
    );
  const blockers: string[] = [];
  const capability = inspectProjectCapabilities(root, env);
  const claimVisual = capability.vision.mode !== "none";
  const executionPolicy = executionPolicyFor(root, ledger);
  const currentRenderedLayoutRequired = executionPolicy.currentRenderedLayoutRequired;
  // Source chunk reads are a kernel-agnostic preflight — they gate compose for
  // every model, including text-only ones that skip the image ceremony.
  if (missingReferenceChunks.length) {
    blockers.push(`${missingReferenceChunks.length} required source chunks unread`);
  }
  blockers.push(...yamlStructureBlockers(root));
  blockers.push(...leftoverComposeBlockers(root));
  blockers.push(
    ...renderedLayoutBlockers(
      ledger,
      pages,
      currentRenderedLayoutRequired,
      RENDERED_LAYOUT_GATE_VERSION,
    ),
  );
  blockers.push(...layoutComposeBlockers(project, ledger, pages));
  // Plan coverage is kernel-agnostic: a text-only model still owes an explicit
  // todo and every planned page on disk. Only the image-delivery and visual
  // review ceremony is excused when the model cannot see images.
  if (!todo) blockers.push("write_todo missing");
  if (todo) {
    if (Array.isArray(todo.pageIds) && todo.pageIds.length) {
      blockers.push(...planCoverageBlockers(root, todo, currentPages));
    } else if (pages.length !== todo.itemCount) {
      blockers.push(
        `todo has ${todo.itemCount} pages but ${pages.length} current page revisions exist`,
      );
    }
  }
  if (claimVisual) {
    // A page whose layout changed needs render_page first; its image and review come after that.
    for (const page of pages.filter((item) => !item.chromeStale)) {
      if (!page.imageEmitted)
        blockers.push(`${page.pageId}: image content not emitted to the model`);
      if (page.visualReview !== "pass")
        blockers.push(`${page.pageId}: visual review ${page.visualReview}`);
    }
  }
  if (executionPolicy.structuralReviewRequired) {
    if (!structural) blockers.push("current structural review missing");
    else if (!structural.ok) blockers.push("current structural review failed");
  }
  if (
    hostedResearchNeedsWebSearchReceipt(inspectProjectCapabilities(root, env).research) &&
    !ledgerHasSuccessfulWebSearch(ledger)
  ) {
    blockers.push(MISSING_HOSTED_WEB_SEARCH_RECEIPT);
  }
  // A layout edit leaves page revisions alone, so the layout chrome is part of what was composed.
  const layoutChromeNow = composeLayoutChromes(chromes, root);
  const composedFact = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is DeckComposedFact =>
        fact.type === "deck.composed" &&
        (!epoch || fact.contextEpochId === epoch) &&
        sameRevisionSnapshot(fact.pageRevisions, revisionSnapshot) &&
        stableSha256(fact.pageChromes ?? {}) === stableSha256(layoutChromeNow),
    );
  return {
    initialized: true,
    contextEpochId: epoch || undefined,
    referencesComplete: missingReferenceChunks.length === 0,
    missingReferenceChunks,
    todoCount: todo?.itemCount ?? 0,
    pages,
    structuralReview: structural ? (structural.ok ? "pass" : "fail") : "missing",
    composeReady: blockers.length === 0,
    composeBlockers: blockers,
    composed: Boolean(composedFact),
  };
}

export function requireReferencesComplete(root: string, contextEpochId: string): void {
  const status = inspectRunLedger(root, contextEpochId);
  if (status.referencesComplete) return;
  const list = status.missingReferenceChunks
    .slice(0, 12)
    .map((item) => `${item.sourceId}#${item.chunkIndex}`)
    .join(", ");
  throw new Error(`read_reference is incomplete for this context epoch: ${list}`);
}

export function readCommittedPagePlan(root: string): readonly CanonicalPlanPage[] {
  const todo = readRunLedger(root)
    ?.facts.filter((fact): fact is TodoFact => fact.type === "todo.committed")
    .at(-1);
  try {
    return parseCanonicalPagePlan(todo?.pagePlan);
  } catch {
    throw new Error(
      "write_todo must commit a complete page plan before write_page; legacy ID-only plans require replan",
    );
  }
}

export function requireTodo(root: string): void {
  readCommittedPagePlan(root);
}

export function requireComposeReady(
  root: string,
  contextEpochId: string,
  env: NodeJS.ProcessEnv = process.env,
): RunLedgerInspection {
  const status = inspectRunLedger(root, contextEpochId, env);
  if (!status.composeReady)
    throw new Error(`compose gate failed: ${status.composeBlockers.join("; ")}`);
  return status;
}

export function recordWebSearchExecuted(
  root: string,
  context: RunToolContext,
  input: { readonly queries: readonly string[]; readonly factCount: number },
): WebSearchExecutedFact {
  const queries = [...new Set(input.queries.map((item) => item.trim()).filter(Boolean))];
  const payload = {
    contextEpochId: context.contextEpochId,
    commandId: context.commandId,
    queries,
    factCount: input.factCount,
    source: "pi-xai-hosted" as const,
    ok: true as const,
  };
  const fact: WebSearchExecutedFact = {
    type: "web-search.executed",
    factId: factId("web-search.executed", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

export function recordCompose(
  root: string,
  context: RunToolContext,
  title: string,
): DeckComposedFact {
  requireComposeReady(root, context.contextEpochId);
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const pageRevisions = currentRevisionSnapshot(ledger, root);
  const pageChromeRecord = composePageChromes(diskProject(root), root);
  const chromes = Object.keys(pageChromeRecord).length ? { pageChromes: pageChromeRecord } : {};
  const payload = {
    contextEpochId: context.contextEpochId,
    title,
    deckSha256: stableSha256({ title, pageRevisions, ...chromes }),
    pageRevisions,
    ...chromes,
  };
  const fact: DeckComposedFact = {
    type: "deck.composed",
    factId: factId("deck.composed", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

export function recordExportSucceeded(
  root: string,
  context: RunToolContext,
  input: Omit<ExportSucceededFact, "type" | "factId" | "at" | "contextEpochId">,
): ExportSucceededFact {
  const payload = {
    contextEpochId: context.contextEpochId,
    ...input,
  };
  const fact: ExportSucceededFact = {
    type: "export.succeeded",
    factId: factId("export.succeeded", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

export function contextFromToolArgs(args: Record<string, unknown>): {
  context: RunToolContext;
  args: Record<string, unknown>;
} {
  const meta = asRecord(args.__openSlideStudio);
  const commandId = typeof meta?.commandId === "string" ? meta.commandId.trim() : "";
  const contextEpochId = typeof meta?.contextEpochId === "string" ? meta.contextEpochId.trim() : "";
  if (!commandId || !contextEpochId) {
    throw new Error("agent execution context is missing");
  }
  const clean = { ...args };
  delete clean.__openSlideStudio;
  return { context: { commandId, contextEpochId }, args: clean };
}
