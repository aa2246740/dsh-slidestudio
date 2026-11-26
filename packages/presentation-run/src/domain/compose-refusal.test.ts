import assert from "node:assert/strict";
import test from "node:test";
import { boundComposeRefusal, compactComposeBlockers } from "./compose-refusal.js";

test("compose blockers name each page with short reasons and retain plan order", () => {
  assert.deepEqual(
    compactComposeBlockers(
      [
        "p10: visual review missing",
        "todo missing pages: p2,p10",
        "p2: image content not emitted to the model",
        "current structural review missing",
      ],
      ["p2", "p10", "p3"],
    ),
    {
      blockingPages: [
        { pageId: "p2", reason: "not-written+image" },
        { pageId: "p10", reason: "review+not-written" },
      ],
      blockingIssues: ["structure"],
    },
  );
});

test("a stale layout chrome and an undefined layout get their own short reasons", () => {
  assert.deepEqual(
    compactComposeBlockers(
      ["p02: 版式已变更，需要重新渲染", "版式「封面」还没有定义记录，请先定义该版式后再合成"],
      ["p02"],
    ),
    {
      blockingPages: [{ pageId: "p02", reason: "版式已变更" }],
      blockingIssues: ["版式未定义"],
    },
  );
});

test("page identifiers with shared prefixes match the full id only", () => {
  assert.deepEqual(
    compactComposeBlockers(["page-10: rendered layout fail (text-overflow-y)"], ["page-1", "page-10"]).blockingPages,
    [{ pageId: "page-10", reason: "layout" }],
  );
});

test("compose refusal remains below 4 KiB when reference diagnostics are large", () => {
  const missingReferenceChunks = Array.from({ length: 200 }, (_, index) => ({
    sourceId: `source-${index}-${"x".repeat(80)}`,
    chunkIndex: index,
  }));
  const blockingPages = Array.from({ length: 24 }, (_, index) => ({
    pageId: `page-${String(index + 1).padStart(2, "0")}`,
    reason: "review",
  }));
  const result = boundComposeRefusal({
    ok: false,
    name: "compose_deck",
    summary: "compose gate rejected",
    detail: "compose_deck is not ready.",
    payload: { error: "compose_not_ready", missingReferenceChunks, blockingPages },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 4096);
  const payload = result.payload as Record<string, unknown>;
  assert.equal((payload.blockingPages as unknown[]).length, 24);
  assert.equal(payload.missingReferenceChunkCount, 200);
  assert.equal(payload.missingReferenceChunksTruncated, true);
});

test("compose refusal transparently bounds pathological page lists", () => {
  const blockingPages = Array.from({ length: 200 }, (_, index) => ({
    pageId: `page-${String(index + 1).padStart(3, "0")}-${"x".repeat(72)}`,
    reason: "layout",
  }));
  const result = boundComposeRefusal({
    ok: false,
    name: "compose_deck",
    summary: "compose gate rejected",
    detail: "compose_deck is not ready.",
    payload: { error: "compose_not_ready", blockingPages },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 4096);
  const payload = result.payload as Record<string, unknown>;
  assert.equal(payload.blockingPageCount, 200);
  assert.equal(payload.blockingPagesTruncated, true);
  assert.ok((payload.blockingPages as unknown[]).length < 200);
});

test("page identities take priority over reference samples near the byte limit", () => {
  const blockingPages = Array.from({ length: 55 }, (_, index) => ({
    pageId: `page-${String(index + 1).padStart(2, "0")}-${"x".repeat(24)}`,
    reason: "layout",
  }));
  const missingReferenceChunks = Array.from({ length: 200 }, (_, index) => ({
    sourceId: `source-${index}-${"y".repeat(80)}`,
    chunkIndex: index,
  }));
  const result = boundComposeRefusal({
    ok: false,
    name: "compose_deck",
    summary: "compose gate rejected",
    detail: "compose_deck is not ready.",
    payload: { error: "compose_not_ready", blockingPages, missingReferenceChunks },
  });
  const payload = result.payload as Record<string, unknown>;
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 4096);
  assert.equal((payload.blockingPages as unknown[]).length, blockingPages.length);
  assert.equal(payload.blockingPageCount, undefined);
  assert.equal(payload.missingReferenceChunkCount, 200);
  assert.equal(payload.missingReferenceChunks, undefined);
  assert.equal(payload.missingReferenceChunksTruncated, true);
});

test("an empty reference list is not reported as truncated during page-list bounding", () => {
  const blockingPages = Array.from({ length: 200 }, (_, index) => ({
    pageId: `page-${String(index + 1).padStart(3, "0")}-${"x".repeat(72)}`,
    reason: "layout",
  }));
  const result = boundComposeRefusal({
    ok: false,
    name: "compose_deck",
    summary: "compose gate rejected",
    detail: "compose_deck is not ready.",
    payload: { error: "compose_not_ready", blockingPages, missingReferenceChunks: [] },
  });
  const payload = result.payload as Record<string, unknown>;
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 4096);
  assert.equal(payload.missingReferenceChunkCount, undefined);
  assert.equal(payload.missingReferenceChunksTruncated, undefined);
});
