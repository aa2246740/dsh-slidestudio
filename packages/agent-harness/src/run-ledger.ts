import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readDesignContract } from "./design-contract.js";
import { DECK_OVERVIEW_RENDERER_VERSION } from "./deck-overview.js";

export const RUN_LEDGER_REL = path.join("_agent", "run-ledger.v1.json");
/** Bump whenever rendered layout acceptance semantics change. */
export const RENDERED_LAYOUT_GATE_VERSION = "rendered-layout-gate-v8";
/** Bump whenever structural review rules change. */
export const STRUCTURAL_REVIEW_GATE_VERSION = "structural-review-gate-v6";
/** Bump whenever the selected-reference/contract/full-deck taste semantics change. */
export const TASTE_EXECUTION_GATE_VERSION = "taste-execution-gate-v1";
export const DECK_TASTE_REVIEW_GATE_VERSION = "deck-taste-review-gate-v1";

export const DECK_TASTE_AXES = [
  "hierarchy",
  "composition",
  "typography",
  "color",
  "evidence-legibility",
  "layout-variety",
  "cross-slide-rhythm",
  "reference-fidelity",
  "remaining-ai-defaults",
] as const;

export type DeckTasteAxis = (typeof DECK_TASTE_AXES)[number];

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
  contractSha256?: string;
  pageIds?: readonly string[];
  pagePlan?: readonly Readonly<{
    pageId: string;
    title: string;
    layoutFamily: string;
  }>[];
}>;

export type DesignReferencePreparedFact = Readonly<{
  type: "design.reference-image-prepared";
  factId: string;
  at: string;
  contextEpochId: string;
  sourceId: string;
  imageSha256: string;
  src: string;
  mediaType: "image/jpeg";
  deliveryToken: string;
}>;

export type DesignReferenceEmittedFact = Readonly<{
  type: "design.reference-image-emitted";
  factId: string;
  at: string;
  contextEpochId: string;
  commandId: string;
  sourceId: string;
  imageSha256: string;
  deliveryToken: string;
}>;

export type DesignContractCommittedFact = Readonly<{
  type: "design.contract-committed";
  factId: string;
  at: string;
  contextEpochId: string;
  commandId: string;
  contractSha256: string;
}>;

export type DesignContractReturnedFact = Readonly<{
  type: "design.contract-returned";
  factId: string;
  at: string;
  contextEpochId: string;
  commandId: string;
  contractSha256: string;
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

export type DeckSnapshotPage = Readonly<{
  pageId: string;
  revision: number;
  pageSha256: string;
  rasterSha256: string;
  rasterSrc: string;
  pageReviewFactId: string;
}>;

export type DeckOverviewPreparedFact = Readonly<{
  type: "deck.overview-prepared";
  factId: string;
  at: string;
  contextEpochId: string;
  contractSha256: string;
  deckSnapshotSha256: string;
  pageSnapshot: readonly DeckSnapshotPage[];
  structuralReviewFactId: string;
  rendererVersion: string;
  overviewSha256: string;
  src: string;
  width: number;
  height: number;
  deliveryToken: string;
}>;

export type DeckOverviewEmittedFact = Readonly<{
  type: "deck.overview-emitted";
  factId: string;
  at: string;
  contextEpochId: string;
  commandId: string;
  contractSha256: string;
  deckSnapshotSha256: string;
  overviewSha256: string;
  deliveryToken: string;
}>;

export type DeckTasteAxisReview = Readonly<{
  axis: DeckTasteAxis;
  verdict: "pass" | "revise";
  observations: readonly string[];
  pageIds: readonly string[];
  contractRules: readonly string[];
}>;

export type DeckTasteReviewFact = Readonly<{
  type: "deck.taste-review-recorded";
  factId: string;
  at: string;
  contextEpochId: string;
  reviewGateVersion: string;
  contractSha256: string;
  deckSnapshotSha256: string;
  overviewSha256: string;
  deliveryToken: string;
  verdict: "pass" | "revise";
  axes: readonly DeckTasteAxisReview[];
  strongestPageId: string;
  weakestPageId: string;
  visualMemoryObserved: string;
  summary: string;
  remainingAiDefaults: readonly string[];
  revisionActions: readonly Readonly<{ pageId: string; action: string }>[];
}>;

export type DeckComposedFact = Readonly<{
  type: "deck.composed";
  factId: string;
  at: string;
  contextEpochId: string;
  title: string;
  deckSha256: string;
  pageRevisions: Readonly<Record<string, string>>;
  contractSha256?: string;
  deckSnapshotSha256?: string;
}>;

export type RunFact =
  | ReferenceChunkFact
  | DesignReferencePreparedFact
  | DesignReferenceEmittedFact
  | DesignContractCommittedFact
  | DesignContractReturnedFact
  | TodoFact
  | PageRevisionFact
  | RasterFact
  | ImagePreparedFact
  | ImageEmittedFact
  | VisualReviewFact
  | StructuralReviewFact
  | DeckOverviewPreparedFact
  | DeckOverviewEmittedFact
  | DeckTasteReviewFact
  | DeckComposedFact;

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
    tasteGate?: Readonly<{
      version: typeof TASTE_EXECUTION_GATE_VERSION;
      visualManifestSha256: string;
      designSystemId: string;
      selectedDesignSourceId: string;
      selectedDesignSha256: string;
      selectedPreviewSourceId: string;
      selectedPreviewSha256: string;
    }>;
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
}>;

export type RunLedgerInspection = Readonly<{
  initialized: boolean;
  contextEpochId?: string;
  referencesComplete: boolean;
  missingReferenceChunks: readonly { sourceId: string; chunkIndex: number }[];
  todoCount: number;
  pages: readonly PageEvidenceStatus[];
  structuralReview: "pass" | "fail" | "missing";
  tasteGateEnabled: boolean;
  designReference: "emitted" | "missing";
  designContract: "current" | "missing";
  deckOverview: "emitted" | "missing";
  deckTasteReview: "pass" | "revise" | "missing";
  deckSnapshotSha256?: string;
  composeReady: boolean;
  composeBlockers: readonly string[];
  composed: boolean;
}>;

function nowIso(): string {
  return new Date().toISOString();
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

function stableValue(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(stableValue);
  const rec = asRecord(raw);
  if (!rec) return raw;
  return Object.fromEntries(
    Object.keys(rec)
      .sort()
      .map((key) => [key, stableValue(rec[key])]),
  );
}

export function stableSha256(raw: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(raw) ?? null))
    .digest("hex");
}

export function bytesSha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function factId(type: RunFact["type"], payload: unknown): string {
  return `${type}:${stableSha256(payload)}`;
}

function persistPageKey(name: string): string {
  const base = name
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(/\.page$/i, "")
    .toLowerCase();
  return base.replace(/^0+(\d)/, "$1");
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

function parseTasteGate(
  raw: unknown,
): RunLedgerV1["sourcePack"]["tasteGate"] | undefined {
  if (raw === undefined) return undefined;
  const rec = asRecord(raw);
  if (!rec || rec.version !== TASTE_EXECUTION_GATE_VERSION) {
    throw new Error("invalid run ledger taste gate version");
  }
  const result = {
    version: TASTE_EXECUTION_GATE_VERSION,
    visualManifestSha256: String(rec.visualManifestSha256 ?? ""),
    designSystemId: String(rec.designSystemId ?? ""),
    selectedDesignSourceId: String(rec.selectedDesignSourceId ?? ""),
    selectedDesignSha256: String(rec.selectedDesignSha256 ?? ""),
    selectedPreviewSourceId: String(rec.selectedPreviewSourceId ?? ""),
    selectedPreviewSha256: String(rec.selectedPreviewSha256 ?? ""),
  } as const;
  if (
    !/^[a-f0-9]{64}$/.test(result.visualManifestSha256) ||
    !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(result.designSystemId) ||
    !result.selectedDesignSourceId ||
    !/^[a-f0-9]{64}$/.test(result.selectedDesignSha256) ||
    result.selectedPreviewSourceId !== `openkimi-preview:${result.designSystemId}` ||
    !/^[a-f0-9]{64}$/.test(result.selectedPreviewSha256)
  ) {
    throw new Error("invalid run ledger taste gate fields");
  }
  return result;
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
      tasteGate: parseTasteGate(pack.tasteGate),
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
  return parseLedger(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
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
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  throw new Error("run ledger lock unavailable");
}

function writeLedger(root: string, ledger: RunLedgerV1): void {
  const file = ledgerFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function mutateLedger(root: string, apply: (current: RunLedgerV1) => RunLedgerV1): RunLedgerV1 {
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
    stableSha256(current.sourcePack.tasteGate) !== stableSha256(sourcePack.tasteGate) ||
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

export function ensureRunLedger(
  root: string,
  sourcePack: RunLedgerV1["sourcePack"],
): RunLedgerV1 {
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

function appendFact(root: string, fact: RunFact): RunLedgerV1 {
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

function requireTasteGate(ledger: RunLedgerV1): NonNullable<RunLedgerV1["sourcePack"]["tasteGate"]> {
  const gate = ledger.sourcePack.tasteGate;
  if (!gate) throw new Error("taste execution gate is not enabled for this run");
  return gate;
}

export function recordDesignReferencePrepared(
  root: string,
  context: RunToolContext,
  input: Readonly<{
    sourceId: string;
    imageSha256: string;
    src: string;
    deliveryToken: string;
  }>,
): DesignReferencePreparedFact {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const gate = requireTasteGate(ledger);
  if (
    input.sourceId !== gate.selectedPreviewSourceId ||
    input.imageSha256 !== gate.selectedPreviewSha256
  ) {
    throw new Error("prepared design preview does not match the selected checked reference");
  }
  const payload = {
    contextEpochId: context.contextEpochId,
    sourceId: input.sourceId,
    imageSha256: input.imageSha256,
    src: input.src,
    mediaType: "image/jpeg" as const,
    deliveryToken: input.deliveryToken,
  };
  const fact: DesignReferencePreparedFact = {
    type: "design.reference-image-prepared",
    factId: factId("design.reference-image-prepared", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

export function recordDesignReferenceEmitted(
  root: string,
  context: RunToolContext,
  deliveryToken: string,
): DesignReferenceEmittedFact {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const prepared = [...ledger.facts].reverse().find(
    (fact): fact is DesignReferencePreparedFact =>
      fact.type === "design.reference-image-prepared" &&
      fact.deliveryToken === deliveryToken &&
      fact.contextEpochId === context.contextEpochId,
  );
  if (!prepared) throw new Error("design reference token is not prepared for this Pi context");
  const payload = {
    contextEpochId: context.contextEpochId,
    commandId: context.commandId,
    sourceId: prepared.sourceId,
    imageSha256: prepared.imageSha256,
    deliveryToken,
  };
  const fact: DesignReferenceEmittedFact = {
    type: "design.reference-image-emitted",
    factId: factId("design.reference-image-emitted", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

export function recordDesignContractCommitted(
  root: string,
  context: RunToolContext,
  contractSha256: string,
): DesignContractCommittedFact {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  requireTasteGate(ledger);
  const contract = readDesignContract(root);
  if (!contract || contract.contractSha256 !== contractSha256) {
    throw new Error("committed design contract artifact is missing or changed");
  }
  const payload = {
    contextEpochId: context.contextEpochId,
    commandId: context.commandId,
    contractSha256,
  };
  const fact: DesignContractCommittedFact = {
    type: "design.contract-committed",
    factId: factId("design.contract-committed", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

export function recordDesignContractReturned(
  root: string,
  context: RunToolContext,
): DesignContractReturnedFact {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  requireTasteGate(ledger);
  const contract = readDesignContract(root);
  if (!contract) throw new Error("design contract is not committed");
  const payload = {
    contextEpochId: context.contextEpochId,
    commandId: context.commandId,
    contractSha256: contract.contractSha256,
  };
  const fact: DesignContractReturnedFact = {
    type: "design.contract-returned",
    factId: factId("design.contract-returned", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

export function recordTodo(
  root: string,
  context: RunToolContext,
  items: readonly unknown[],
): void {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const contract = ledger.sourcePack.tasteGate ? readDesignContract(root) : undefined;
  const pagePlan = contract
    ? items.map((item, index) => {
        const rec = asRecord(item);
        if (!rec) throw new Error(`invalid todo item ${index}`);
        return {
          pageId: String(rec.pageId ?? ""),
          title: String(rec.title ?? ""),
          layoutFamily: String(rec.layoutFamily ?? ""),
        };
      })
    : undefined;
  const pageIds = items.map((item) => {
    const rec = asRecord(item);
    return typeof rec?.pageId === "string" ? rec.pageId.trim() : "";
  }).filter((pageId) => pageId.length > 0);
  const payload = {
    contextEpochId: context.contextEpochId,
    todoSha256: stableSha256(items),
    itemCount: items.length,
    ...(pageIds.length ? { pageIds } : {}),
    ...(contract ? { contractSha256: contract.contractSha256, pagePlan } : {}),
  };
  appendFact(root, {
    type: "todo.committed",
    factId: factId("todo.committed", payload),
    at: nowIso(),
    ...payload,
  });
}

function latestPageFacts(ledger: RunLedgerV1): Map<string, PageRevisionFact> {
  const pages = new Map<string, PageRevisionFact>();
  for (const fact of ledger.facts) {
    if (fact.type === "page.revision-committed") pages.set(fact.pageId, fact);
  }
  return pages;
}

export function recordPageRevision(
  root: string,
  context: RunToolContext,
  pageId: string,
  page: unknown,
): PageRevisionFact {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const current = latestPageFacts(ledger).get(pageId);
  const pageSha256 = stableSha256(page);
  if (current?.pageSha256 === pageSha256) {
    const lastReview = [...ledger.facts]
      .reverse()
      .find(
        (fact): fact is VisualReviewFact =>
          fact.type === "page.visual-review-recorded" &&
          fact.pageId === pageId &&
          fact.revision === current.revision &&
          fact.pageSha256 === pageSha256,
      );
    if (lastReview?.verdict === "revise") {
      throw new Error(`${pageId} must change after a revise review`);
    }
    return current;
  }
  const payload = {
    contextEpochId: context.contextEpochId,
    pageId,
    revision: (current?.revision ?? 0) + 1,
    pageSha256,
  };
  const fact: PageRevisionFact = {
    type: "page.revision-committed",
    factId: factId("page.revision-committed", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

export function currentPageRevision(root: string, pageId: string): PageRevisionFact | undefined {
  const ledger = readRunLedger(root);
  return ledger ? latestPageFacts(ledger).get(pageId) : undefined;
}

export type PageRewriteGate = Readonly<{
  allowed: boolean;
  pageId: string;
  revision?: number;
  reason: string;
}>;

type PageRewriteLifecycle =
  | { state: "no-revision" }
  | { state: "layout-open"; revision: number; reason: string }
  | { state: "visual-revise"; revision: number }
  | { state: "deck-taste-revise"; revision: number }
  | { state: "structural-fail"; revision: number }
  | { state: "structural-pass"; revision: number }
  | { state: "open"; revision: number };

function structuralPassLockReason(pageId: string, revision: number): string {
  return (
    `${pageId} revision ${revision} already has a structural review pass. ` +
    "Do not rewrite or append to this page. Move to the next committed todo page. " +
    "A later write is allowed only when review_pages names this page as failing, or review_page/review_deck explicitly returns revise for this current revision."
  );
}

function namesPageForRepair(pageId: string, issues: readonly string[]): boolean {
  return issues.some(
    (issue) => issue === pageId || issue.startsWith(`${pageId}:`) || issue.includes(`[${pageId}]`),
  );
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

  const pageReview = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is VisualReviewFact =>
        fact.type === "page.visual-review-recorded" &&
        fact.pageId === current.pageId &&
        fact.revision === current.revision &&
        fact.pageSha256 === current.pageSha256 &&
        fact.rasterSha256 === raster.rasterSha256,
    );
  if (pageReview?.verdict === "revise") {
    return { state: "visual-revise", revision: current.revision };
  }

  const deckReview = [...ledger.facts]
    .reverse()
    .find((fact): fact is DeckTasteReviewFact => {
      if (fact.type !== "deck.taste-review-recorded" || fact.verdict !== "revise") return false;
      if (!fact.revisionActions.some((action) => action.pageId === current.pageId)) return false;
      const overview = [...ledger.facts].reverse().find(
        (candidate): candidate is DeckOverviewPreparedFact =>
          candidate.type === "deck.overview-prepared" &&
          candidate.deckSnapshotSha256 === fact.deckSnapshotSha256,
      );
      return Boolean(
        overview?.pageSnapshot.some(
          (page) =>
            page.pageId === current.pageId &&
            page.revision === current.revision &&
            page.pageSha256 === current.pageSha256 &&
            page.rasterSha256 === raster.rasterSha256,
        ),
      );
    });
  if (deckReview) {
    return { state: "deck-taste-revise", revision: current.revision };
  }

  const snapshot = currentRevisionSnapshot(ledger);
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
    case "visual-revise":
      return {
        allowed: true,
        pageId,
        revision: life.revision,
        reason: "current image review explicitly requires revision",
      };
    case "deck-taste-revise":
      return {
        allowed: true,
        pageId,
        revision: life.revision,
        reason: "current deck review explicitly requires this page revision",
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

export function recordRaster(
  root: string,
  page: PageRevisionFact,
  input: Readonly<{
    bytes: Buffer;
    src: string;
    width: number;
    height: number;
    layoutStatus: RasterFact["layoutStatus"];
    layoutIssues: readonly PageLayoutIssue[];
  }>,
): { fact: RasterFact; deliveryToken: string } {
  const rasterSha256 = bytesSha256(input.bytes);
  const payload = {
    pageId: page.pageId,
    revision: page.revision,
    pageSha256: page.pageSha256,
    rasterSha256,
    src: input.src,
    width: input.width,
    height: input.height,
    layoutGateVersion: RENDERED_LAYOUT_GATE_VERSION,
    layoutStatus: input.layoutStatus,
    layoutIssues: input.layoutIssues,
  };
  const fact: RasterFact = {
    type: "page.raster-committed",
    factId: factId("page.raster-committed", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return { fact, deliveryToken: crypto.randomUUID() };
}

export function recordImagePrepared(
  root: string,
  context: RunToolContext,
  raster: RasterFact,
  deliveryToken: string,
): ImagePreparedFact {
  const payload = {
    contextEpochId: context.contextEpochId,
    pageId: raster.pageId,
    revision: raster.revision,
    pageSha256: raster.pageSha256,
    rasterSha256: raster.rasterSha256,
    deliveryToken,
  };
  const fact: ImagePreparedFact = {
    type: "page.image-result-prepared",
    factId: factId("page.image-result-prepared", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

export function recordImageEmitted(
  root: string,
  context: RunToolContext,
  deliveryToken: string,
): ImageEmittedFact {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const prepared = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is ImagePreparedFact =>
        fact.type === "page.image-result-prepared" &&
        fact.deliveryToken === deliveryToken &&
        fact.contextEpochId === context.contextEpochId,
    );
  if (!prepared) throw new Error("image delivery token is not prepared for this Pi context");
  const payload = {
    contextEpochId: context.contextEpochId,
    commandId: context.commandId,
    pageId: prepared.pageId,
    revision: prepared.revision,
    pageSha256: prepared.pageSha256,
    rasterSha256: prepared.rasterSha256,
    deliveryToken,
  };
  const fact: ImageEmittedFact = {
    type: "page.image-content-emitted",
    factId: factId("page.image-content-emitted", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

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
): VisualReviewFact {
  if (input.verdict === "pass" && input.issues.length) {
    throw new Error(
      `a passing page review cannot contain unresolved issues: ${input.issues.join("; ")}. Fix them and render again, or send verdict=revise.`,
    );
  }
  if (input.verdict === "revise" && !input.issues.length) {
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
        fact.deliveryToken === input.deliveryToken &&
        fact.contextEpochId === context.contextEpochId,
    );
  if (!emitted) throw new Error("page image was not emitted in this Pi context");
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
    const issues = raster.layoutIssues
      .map((issue) => `${issue.code}: ${issue.detail}`)
      .join("; ");
    throw new Error(
      `review_page cannot pass while rendered layout is ${raster.layoutStatus}: ${issues || "no trustworthy layout result"}. ` +
        "Record verdict=revise with these issues, rewrite the page, render it again, and review the new revision.",
    );
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
  const fact: VisualReviewFact = {
    type: "page.visual-review-recorded",
    factId: factId("page.visual-review-recorded", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

function currentRevisionSnapshot(ledger: RunLedgerV1): Record<string, string> {
  return Object.fromEntries(
    [...latestPageFacts(ledger).values()]
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
    pageRevisions: currentRevisionSnapshot(ledger),
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

export type CurrentDeckSnapshot = Readonly<{
  contractSha256: string;
  deckSnapshotSha256: string;
  pageSnapshot: readonly DeckSnapshotPage[];
  structuralReviewFactId: string;
}>;

function currentContractReceipt(
  ledger: RunLedgerV1,
  contextEpochId: string,
  contractSha256: string,
): DesignContractCommittedFact | DesignContractReturnedFact | undefined {
  return [...ledger.facts].reverse().find(
    (fact): fact is DesignContractCommittedFact | DesignContractReturnedFact =>
      (fact.type === "design.contract-committed" || fact.type === "design.contract-returned") &&
      fact.contextEpochId === contextEpochId &&
      fact.contractSha256 === contractSha256,
  );
}

function deriveCurrentDeckSnapshot(
  root: string,
  ledger: RunLedgerV1,
  contextEpochId: string,
): Readonly<{ snapshot?: CurrentDeckSnapshot; blockers: readonly string[] }> {
  const blockers: string[] = [];
  if (!ledger.sourcePack.tasteGate) return { blockers: ["taste execution gate is not enabled"] };
  const contract = readDesignContract(root);
  if (!contract) return { blockers: ["design contract missing"] };
  if (!currentContractReceipt(ledger, contextEpochId, contract.contractSha256)) {
    blockers.push("design contract not returned in this Pi context");
  }
  const todo = [...ledger.facts].reverse().find(
    (fact): fact is TodoFact =>
      fact.type === "todo.committed" &&
      fact.contractSha256 === contract.contractSha256 &&
      Array.isArray(fact.pagePlan),
  );
  if (!todo?.pagePlan) return { blockers: [...blockers, "contract-bound write_todo missing"] };
  const pagesById = latestPageFacts(ledger);
  const pageSnapshot: DeckSnapshotPage[] = [];
  for (const planned of todo.pagePlan) {
    const page = pagesById.get(planned.pageId);
    if (!page) {
      blockers.push(`${planned.pageId}: current page revision missing`);
      continue;
    }
    const raster = [...ledger.facts].reverse().find(
      (fact): fact is RasterFact =>
        fact.type === "page.raster-committed" &&
        fact.pageId === page.pageId &&
        fact.revision === page.revision &&
        fact.pageSha256 === page.pageSha256 &&
        fact.layoutGateVersion === RENDERED_LAYOUT_GATE_VERSION &&
        fact.layoutStatus === "pass",
    );
    if (!raster) {
      blockers.push(`${planned.pageId}: passing current raster missing`);
      continue;
    }
    const emitted = [...ledger.facts].reverse().find(
      (fact): fact is ImageEmittedFact =>
        fact.type === "page.image-content-emitted" &&
        fact.contextEpochId === contextEpochId &&
        fact.pageId === page.pageId &&
        fact.revision === page.revision &&
        fact.pageSha256 === page.pageSha256 &&
        fact.rasterSha256 === raster.rasterSha256,
    );
    if (!emitted) {
      blockers.push(`${planned.pageId}: image content not emitted in this Pi context`);
      continue;
    }
    const review = [...ledger.facts].reverse().find(
      (fact): fact is VisualReviewFact =>
        fact.type === "page.visual-review-recorded" &&
        fact.contextEpochId === contextEpochId &&
        fact.pageId === page.pageId &&
        fact.revision === page.revision &&
        fact.pageSha256 === page.pageSha256 &&
        fact.rasterSha256 === raster.rasterSha256 &&
        fact.verdict === "pass",
    );
    if (!review) {
      blockers.push(`${planned.pageId}: passing visual review missing in this Pi context`);
      continue;
    }
    pageSnapshot.push({
      pageId: page.pageId,
      revision: page.revision,
      pageSha256: page.pageSha256,
      rasterSha256: raster.rasterSha256,
      rasterSrc: raster.src,
      pageReviewFactId: review.factId,
    });
  }
  const revisions = currentRevisionSnapshot(ledger);
  const structural = [...ledger.facts].reverse().find(
    (fact): fact is StructuralReviewFact =>
      fact.type === "deck.structural-review-recorded" &&
      fact.reviewGateVersion === STRUCTURAL_REVIEW_GATE_VERSION &&
      fact.ok &&
      sameRevisionSnapshot(fact.pageRevisions, revisions),
  );
  if (!structural) blockers.push("passing current structural review missing");
  if (pageSnapshot.length !== todo.pagePlan.length) {
    blockers.push("deck overview page snapshot is incomplete");
  }
  if (blockers.length || !structural) return { blockers };
  const identity = {
    contractSha256: contract.contractSha256,
    pageSnapshot,
    structuralReviewFactId: structural.factId,
    renderedLayoutGateVersion: RENDERED_LAYOUT_GATE_VERSION,
    structuralReviewGateVersion: STRUCTURAL_REVIEW_GATE_VERSION,
    overviewRendererVersion: DECK_OVERVIEW_RENDERER_VERSION,
  };
  return {
    blockers: [],
    snapshot: {
      contractSha256: contract.contractSha256,
      deckSnapshotSha256: stableSha256(identity),
      pageSnapshot,
      structuralReviewFactId: structural.factId,
    },
  };
}

export function currentDeckSnapshot(
  root: string,
  contextEpochId: string,
): CurrentDeckSnapshot {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const derived = deriveCurrentDeckSnapshot(root, ledger, contextEpochId);
  if (!derived.snapshot) {
    throw new Error(`deck overview gate failed: ${derived.blockers.join("; ")}`);
  }
  return derived.snapshot;
}

export function recordDeckOverviewPrepared(
  root: string,
  context: RunToolContext,
  snapshot: CurrentDeckSnapshot,
  input: Readonly<{
    bytes: Buffer;
    src: string;
    width: number;
    height: number;
    rendererVersion: string;
  }>,
): DeckOverviewPreparedFact {
  const current = currentDeckSnapshot(root, context.contextEpochId);
  if (current.deckSnapshotSha256 !== snapshot.deckSnapshotSha256) {
    throw new Error("deck overview targets a stale deck snapshot");
  }
  if (input.rendererVersion !== DECK_OVERVIEW_RENDERER_VERSION) {
    throw new Error("deck overview renderer version mismatch");
  }
  const ledger = readRunLedger(root);
  const lastTaste = ledger
    ? [...ledger.facts].reverse().find(
        (fact): fact is DeckTasteReviewFact =>
          fact.type === "deck.taste-review-recorded" &&
          fact.deckSnapshotSha256 === current.deckSnapshotSha256,
      )
    : undefined;
  if (lastTaste?.verdict === "revise") {
    throw new Error("deck snapshot must change after a revise taste review");
  }
  const deliveryToken = crypto.randomUUID();
  const payload = {
    contextEpochId: context.contextEpochId,
    contractSha256: snapshot.contractSha256,
    deckSnapshotSha256: snapshot.deckSnapshotSha256,
    pageSnapshot: snapshot.pageSnapshot,
    structuralReviewFactId: snapshot.structuralReviewFactId,
    rendererVersion: input.rendererVersion,
    overviewSha256: bytesSha256(input.bytes),
    src: input.src,
    width: input.width,
    height: input.height,
    deliveryToken,
  };
  const fact: DeckOverviewPreparedFact = {
    type: "deck.overview-prepared",
    factId: factId("deck.overview-prepared", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

export function recordDeckOverviewEmitted(
  root: string,
  context: RunToolContext,
  deliveryToken: string,
): DeckOverviewEmittedFact {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const prepared = [...ledger.facts].reverse().find(
    (fact): fact is DeckOverviewPreparedFact =>
      fact.type === "deck.overview-prepared" &&
      fact.deliveryToken === deliveryToken &&
      fact.contextEpochId === context.contextEpochId,
  );
  if (!prepared) throw new Error("deck overview token is not prepared for this Pi context");
  const current = currentDeckSnapshot(root, context.contextEpochId);
  if (current.deckSnapshotSha256 !== prepared.deckSnapshotSha256) {
    throw new Error("deck overview token targets a stale deck snapshot");
  }
  const payload = {
    contextEpochId: context.contextEpochId,
    commandId: context.commandId,
    contractSha256: prepared.contractSha256,
    deckSnapshotSha256: prepared.deckSnapshotSha256,
    overviewSha256: prepared.overviewSha256,
    deliveryToken,
  };
  const fact: DeckOverviewEmittedFact = {
    type: "deck.overview-emitted",
    factId: factId("deck.overview-emitted", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

export function recordPreparedImageEmitted(
  root: string,
  context: RunToolContext,
  deliveryToken: string,
): ImageEmittedFact | DesignReferenceEmittedFact | DeckOverviewEmittedFact {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const prepared = [...ledger.facts].reverse().find(
    (fact) =>
      (fact.type === "page.image-result-prepared" ||
        fact.type === "design.reference-image-prepared" ||
        fact.type === "deck.overview-prepared") &&
      fact.deliveryToken === deliveryToken &&
      fact.contextEpochId === context.contextEpochId,
  );
  if (!prepared) throw new Error("image delivery token is not prepared for this Pi context");
  if (prepared.type === "design.reference-image-prepared") {
    return recordDesignReferenceEmitted(root, context, deliveryToken);
  }
  if (prepared.type === "deck.overview-prepared") {
    return recordDeckOverviewEmitted(root, context, deliveryToken);
  }
  return recordImageEmitted(root, context, deliveryToken);
}

export type RecordDeckTasteReviewInput = Readonly<{
  deliveryToken: string;
  verdict: "pass" | "revise";
  axes: readonly DeckTasteAxisReview[];
  strongestPageId: string;
  weakestPageId: string;
  visualMemoryObserved: string;
  summary: string;
  remainingAiDefaults: readonly string[];
  revisionActions: readonly Readonly<{ pageId: string; action: string }>[];
}>;

export function recordDeckTasteReview(
  root: string,
  context: RunToolContext,
  input: RecordDeckTasteReviewInput,
): DeckTasteReviewFact {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const overview = [...ledger.facts].reverse().find(
    (fact): fact is DeckOverviewEmittedFact =>
      fact.type === "deck.overview-emitted" &&
      fact.contextEpochId === context.contextEpochId &&
      fact.deliveryToken === input.deliveryToken,
  );
  if (!overview) throw new Error("deck overview was not emitted in this Pi context");
  const current = currentDeckSnapshot(root, context.contextEpochId);
  if (current.deckSnapshotSha256 !== overview.deckSnapshotSha256) {
    throw new Error("deck taste review targets a stale deck snapshot");
  }
  const pageIds = new Set(current.pageSnapshot.map((page) => page.pageId));
  const axes = parseDeckTasteAxes(input.axes, pageIds);
  const strongestPageId = requireCurrentPageId(input.strongestPageId, pageIds, "strongestPageId");
  const weakestPageId = requireCurrentPageId(input.weakestPageId, pageIds, "weakestPageId");
  const visualMemoryObserved = nonEmpty(input.visualMemoryObserved, "visualMemoryObserved");
  const summary = nonEmpty(input.summary, "summary");
  const remainingAiDefaults = textList(input.remainingAiDefaults, "remainingAiDefaults", true);
  const revisionActions = input.revisionActions.map((action, index) => ({
    pageId: requireCurrentPageId(action.pageId, pageIds, `revisionActions[${index}].pageId`),
    action: nonEmpty(action.action, `revisionActions[${index}].action`),
  }));
  if (input.verdict === "pass") {
    if (axes.some((axis) => axis.verdict !== "pass")) {
      throw new Error("deck pass requires every taste axis to pass");
    }
    if (remainingAiDefaults.length || revisionActions.length) {
      throw new Error("deck pass cannot retain AI defaults or revision actions");
    }
  } else if (!revisionActions.length) {
    throw new Error("deck revise requires at least one page repair action");
  }
  const payload = {
    contextEpochId: context.contextEpochId,
    reviewGateVersion: DECK_TASTE_REVIEW_GATE_VERSION,
    contractSha256: current.contractSha256,
    deckSnapshotSha256: current.deckSnapshotSha256,
    overviewSha256: overview.overviewSha256,
    deliveryToken: input.deliveryToken,
    verdict: input.verdict,
    axes,
    strongestPageId,
    weakestPageId,
    visualMemoryObserved,
    summary,
    remainingAiDefaults,
    revisionActions,
  };
  const fact: DeckTasteReviewFact = {
    type: "deck.taste-review-recorded",
    factId: factId("deck.taste-review-recorded", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

function parseDeckTasteAxes(
  raw: readonly DeckTasteAxisReview[],
  currentPageIds: ReadonlySet<string>,
): DeckTasteAxisReview[] {
  if (!Array.isArray(raw)) throw new Error("review_deck.axes must be an array");
  const byAxis = new Map<DeckTasteAxis, DeckTasteAxisReview>();
  for (const [index, item] of raw.entries()) {
    if (!item || !DECK_TASTE_AXES.includes(item.axis)) {
      throw new Error(`review_deck.axes[${index}] has an unknown axis`);
    }
    if (byAxis.has(item.axis)) throw new Error(`duplicate deck taste axis: ${item.axis}`);
    if (item.verdict !== "pass" && item.verdict !== "revise") {
      throw new Error(`invalid verdict for deck taste axis ${item.axis}`);
    }
    const observations = textList(item.observations, `${item.axis}.observations`);
    const contractRules = textList(item.contractRules, `${item.axis}.contractRules`);
    const pageIds = textList(item.pageIds, `${item.axis}.pageIds`).map((pageId) =>
      requireCurrentPageId(pageId, currentPageIds, `${item.axis}.pageIds`),
    );
    byAxis.set(item.axis, {
      axis: item.axis,
      verdict: item.verdict,
      observations,
      pageIds,
      contractRules,
    });
  }
  const missing = DECK_TASTE_AXES.filter((axis) => !byAxis.has(axis));
  if (missing.length) throw new Error(`review_deck missing axes: ${missing.join(", ")}`);
  return DECK_TASTE_AXES.map((axis) => byAxis.get(axis)!);
}

function nonEmpty(value: string, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} must be non-empty`);
  return text;
}

function textList(values: readonly string[], label: string, allowEmpty = false): string[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const result = values.map((value, index) => nonEmpty(value, `${label}[${index}]`));
  if (!allowEmpty && !result.length) throw new Error(`${label} must be non-empty`);
  return result;
}

function requireCurrentPageId(
  value: string,
  currentPageIds: ReadonlySet<string>,
  label: string,
): string {
  const pageId = nonEmpty(value, label);
  if (!currentPageIds.has(pageId)) throw new Error(`${label} is not a current page: ${pageId}`);
  return pageId;
}

function sameRevisionSnapshot(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): boolean {
  return stableSha256(expected) === stableSha256(actual);
}

export function inspectRunLedger(
  root: string,
  contextEpochId?: string,
): RunLedgerInspection {
  const ledger = readRunLedger(root);
  if (!ledger) {
    return {
      initialized: false,
      contextEpochId: undefined,
      referencesComplete: false,
      missingReferenceChunks: [],
      todoCount: 0,
      pages: [],
      structuralReview: "missing",
      tasteGateEnabled: false,
      designReference: "missing",
      designContract: "missing",
      deckOverview: "missing",
      deckTasteReview: "missing",
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
      .filter(
        (fact): fact is ReferenceChunkFact =>
          fact.type === "reference.chunk-returned" && fact.contextEpochId === epoch,
      )
      .map((fact) => `${fact.sourceId}:${fact.fileSha256}:${fact.chunkIndex}:${fact.chunkSha256}`),
  );
  const missingReferenceChunks: { sourceId: string; chunkIndex: number }[] = [];
  for (const requirement of ledger.sourcePack.requirements) {
    for (const chunkIndex of requirement.chunkIndexes) {
      const match = ledger.facts.some(
        (fact) =>
          fact.type === "reference.chunk-returned" &&
          fact.contextEpochId === epoch &&
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
  const currentPages = latestPageFacts(ledger);
  const pages: PageEvidenceStatus[] = [];
  for (const page of currentPages.values()) {
    const raster = [...ledger.facts]
      .reverse()
      .find(
        (fact): fact is RasterFact =>
          fact.type === "page.raster-committed" &&
          fact.pageId === page.pageId &&
          fact.revision === page.revision &&
          fact.pageSha256 === page.pageSha256 &&
          fact.layoutGateVersion === RENDERED_LAYOUT_GATE_VERSION,
      );
    const emitted = raster
      ? [...ledger.facts]
          .reverse()
          .find(
            (fact): fact is ImageEmittedFact =>
              fact.type === "page.image-content-emitted" &&
              fact.pageId === page.pageId &&
              fact.revision === page.revision &&
              fact.pageSha256 === page.pageSha256 &&
              fact.rasterSha256 === raster.rasterSha256 &&
              (!epoch || fact.contextEpochId === epoch),
          )
      : undefined;
    const review = emitted
      ? [...ledger.facts]
          .reverse()
          .find(
            (fact): fact is VisualReviewFact =>
              fact.type === "page.visual-review-recorded" &&
              fact.pageId === page.pageId &&
              fact.revision === page.revision &&
              fact.pageSha256 === page.pageSha256 &&
              fact.rasterSha256 === raster?.rasterSha256 &&
              (!epoch || fact.contextEpochId === epoch),
          )
      : undefined;
    pages.push({
      pageId: page.pageId,
      revision: page.revision,
      pageSha256: page.pageSha256,
      raster: Boolean(raster),
      imageEmitted: Boolean(emitted),
      visualReview: review?.verdict ?? "missing",
      layout: raster?.layoutStatus ?? "missing",
    });
  }
  pages.sort((a, b) => a.pageId.localeCompare(b.pageId));
  const revisionSnapshot = currentRevisionSnapshot(ledger);
  const structural = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is StructuralReviewFact =>
        fact.type === "deck.structural-review-recorded" &&
        fact.reviewGateVersion === STRUCTURAL_REVIEW_GATE_VERSION &&
        sameRevisionSnapshot(fact.pageRevisions, revisionSnapshot),
    );
  const blockers: string[] = [];
  if (missingReferenceChunks.length) blockers.push(`${missingReferenceChunks.length} required source chunks unread`);
  if (!todo) blockers.push("write_todo missing");
  if (todo) {
    const planned = Array.isArray(todo.pageIds) && todo.pageIds.length
      ? todo.pageIds.map((pageId) => persistPageKey(pageId)).filter((key) => key.length > 0)
      : undefined;
    if (planned) {
      const current = pages.map((page) => persistPageKey(page.pageId));
      const missing = planned.filter((key) => !current.includes(key));
      const extra = current.filter((key) => !planned.includes(key));
      if (missing.length) blockers.push(`todo missing pages: ${missing.join(",")}`);
      if (extra.length) blockers.push(`pages not in todo: ${extra.join(",")}`);
    } else if (pages.length !== todo.itemCount) {
      blockers.push(`todo has ${todo.itemCount} pages but ${pages.length} current page revisions exist`);
    }
  }
  for (const page of pages) {
    if (!page.raster) blockers.push(`${page.pageId}: current raster missing`);
    if (!page.imageEmitted) blockers.push(`${page.pageId}: image content not emitted to Pi`);
    if (page.visualReview !== "pass") blockers.push(`${page.pageId}: visual review ${page.visualReview}`);
    if (page.layout !== "pass") blockers.push(`${page.pageId}: rendered layout ${page.layout}`);
  }
  if (!structural) blockers.push("current structural review missing");
  else if (!structural.ok) blockers.push("current structural review failed");
  const tasteGate = ledger.sourcePack.tasteGate;
  let designReference: RunLedgerInspection["designReference"] = "missing";
  let designContract: RunLedgerInspection["designContract"] = "missing";
  let deckOverview: RunLedgerInspection["deckOverview"] = "missing";
  let deckTasteReview: RunLedgerInspection["deckTasteReview"] = "missing";
  let deckSnapshotSha256: string | undefined;
  if (tasteGate) {
    const previewEmitted = [...ledger.facts].reverse().find(
      (fact): fact is DesignReferenceEmittedFact =>
        fact.type === "design.reference-image-emitted" &&
        fact.contextEpochId === epoch &&
        fact.sourceId === tasteGate.selectedPreviewSourceId &&
        fact.imageSha256 === tasteGate.selectedPreviewSha256,
    );
    if (previewEmitted) designReference = "emitted";
    else blockers.push("selected design preview not emitted in this Pi context");

    const contract = readDesignContract(root);
    const selectedDesign = contract?.references.find((reference) => reference.role === "selected-design");
    const selectedPreview = contract?.references.find((reference) => reference.role === "selected-preview");
    const contractMatches = Boolean(
      contract &&
        contract.designSystemId === tasteGate.designSystemId &&
        selectedDesign?.sourceId === tasteGate.selectedDesignSourceId &&
        selectedDesign.sha256 === tasteGate.selectedDesignSha256 &&
        selectedPreview?.sourceId === tasteGate.selectedPreviewSourceId &&
        selectedPreview.sha256 === tasteGate.selectedPreviewSha256,
    );
    if (!contractMatches || !contract) {
      blockers.push("valid selected-reference-bound design contract missing");
    } else if (!currentContractReceipt(ledger, epoch, contract.contractSha256)) {
      blockers.push("design contract not returned in this Pi context");
    } else {
      designContract = "current";
    }

    const boundTodo = contract
      ? [...ledger.facts].reverse().find(
          (fact): fact is TodoFact =>
            fact.type === "todo.committed" &&
            fact.contractSha256 === contract.contractSha256 &&
            Array.isArray(fact.pagePlan),
        )
      : undefined;
    if (!boundTodo) blockers.push("contract-bound write_todo missing");

    const derived = deriveCurrentDeckSnapshot(root, ledger, epoch);
    if (derived.snapshot) {
      deckSnapshotSha256 = derived.snapshot.deckSnapshotSha256;
      const overviewEmitted = [...ledger.facts].reverse().find(
        (fact): fact is DeckOverviewEmittedFact =>
          fact.type === "deck.overview-emitted" &&
          fact.contextEpochId === epoch &&
          fact.contractSha256 === derived.snapshot?.contractSha256 &&
          fact.deckSnapshotSha256 === derived.snapshot?.deckSnapshotSha256,
      );
      if (overviewEmitted) {
        deckOverview = "emitted";
        const taste = [...ledger.facts].reverse().find(
          (fact): fact is DeckTasteReviewFact =>
            fact.type === "deck.taste-review-recorded" &&
            fact.contextEpochId === epoch &&
            fact.reviewGateVersion === DECK_TASTE_REVIEW_GATE_VERSION &&
            fact.contractSha256 === derived.snapshot?.contractSha256 &&
            fact.deckSnapshotSha256 === derived.snapshot?.deckSnapshotSha256 &&
            fact.overviewSha256 === overviewEmitted.overviewSha256 &&
            fact.deliveryToken === overviewEmitted.deliveryToken,
        );
        deckTasteReview = taste?.verdict ?? "missing";
        if (!taste) blockers.push("current grounded deck taste review missing");
        else if (taste.verdict !== "pass") blockers.push("current deck taste review requires revision");
      } else {
        blockers.push("current deck overview not emitted in this Pi context");
      }
    } else {
      for (const blocker of derived.blockers) {
        if (!blockers.includes(blocker)) blockers.push(blocker);
      }
    }
  }
  const composedFact = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is DeckComposedFact =>
        fact.type === "deck.composed" &&
        (!epoch || fact.contextEpochId === epoch) &&
        (!tasteGate || fact.deckSnapshotSha256 === deckSnapshotSha256) &&
        sameRevisionSnapshot(fact.pageRevisions, revisionSnapshot),
    );
  return {
    initialized: true,
    contextEpochId: epoch || undefined,
    referencesComplete: missingReferenceChunks.length === 0,
    missingReferenceChunks,
    todoCount: todo?.itemCount ?? 0,
    pages,
    structuralReview: structural ? (structural.ok ? "pass" : "fail") : "missing",
    tasteGateEnabled: Boolean(tasteGate),
    designReference,
    designContract,
    deckOverview,
    deckTasteReview,
    deckSnapshotSha256,
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
  throw new Error(`read_reference is incomplete for this Pi context: ${list}`);
}

export function requireDesignReferenceEmitted(root: string, contextEpochId: string): void {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const gate = requireTasteGate(ledger);
  const emitted = ledger.facts.some(
    (fact) =>
      fact.type === "design.reference-image-emitted" &&
      fact.contextEpochId === contextEpochId &&
      fact.sourceId === gate.selectedPreviewSourceId &&
      fact.imageSha256 === gate.selectedPreviewSha256,
  );
  if (!emitted) {
    throw new Error("view_design_reference must emit the selected preview in this Pi context");
  }
}

export function requireDesignContractCurrent(root: string, contextEpochId: string): void {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  requireTasteGate(ledger);
  const contract = readDesignContract(root);
  if (!contract) throw new Error("commit_design must succeed before write_todo");
  if (!currentContractReceipt(ledger, contextEpochId, contract.contractSha256)) {
    throw new Error("read_design must return the committed contract in this Pi context");
  }
}

export function requireTodo(root: string): void {
  const status = inspectRunLedger(root);
  if (status.todoCount > 0) return;
  throw new Error("write_todo must succeed before write_page");
}

export function requireComposeReady(root: string, contextEpochId: string): RunLedgerInspection {
  const status = inspectRunLedger(root, contextEpochId);
  if (!status.composeReady) throw new Error(`compose gate failed: ${status.composeBlockers.join("; ")}`);
  return status;
}

export function recordCompose(
  root: string,
  context: RunToolContext,
  title: string,
): DeckComposedFact {
  requireComposeReady(root, context.contextEpochId);
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const pageRevisions = currentRevisionSnapshot(ledger);
  const contract = ledger.sourcePack.tasteGate ? readDesignContract(root) : undefined;
  const deckSnapshotSha256 = ledger.sourcePack.tasteGate
    ? inspectRunLedger(root, context.contextEpochId).deckSnapshotSha256
    : undefined;
  const payload = {
    contextEpochId: context.contextEpochId,
    title,
    deckSha256: stableSha256({ title, pageRevisions }),
    pageRevisions,
    ...(contract && deckSnapshotSha256
      ? { contractSha256: contract.contractSha256, deckSnapshotSha256 }
      : {}),
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

export function contextFromToolArgs(args: Record<string, unknown>): {
  context: RunToolContext;
  args: Record<string, unknown>;
} {
  const meta = asRecord(args.__openSlideStudio);
  const commandId = typeof meta?.commandId === "string" ? meta.commandId.trim() : "";
  const contextEpochId =
    typeof meta?.contextEpochId === "string" ? meta.contextEpochId.trim() : "";
  if (!commandId || !contextEpochId) {
    throw new Error("Pi extension execution context is missing");
  }
  const clean = { ...args };
  delete clean.__openSlideStudio;
  return { context: { commandId, contextEpochId }, args: clean };
}
