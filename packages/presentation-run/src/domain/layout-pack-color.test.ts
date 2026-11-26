import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { createEmptyProject, loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { packColorSchemaContext, type ToolExecution } from "./agent-tools.js";
import { writePageColorIssues } from "./layout-qa.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { imageFixture, tempProject, writeMaterialFixture } from "./material-testkit.js";
import { packColorSourceIds, projectPackColorContext, runtimeDesignSystemId } from "./pack-color-context.js";
import { recordSourceReceipt } from "../receipts.js";
import { ensureRunLedger, inspectRunLedger } from "./run-ledger.js";
import { packColorWriteContext, type PackColorWriteContext } from "./theme-pack.js";

/**
 * VAL-TPL-012: write_page, write_layout, the agent write checks and the run ledger take their
 * pack_color context from the project root. One material adoption must give the same allowed
 * palette from each of them, and a tampered receipt must grant nothing to any of them.
 */
const context = { commandId: "layout-pack-fixture", contextEpochId: "layout-pack-epoch" };
const ADOPTED = "#C00000";
const OFF_PALETTE = "#3366FF";

const IMAGE_PROFILE = {
  schema: "style-profile/v1",
  source: "image-pixels",
  accentColors: [
    { hex: "#C00000", share: 0.3 },
    { hex: "#7A1F1F", share: 0.08 },
  ],
  neutralColors: [{ hex: "#FFFFFF" }, { hex: "#F2F2F2" }],
  background: "#FFFFFF",
  contrastPairs: [{ fg: "#C00000", bg: "#FFFFFF", ratio: 6.5 }],
};

/** A deck whose palette is adopted from a brand image: the one material source under test. */
function brandDeck(t: TestContext): string {
  const root = tempProject("layout-pack-color-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = imageFixture("img-brand", "brand-redwhite.png", 1200, 800);
  writeMaterialFixture(root, {
    ...base,
    derivative: {
      image: {
        ...(base.derivative!.image as Record<string, unknown>),
        format: "png",
        styleProfile: IMAGE_PROFILE,
      },
    },
  });
  createEmptyProject(root, { title: "版式配色" });
  writeDomainRuntime(root, {
    brief: "制作 4 页带统一版式的汇报。",
    designAspects: [{ source: "material:img-brand", aspects: ["palette"] }],
  });
  recordSourceReceipt(root, {
    sourceId: "material:img-brand",
    state: "adopted",
    toolCallId: "fixture",
  });
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

type Receipt = Omit<ToolExecution, "payload"> & { payload: Record<string, unknown> };

async function call(root: string, name: string, args: Record<string, unknown>): Promise<Receipt> {
  const result = await runDomainHand(name, { ...args, __openSlideStudio: context }, root);
  return { ...result, payload: result.payload as Record<string, unknown> };
}

/** One layout whose only element fills with `fill`, so the colour check is the only input. */
const bandLayout = (fill: string) => ({
  scope: "layout",
  id: "body",
  name: "正文",
  elements: [{ elementId: "band", elementType: "shape", bounds: [0, 0, 960, 40], content: { fill } }],
});

/** A page whose only colour is `fill`; two text elements keep the closing-page check quiet. */
const pageWith = (fill: string) => ({
  pageType: "content",
  elements: [
    {
      elementId: "title",
      elementType: "text",
      bounds: [80, 80, 600, 60],
      content: { text: "标题", fontSize: 32 },
    },
    {
      elementId: "point",
      elementType: "text",
      bounds: [80, 160, 600, 40],
      content: { text: "要点一", fontSize: 20 },
    },
    { elementId: "band", elementType: "shape", bounds: [80, 300, 400, 120], content: { fill } },
  ],
});

/** The four callers' contexts for one project, by name. */
function fourCallers(root: string): Array<[string, PackColorWriteContext]> {
  return [
    ["write_page and write_layout", projectPackColorContext(root)],
    ["agent write checks", packColorSchemaContext({ projectRoot: root, playbook: { designSystemId: "" } } as never)],
    ["run ledger", packColorWriteContext(packColorSourceIds(root, runtimeDesignSystemId(root)), root)],
  ];
}

const paletteOf = (ctx: PackColorWriteContext) => [...(ctx.adoptedPackHexes ?? [])].sort();

it("the four pack_color callers grant one palette for one material adoption", (t) => {
  const root = brandDeck(t);
  const callers = fourCallers(root);
  const reference = callers[0]![1];
  const expected = paletteOf(reference);
  assert.ok(expected.includes(ADOPTED), "the adopted accent is in the allowed palette");
  assert.equal(expected.includes(OFF_PALETTE), false);
  assert.deepEqual(reference.adoptedDesignSourceIds, ["material:img-brand"]);
  assert.equal(reference.materialError, undefined);
  for (const [name, ctx] of callers.slice(1)) {
    assert.deepEqual(paletteOf(ctx), expected, name);
    assert.deepEqual(ctx.adoptedDesignSourceIds, ["material:img-brand"], name);
    assert.equal(ctx.materialError, undefined, name);
  }
});

it("write_layout refuses an off-palette colour once, as the write_page check does, and accepts the adopted one", async (t) => {
  const root = brandDeck(t);
  const layout = bandLayout(OFF_PALETTE);
  // write_page's own colour check on the same element; only its tool label differs from write_layout's.
  const pageCheck = writePageColorIssues(
    { id: "body", elements: layout.elements as never },
    undefined,
    projectPackColorContext(root),
  );
  assert.equal(pageCheck.length, 1);
  assert.equal(pageCheck[0]!.code, "pack_color");
  const pageWording = pageCheck[0]!.message.replace("write_page refused", "write_layout refused");
  const refused = await call(root, "write_layout", layout);
  assert.equal(refused.ok, false);
  assert.equal(refused.payload.outcome, "rejected");
  assert.equal(refused.payload.error, "pack_color");
  assert.equal(refused.detail.split(pageWording).length - 1, 1, "reported once, worded as write_page's");
  assert.equal((loadProject(root).presentation.layouts ?? []).length, 0);
  const accepted = await call(root, "write_layout", bandLayout(ADOPTED));
  assert.equal(accepted.ok, true, accepted.detail);
  assert.equal(accepted.payload.outcome, "written");
});

it("the run ledger reports only the page that uses an off-palette colour", (t) => {
  const root = brandDeck(t);
  const project = loadProject(root);
  project.pages.push(
    { path: "pages/on-brand.page", page: pageWith(ADOPTED) as never },
    { path: "pages/off-brand.page", page: pageWith(OFF_PALETTE) as never },
  );
  project.presentation.pages = project.pages.map((entry) => entry.path);
  saveProject(project);
  const blockers = inspectRunLedger(root).composeBlockers;
  const colourBlockers = blockers.filter((line) => /pack_color/.test(line));
  assert.equal(colourBlockers.length, 1, blockers.join("\n"));
  assert.match(colourBlockers[0]!, /off-brand/);
  assert.doesNotMatch(colourBlockers[0]!, /on-brand/);
});

it("a tampered design source grants nothing, and write_layout fails closed in Chinese", async (t) => {
  const root = brandDeck(t);
  const file = path.join(root, "_agent", "materials", "img-brand", "derivative.json");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(ADOPTED, OFF_PALETTE));
  for (const [name, ctx] of fourCallers(root)) {
    assert.match(ctx.materialError ?? "", /已采用的设计源.*解析结果已变化/, name);
    assert.equal(ctx.adoptedPackHexes?.has(ADOPTED) ?? false, false, name);
    assert.equal(ctx.adoptedPackHexes?.has(OFF_PALETTE) ?? false, false, name);
  }
  const refused = await call(root, "write_layout", bandLayout(ADOPTED));
  assert.equal(refused.ok, false);
  assert.equal(refused.payload.error, "pack_color");
  assert.match(refused.detail, /已采用的设计源未通过校验/);
  assert.equal((loadProject(root).presentation.layouts ?? []).length, 0);
});
