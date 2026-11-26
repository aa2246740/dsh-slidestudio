import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderFixturePage } from "@open-slidestudio/presentation-run/testkit";
import { readProjectLease } from "@open-slidestudio/slides-tools";
import { createSlidesMcpServer } from "./server.js";
import { SessionClient, tempDir, toolData } from "./testkit.js";

// No browser runs: rasters are the synthetic ones the presentation-run testkit records,
// standing in for the native editor's page render.
process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = "/nonexistent/slides-mcp-test/runtime.mjs";

const INK = "#1F2937";

function pageArgs(id: string) {
  return {
    id,
    pageType: "content",
    elements: [
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 120, 800, 70],
        content: { text: `第 ${id} 页标题`, fontSize: 32, color: INK },
      },
      {
        elementId: "body",
        elementType: "text",
        bounds: [80, 220, 800, 160],
        content: { text: "明确负责人，核对输入信息，再记录交付结果。", fontSize: 24, color: INK },
      },
    ],
  };
}

test("offline chain: open -> capabilities -> references -> plan -> write -> review -> compose -> export -> editor", async () => {
  const dataRoot = tempDir("workflow");
  const server = createSlidesMcpServer({ dataRoot, editorBaseUrl: "http://127.0.0.1:9", log: () => undefined });
  const c = new SessionClient(server.createSession());
  await c.request("initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "workflow" } });
  const ok = (name: string, result: Awaited<ReturnType<SessionClient["call"]>>) => {
    assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result)}`);
    const data = toolData(result);
    assert.notEqual(data.ok, false, `${name}: ${JSON.stringify(data).slice(0, 600)}`);
    return data;
  };

  ok("open_project", await c.call("open_project", { title: "季度复盘" }));
  const root = c.session.state.binding!.projectRoot;
  ok("inspect_capabilities", await c.call("inspect_capabilities"));
  const refs = ok("list_references", await c.call("list_references"));
  const missing = (refs.payload as { missingReferenceChunks?: { sourceId: string; chunkIndex: number }[] })
    .missingReferenceChunks;
  assert.ok(missing && missing.length > 0, "a fresh project lists required reference chunks");
  for (const chunk of missing) ok("read_reference", await c.call("read_reference", chunk));
  const after = ok("list_references", await c.call("list_references"));
  assert.equal((after.payload as { referencesComplete: boolean }).referencesComplete, true);

  const ids = ["p01", "p02"];
  const plan = ids.map((pageId, index) => ({
    pageId,
    title: `标题 ${pageId}`,
    layoutFamily: "content",
    exhibits: [],
    purpose: index ? "evidence" : "cover",
  }));
  assert.equal(ok("commit_design", await c.call("commit_design", { slidePlan: plan })).outcome, "committed");
  const todo = ids.map((pageId) => ({ pageId, title: `标题 ${pageId}`, layoutFamily: "content", exhibits: ["none"] }));
  assert.equal(ok("write_todo", await c.call("write_todo", { items: todo })).outcome, "committed");
  for (const id of ids) {
    assert.equal(ok("write_page", await c.call("write_page", pageArgs(id))).outcome, "written");
    renderFixturePage(root, id);
  }
  const outside = await c.call("write_page", pageArgs("p09"));
  assert.notEqual(toolData(outside).outcome, "written", "a page not in the todo is refused");

  ok("review_pages", await c.call("review_pages"));
  const composed = ok("compose_deck", await c.call("compose_deck", { title: "季度复盘" }));
  assert.equal((composed.payload as { pageCount: number }).pageCount, 2);
  const exported = ok("export_deck", await c.call("export_deck"));
  const report = (exported.payload as { report: { slideCount: number; nativeCoverage: number } }).report;
  assert.equal(report.slideCount, 2);
  assert.equal(report.nativeCoverage, 1, "the export is natively editable");
  const artifact = String((exported.payload as { src: string }).src);
  assert.ok(fs.existsSync(path.join(root, artifact)), artifact);
  const editor = ok("open_in_editor", await c.call("open_in_editor"));
  assert.match(String(editor.url), /^http:\/\/127\.0\.0\.1:9\/\?project=output%2Fdsh-slices%2Fmcp-/);

  assert.equal(readProjectLease(root).holder?.ownerId, c.session.state.callerId);
  assert.deepEqual(c.session.close(), [root]);
  assert.equal(readProjectLease(root).holder, undefined);
});
