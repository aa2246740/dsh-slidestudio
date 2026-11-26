/**
 * Durable product-progress sampling. Progress is what the run ledger and the
 * PPTD pages on disk prove — never a tool's claimed outcome. Context epochs,
 * command ids and timestamps are excluded so replaying a read cannot refresh
 * a no-progress budget.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import {
  inspectRunLedger,
  listSourceReceipts,
  persistPageKey,
  readRunLedger,
  stableSha256,
} from "@open-slidestudio/presentation-run";

export type ProductProgressPhase = "planning" | "production";

export type PersistentPageRevision = Readonly<{ pageId: string; revision: number; pageSha256: string }>;

export type PersistentProductSnapshot = Readonly<{
  phase: ProductProgressPhase;
  pageCount: number;
  pageRevisionFingerprint: string;
  completionEvidenceFingerprint: string;
  completionEvidence: readonly string[];
  ledgerRevisions: readonly PersistentPageRevision[];
  diskPages: readonly Readonly<{ pageId: string; pageSha256: string }>[];
}>;

const SOURCE_STATES = ["available", "consulted", "adopted", "executed"] as const;

export function normalizeCompletionEvidence(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function completionEvidenceFingerprint(values: readonly string[]): string {
  return stableSha256({ schemaVersion: 1, evidence: normalizeCompletionEvidence(values) });
}

export const EMPTY_COMPLETION_EVIDENCE_FINGERPRINT = completionEvidenceFingerprint([]);

function evidenceKey(kind: string, value: unknown): string {
  return `${kind}:${stableSha256(value)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function exportEvidence(projectRoot: string): string | undefined {
  try {
    const report = asRecord(
      JSON.parse(fs.readFileSync(path.join(projectRoot, "_agent", "export", "export-report.json"), "utf8")),
    );
    const src = typeof report?.src === "string" ? report.src.trim() : "";
    if (report?.ok !== true || !src) return undefined;
    const artifact = path.resolve(projectRoot, src);
    const relative = path.relative(projectRoot, artifact);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !fs.statSync(artifact).isFile()) {
      return undefined;
    }
    return evidenceKey("export:ready", {
      src: relative.replace(/\\/g, "/"),
      artifactSha256: crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex"),
      bytes: fs.statSync(artifact).size,
      slideCount: report.slideCount,
      nativeCoverage: report.nativeCoverage,
    });
  } catch {
    return undefined;
  }
}

type Ledger = NonNullable<ReturnType<typeof readRunLedger>>;

function referenceEvidence(ledger: Ledger, evidence: Set<string>): void {
  for (const requirement of ledger.sourcePack.requirements) {
    for (const chunkIndex of requirement.chunkIndexes) {
      const fact = ledger.facts.find(
        (candidate) =>
          candidate.type === "reference.chunk-returned" &&
          candidate.sourceId === requirement.sourceId &&
          candidate.fileSha256 === requirement.fileSha256 &&
          candidate.chunkIndex === chunkIndex,
      );
      if (fact?.type !== "reference.chunk-returned") continue;
      evidence.add(
        evidenceKey("reference:required-chunk", {
          sourceId: fact.sourceId,
          fileSha256: fact.fileSha256.toLowerCase(),
          chunkIndex: fact.chunkIndex,
          chunkSha256: fact.chunkSha256.toLowerCase(),
        }),
      );
    }
  }
}

type LedgerStatus = ReturnType<typeof inspectRunLedger>;

function pageEvidence(status: LedgerStatus, evidence: Set<string>): void {
  for (const page of status.pages) {
    const identity = { pageId: page.pageId, revision: page.revision, pageSha256: page.pageSha256.toLowerCase() };
    if (page.raster) evidence.add(evidenceKey("page:raster-current", identity));
    if (page.imageEmitted) evidence.add(evidenceKey("page:image-emitted-current", identity));
    if (page.layout === "pass") evidence.add(evidenceKey("page:layout-pass-current", identity));
    if (page.visualReview === "pass") evidence.add(evidenceKey("page:visual-review-pass-current", identity));
  }
  const deck = status.pages.map((page) => ({
    pageId: page.pageId,
    revision: page.revision,
    pageSha256: page.pageSha256.toLowerCase(),
  }));
  if (status.structuralReview === "pass") evidence.add(evidenceKey("deck:structural-review-pass-current", deck));
  if (status.composeReady) evidence.add(evidenceKey("deck:compose-ready", deck));
  if (status.composed) evidence.add(evidenceKey("deck:composed-current", deck));
}

/** Semantic, persistent milestones of one project, sorted. */
export function persistentCompletionEvidence(projectRoot: string): readonly string[] {
  const ledger = readRunLedger(projectRoot);
  if (!ledger) return [];
  const evidence = new Set<string>();
  const status = inspectRunLedger(projectRoot, undefined, process.env, ledger);
  referenceEvidence(ledger, evidence);
  if (status.referencesComplete && ledger.sourcePack.requirements.length > 0) {
    evidence.add("reference:requirements-complete");
  }
  if (status.todoCount > 0) evidence.add("todo:committed");
  pageEvidence(status, evidence);
  for (const receipt of listSourceReceipts(projectRoot)) {
    const rank = SOURCE_STATES.indexOf(receipt.state as (typeof SOURCE_STATES)[number]);
    for (let index = 1; index <= rank; index += 1) {
      evidence.add(evidenceKey(`source:${SOURCE_STATES[index]}`, { sourceId: receipt.sourceId }));
    }
  }
  const exported = exportEvidence(projectRoot);
  if (exported) evidence.add(exported);
  return [...evidence].sort();
}

function latestLedgerRevisions(projectRoot: string): PersistentPageRevision[] {
  const latest = new Map<string, PersistentPageRevision>();
  for (const fact of readRunLedger(projectRoot)?.facts ?? []) {
    if (
      fact.type === "page.revision-committed" &&
      typeof fact.pageId === "string" &&
      Number.isInteger(fact.revision) &&
      typeof fact.pageSha256 === "string"
    ) {
      latest.set(fact.pageId, { pageId: fact.pageId, revision: fact.revision, pageSha256: fact.pageSha256 });
    }
  }
  return [...latest.values()].sort((left, right) => left.pageId.localeCompare(right.pageId));
}

function diskPageDigests(projectRoot: string): { pageId: string; pageSha256: string }[] {
  const pages = loadProject(projectRoot)
    .pages.map((loaded) => {
      const pageId = persistPageKey(loaded.path);
      const detached = JSON.parse(JSON.stringify(loaded.page)) as Record<string, unknown>;
      return { pageId, pageSha256: stableSha256({ ...detached, id: pageId }) };
    })
    .sort((left, right) => left.pageId.localeCompare(right.pageId));
  for (let index = 1; index < pages.length; index += 1) {
    if (pages[index - 1]!.pageId === pages[index]!.pageId) {
      throw new Error(`duplicate persisted pageId ${pages[index]!.pageId}`);
    }
  }
  return pages;
}

/**
 * Sample both durable page sources (latest ledger revision facts and the page
 * bodies on disk) plus completion evidence for one project.
 */
export function readPersistentProductSnapshot(projectRoot: string): PersistentProductSnapshot {
  const ledgerRevisions = latestLedgerRevisions(projectRoot);
  const diskPages = diskPageDigests(projectRoot);
  const pageCount = diskPages.length;
  const completionEvidence = persistentCompletionEvidence(projectRoot);
  return {
    phase: pageCount > 0 || ledgerRevisions.length > 0 ? "production" : "planning",
    pageCount,
    pageRevisionFingerprint: stableSha256({ schemaVersion: 1, pageCount, ledgerRevisions, diskPages }),
    completionEvidenceFingerprint: completionEvidenceFingerprint(completionEvidence),
    completionEvidence,
    ledgerRevisions,
    diskPages,
  };
}
