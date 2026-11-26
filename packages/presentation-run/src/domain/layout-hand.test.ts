import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { createEmptyProject, loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import type { ToolExecution } from "./agent-tools.js";
import { ensureRunLedger, readRunLedger } from "./run-ledger.js";
import { savedLayoutSha256 } from "./layout-saved.js";
import { packColorSourceIds, projectPackColorContext, runtimeDesignSystemId } from "./pack-color-context.js";
import { catalogPackPaletteHexes, packColorWriteContext } from "./theme-pack.js";

const context = { commandId: "layout-fixture", contextEpochId: "layout-epoch" };
const PINE_GREEN = "consulting/pine-green-strategy";

/** Tool payloads are JSON receipts; each test reads the named fields it asserts. */
type Receipt = Omit<ToolExecution, "payload"> & { payload: Record<string, unknown> };

async function call(root: string, name: string, args: Record<string, unknown>): Promise<Receipt> {
  const result = await runDomainHand(name, { ...args, __openSlideStudio: context }, root);
  return { ...result, payload: result.payload as Record<string, unknown> };
}

function fixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "layout-hand-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "版式" });
  writeDomainRuntime(root, { brief: "制作 4 页带统一版式的汇报。" });
  persistPresentationRunProvider(root, {
    providerId: "offline",
    modelId: "fixture",
    ready: true,
    modelInputModalities: ["text"],
  });
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
  });
  return root;
}

const copy = (elementId: string, x: number, y: number, text: string) => ({
  elementId,
  elementType: "text",
  bounds: [x, y, 600, 40],
  content: { text, fontSize: 20 },
});
const logo = (x: number, y: number) => ({
  elementId: "logo",
  elementType: "image",
  bounds: [x, y, 80, 40],
  src: "media/logo-a.png",
});
const master = {
  scope: "master",
  id: "main",
  name: "母版",
  elements: [copy("footer", 80, 500, "页脚")],
};
const bodyLayout = (...elements: unknown[]) => ({
  scope: "layout",
  id: "body",
  name: "正文",
  masterId: "main",
  elements,
});

function savePages(root: string, pages: Array<{ path: string; page: Record<string, unknown> }>) {
  const project = loadProject(root);
  project.pages.push(...(pages as typeof project.pages));
  project.presentation.pages = project.pages.map((entry) => entry.path);
  saveProject(project);
}

it("write_layout defines a master and a layout; an identical repeat is skipped-identical", async (t) => {
  const root = fixture(t);
  const first = await call(root, "write_layout", master);
  assert.equal(first.ok, true, first.detail);
  assert.equal(first.payload.outcome, "written");
  assert.equal(first.payload.revision, 1);
  const layoutArgs = bodyLayout(logo(860, 20), copy("header", 80, 20, "标题栏"));
  const layout = await call(root, "write_layout", layoutArgs);
  assert.equal(layout.ok, true, layout.detail);
  assert.equal(layout.payload.outcome, "written");
  assert.equal(layout.payload.layoutId, "body");
  assert.equal(layout.payload.pagesUsing, 0);
  assert.equal(layout.payload.pagesNeedingRender, 0);
  assert.match(String(layout.payload.layoutSha256), /^[0-9a-f]{64}$/);
  const saved = loadProject(root).presentation;
  assert.equal(saved.masters?.[0]?.id, "main");
  assert.equal(saved.layouts?.[0]?.masterId, "main");
  const again = await call(root, "write_layout", layoutArgs);
  assert.equal(again.ok, true, again.detail);
  assert.equal(again.payload.outcome, "skipped-identical");
  assert.equal(again.payload.revision, 1);
  const facts = readRunLedger(root)!.facts as unknown as Array<Record<string, unknown>>;
  const committed = facts.filter((fact) => fact.type === "layout.revision-committed");
  assert.deepEqual(
    committed.map((fact) => [fact.layoutId, fact.revision, fact.source]),
    [
      ["main", 1, "agent"],
      ["body", 1, "agent"],
    ],
  );
});

it("write_layout refuses invalid layouts in Chinese and leaves the deck unchanged", async (t) => {
  const root = fixture(t);
  assert.equal((await call(root, "write_layout", master)).ok, true);
  const chart = await call(
    root,
    "write_layout",
    bodyLayout({
      elementId: "chart1",
      elementType: "chart",
      bounds: [80, 120, 400, 300],
      chart: {},
    }),
  );
  assert.equal(chart.ok, false);
  assert.equal(chart.payload.outcome, "rejected");
  assert.equal(chart.payload.error, "layout_element_type");
  assert.match(String(chart.payload.detail), /版式里不能放图表、表格或 SmartArt/);
  const missingMaster = await call(root, "write_layout", {
    scope: "layout",
    id: "cover",
    name: "封面",
    masterId: "nope",
    elements: [],
  });
  assert.equal(missingMaster.payload.error, "layout_master_missing");
  const secondMaster = await call(root, "write_layout", {
    scope: "master",
    id: "other",
    name: "备用",
    elements: [],
  });
  assert.equal(secondMaster.payload.error, "layout_master_singleton");
  for (let index = 1; index <= 12; index += 1) {
    const id = `l${String(index).padStart(2, "0")}`;
    const written = await call(root, "write_layout", {
      scope: "layout",
      id,
      name: `版式${index}`,
      elements: [],
    });
    assert.equal(written.payload.outcome, "written", String(written.detail));
  }
  const thirteenth = await call(root, "write_layout", {
    scope: "layout",
    id: "l13",
    name: "第十三",
    elements: [],
  });
  assert.equal(thirteenth.payload.error, "layout_limit");
  const saved = loadProject(root).presentation;
  assert.equal(saved.layouts?.length, 12);
  assert.equal(saved.masters?.length, 1);
  assert.equal(
    saved.layouts?.some((layout) => layout.id === "body"),
    false,
  );
});

it("pages on a layout are counted, and the ones whose chrome changed need a render", async (t) => {
  const root = fixture(t);
  assert.equal((await call(root, "write_layout", master)).ok, true);
  assert.equal((await call(root, "write_layout", bodyLayout(logo(860, 20)))).ok, true);
  savePages(root, [
    {
      path: "pages/body-1.page",
      page: { pageType: "content", layoutId: "body", elements: [copy("t1", 80, 80, "第一页")] },
    },
    {
      path: "pages/body-2.page",
      page: { pageType: "content", layoutId: "body", elements: [copy("t2", 80, 80, "第二页")] },
    },
    {
      path: "pages/plain-3.page",
      page: { pageType: "content", elements: [copy("t3", 80, 80, "无版式")] },
    },
  ]);
  const moved = await call(root, "write_layout", bodyLayout(logo(840, 20)));
  assert.equal(moved.ok, true, moved.detail);
  assert.equal(moved.payload.outcome, "written");
  assert.equal(moved.payload.revision, 2);
  assert.equal(moved.payload.pagesUsing, 2);
  assert.equal(moved.payload.pagesNeedingRender, 2);
  const repeat = await call(root, "write_layout", bodyLayout(logo(840, 20)));
  assert.equal(repeat.payload.outcome, "skipped-identical");
});

it("a layout that a version restore returned to an older definition is written again, not skipped as identical", async (t) => {
  const root = fixture(t);
  assert.equal((await call(root, "write_layout", master)).ok, true);
  assert.equal((await call(root, "write_layout", bodyLayout(logo(860, 20)))).ok, true);
  const older = loadProject(root).presentation.layouts;
  const moved = await call(root, "write_layout", bodyLayout(logo(840, 20)));
  assert.equal(moved.payload.outcome, "written");
  // A version restore rewinds the deck files and leaves the run ledger, which still names the moved layout.
  const rewound = loadProject(root);
  rewound.presentation.layouts = older;
  saveProject(rewound);
  assert.equal(loadProject(root).presentation.layouts?.[0]?.elements[0]?.bounds[0], 860);
  const again = await call(root, "write_layout", bodyLayout(logo(840, 20)));
  assert.equal(again.ok, true, again.detail);
  assert.equal(again.payload.outcome, "written");
  assert.equal(loadProject(root).presentation.layouts?.[0]?.elements[0]?.bounds[0], 840);
  const repeat = await call(root, "write_layout", bodyLayout(logo(840, 20)));
  assert.equal(repeat.payload.outcome, "skipped-identical");
});

it("after a version restore, write_layout's expected hash is the saved layout's, not the newer one the ledger names", async (t) => {
  const root = fixture(t);
  assert.equal((await call(root, "write_layout", master)).ok, true);
  const first = await call(root, "write_layout", bodyLayout(logo(860, 20)));
  const older = loadProject(root).presentation.layouts;
  const moved = await call(root, "write_layout", bodyLayout(logo(840, 20)));
  assert.equal(moved.payload.revision, 2);
  // A version restore rewinds the deck files and leaves the run ledger, which still names revision 2.
  const rewound = loadProject(root);
  rewound.presentation.layouts = older;
  saveProject(rewound);

  const stale = await call(root, "write_layout", {
    ...bodyLayout(logo(800, 20)),
    expectedLayoutSha256: moved.payload.layoutSha256,
  });
  assert.equal(stale.ok, false, "the ledger's hash names a layout the deck no longer holds");
  assert.equal(stale.payload.error, "layout_stale");
  assert.equal(loadProject(root).presentation.layouts?.[0]?.elements[0]?.bounds[0], 860);

  const fresh = await call(root, "write_layout", {
    ...bodyLayout(logo(800, 20)),
    expectedLayoutSha256: first.payload.layoutSha256,
  });
  assert.equal(fresh.ok, true, fresh.detail);
  assert.equal(fresh.payload.outcome, "written");
  assert.equal(loadProject(root).presentation.layouts?.[0]?.elements[0]?.bounds[0], 800);
});

it("savedLayoutSha256 is the hash a write reports for the saved layout, and empty for a layout the deck lacks", async (t) => {
  const root = fixture(t);
  assert.equal(savedLayoutSha256(root, "layout", "body"), "");
  const first = await call(root, "write_layout", master);
  assert.equal(savedLayoutSha256(root, "master", "main"), first.payload.layoutSha256);
  const rich = await call(root, "write_layout", {
    ...bodyLayout(logo(860, 20), copy("header", 80, 20, "标题栏")),
    showMasterElements: false,
    background: { type: "solid", color: "#FFFFFF" },
  });
  assert.equal(rich.ok, true, rich.detail);
  assert.equal(savedLayoutSha256(root, "layout", "body"), rich.payload.layoutSha256);
  // The saved hash is what a later write is told to echo back, so it matches a repeat of the same layout.
  const repeat = await call(root, "write_layout", {
    ...bodyLayout(logo(860, 20), copy("header", 80, 20, "标题栏")),
    showMasterElements: false,
    background: { type: "solid", color: "#FFFFFF" },
    expectedLayoutSha256: savedLayoutSha256(root, "layout", "body"),
  });
  assert.equal(repeat.payload.outcome, "skipped-identical");
  assert.equal(savedLayoutSha256(root, "layout", "missing"), "");
});

it("layout-level QA reports an element outside the 960 by 540 canvas once and still writes", async (t) => {
  const root = fixture(t);
  assert.equal((await call(root, "write_layout", master)).ok, true);
  const result = await call(root, "write_layout", bodyLayout(logo(940, 20)));
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.payload.outcome, "written");
  const issues = result.payload.layoutIssues as Array<{ code: string; elementId?: string }>;
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.elementId]),
    [["out_of_bounds", "logo"]],
  );
});

it("layout-level QA leaves the bleed of an expanded template decoration alone and still reports a hand-drawn overhang", async (t) => {
  const root = fixture(t);
  assert.equal((await call(root, "write_layout", master)).ok, true);
  const bleed = (elementId: string) => ({
    ...logo(2, -10.6),
    elementId,
    bounds: [2, -10.6, 62, 62.3],
    layoutRole: "decoration",
  });
  const result = await call(root, "write_layout", bodyLayout(bleed("tpl-body-header-e2"), bleed("body-logo-corner")));
  assert.equal(result.ok, true, result.detail);
  const issues = result.payload.layoutIssues as Array<{ code: string; elementId?: string }>;
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.elementId]),
    [["out_of_bounds", "body-logo-corner"]],
  );
});

const titleWithColor = (color: string) => ({
  ...copy("header", 80, 20, "标题栏"),
  content: { text: "标题栏", fontSize: 20, color },
});

it("write_layout refuses an off-palette colour once for the layout, and accepts a palette colour", async (t) => {
  const root = fixture(t);
  writeDomainRuntime(root, { brief: "制作 4 页带统一版式的汇报。", designSystemId: PINE_GREEN });
  assert.equal((await call(root, "write_layout", master)).ok, true);
  const refused = await call(root, "write_layout", bodyLayout(titleWithColor("#FF00FF")));
  assert.equal(refused.ok, false);
  assert.equal(refused.payload.outcome, "rejected");
  assert.equal(refused.payload.error, "pack_color");
  assert.match(String(refused.payload.detail), /版式「body」里有颜色不在已采用的配色中，本次未保存/);
  assert.equal(
    (loadProject(root).presentation.layouts ?? []).some((layout) => layout.id === "body"),
    false,
  );
  const [paletteHex] = [...(catalogPackPaletteHexes().get(PINE_GREEN) ?? [])];
  assert.ok(paletteHex, "the pine-green pack declares a palette");
  const accepted = await call(root, "write_layout", bodyLayout(titleWithColor(paletteHex!)));
  assert.equal(accepted.ok, true, accepted.detail);
  assert.equal(accepted.payload.outcome, "written");
});

it("the layout pack-colour context is the one the run ledger builds from the same sources", (t) => {
  const root = fixture(t);
  writeDomainRuntime(root, { brief: "制作 4 页带统一版式的汇报。", designSystemId: PINE_GREEN });
  const fromLayout = projectPackColorContext(root);
  const fromLedger = packColorWriteContext(packColorSourceIds(root, runtimeDesignSystemId(root)), root);
  assert.equal(fromLayout.adoptedPackId, PINE_GREEN);
  assert.deepEqual([...(fromLayout.adoptedPackHexes ?? [])].sort(), [...(fromLedger.adoptedPackHexes ?? [])].sort());
  assert.ok((fromLayout.adoptedPackHexes?.size ?? 0) > 0);
});
