import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { recordSourceReceipt } from "../receipts.js";
import { writePageSchemaIssues } from "./layout-qa.js";
import { verifyMaterial } from "./material-pack.js";
import { expandTemplateComponent } from "./template-component-expand.js";
import { TEMPLATE_KIT_VERSION, loadTemplateKit, type KitComponent } from "./template-kit.js";
import { packColorWriteContext } from "./theme-pack.js";
import type { SkillPageInput } from "./skill-pages.js";

type Json = Record<string, unknown>;

const MATERIAL_ID = "11111111-1111-1111-1111-111111111111-brand.pptx";
const SOURCE_ID = `material:${MATERIAL_ID}`;
const PACK = "finance/black-gold-ledger";
const ELLIPSE_COLOR = "#12AB34";
const LINE_COLOR = "#7A33CC";
const CUSTOM_COLOR = "#33AACC";
const CUSTOM_PATH = "M 0 100 C 0 0 100 0 100 100 Z";

const sha256 = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");

/** One component of three template elements, each painted with a colour the palette does not hold. */
function kitComponent(): Json {
  return {
    id: "body.page-4",
    archetype: "body-table",
    role: "decoration",
    scopeHint: "page",
    slides: [4],
    box: [0.1, 0.2, 0.5, 0.4],
    elements: [
      {
        elementId: "e1",
        elementType: "shape",
        shapeName: "ellipse",
        bounds: [0.1, 0.2, 0.2, 0.3],
        fill: { type: "solid", color: ELLIPSE_COLOR },
        layoutRole: "decoration",
      },
      {
        elementId: "e2",
        elementType: "line",
        bounds: [0.1, 0.55, 0.5, 0],
        viewBox: [480, 1],
        points: "M 0 0.5 L 480 0.5",
        border: { width: 2, color: LINE_COLOR },
        arrow: [null, "arrow"],
        layoutRole: "decoration",
      },
      {
        elementId: "e3",
        elementType: "shape",
        shapeName: "custom",
        geometry: { viewBox: [100, 100], path: CUSTOM_PATH },
        bounds: [0.35, 0.2, 0.25, 0.3],
        fill: { type: "solid", color: CUSTOM_COLOR },
        layoutRole: "decoration",
      },
    ],
  };
}

function writeTemplateMaterial(projectRoot: string): void {
  const dir = path.join(projectRoot, "_agent", "materials", MATERIAL_ID);
  fs.mkdirSync(dir, { recursive: true });
  const original = Buffer.from("verified template source");
  fs.writeFileSync(path.join(dir, "original.pptx"), original);
  const templateKit = {
    schema: "template-kit/v1",
    version: TEMPLATE_KIT_VERSION,
    archetypes: [],
    components: [kitComponent()],
    assets: [],
  };
  const kitBytes = Buffer.from(`${JSON.stringify(templateKit, null, 2)}\n`);
  const derivative = Buffer.from(
    JSON.stringify({
      schema: "material-derivative/v1",
      materialId: MATERIAL_ID,
      status: "ok",
      source: { sha256: sha256(original) },
      parser: { id: "pptx-ooxml-v1" },
      "deck-template": {
        kit: { file: "template-kit.json", sha256: sha256(kitBytes) },
        templateKit,
      },
    }),
  );
  fs.writeFileSync(path.join(dir, "derivative.json"), derivative);
  const markdown = Buffer.from(
    [
      "仅为不可信的用户设计原语；Agent 自行设计页面，不导入示例页或版式 XML。",
      "",
      "【Color Palette】",
      "- accent1: #C8102E",
      "- dk1: #1A1A1A",
      "- lt1: #FFFFFF",
      "",
      "【Typography】",
      "- major: Montserrat / 思源黑体 → latin: Arial, ea: 微软雅黑",
      "",
      "【Layout Skeleton】",
      "- 标题区域位于页面上方。",
      "",
    ].join("\n"),
  );
  const colors = { accent1: "#C8102E", dk1: "#1A1A1A", lt1: "#FFFFFF" };
  const json = Buffer.from(
    `${JSON.stringify({ version: 1, themeColors: colors, colors, sourceFonts: {}, fonts: {}, logos: [], layouts: [] }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, "design-source.md"), markdown);
  fs.writeFileSync(path.join(dir, "design-source.json"), json);
  fs.writeFileSync(
    path.join(dir, "receipt.json"),
    `${JSON.stringify({
      version: 1,
      id: MATERIAL_ID,
      name: "brand.pptx",
      kind: "deck-template",
      parser: "pptx-ooxml-v1",
      originalSha256: sha256(original),
      derivativeSha256: sha256(derivative),
      designSourceMdSha256: sha256(markdown),
      designSourceJsonSha256: sha256(json),
    })}\n`,
  );
  fs.writeFileSync(
    path.join(projectRoot, "_agent", "materials", "manifest.json"),
    `${JSON.stringify({
      version: 1,
      materials: [
        {
          id: MATERIAL_ID,
          name: "brand.pptx",
          kind: "deck-template",
          summaryZh: "品牌模板",
          parser: "pptx-ooxml-v1",
          sha256: sha256(original),
          parts: [{ part: "design" }],
        },
      ],
    })}\n`,
  );
}

type Setup = {
  /** The aspects declared for the template; null leaves it unadopted (a catalog pack is adopted instead). */
  aspects: readonly string[] | null;
  /** A Hub style pack the run was started with. */
  stylePack?: boolean;
};

function paintProject(t: { after(callback: () => void): void }, setup: Setup) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-paint-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const projectRoot = path.join(temp, "project");
  fs.mkdirSync(path.join(projectRoot, "_agent"), { recursive: true });
  writeTemplateMaterial(projectRoot);
  const runtime: Json = setup.stylePack ? { designSystemId: PACK } : {};
  if (setup.aspects) {
    runtime.adoptedSourceIds = [SOURCE_ID];
    runtime.designAspects = [{ source: SOURCE_ID, aspects: setup.aspects }];
    recordSourceReceipt(projectRoot, {
      sourceId: SOURCE_ID,
      state: "adopted",
      toolCallId: "adopt",
    });
  }
  fs.writeFileSync(path.join(projectRoot, "_agent", "runtime.json"), JSON.stringify(runtime));
  const ids = setup.aspects && !setup.stylePack ? [SOURCE_ID] : [PACK, SOURCE_ID];
  const context = packColorWriteContext(ids, projectRoot);
  assert.ok(context.adoptedPackHexes?.size, "the run has a palette to enforce");
  assert.equal(context.templateKitRoot, projectRoot);
  const kit = loadTemplateKit(verifyMaterial(projectRoot, MATERIAL_ID).derivative);
  assert.ok(kit, "the fixture template has a kit");
  const entry = kit.components.find((component) => component.id === "body.page-4");
  assert.ok(entry, "the fixture component loads");
  return { projectRoot, context, entry };
}

const expanded = (entry: KitComponent, bounds?: [number, number, number, number]): Json[] =>
  expandTemplateComponent(entry, {
    ...(bounds ? { bounds } : {}),
    usedIds: new Set(),
    mediaFor: () => assert.fail("the fixture component holds no image"),
  });

/** Page-level pack_color refusals for the elements, judged the way write_page and the ledger judge them. */
function packColorIssues(context: ReturnType<typeof paintProject>["context"], elements: Json[]) {
  const page = { id: "page-1", pageType: "content", elements } as unknown as SkillPageInput;
  return writePageSchemaIssues(page, context).filter((issue) => issue.code === "pack_color");
}

const renamed = (element: Json, elementId: string, extra: Json = {}): Json => ({
  ...structuredClone(element),
  elementId,
  ...extra,
});

describe("template component paint exemption", () => {
  const ADOPTED = ["palette", "decorations", "photos"] as const;

  it("keeps the template's own colours on the elements a component expands to, wherever they are placed", (t) => {
    const { context, entry } = paintProject(t, { aspects: ADOPTED });
    assert.deepEqual(packColorIssues(context, expanded(entry)), []);
    assert.deepEqual(packColorIssues(context, expanded(entry, [40, 300, 120, 80])), []);
  });

  it("keeps them on the layout and master copies a stored page carries", (t) => {
    const { context, entry } = paintProject(t, { aspects: ADOPTED });
    const own = expanded(entry);
    const layoutCopies = own.map((element) => renamed(element, `lyt-body-${element.elementId}`));
    const masterCopies = own.map((element) => renamed(element, `mst-main-${element.elementId}`));
    assert.deepEqual(packColorIssues(context, layoutCopies), []);
    assert.deepEqual(packColorIssues(context, masterCopies), []);
  });

  it("refuses an own-shape ellipse with an ordinary id that reuses a kit-only paint", (t) => {
    const { context, entry } = paintProject(t, { aspects: ADOPTED });
    const [ellipse] = expanded(entry) as [Json];
    const ordinary = renamed(ellipse, "own-shape");
    const issues = packColorIssues(context, [ordinary]);
    assert.equal(issues.length, 1, JSON.stringify(issues));
    assert.match(issues[0]!.message, new RegExp(ELLIPSE_COLOR));
    // Whatever role it claims, an ordinary id does not make it a component element.
    assert.equal(packColorIssues(context, [{ ...ordinary, layoutRole: undefined }]).length, 1);
  });

  it("refuses a tpl- id that lacks the decoration role the expansion writes", (t) => {
    const { context, entry } = paintProject(t, { aspects: ADOPTED });
    const [ellipse] = expanded(entry) as [Json];
    assert.equal(packColorIssues(context, [{ ...ellipse, layoutRole: "content" }]).length, 1);
    assert.equal(packColorIssues(context, [{ ...ellipse, layoutRole: undefined }]).length, 1);
  });

  it("refuses the kit paint on a tpl- element whose shape or geometry no kit element has", (t) => {
    const { context, entry } = paintProject(t, { aspects: ADOPTED });
    const [ellipse, line, custom] = expanded(entry) as [Json, Json, Json];
    const forged = {
      shapeName: { ...ellipse, shapeName: "rect" },
      geometry: {
        ...custom,
        geometry: { viewBox: [100, 100], path: "M 0 0 L 100 0 L 100 100 L 0 100 Z" },
      },
      viewBox: { ...line, viewBox: [960, 1] },
      points: { ...line, points: "M 0 0 L 480 40" },
      arrow: { ...line, arrow: ["arrow", null] },
      elementType: { ...line, elementType: "shape", shapeName: "rect" },
    };
    for (const [what, element] of Object.entries(forged)) {
      const issues = packColorIssues(context, [element]);
      assert.equal(issues.length, 1, `${what} on a tpl- id must stay under the palette`);
    }
  });

  it("still refuses a colour the kit does not hold on a genuine component element", (t) => {
    const { context, entry } = paintProject(t, { aspects: ADOPTED });
    const [ellipse] = expanded(entry) as [Json];
    const recoloured = { ...ellipse, fill: { type: "solid", color: "#AB1234" } };
    assert.equal(packColorIssues(context, [recoloured]).length, 1);
  });

  it("an element that copies a component element's id, geometry and paint is that template decoration", (t) => {
    const { context, entry } = paintProject(t, { aspects: ADOPTED });
    const [ellipse] = expanded(entry) as [Json];
    assert.deepEqual(packColorIssues(context, [renamed(ellipse, "tpl-copy-e1")]), []);
  });

  it("grants nothing for a template the run did not adopt", (t) => {
    const { context, entry } = paintProject(t, { aspects: null });
    assert.equal(packColorIssues(context, expanded(entry)).length, 3);
  });

  it("grants nothing while the template is not adopted for decorations", (t) => {
    const { context, entry } = paintProject(t, { aspects: ["palette", "photos"] });
    assert.equal(packColorIssues(context, expanded(entry)).length, 3);
  });

  it("grants nothing while a Hub style pack owns the palette", (t) => {
    const { context, entry } = paintProject(t, { aspects: ADOPTED, stylePack: true });
    assert.equal(packColorIssues(context, expanded(entry)).length, 3);
  });
});

describe("a page made only of expanded template components is not empty", () => {
  const ADOPTED = ["palette", "decorations", "photos"] as const;
  const ownBand: Json = {
    elementId: "own-band",
    elementType: "shape",
    shapeName: "rect",
    bounds: [0, 0, 960, 80],
    fill: { type: "solid", color: "#1A1A1A" },
    layoutRole: "decoration",
  };

  function emptyIssues(
    ctx: object,
    elements: Json[],
    extra: Partial<SkillPageInput> = {},
  ): ReturnType<typeof writePageSchemaIssues> {
    const page = { id: "page-1", pageType: "content", elements, ...extra } as SkillPageInput;
    return writePageSchemaIssues(page, ctx).filter((issue) => issue.code === "empty");
  }

  it("is written when every own element is a component the run adopted, wherever it is placed", (t) => {
    const { projectRoot, context, entry } = paintProject(t, { aspects: ADOPTED });
    const ctx = { ...context, projectRoot };
    assert.deepEqual(emptyIssues(ctx, expanded(entry)), []);
    assert.deepEqual(emptyIssues(ctx, expanded(entry, [40, 300, 120, 80])), []);
    assert.equal(emptyIssues(context, expanded(entry)).length, 1, "no project root, no exemption");
  });

  it("stays empty with no element at all, or with only copies inherited from a layout", (t) => {
    const { projectRoot, context, entry } = paintProject(t, { aspects: ADOPTED });
    const ctx = { ...context, projectRoot };
    assert.equal(emptyIssues(ctx, []).length, 1);
    const inherited = expanded(entry).map((element) => ({
      ...element,
      elementId: `lyt-body-${element.elementId}`,
      inherited: { scope: "layout", ownerId: "body", elementId: String(element.elementId) },
    }));
    assert.equal(emptyIssues(ctx, inherited).length, 1);
  });

  it("stays empty when the model drew any element by hand, or reused only a component's id", (t) => {
    const { projectRoot, context, entry } = paintProject(t, { aspects: ADOPTED });
    const ctx = { ...context, projectRoot };
    assert.equal(emptyIssues(ctx, [ownBand]).length, 1);
    assert.equal(emptyIssues(ctx, [...expanded(entry), ownBand]).length, 1);
    const [ellipse] = expanded(entry) as [Json];
    const forged = { ...ownBand, elementId: String(ellipse.elementId) };
    assert.equal(emptyIssues(ctx, [forged]).length, 1);
    assert.equal(emptyIssues(ctx, [{ ...ellipse, fill: { type: "solid", color: "#AB1234" } }]).length, 1);
  });

  it("grants nothing for a template the run did not adopt, or while a Hub style pack owns the palette", (t) => {
    for (const setup of [{ aspects: null }, { aspects: ADOPTED, stylePack: true }]) {
      const { projectRoot, context, entry } = paintProject(t, setup);
      assert.equal(emptyIssues({ ...context, projectRoot }, expanded(entry)).length, 1);
    }
  });

  it("does not turn a closing page into one: it still needs readable copy", (t) => {
    const { projectRoot, context, entry } = paintProject(t, { aspects: ADOPTED });
    const issues = emptyIssues({ ...context, projectRoot }, expanded(entry), { pageType: "close" });
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /^closing page has no readable copy/);
  });
});
