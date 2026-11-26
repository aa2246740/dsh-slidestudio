import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import { recordSourceReceipt } from "../receipts.js";
import { materialChunkCount } from "./material-content.js";
import { verifyMaterial } from "./material-pack.js";
import {
  KIND_THEME_PACK_ERROR,
  MISSING_THEME_PACK_ERROR,
  PACK_COLOR_ERROR,
  kindThemePackIssue,
  packColorWriteContext,
  parseThemePackId,
} from "./theme-pack.js";
import { writePageSchemaError, writePageSchemaIssues } from "./layout-qa.js";

import {
  TEMPLATE_ID,
  SOURCE_ID,
  TEMPLATE_PALETTE,
  createMaterialProject,
  plan,
  colorPage,
  readRuntimeSelection,
  openTwoBrandRun,
} from "./template-design-gates.support.js";

describe("template design source gates", () => {
  it("VAL-ASPECT-002/004: pack allows logo/photos/layout references/content/data and keeps theme", async (t) => {
    const designSystemId = "finance/honey-orange-memo";
    const { projectRoot, run, context, brandA, sourceA } = await openTwoBrandRun(t, {
      brief: "按附件模板的风格做",
      sessionId: "style-pack-allowed",
      designSystemId,
    });
    const project = loadProject(projectRoot);
    project.presentation.theme = {
      colors: { accent1: "#FF5703" },
      textStyles: { schemeMajor: { fontFamily: { latin: "Verdana", ea: "黑体" } } },
    };
    saveProject(project);
    const before = loadProject(projectRoot).presentation.theme;
    for (const part of ["slides", "charts"]) {
      const material = verifyMaterial(projectRoot, brandA.id);
      for (let offset = 0; offset < materialChunkCount(material, part); offset++) {
        const read = await run.execute(
          { name: "read_material", args: { materialId: brandA.id, part, offset } },
          { ...context, toolCallId: `allowed-read-${part}-${offset}` },
        );
        assert.equal(read.ok, true, read.detail);
      }
    }
    for (const aspects of [
      ["logo"],
      ["photos"],
      ["layouts"],
      ["content"],
      ["data"],
      ["logo", "photos", "layouts", "content", "data"],
    ]) {
      const result = await run.execute(
        {
          name: "commit_design",
          args: {
            slidePlan: plan(),
            adoptedSourceIds: [sourceA],
            designAspects: [{ source: sourceA, aspects }],
          },
        },
        { ...context, toolCallId: `allowed-${aspects.join("-")}` },
      );
      assert.equal(result.ok, true, result.detail);
      assert.deepEqual(result.payload.designAspects, [{ source: sourceA, aspects }]);
      assert.deepEqual(loadProject(projectRoot).presentation.theme, before);
      const palette = packColorWriteContext([designSystemId, sourceA], projectRoot);
      assert.equal(palette.adoptedPackHexes?.has("#FF5703"), true);
      assert.equal(palette.adoptedPackHexes?.has("#C8102E"), false);
      assert.ok(writePageSchemaIssues(colorPage("#C8102E"), palette).some((issue) => issue.code === PACK_COLOR_ERROR));
    }
  });

  it("VAL-ASPECT-002/004: structured Hub style refuses attachment style aspects, not brief words", async (t) => {
    for (const designSystemId of [undefined, "finance/honey-orange-memo"]) {
      const { projectRoot, run, context, sourceA } = await openTwoBrandRun(t, {
        brief: "按附件模板的风格做",
        sessionId: `style-priority-${designSystemId ? "pack" : "free"}`,
        ...(designSystemId ? { designSystemId } : {}),
      });
      const before = loadProject(projectRoot).presentation.theme;
      for (const aspects of [["palette"], ["fonts"], ["decorations"], undefined]) {
        const result = await run.execute(
          {
            name: "commit_design",
            args: {
              slidePlan: plan(),
              adoptedSourceIds: [sourceA],
              ...(aspects ? { designAspects: [{ source: sourceA, aspects }] } : {}),
            },
          },
          { ...context, toolCallId: `style-priority-${aspects?.join("-") ?? "default"}` },
        );
        assert.equal(result.ok, !designSystemId, result.detail);
        if (designSystemId) {
          assert.match(result.detail, /你在首页选择了风格「蜜橙备忘」/);
          assert.match(result.detail, /附件「品牌A\.pptx」/);
          assert.match(result.detail, /designAuthority: material:<id>/);
          assert.deepEqual(loadProject(projectRoot).presentation.theme, before);
          assert.equal(readRuntimeSelection(projectRoot), undefined);
        }
      }
    }
  });

  it("persists per-source aspects and never borrows palette from a logo-only source", async (t) => {
    const { projectRoot, run, context, sourceA, sourceB } = await openTwoBrandRun(t, {
      brief: "公司介绍，只参考第二份文件的 Logo",
      sessionId: "design-aspects",
    });
    const designAspects = [
      { source: sourceA, aspects: ["palette", "fonts"] },
      { source: sourceB, aspects: ["logo"] },
    ];
    const result = await run.execute(
      {
        name: "commit_design",
        args: { slidePlan: plan(), adoptedSourceIds: [sourceA, sourceB], designAspects },
      },
      { ...context, toolCallId: "aspects-commit" },
    );
    assert.equal(result.ok, true, result.detail);
    const runtime = JSON.parse(fs.readFileSync(path.join(projectRoot, "_agent/runtime.json"), "utf8"));
    assert.deepEqual(runtime.designAspects, designAspects);
    assert.deepEqual(result.payload.designAspects, designAspects);
    const colors = packColorWriteContext([sourceA, sourceB], projectRoot).adoptedPackHexes;
    assert.equal(colors?.has("#C8102E"), true);
    assert.equal(colors?.has("#112233"), false);
    assert.equal(colors?.has("#A1B2C3"), false);
    const logoOnlyContext = packColorWriteContext(["consulting/pine-green-strategy", sourceB], projectRoot);
    const logoOnlyColors = logoOnlyContext.adoptedPackHexes;
    assert.equal(logoOnlyColors?.has("#A1B2C3"), false);
    assert.ok(
      writePageSchemaIssues(colorPage("#A1B2C3"), logoOnlyContext).some((issue) => issue.code === PACK_COLOR_ERROR),
    );
    const denied = writePageSchemaIssues(colorPage("#A1B2C3"), packColorWriteContext([sourceA, sourceB], projectRoot));
    assert.ok(denied.some((issue) => issue.code === PACK_COLOR_ERROR));
    const updated = await run.execute(
      { name: "write_todo", args: { items: plan() } },
      { ...context, toolCallId: "aspects-plan-update" },
    );
    assert.equal(updated.ok, true, updated.detail);
    assert.deepEqual(updated.payload.designAspects, designAspects);
    const reordered = await run.execute(
      { name: "write_todo", args: { items: plan(), adoptedSourceIds: [sourceB, sourceA] } },
      { ...context, toolCallId: "aspects-plan-reorder" },
    );
    assert.equal(reordered.ok, true, reordered.detail);
    assert.deepEqual(reordered.payload.designAspects, designAspects);
    const adoptPalette = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: plan(),
          adoptedSourceIds: [sourceB],
          designAspects: [{ source: sourceB, aspects: ["palette"] }],
        },
      },
      { ...context, toolCallId: "aspects-observed-palette" },
    );
    assert.equal(adoptPalette.ok, true, adoptPalette.detail);
    assert.equal(packColorWriteContext([sourceB], projectRoot).adoptedPackHexes?.has("#A1B2C3"), true);
    assert.equal(
      writePageSchemaIssues(colorPage("#A1B2C3"), packColorWriteContext([sourceB], projectRoot)).some(
        (issue) => issue.code === PACK_COLOR_ERROR,
      ),
      false,
    );
  });

  it("defaults omitted PPTX aspects and seeds palette and fonts independently", async (t) => {
    const { projectRoot, run, context, sourceA, sourceB, brandB } = await openTwoBrandRun(t, {
      brief: "公司介绍",
      sessionId: "aspect-defaults",
    });
    const defaulted = await run.execute(
      { name: "commit_design", args: { slidePlan: plan(), adoptedSourceIds: [sourceA] } },
      { ...context, toolCallId: "aspect-default" },
    );
    assert.equal(defaulted.ok, true, defaulted.detail);
    assert.deepEqual(defaulted.payload.designAspects, [{ source: sourceA, aspects: ["palette", "fonts", "logo"] }]);
    const before = loadProject(projectRoot).presentation.theme?.colors;
    const separated = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: plan(),
          adoptedSourceIds: [sourceB],
          designAspects: [{ source: `openkimi:${sourceB}`, aspects: ["fonts"] }],
        },
      },
      { ...context, toolCallId: "aspect-fonts-only" },
    );
    assert.equal(separated.ok, true, separated.detail);
    const theme = loadProject(projectRoot).presentation.theme;
    assert.deepEqual(theme?.colors, before);
    assert.deepEqual(theme?.textStyles?.schemeMajor?.fontFamily, brandB.major);
    assert.deepEqual(separated.payload.designAspects, [{ source: sourceB, aspects: ["fonts"] }]);
  });

  it("refuses malformed aspects in Chinese without changing the saved selection", async (t) => {
    const { projectRoot, run, context, sourceA } = await openTwoBrandRun(t, {
      brief: "公司介绍",
      sessionId: "aspect-invalid",
    });
    for (const designAspects of [
      null,
      1,
      [{ source: sourceA, aspects: ["unknown"] }],
      [
        { source: sourceA, aspects: ["logo"] },
        { source: "material:../bad", aspects: ["fonts"] },
      ],
    ]) {
      const result = await run.execute(
        {
          name: "commit_design",
          args: { slidePlan: plan(), adoptedSourceIds: [sourceA], designAspects },
        },
        { ...context, toolCallId: `invalid-aspect-${JSON.stringify(designAspects)}` },
      );
      assert.equal(result.ok, false, JSON.stringify(designAspects));
      assert.match(result.detail, /[\u4e00-\u9fff]/);
      assert.equal(readRuntimeSelection(projectRoot), undefined);
    }
  });

  it("requires current-epoch content and data parts, even without visual adoption", async (t) => {
    const { projectRoot, run, context, brandA, sourceA } = await openTwoBrandRun(t, {
      brief: "公司介绍，只取内容与数字，不用样例配色",
      sessionId: "aspect-content-reads",
    });
    const args = {
      slidePlan: plan(),
      adoptedSourceIds: [],
      designAspects: [{ source: sourceA, aspects: ["content", "data"] }],
    };
    const commit = (toolCallId: string) => run.execute({ name: "commit_design", args }, { ...context, toolCallId });
    const rejected = await commit("content-unread");
    assert.equal(rejected.ok, false);
    assert.match(rejected.detail, /slides/);
    assert.deepEqual(readRuntimeSelection(projectRoot), undefined);
    for (const part of ["slides", "tables", "charts"]) {
      const material = verifyMaterial(projectRoot, brandA.id);
      for (let offset = 0; offset < materialChunkCount(material, part); offset++) {
        const read = await run.execute(
          { name: "read_material", args: { materialId: brandA.id, part, offset } },
          { ...context, toolCallId: `content-read-${part}-${offset}` },
        );
        assert.equal(read.ok, true, read.detail);
      }
    }
    const accepted = await commit("content-read-commit");
    assert.equal(accepted.ok, true, accepted.detail);
    assert.deepEqual(readRuntimeSelection(projectRoot), []);
    assert.deepEqual(accepted.payload.designAspects, args.designAspects);
    const stale = await run.execute(
      { name: "commit_design", args },
      { ...context, sessionId: "fresh-content-epoch", toolCallId: "stale-content-commit" },
    );
    assert.equal(stale.ok, false);
    assert.match(stale.detail, /slides/);
  });

  it("accepts data after reading either charts or tables in the current epoch", async (t) => {
    for (const part of ["charts", "tables"]) {
      const { projectRoot, run, context, brandA, sourceA } = await openTwoBrandRun(t, {
        brief: "公司介绍，只取数字",
        sessionId: `aspect-data-${part}`,
      });
      const material = verifyMaterial(projectRoot, brandA.id);
      for (let offset = 0; offset < materialChunkCount(material, part); offset += 1) {
        const read = await run.execute(
          { name: "read_material", args: { materialId: brandA.id, part, offset } },
          { ...context, toolCallId: `data-read-${part}-${offset}` },
        );
        assert.equal(read.ok, true, read.detail);
      }
      const committed = await run.execute(
        {
          name: "commit_design",
          args: {
            slidePlan: plan(),
            adoptedSourceIds: [],
            designAspects: [{ source: sourceA, aspects: ["data"] }],
          },
        },
        { ...context, toolCallId: `data-commit-${part}` },
      );
      assert.equal(committed.ok, true, `${part}: ${committed.detail}`);
      assert.deepEqual(committed.payload.designAspects, [{ source: sourceA, aspects: ["data"] }]);
    }
  });

  it("parses material ids as user design sources and lets adoption satisfy a required pack family", () => {
    assert.equal(parseThemePackId(SOURCE_ID), SOURCE_ID);
    const brief = "给董事会做一份北麓制造上半年经营汇报，16页，重点说明经营结果和决策事项。";
    assert.equal(
      kindThemePackIssue({
        brief,
        adoptedSourceIds: [SOURCE_ID],
        designAspects: [{ source: SOURCE_ID, aspects: ["palette"] }],
      }),
      undefined,
    );
    assert.equal(kindThemePackIssue({ brief, adoptedSourceIds: [] })?.code, MISSING_THEME_PACK_ERROR);
    assert.equal(
      kindThemePackIssue({
        brief,
        adoptedSourceIds: [SOURCE_ID, "work/warm-jade-annual-report"],
      })?.code,
      KIND_THEME_PACK_ERROR,
      "a user source does not exempt a co-adopted forbidden catalog family",
    );
  });

  it("allows receipt-verified template colors and documented tints/shades, but refuses foreign colors", (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-palette-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = createMaterialProject(temp);
    const context = packColorWriteContext([SOURCE_ID], projectRoot);
    const allowed = [...TEMPLATE_PALETTE, "#D34058", "#DE7082", "#E99FAB", "#A00D25", "#780A1C", "#500612"];
    for (const color of allowed) {
      assert.ok(context.adoptedPackHexes?.has(color), `missing allowed color ${color}`);
      const page = colorPage(color);
      assert.equal(
        writePageSchemaIssues(page, context).some((issue) => issue.code === "pack_color"),
        false,
        `${color} should pass`,
      );
    }
    const nearMiss = colorPage("#C81040");
    const nearMissError = writePageSchemaError(writePageSchemaIssues(nearMiss, context), nearMiss, context);
    assert.equal(nearMissError?.error, "pack_color");
    const foreign = colorPage("#3366FF");
    const foreignError = writePageSchemaError(writePageSchemaIssues(foreign, context), foreign, context);
    assert.equal(foreignError?.error, "pack_color");
    assert.match(foreignError?.detail ?? "", /已采用的设计源/);
    assert.match(foreignError?.detail ?? "", /#3366FF/);

    const catalogOnly = packColorWriteContext(["consulting/pine-green-strategy"], projectRoot);
    assert.equal(catalogOnly.adoptedPackHexes?.has("#024223"), false);
    assert.equal(catalogOnly.adoptedPackHexes?.has("#C8102E"), false);

    recordSourceReceipt(projectRoot, { sourceId: SOURCE_ID, state: "consulted" });
    const referencedOnly = packColorWriteContext(["consulting/pine-green-strategy"], projectRoot);
    assert.equal(referencedOnly.adoptedPackHexes?.has("#C8102E"), false);
    assert.equal(
      writePageSchemaIssues(colorPage("#C8102E"), referencedOnly).some((issue) => issue.code === "pack_color"),
      true,
      "a consulted but unadopted template cannot widen a catalog palette",
    );

    // VAL-TPL-010/011: colours the Agent declared from the user's words join the allowed set with the
    // same documented tints and shades; the template palette stays, and a near miss is still refused.
    fs.mkdirSync(path.join(projectRoot, "_agent"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "_agent", "runtime.json"),
      JSON.stringify({ userColors: [{ hex: "#1F4E9A", reason: "用户要求主色换成蓝色" }] }),
    );
    const withUser = packColorWriteContext([SOURCE_ID], projectRoot);
    const userAllowed = ["#1F4E9A", "#4C71AE", "#7995C2", "#A5B8D7", "#193E7B", "#132F5C", "#0C1F3E"];
    for (const color of [...TEMPLATE_PALETTE, "#D34058", "#500612", ...userAllowed]) {
      assert.ok(withUser.adoptedPackHexes?.has(color), `missing allowed color ${color}`);
      assert.equal(
        writePageSchemaIssues(colorPage(color), withUser).some((issue) => issue.code === "pack_color"),
        false,
        `${color} should pass`,
      );
    }
    for (const color of ["#C81040", "#1F4EA8", "#3366FF"]) {
      assert.equal(
        writePageSchemaIssues(colorPage(color), withUser).some((issue) => issue.code === "pack_color"),
        true,
        `${color} should be refused`,
      );
    }
    const catalogWithUser = packColorWriteContext(["consulting/pine-green-strategy"], projectRoot);
    for (const color of userAllowed) assert.ok(catalogWithUser.adoptedPackHexes?.has(color), color);
    assert.equal(catalogWithUser.adoptedPackHexes?.has("#C8102E"), false);
    assert.equal(catalogWithUser.adoptedPackHexes?.has("#D34058"), false, "no template tints");
  });

  it("fails closed with a Chinese pack_color issue when a design-source receipt no longer matches", (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-tamper-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = createMaterialProject(temp);
    const markdownFile = path.join(projectRoot, "_agent", "materials", TEMPLATE_ID, "design-source.md");
    fs.appendFileSync(markdownFile, "\n- injected: #3366FF\n");
    const context = packColorWriteContext([SOURCE_ID], projectRoot);
    assert.ok(context.materialError);
    const page = colorPage("#C8102E");
    const error = writePageSchemaError(writePageSchemaIssues(page, context), page, context);
    assert.equal(error?.error, "pack_color");
    assert.match(error?.detail ?? "", /已采用的设计源/);
    assert.match(error?.detail ?? "", /校验|变化|重新上传/);
  });
});
