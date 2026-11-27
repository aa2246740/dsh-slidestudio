import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalWritePageIssues, loadProject, saveProject, type Page } from "@open-slidestudio/pptd-v2";
import { pagePatchIssues, preparePagePatch, PATCH_PAGE_ELEMENTS_TOOL_NAME } from "./page-patch.js";
import { readPageFromProject } from "./read-page.js";
import { createSlideTools, listCanonicalSlideTools, slideToolSchemaBytes } from "./suite.js";
import { contextFor, makeProject, recordingPresentation, runtimeDeps, textPage } from "./testkit.js";
import { CANONICAL_SLIDE_TOOL_NAMES } from "./tool-names.js";

const title = {
  elementId: "title",
  elementType: "text",
  bounds: [80, 60, 800, 80],
  content: { text: "季度复盘", fontSize: 32, color: "#111111" },
};
const body = {
  elementId: "body",
  elementType: "text",
  bounds: [80, 180, 800, 200],
  content: { text: "收入同比增长 12%", fontSize: 18, color: "#999999" },
};
const card = {
  elementId: "card",
  elementType: "shape",
  shapeName: "rect",
  bounds: [60, 160, 840, 240],
  fill: { type: "solid", color: "#F2F2F2" },
};

function fixture(): { root: string; sha: string } {
  const root = makeProject([{ file: "2_body.page", page: textPage("2_body", [card, title, body] as never) }]);
  return { root, sha: String(readPageFromProject(root, "2_body").pageSha256) };
}

test("patch_page_elements is opt-in and stays out of the frozen canonical contract", () => {
  assert.equal(
    listCanonicalSlideTools().some((tool) => tool.name === PATCH_PAGE_ELEMENTS_TOOL_NAME),
    false,
  );
  assert.equal((CANONICAL_SLIDE_TOOL_NAMES as readonly string[]).includes(PATCH_PAGE_ELEMENTS_TOOL_NAME), false);
  const tool = listCanonicalSlideTools({ include: new Set([PATCH_PAGE_ELEMENTS_TOOL_NAME]) }).at(-1)!;
  assert.equal(tool.name, PATCH_PAGE_ELEMENTS_TOOL_NAME);
  assert.equal(tool.readOnly, false);
  const bytes = slideToolSchemaBytes(tool);
  assert.ok(bytes <= 2048, `patch_page_elements schema is ${bytes} bytes (budget 2048)`);
});

test("bounds, text and style patches merge into the own canonical body and round-trip through YAML", () => {
  const { root, sha } = fixture();
  const prepared = preparePagePatch(root, {
    pageId: "2_body",
    expectedPageSha256: sha,
    patches: [
      { elementId: "title", bounds: [80, 40, 800, 72], fontSize: 30 },
      { elementId: "body", text: "收入同比增长 15%", color: "#333333" },
      { elementId: "card", fill: "#FFFFFF", border: { color: "#DDDDDD", width: 1 } },
    ],
  });
  assert.ok(prepared.ok, JSON.stringify(prepared));
  assert.deepEqual(canonicalWritePageIssues(structuredClone(prepared.page) as never), []);
  assert.equal(prepared.page.expectedPageSha256, sha);
  const project = loadProject(root);
  const page = structuredClone(prepared.page) as Partial<typeof prepared.page>;
  delete page.expectedPageSha256;
  project.pages[0]!.page = page as unknown as Page;
  saveProject(project);
  type Saved = { bounds: number[]; content: Record<string, unknown>; fill?: unknown; border?: unknown };
  const [cardOut, titleOut, bodyOut] = loadProject(root).pages[0]!.page.elements as unknown as Saved[];
  assert.deepEqual(titleOut!.bounds, [80, 40, 800, 72]);
  assert.equal(titleOut!.content.fontSize, 30);
  assert.equal(titleOut!.content.text, "季度复盘", "unpatched fields are preserved");
  assert.equal(bodyOut!.content.text, "收入同比增长 15%");
  assert.equal(bodyOut!.content.color, "#333333");
  assert.deepEqual(bodyOut!.bounds, body.bounds);
  assert.deepEqual(cardOut!.fill, { type: "solid", color: "#FFFFFF" });
  assert.deepEqual(cardOut!.border, { color: "#DDDDDD", width: 1 });
});

test("remove and index patches change membership and z-order only", () => {
  const { root, sha } = fixture();
  const prepared = preparePagePatch(root, {
    pageId: "2_body",
    expectedPageSha256: sha,
    patches: [
      { elementId: "card", remove: true },
      { elementId: "body", index: 0 },
    ],
  });
  assert.ok(prepared.ok, JSON.stringify(prepared));
  assert.deepEqual(
    prepared.page.elements.map((element) => element.elementId),
    ["body", "title"],
  );
});

test("unknown elementIds, wrong element kinds, stale hashes and bad arguments are rejected", () => {
  const { root, sha } = fixture();
  const missing = preparePagePatch(root, {
    pageId: "2_body",
    expectedPageSha256: sha,
    patches: [{ elementId: "nope", text: "x" }],
  });
  assert.ok(!missing.ok);
  assert.equal(missing.outcome.error, "PAGE_PATCH_TARGET_INVALID");
  assert.match(missing.outcome.detail, /nope is not an own element/);
  const kind = preparePagePatch(root, {
    pageId: "2_body",
    expectedPageSha256: sha,
    patches: [{ elementId: "card", text: "x" }],
  });
  assert.ok(!kind.ok);
  assert.match(kind.outcome.detail, /text applies to text elements only/);
  const stale = preparePagePatch(root, {
    pageId: "2_body",
    expectedPageSha256: "0".repeat(64),
    patches: [{ elementId: "title", text: "x" }],
  });
  assert.ok(!stale.ok);
  assert.equal(stale.outcome.error, "PAGE_PATCH_STALE_PAGE");
  const page = preparePagePatch(root, {
    pageId: "9_none",
    expectedPageSha256: sha,
    patches: [{ elementId: "a", text: "b" }],
  });
  assert.ok(!page.ok);
  assert.equal(page.outcome.error, "PAGE_PATCH_PAGE_NOT_FOUND");
  assert.deepEqual(pagePatchIssues({ pageId: "p", expectedPageSha256: "s", patches: [] }), [
    "patches must be a non-empty array",
  ]);
  const issues = pagePatchIssues({
    pageId: "p",
    expectedPageSha256: "s",
    patches: [
      { elementId: "a" },
      { elementId: "b", remove: true, text: "x" },
      { elementId: "b", bounds: [1, 2, 3] },
      { elementId: "c", index: -1, fontSize: 0 },
    ],
  });
  assert.equal(issues.length, 6, issues.join("\n"));
});

test("the tool persists through the canonical write_page command and replays its receipt", async () => {
  const { root, sha } = fixture();
  const { presentation, calls } = recordingPresentation();
  const deps = runtimeDeps(presentation, { writerLease: false });
  const tool = createSlideTools(deps, { include: new Set([PATCH_PAGE_ELEMENTS_TOOL_NAME]) }).find(
    (def) => def.name === PATCH_PAGE_ELEMENTS_TOOL_NAME,
  )!;
  const ctx = contextFor(root, { kind: "hub-run", id: "hub-run:s" }, "patch-1");
  const args = { pageId: "2_body", expectedPageSha256: sha, patches: [{ elementId: "body", color: "#222222" }] };
  const first = await tool.execute(args, ctx);
  assert.equal(first.data.outcome, "written", JSON.stringify(first.data));
  const write = calls.find((call) => call.name === "write_page");
  assert.ok(write, "the patch is persisted by the canonical write_page domain command");
  assert.equal(write.args.id, "2_body");
  assert.equal(write.args.expectedPageSha256, sha);
  const elements = write.args.elements as { elementId: string; content?: { color?: string } }[];
  assert.deepEqual(
    elements.map((element) => element.elementId),
    ["card", "title", "body"],
  );
  assert.equal(elements[2]!.content?.color, "#222222");
  assert.ok(
    calls.some((call) => call.name === "render_page"),
    "the write is auto-rendered",
  );
  const writes = calls.length;
  const replay = await tool.execute(args, ctx);
  assert.deepEqual(replay.data, first.data);
  assert.equal(calls.length, writes, "a replayed callId never writes twice");
  await assert.rejects(
    tool.execute({ pageId: "2_body", expectedPageSha256: sha, patches: [{ elementId: "body" }] }, ctx),
    /set at least one field/,
  );
});

test("pagePatchIssues rejects non-positive border.width and preparePagePatch rejects null text content", () => {
  const issues = pagePatchIssues({
    pageId: "2_body",
    expectedPageSha256: "abc",
    patches: [{ elementId: "card", border: { color: "#111111", width: 0 } }],
  });
  assert.ok(issues.some((msg) => /border\.width/.test(msg)));

  const { root } = fixture();
  const pageFile = path.join(root, "pages", "2_body.page");
  const raw = fs
    .readFileSync(pageFile, "utf8")
    .replace(/content:\n[\s\S]*?(?=\n {2}- elementId: body)/, "content: null\n");
  fs.writeFileSync(pageFile, raw);
  const updated = readPageFromProject(root, "2_body");
  assert.equal("pageSha256" in updated, true);
  const bad = preparePagePatch(root, {
    pageId: "2_body",
    expectedPageSha256: (updated as { pageSha256: string }).pageSha256,
    patches: [{ elementId: "title", text: "改标题" }],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.outcome.error, "PAGE_PATCH_TARGET_INVALID");
});
