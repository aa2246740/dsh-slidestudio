import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writePageSchemaIssues, writePageSchemaError } from "./layout-qa.js";
import type { SkillPageInput } from "./skill-pages.js";
import { executeGenerateTool } from "./agent-tools.js";
import { loadPlaybook } from "./playbook.js";
import { packColorWriteContextFrom, PACK_COLOR_ERROR } from "./theme-pack.js";

const navy = {
  elementId: "cl-bg",
  elementType: "shape" as const,
  shapeName: "rect" as const,
  bounds: [0, 0, 960, 540] as [number, number, number, number],
  fill: { type: "solid" as const, color: "#06223F" },
};

function textEl(
  id: string,
  text: string,
  bounds: [number, number, number, number],
  fontSize: number,
): SkillPageInput["elements"][number] {
  return {
    elementId: id,
    elementType: "text",
    bounds,
    content: { text, fontSize, color: "#FFFFFF" },
  };
}

describe("EDITH produce leaks", () => {
  it("write_page refuses an unknown border $token in Chinese before the export can throw (M5-SCR-005)", () => {
    const playbook = loadPlaybook({ hostDefaults: false });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
    };
    const rejected = executeGenerateTool(
      "write_page",
      {
        id: "19_final",
        pageType: "final",
        elements: [
          {
            elementId: "bg",
            elementType: "shape",
            shapeName: "rect",
            bounds: [0, 0, 960, 540],
            fill: { type: "solid", color: "#0E0807" },
          },
          {
            elementId: "frame",
            elementType: "shape",
            shapeName: "rect",
            bounds: [60, 120, 840, 160],
            border: { width: 2, color: "$accent9" },
          },
          {
            elementId: "ask",
            elementType: "text",
            bounds: [60, 312, 840, 80],
            content: { text: "下个月请评委给三件事反馈。", fontSize: 16, color: "#E8DED7" },
          },
        ],
      },
      {
        brief: "unknown border token",
        playbook,
        todos: [],
        researchNotes: [],
        writtenPages: [cover],
      },
    );
    assert.equal(rejected.ok, false);
    assert.equal((rejected.payload as { error?: string }).error, "invalid_color");
    assert.match(String(rejected.detail), /elements\[1\]\.border\.color/);
    assert.match(String(rejected.detail), /"\$accent9" 在主题 colors 中不存在/);
    assert.match(String(rejected.detail), /无效颜色不会变成 #000000/);
  });

  it("write_page rejects HTML style color:0E0807 and accepts official # / $theme span colors", () => {
    const playbook = loadPlaybook({ hostDefaults: false });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
    };
    const rejected = executeGenerateTool(
      "write_page",
      {
        id: "19_final",
        pageType: "final",
        elements: [
          {
            elementId: "bg",
            elementType: "shape",
            shapeName: "rect",
            bounds: [0, 0, 960, 540],
            fill: { type: "solid", color: "#0E0807" },
          },
          {
            elementId: "recap",
            elementType: "text",
            bounds: [60, 120, 840, 80],
            content: {
              text: '<p><span style="color:0E0807">我把一条事故频发的发布线改造成可回滚。</span></p>',
              fontSize: 18,
              color: "#E8DED7",
            },
          },
        ],
      },
      {
        brief: "html unprefixed hex inversion",
        playbook,
        todos: [],
        researchNotes: [],
        writtenPages: [cover],
      },
    );
    assert.equal(rejected.ok, false);
    assert.equal((rejected.payload as { error?: string }).error, "invalid_color");
    assert.match(String(rejected.detail), /0E0807/);
    assert.match(String(rejected.detail), /@style\.color/);
    assert.match(String(rejected.detail), /无效颜色不会变成 #000000/);
    const bgPage: SkillPageInput = {
      id: "19_final",
      pageType: "final",
      elements: [
        {
          elementId: "bg",
          elementType: "shape",
          shapeName: "rect",
          bounds: [0, 0, 960, 540],
          fill: { type: "solid", color: "#0E0807" },
        },
        {
          elementId: "recap",
          elementType: "text",
          bounds: [60, 120, 840, 80],
          content: {
            text: '<p><span style="background-color:E8DED7">我把一条事故频发的发布线改造成可回滚。</span></p>',
            fontSize: 18,
            color: "#E8DED7",
          },
        },
      ],
    };
    const bgRejected = writePageSchemaError(writePageSchemaIssues(bgPage), bgPage);
    assert.equal(bgRejected?.error, "invalid_color");
    assert.match(String(bgRejected?.detail), /E8DED7/);
    assert.match(String(bgRejected?.detail), /@style\.background-color/);
    const theme = { colors: { primary: "#2563EB" } };
    const officialHtml: SkillPageInput = {
      id: "19_final",
      pageType: "final",
      elements: [
        {
          elementId: "bg",
          elementType: "shape",
          shapeName: "rect",
          bounds: [0, 0, 960, 540],
          fill: { type: "solid", color: "#0E0807" },
        },
        {
          elementId: "recap",
          elementType: "text",
          bounds: [60, 120, 840, 80],
          content: {
            text: '<p><span style="color:#E8DED7">我把一条事故频发的发布线改造成可回滚。</span></p>',
            fontSize: 18,
            color: "#E8DED7",
          },
        },
        {
          elementId: "ask",
          elementType: "text",
          bounds: [60, 312, 840, 80],
          content: {
            text: '<p><span style="color:$primary">下个月请评委给三件事反馈。</span></p>',
            fontSize: 16,
            color: "#E8DED7",
          },
        },
      ],
    };
    const allowed = writePageSchemaError(writePageSchemaIssues(officialHtml, { theme }), officialHtml, { theme });
    assert.equal(allowed, undefined);
    const mention: SkillPageInput = {
      id: "19_final",
      pageType: "final",
      elements: [
        {
          elementId: "bg",
          elementType: "shape",
          shapeName: "rect",
          bounds: [0, 0, 960, 540],
          fill: { type: "solid", color: "#0E0807" },
        },
        {
          elementId: "recap",
          elementType: "text",
          bounds: [60, 120, 840, 80],
          content: {
            text: "<p>我把一条事故频发的发布线改造成可回滚。主色 0E0807 写在正文里，没有 style 属性。</p>",
            fontSize: 18,
            color: "#E8DED7",
          },
        },
        {
          elementId: "ask",
          elementType: "text",
          bounds: [60, 312, 840, 80],
          content: {
            text: "<p>下个月请评委给三件事反馈。</p>",
            fontSize: 16,
            color: "#E8DED7",
          },
        },
      ],
    };
    assert.equal(writePageSchemaError(writePageSchemaIssues(mention), mention), undefined);
  });

  it("write_page refuses another pack's Color Palette hex after adopt and skips when no pack is adopted", () => {
    const pine = packColorWriteContextFrom({
      designSystemId: "consulting/pine-green-strategy",
    });
    const foreign: SkillPageInput = {
      id: "cover",
      pageType: "cover",
      elements: [
        {
          elementId: "bg",
          elementType: "shape",
          shapeName: "rect",
          bounds: [0, 0, 960, 540],
          fill: { type: "solid", color: "#FDC356" },
        },
        textEl("t", "北麓制造 2026 上半年经营汇报", [80, 160, 800, 80], 36),
      ],
    };
    const rejected = writePageSchemaError(writePageSchemaIssues(foreign, pine), foreign, pine);
    assert.equal(rejected?.error, PACK_COLOR_ERROR);
    assert.match(String(rejected?.detail), /#FDC356/);
    const mixed: SkillPageInput = {
      id: "cover",
      pageType: "cover",
      elements: [
        {
          elementId: "bg",
          elementType: "shape",
          shapeName: "rect",
          bounds: [0, 0, 960, 540],
          fill: { type: "solid", color: "#03522C" },
        },
        textEl("t", "北麓制造 2026 上半年经营汇报", [80, 160, 800, 80], 36),
        {
          elementId: "accent",
          elementType: "shape",
          shapeName: "rect",
          bounds: [80, 260, 200, 40],
          fill: { type: "solid", color: "#FDC356" },
        },
      ],
    };
    assert.equal(writePageSchemaError(writePageSchemaIssues(mixed, pine), mixed, pine)?.error, PACK_COLOR_ERROR);
    const adopted: SkillPageInput = {
      id: "cover",
      pageType: "cover",
      elements: [
        {
          elementId: "bg",
          elementType: "shape",
          shapeName: "rect",
          bounds: [0, 0, 960, 540],
          fill: { type: "solid", color: "#03522C" },
        },
        textEl("t", "北麓制造 2026 上半年经营汇报", [80, 160, 800, 80], 36),
      ],
    };
    assert.equal(writePageSchemaError(writePageSchemaIssues(adopted, pine), adopted, pine), undefined);
    assert.equal(writePageSchemaError(writePageSchemaIssues(foreign), foreign), undefined);
    const navy: SkillPageInput = {
      id: "cover",
      pageType: "cover",
      elements: [
        {
          elementId: "bg",
          elementType: "shape",
          shapeName: "rect",
          bounds: [0, 0, 960, 540],
          fill: { type: "solid", color: "#06223F" },
        },
        textEl("t", "北麓制造 2026 上半年经营汇报", [80, 160, 800, 80], 36),
      ],
    };
    assert.equal(writePageSchemaError(writePageSchemaIssues(navy, pine), navy, pine)?.error, PACK_COLOR_ERROR);
    const hostBlue: SkillPageInput = {
      ...navy,
      elements: [
        {
          elementId: "bg",
          elementType: "shape",
          shapeName: "rect",
          bounds: [0, 0, 960, 540],
          fill: { type: "solid", color: "#2563EB" },
        },
        navy.elements[1]!,
      ],
    };
    assert.equal(writePageSchemaError(writePageSchemaIssues(hostBlue, pine), hostBlue, pine)?.error, PACK_COLOR_ERROR);
    const packPrimary: SkillPageInput = {
      id: "cover",
      pageType: "cover",
      elements: [
        {
          elementId: "bg",
          elementType: "shape",
          shapeName: "rect",
          bounds: [0, 0, 960, 540],
          fill: { type: "solid", color: "$primary" },
        },
        textEl("t", "北麓制造 2026 上半年经营汇报", [80, 160, 800, 80], 36),
      ],
    };
    const packTheme = { theme: { colors: { primary: "#03522C" } }, ...pine };
    assert.equal(
      writePageSchemaError(writePageSchemaIssues(packPrimary, packTheme), packPrimary, packTheme),
      undefined,
    );
    const emptyTheme = { theme: { colors: { primary: "#2563EB" } }, ...pine };
    assert.equal(
      writePageSchemaError(writePageSchemaIssues(packPrimary, emptyTheme), packPrimary, emptyTheme)?.error,
      PACK_COLOR_ERROR,
    );
  });

  it("checks a string chart series fill against a catalog-only palette", () => {
    const pine = packColorWriteContextFrom({
      designSystemId: "consulting/pine-green-strategy",
    });
    const page = (fill: string): SkillPageInput => ({
      id: "revenue",
      pageType: "content",
      elements: [
        {
          elementId: "revenue-chart",
          elementType: "chart",
          bounds: [40, 80, 880, 400],
          title: "营收",
          data: {
            cols: ["年", "营收"],
            rows: [["2024", 1200]],
          },
          series: [{ type: "bar", name: "营收", encode: { x: "年", y: "营收" }, fill }],
        },
        textEl("title", "目录色板图表", [40, 24, 600, 40], 24),
      ],
    });
    const allowed = page("#03522C");
    assert.equal(
      writePageSchemaIssues(allowed, pine).some((issue) => issue.code === "pack_color"),
      false,
    );
    const foreign = page("#3366FF");
    const error = writePageSchemaError(writePageSchemaIssues(foreign, pine), foreign, pine);
    assert.equal(error?.error, PACK_COLOR_ERROR);
    assert.match(error?.detail ?? "", /#3366FF/);
    const image: SkillPageInput = {
      id: "photo",
      pageType: "content",
      elements: [
        {
          elementId: "shot",
          elementType: "image",
          bounds: [40, 80, 400, 300],
          src: "media/logo.png",
        },
        textEl("title", "图片填充不按 fill 字符串校验", [40, 24, 700, 40], 24),
      ],
    };
    assert.equal(
      writePageSchemaIssues(image, pine).some((issue) => issue.code === "pack_color"),
      false,
    );
  });
});
