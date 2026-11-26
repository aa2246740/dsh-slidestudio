import assert from "node:assert/strict";
import test from "node:test";
import { SlideToolArgsError } from "./contract.js";
import { createSlideTools } from "./suite.js";
import { expandComponentElements } from "./template-components.js";
import { contextFor, makeProject, recordingPresentation, runtimeDeps, textPage } from "./testkit.js";
import { applyTraceTruthGuard, guardAssistantMessageTruth, TRUTH_GUARD_MARKER } from "./trace-truth-guard.js";
import { initialDeckMessage } from "./turn-message.js";

const element = { elementId: "title", elementType: "text", bounds: [80, 60, 800, 80], content: { text: "标题" } };

test("template component expansion passes plain elements through untouched", () => {
  const root = makeProject([]);
  const result = expandComponentElements({ projectRoot: root, contextEpochId: "e", elements: [element], kind: "page" });
  assert.deepEqual(result, { ok: true, elements: [element], uses: [] });
});

test("template component references fail closed with Chinese reasons", () => {
  const root = makeProject([]);
  const missingRef = expandComponentElements({
    projectRoot: root,
    contextEpochId: "e",
    elements: [{ elementType: "component", bounds: [0, 0, 100, 100] }],
    kind: "page",
  });
  assert.equal(missingRef.ok, false);
  assert.ok(!missingRef.ok);
  assert.match(missingRef.detail, /缺少 ref/);
  const badBounds = expandComponentElements({
    projectRoot: root,
    contextEpochId: "e",
    elements: [{ elementType: "component", ref: "material:kit#smartart.1", bounds: [0, 0, -1] }],
    kind: "layout",
  });
  assert.ok(!badBounds.ok);
  assert.match(badBounds.detail, /bounds/);
  const unknown = expandComponentElements({
    projectRoot: root,
    contextEpochId: "e",
    elements: [{ elementType: "component", ref: "material:kit#smartart.1", bounds: [0, 0, 100, 100] }],
    kind: "page",
  });
  assert.equal(unknown.ok, false, "an unread or unknown template kit is refused");
});

test("only write_page and write_layout accept component (and smartart) references", async () => {
  const root = makeProject([{ file: "1_cover.page", page: textPage("1_cover", [element] as never) }]);
  const { presentation, calls } = recordingPresentation();
  const suite = new Map(createSlideTools(runtimeDeps(presentation)).map((tool) => [tool.name, tool]));
  await assert.rejects(
    suite
      .get("update_deck")!
      .execute(
        { theme: { decorations: [{ elementType: "component", ref: "material:kit#smartart.1" }] } },
        contextFor(root),
      ),
    (error: unknown) => error instanceof SlideToolArgsError && /update_deck 不接受模板组件引用/.test(error.message),
  );
  assert.deepEqual(calls, []);
  const writePage = suite.get("write_page")!;
  assert.doesNotThrow(() =>
    writePage.validate!({ id: "1_cover", elements: [{ elementType: "component", ref: "material:kit#smartart.1" }] }),
  );
  const outcome = await writePage.execute(
    {
      id: "1_cover",
      elements: [{ elementType: "component", ref: "material:kit#smartart.1", bounds: [0, 0, 100, 100] }],
    },
    contextFor(root, { kind: "hub-run", id: "hub-run:s" }),
  );
  assert.equal(outcome.data.outcome, "rejected", "the Host refuses a component whose kit was never read");
  assert.equal(outcome.data.painted, false);
  assert.deepEqual(calls, []);
});

test("trace-truth-guard annotates unmet completion claims against the disk ledger", () => {
  const root = makeProject([]);
  const claim = "已完成封版，PPTX 已导出。";
  const guarded = guardAssistantMessageTruth(root, claim);
  assert.ok(guarded.startsWith(claim));
  assert.ok(guarded.includes(TRUTH_GUARD_MARKER));
  assert.match(guarded, /compose_deck/);
  assert.match(guarded, /export_deck/);
  assert.equal(guardAssistantMessageTruth(root, "如果审查通过，就封版。"), "如果审查通过，就封版。");
  assert.equal(guardAssistantMessageTruth(root, "我先写第二页。"), "我先写第二页。");
  const rows = applyTraceTruthGuard(root, [
    { kind: "message", status: "complete", detail: claim, id: "m1" },
    { kind: "message", status: "streaming", detail: claim, id: "m2" },
    { kind: "tool", status: "complete", detail: claim, id: "t1" },
  ]);
  assert.ok(rows[0]!.detail!.includes(TRUTH_GUARD_MARKER));
  assert.equal(rows[0]!.id, "m1", "host row fields are preserved");
  assert.equal(rows[1]!.detail, claim);
  assert.equal(rows[2]!.detail, claim);
});

test("the initial deck message is host-neutral and states the canvas", () => {
  const text = initialDeckMessage(
    { brief: "做一份 8 页的季度经营复盘" },
    { kind: "Slides", layout: "16:9", size: [960, 540] },
    [],
    { modelInputModalities: ["text"] },
  );
  assert.match(text, /Document format: Slides 16:9, 960 x 540 pixels/);
  const discussed = initialDeckMessage(
    { brief: "先聊聊结构", conversationMode: "discuss" },
    { kind: "Slides", layout: "4:3", size: [720, 540] },
    [],
    { modelInputModalities: ["text"] },
    (brief) => `DISCUSS:${brief}`,
  );
  assert.match(discussed, /^DISCUSS:先聊聊结构/);
});
