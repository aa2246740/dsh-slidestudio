/**
 * Shared fixtures for the delivery note tests. A synthetic sealed project is
 * generated on demand (no checked-in fixture tree): `post-seal-24-page` and
 * `post-seal-40-page` are runs whose every page passed review and whose deck
 * was composed, followed by a post-seal context budget fault.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSystemDeliveryNote as buildNote } from "./delivery-note.mjs";

/** Temp project roots created by the current test; removed by cleanupScratchRoots(). */
export const scratchRoots = /** @type {string[]} */ ([]);

export function cleanupScratchRoots() {
  for (const root of scratchRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

/**
 * Same as the product builder, typed as always returning a note so tests can
 * read `note.lines` directly (an absent note still compares equal to undefined).
 * @param {Parameters<typeof buildNote>[0]} input
 * @returns {import("./delivery-note.mjs").SystemDeliveryNote}
 */
export function buildSystemDeliveryNote(input) {
  return /** @type {import("./delivery-note.mjs").SystemDeliveryNote} */ (buildNote(input));
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const AT = "2026-01-01T00:00:00.000Z";
const EPOCH = "post-seal-fixture-epoch";

/** @param {number} index */
const pageId = (index) => `page-${String(index + 1).padStart(2, "0")}`;
/** @param {string} letter */
const sha = (letter) => letter.repeat(64);

/** @param {number} pageCount */
function ledger(pageCount) {
  const ids = Array.from({ length: pageCount }, (_, index) => pageId(index));
  const reviews = ids.map((id, index) => ({
    type: "page.visual-review-recorded",
    factId: `page.visual-review-recorded:${id}`,
    at: AT,
    contextEpochId: EPOCH,
    pageId: id,
    revision: 1,
    pageSha256: sha(LETTERS[index % 26] ?? "a"),
    rasterSha256: sha(LETTERS[5 + (index % 20)] ?? "f"),
    deliveryToken: `delivery-${id}`,
    verdict: "pass",
    issues: [],
  }));
  const chunks = ["e", "f", "0"].map((letter, chunkIndex) => ({
    type: "material.chunk-returned",
    factId: `material.chunk-returned:chunk-${chunkIndex}`,
    at: AT,
    contextEpochId: EPOCH,
    materialId: "synthetic-report",
    materialSha256: sha("d"),
    part: "document",
    chunkIndex,
    chunkSha256: sha(letter),
  }));
  const composed = {
    type: "deck.composed",
    factId: "deck.composed:post-seal-fixture",
    at: AT,
    contextEpochId: EPOCH,
    title: "合成月报",
    deckSha256: sha("1"),
    pageRevisions: Object.fromEntries(reviews.map((review) => [review.pageId, review.pageSha256])),
  };
  return {
    schemaVersion: 1,
    runId: `post-seal-${pageCount}-page-fixture`,
    createdAt: AT,
    updatedAt: AT,
    sourcePack: {
      manifestSha256: sha("2"),
      requirementsId: "post-seal-fault-fixture",
      requirements: [],
      executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: false },
    },
    facts: [...reviews, ...chunks, composed],
  };
}

/** @param {"24-page" | "40-page"} variant */
function documentPart(variant) {
  return variant === "24-page"
    ? { part: "document", label: "6 页", pages: 6 }
    : { part: "document", label: "12 个内容块", blocks: 12, counts: 5, chars: 1500 };
}

/**
 * Write the synthetic sealed `_agent` directory of a variant into `projectRoot`.
 * @param {string} projectRoot
 * @param {"24-page" | "40-page"} variant
 */
export function writeSealedAgentDir(projectRoot, variant) {
  const pageCount = variant === "24-page" ? 24 : 40;
  const agentDir = path.join(projectRoot, "_agent");
  fs.mkdirSync(path.join(agentDir, "materials"), { recursive: true });
  /** @type {Record<string, unknown>} */
  const files = {
    "runtime.json": {
      brief: "合成验收夹具，不含用户文字。",
      design: { kind: "self-directed" },
      adoptedSourceIds: [],
    },
    "run-ledger.v1.json": ledger(pageCount),
    "outline.json": {
      version: 1,
      items: Array.from({ length: pageCount }, (_, index) => ({
        pageId: pageId(index),
        title: `页面 ${String(index + 1).padStart(2, "0")}`,
      })),
    },
    "presentation-receipts.v1.json": { version: 1, receipts: [] },
    "dsh-agent-error.json": {
      code: "CONTEXT_BUDGET_EXCEEDED",
      detail: "Synthetic post-seal budget fault.",
      recovering: false,
    },
    "materials/manifest.json": {
      version: 1,
      materials: [
        {
          id: "synthetic-report",
          name: "合成参考资料",
          kind: "document",
          parts: [documentPart(variant)],
        },
      ],
    },
  };
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(agentDir, name), `${JSON.stringify(value, null, 2)}\n`);
  }
}

/** A fresh scratch project holding the sealed `_agent` directory of a variant. @param {"24-page" | "40-page"} variant */
export function projectCopy(variant) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-note-fixture-"));
  scratchRoots.push(target);
  writeSealedAgentDir(target, variant);
  return target;
}

/** @param {string} prefix */
export function scratchProject(prefix) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchRoots.push(target);
  return target;
}

/** @param {string} projectRoot @param {string} relativePath @param {unknown} value */
export function writeMetadata(projectRoot, relativePath, value) {
  fs.writeFileSync(path.join(projectRoot, "_agent", relativePath), JSON.stringify(value));
}

/** @param {string} projectRoot */
export function designSummary(projectRoot) {
  return buildSystemDeliveryNote({ projectRoot, deliveryIssue: { sealed: true } })?.lines.find((line) =>
    line.startsWith("设计："),
  );
}

/**
 * A `delivery-provenance/v1` record with three materials and four pages; top-level
 * sections are replaced by `overrides`.
 * @param {Record<string, unknown>} [overrides]
 */
export function provenanceFixture(overrides = {}) {
  return {
    schema: "delivery-provenance/v1",
    contextEpochId: "epoch-provenance",
    deckSha256: "b".repeat(64),
    materials: [
      {
        id: "synthetic-report",
        name: "合成参考资料",
        kind: "document",
        chunksRead: 3,
        chunkCount: 3,
        pagesCovered: "1–29",
        lowTextPages: [3, 26],
        use: ["content", "style-hint"],
        pagesTotal: 29,
      },
      {
        id: "synthetic-rows",
        name: "合成数据.csv",
        kind: "table",
        chunksRead: 2,
        chunkCount: null,
        pagesCovered: null,
        lowTextPages: [],
        use: [],
      },
      {
        id: "synthetic-photo",
        name: "合成图片.png",
        kind: "image",
        chunksRead: 0,
        chunkCount: null,
        pagesCovered: null,
        lowTextPages: [],
        use: [],
      },
    ],
    design: {
      stylePriority: "agent",
      designSystemId: null,
      adoptedSourceIds: [],
      designAspects: [],
      userColors: [],
      components: [],
      styleHintsUsed: [],
    },
    images: [],
    pages: [
      {
        pageId: "01_cover",
        title: "封面",
        declared: null,
        detected: null,
        visionValues: [],
        queries: [],
      },
      {
        pageId: "02_overview",
        title: "概览",
        declared: { basis: "mock" },
        detected: null,
        visionValues: [],
        queries: [],
      },
      {
        pageId: "03_data",
        title: "数据",
        declared: { basis: "material" },
        detected: {
          quotedCount: 4,
          sourcePages: [12],
          periodMismatch: { page: "2026年9月", source: ["2026年1-2月"] },
        },
        visionValues: [],
        queries: [],
      },
      {
        pageId: "04_plan",
        title: "计划",
        declared: null,
        detected: null,
        visionValues: [],
        queries: [],
      },
    ],
    data: {},
    conflicts: [],
    layouts: [],
    ...overrides,
  };
}
