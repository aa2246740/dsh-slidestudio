import assert from "node:assert/strict";
import test from "node:test";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { batchRemoveFooters, isFooterElement } from "./batch-footers.js";
import { readPageFromProject } from "./read-page.js";
import { createSlideTools } from "./suite.js";
import { contextFor, makeProject, recordingPresentation, runtimeDeps, textPage } from "./testkit.js";

const title = {
  elementId: "title",
  elementType: "text",
  bounds: [80, 60, 800, 80],
  content: { text: "季度复盘", fontSize: 32 },
};
const body = {
  elementId: "body",
  elementType: "text",
  bounds: [80, 180, 800, 200],
  content: { text: "收入同比增长 12%", fontSize: 18 },
};
const footer = {
  elementId: "footer-note",
  elementType: "text",
  bounds: [40, 505, 300, 24],
  content: { text: "来源：公开年报", fontSize: 10 },
};
const pageNumber = {
  elementId: "pn",
  elementType: "text",
  bounds: [880, 505, 60, 24],
  content: { text: "3", fontSize: 10 },
};

test("read_page returns id and pageSha256 first, then the complete own body", () => {
  const root = makeProject([{ file: "2_body.page", page: textPage("2_body", [title, body] as never) }]);
  const read = readPageFromProject(root, "2_body");
  assert.deepEqual(Object.keys(read).slice(0, 2), ["id", "pageSha256"]);
  assert.equal(read.id, "2_body");
  assert.match(String(read.pageSha256), /^[a-f0-9]{64}$/);
  assert.deepEqual(
    (read.elements as { elementId: string }[]).map((el) => el.elementId),
    ["title", "body"],
  );
  assert.equal("inheritedSummary" in read, false);
});

test("read_page resolves a unique _rvN snapshot id to its page and refuses unknown or empty ids", () => {
  const root = makeProject([{ file: "2_body.page", page: textPage("2_body", [title] as never) }]);
  assert.equal(readPageFromProject(root, "2_body_rv3").id, "2_body");
  assert.equal(readPageFromProject(root, "2_body.rv12").id, "2_body");
  assert.equal(readPageFromProject(root, "missing_rv2").outcome, "not-found");
  assert.equal(readPageFromProject(root, "  ").outcome, "rejected");
});

test("read_page summarises inherited layout copies without sending their bodies", () => {
  const layout = {
    id: "body",
    name: "正文",
    elements: [
      {
        elementId: "logo",
        elementType: "text",
        bounds: [860, 20, 80, 30],
        layoutRole: "logo",
        content: { text: "LOGO" },
      },
    ],
  };
  const root = makeProject(
    [{ file: "2_body.page", page: textPage("2_body", [title] as never, { layoutId: "body" }) }],
    [layout] as never,
  );
  const read = readPageFromProject(root, "2_body");
  const summary = read.inheritedSummary as Record<string, unknown>[];
  assert.ok(Array.isArray(summary) && summary.length === 1, JSON.stringify(read));
  assert.equal(summary[0]!.elementType, "text");
  assert.deepEqual(summary[0]!.bounds, [860, 20, 80, 30]);
  assert.equal("content" in summary[0]!, false, "copies are summarised, never sent");
  assert.equal(
    (read.elements as { elementId: string }[]).some((el) => el.elementId === "logo"),
    false,
    "the own body excludes layout copies",
  );
});

test("footer detection keeps titles and body text but catches footnotes and page numbers", () => {
  assert.equal(isFooterElement(title as never), false);
  assert.equal(isFooterElement(body as never), false);
  assert.equal(isFooterElement(footer as never), true);
  assert.equal(isFooterElement(pageNumber as never), true);
  assert.equal(isFooterElement({ ...body, layoutRole: "footer" } as never), true);
});

test("batch_remove_footers removes footers across pages and preserves everything else", () => {
  const root = makeProject([
    { file: "1_cover.page", page: textPage("1_cover", [title, pageNumber] as never) },
    { file: "2_body.page", page: textPage("2_body", [title, body, footer] as never) },
  ]);
  const outcome = batchRemoveFooters(root, {});
  assert.equal(outcome.outcome, "applied");
  assert.ok(outcome.outcome === "applied");
  assert.equal(outcome.removedCount, 2);
  assert.deepEqual([...outcome.modifiedPages].sort(), ["1_cover", "2_body"]);
  const pages = loadProject(root).pages.map((loaded) => loaded.page.elements.map((el) => el.elementId));
  assert.deepEqual(pages, [["title"], ["title", "body"]]);
  const again = batchRemoveFooters(root, {});
  assert.ok(again.outcome === "applied");
  assert.equal(again.removedCount, 0, "a second run is a no-op");
});

test("batch_remove_footers refuses unknown or empty pageIds without writing", () => {
  const root = makeProject([{ file: "2_body.page", page: textPage("2_body", [title, footer] as never) }]);
  assert.equal(batchRemoveFooters(root, { pageIds: [] }).outcome, "rejected");
  assert.equal(batchRemoveFooters(root, { pageIds: ["nope"] }).outcome, "rejected");
  assert.equal(loadProject(root).pages[0]!.page.elements.length, 2);
});

test("the batch_remove_footers tool replays its receipt and refuses a reused callId with new arguments", async () => {
  const root = makeProject([{ file: "2_body.page", page: textPage("2_body", [title, footer] as never) }]);
  const tool = createSlideTools(runtimeDeps(recordingPresentation().presentation)).find(
    (def) => def.name === "batch_remove_footers",
  )!;
  const ctx = contextFor(root, { kind: "hub-run", id: "hub-run:s" }, "footers-1");
  const first = await tool.execute({}, ctx);
  assert.equal(first.data.removedCount, 1);
  const replay = await tool.execute({}, ctx);
  assert.deepEqual(replay.data, first.data);
  const conflict = await tool.execute({ includeLayouts: false }, ctx);
  assert.equal(conflict.data.outcome, "conflict");
});
