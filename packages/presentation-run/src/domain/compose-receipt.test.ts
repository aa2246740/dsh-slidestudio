import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { slimComposeResult } from "./compose-receipt.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { persistPageKey } from "./page-identity.js";
import {
  ensureRunLedger,
  readRunLedger,
  recordPageRevision,
  recordStructuralReview,
  recordTodo,
  stableSha256,
} from "./run-ledger.js";
import { recordRaster } from "./run-ledger-raster.js";
import type { SkillDeckInput } from "./skill-pages.js";

const context = { commandId: "compose-fixture", contextEpochId: "receipt-epoch" };

async function writtenDeck(root: string, count: number, ids?: readonly string[]): Promise<void> {
  createEmptyProject(root, { title: "旧标题" });
  writeDomainRuntime(root, { brief: `制作 ${count} 页介绍协作流程的演示。` });
  persistPresentationRunProvider(root, {
    providerId: "offline",
    modelId: "fixture",
    ready: true,
    modelInputModalities: ["text"],
  });
  for (let index = 1; index <= count; index += 1) {
    const result = await runDomainHand(
      "write_page",
      {
        id: ids?.[index - 1] ?? `p${index}`,
        pageType: "content",
        notes: `第 ${index} 页完整备注`,
        elements: [
          {
            elementId: "title",
            elementType: "text",
            bounds: [80, 80, 800, 70],
            content: { text: `协作流程的第 ${index} 个环节`, fontSize: 32 },
          },
          {
            elementId: "body",
            elementType: "text",
            bounds: [80, 200, 800, 160],
            content: { text: "明确负责人，核对输入信息，再记录交付结果。", fontSize: 24 },
          },
        ],
      },
      root,
    );
    assert.equal(result.ok, true, result.detail);
  }
}

function strictLedger(root: string, ids: string[], allLongTitles = false): void {
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: true, structuralReviewRequired: true },
  });
  recordTodo(
    root,
    context,
    ids.map((pageId, index) => ({
      pageId,
      title: allLongTitles ? "跨".repeat(40) : index === 0 ? "跨".repeat(39) + "\u{20000}超出" : `大纲标题 ${pageId}`,
      layoutFamily: "content",
      exhibits: ["none"],
    })),
  );
  for (const entry of loadProject(root).pages) {
    const id = persistPageKey(entry.path);
    const revision = recordPageRevision(root, context, id, { ...entry.page, id });
    // Synthetic layout evidence: no browser, renderer or model is called.
    recordRaster(root, revision, {
      bytes: Buffer.from(`offline raster ${id}`),
      src: `_agent/rasters/${id}.png`,
      width: 960,
      height: 540,
      layoutStatus: "pass",
      layoutIssues: [],
    });
  }
  recordStructuralReview(root, true, []);
}

describe("compose success receipt", () => {
  it("omits complete entries when 24 legal 200-byte IDs exceed the cap without altering persisted state", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "compose-receipt-identities-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ids = Array.from(
      { length: 24 },
      (_, index) => `page-${String(index + 1).padStart(2, "0")}-${"x".repeat(192)}`,
    );
    assert.equal(new Set(ids).size, 24);
    assert.ok(ids.every((id) => Buffer.byteLength(id, "utf8") === 200));
    await writtenDeck(root, 24, ids);
    const pagesBefore = loadProject(root).pages.map((entry) => fs.readFileSync(path.join(root, entry.path)));
    strictLedger(root, ids, true);
    const result = await runDomainHand("compose_deck", { title: "协作流程交付", __openSlideStudio: context }, root);
    assert.equal(result.ok, true, result.detail);
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    t.diagnostic(`24 long page IDs: ${bytes} serialized UTF-8 bytes`);
    assert.ok(bytes <= 4096, `${bytes} exceeds the 4096-byte hard limit`);
    const payload = result.payload as {
      pageCount: number;
      pages: { id: string; title: string }[];
      omittedPageCount: number;
      recoveryHint: string;
    };
    assert.equal(payload.pageCount, 24);
    assert.ok(payload.pages.length > 0 && payload.pages.length < 24);
    assert.equal(payload.omittedPageCount, 24 - payload.pages.length);
    assert.match(payload.recoveryHint, /deck\.pptd manifest/);
    assert.deepEqual(
      payload.pages,
      ids.slice(0, payload.pages.length).map((id) => ({ id, title: "跨".repeat(40) })),
    );
    const nextEntry = { id: ids[payload.pages.length]!, title: "跨".repeat(40) };
    assert.ok(
      Buffer.byteLength(
        JSON.stringify({
          ...result,
          payload: {
            ...payload,
            pages: [...payload.pages, nextEntry],
            omittedPageCount: payload.omittedPageCount - 1,
          },
        }),
        "utf8",
      ) > 4096,
      "another full entry should not fit",
    );
    assert.deepEqual(
      loadProject(root).pages.map((entry) => fs.readFileSync(path.join(root, entry.path))),
      pagesBefore,
    );
    const fact = readRunLedger(root)?.facts.find((item) => item.type === "deck.composed");
    if (fact?.type !== "deck.composed") assert.fail("compose seal missing");
    assert.deepEqual(Object.keys(fact.pageRevisions).sort(), [...ids].sort());
    const saved = JSON.parse(fs.readFileSync(path.join(root, "_agent", "hands-state.json"), "utf8")) as {
      skillDeck: SkillDeckInput;
    };
    assert.deepEqual(
      saved.skillDeck.pages.map((page) => page.id),
      ids,
    );
    const persistedPaths = fs.readdirSync(root, { recursive: true }).map(String).sort();
    const persistedFiles = persistedPaths.filter((file) => fs.statSync(path.join(root, file)).isFile()).sort();
    const persistedBytes = () => persistedFiles.map((file) => fs.readFileSync(path.join(root, file)));
    const beforeProjection = persistedBytes();
    const original = {
      name: "compose_deck",
      ok: true,
      summary: "24 页 PPTD",
      detail: ids.join("\n"),
      payload: saved.skillDeck,
    };
    const originalBytes = JSON.stringify(original);
    const projected = slimComposeResult(root, original, fact);
    assert.ok(Buffer.byteLength(JSON.stringify(projected), "utf8") <= 4096);
    assert.equal(JSON.stringify(original), originalBytes);
    assert.deepEqual(persistedBytes(), beforeProjection);
    assert.deepEqual(fs.readdirSync(root, { recursive: true }).map(String).sort(), persistedPaths);
  });

  it("bounds the whole UTF-8 receipt for 24 forty-character Chinese titles without changing stored data", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "compose-receipt-utf8-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await writtenDeck(root, 24);
    const before = loadProject(root);
    const beforePages = before.pages.map((entry) => stableSha256(entry.page));
    const ids = before.pages.map((entry) => persistPageKey(entry.path));
    strictLedger(root, ids, true);
    const outlinePath = path.join(root, "_agent", "outline.json");
    const planBefore = readRunLedger(root)?.facts.find((fact) => fact.type === "todo.committed");
    const result = await runDomainHand("compose_deck", { title: "协作流程交付", __openSlideStudio: context }, root);
    assert.equal(result.ok, true, result.detail);
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    t.diagnostic(`24 long Chinese titles: ${bytes} serialized UTF-8 bytes`);
    assert.ok(bytes <= 4096, `${bytes} exceeds the 4096-byte hard limit`);
    assert.ok(bytes <= 3.5 * 1024, `${bytes} exceeds the 3.5-KiB target`);
    const payload = result.payload as { pages: { id: string; title: string }[] };
    assert.deepEqual(
      payload.pages.map((page) => page.id),
      ids,
    );
    for (const page of payload.pages) {
      assert.ok(page.title.length > 0);
      assert.ok("跨".repeat(40).startsWith(page.title));
      assert.doesNotMatch(page.title, /\uFFFD/);
    }
    const outline = JSON.parse(fs.readFileSync(outlinePath, "utf8")) as {
      items: { title: string }[];
    };
    assert.deepEqual(
      outline.items.map((item) => item.title),
      ids.map(() => "跨".repeat(40)),
    );
    assert.deepEqual(
      readRunLedger(root)?.facts.find((fact) => fact.type === "todo.committed"),
      planBefore,
    );
    assert.deepEqual(
      loadProject(root).pages.map((entry) => stableSha256(entry.page)),
      beforePages,
    );
    const saved = JSON.parse(fs.readFileSync(path.join(root, "_agent", "hands-state.json"), "utf8")) as {
      skillDeck: SkillDeckInput;
    };
    assert.deepEqual(
      saved.skillDeck.pages.map((page) => page.elements.length),
      ids.map(() => 2),
    );
    assert.ok(saved.skillDeck.pages.every((page) => page.notes?.includes("完整备注")));
  });

  it("strict 24-page compose returns a slim receipt while disk, seal and hands-state stay complete", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "compose-receipt-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await writtenDeck(root, 24);
    const before = loadProject(root);
    const beforePages = new Map(before.pages.map((entry) => [entry.path, stableSha256(entry.page)]));
    const ids = before.pages.map((entry) => persistPageKey(entry.path)).reverse();
    strictLedger(root, ids);
    // Disk pages missing from the historical buffer must still reach the full
    // explicitComposeMutations/persistFromState path, not become receipt rows.
    fs.writeFileSync(
      path.join(root, "_agent", "hands-state.json"),
      JSON.stringify({
        todos: [],
        writtenPages: [],
      }),
    );
    const result = await runDomainHand(
      "compose_deck",
      {
        title: "协作流程交付",
        __openSlideStudio: context,
      },
      root,
    );
    assert.equal(result.ok, true, result.detail);
    assert.doesNotMatch(JSON.stringify(result), /"elements"/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 3.5 * 1024);
    const payload = result.payload as {
      title: string;
      pageCount: number;
      pages: { id: string; title: string }[];
      deckSha256: string;
      composedFactId: string;
      next: string;
    };
    assert.deepEqual(Object.keys(payload).sort(), [
      "composedFactId",
      "deckSha256",
      "next",
      "pageCount",
      "pages",
      "title",
    ]);
    assert.equal(payload.title, "协作流程交付");
    assert.equal(payload.pageCount, 24);
    assert.equal(payload.next, "deliver");
    const disk = loadProject(root);
    assert.equal(disk.presentation.title, payload.title);
    assert.deepEqual(
      payload.pages.map((page) => page.id),
      ids,
    );
    assert.deepEqual(
      payload.pages.map((page) => page.id),
      disk.pages.map((entry) => persistPageKey(entry.path)),
    );
    assert.equal(payload.pages[0]?.title, "跨".repeat(39) + "\u{20000}");
    assert.equal(payload.pages[1]?.title, `大纲标题 ${ids[1]}`);
    for (const page of payload.pages) {
      assert.deepEqual(Object.keys(page).sort(), ["id", "title"]);
      assert.ok(Array.from(page.title).length <= 40);
    }
    for (const entry of disk.pages) {
      assert.equal(stableSha256(entry.page), beforePages.get(entry.path));
      assert.ok(fs.readFileSync(path.join(root, entry.path), "utf8").includes("elements:"));
    }
    const fact = readRunLedger(root)?.facts.find((item) => item.type === "deck.composed");
    assert.equal(fact?.type, "deck.composed");
    if (fact?.type !== "deck.composed") assert.fail("compose seal missing");
    assert.equal(payload.deckSha256, fact.deckSha256);
    assert.equal(payload.composedFactId, fact.factId);
    assert.equal(Object.keys(fact.pageRevisions).length, 24);
    const saved = JSON.parse(fs.readFileSync(path.join(root, "_agent", "hands-state.json"), "utf8")) as {
      skillDeck: SkillDeckInput;
    };
    assert.equal(saved.skillDeck.title, payload.title);
    assert.equal(saved.skillDeck.pages.length, 24);
    for (const page of saved.skillDeck.pages) {
      assert.equal(page.elements.length, 2);
      assert.match(page.notes ?? "", /完整备注/);
    }
    t.diagnostic(`24-page model-facing result: ${Buffer.byteLength(JSON.stringify(result))} bytes`);
  });

  it("non-strict compose still returns complete pages and strict rejection stays an error payload", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "compose-receipt-legacy-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await writtenDeck(root, 2);
    const legacy = await runDomainHand("compose_deck", { title: "旧路径完整文稿" }, root);
    assert.equal(legacy.ok, true, legacy.detail);
    assert.equal((legacy.payload as SkillDeckInput).pages[0]?.elements.length, 2);
    ensureRunLedger(root, {
      manifestSha256: "fixture",
      requirementsId: "fixture",
      requirements: [],
    });
    const rejected = await runDomainHand(
      "compose_deck",
      {
        title: "不能完成",
        __openSlideStudio: context,
      },
      root,
    );
    assert.equal(rejected.ok, false);
    assert.match((rejected.payload as { error: string }).error, /write_todo missing/);
    assert.equal(
      readRunLedger(root)?.facts.some((fact) => fact.type === "deck.composed"),
      false,
    );
  });
});
