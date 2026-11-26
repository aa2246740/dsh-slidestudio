import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DESIGN_CONTRACT_REL,
  assertPageMatchesDesignContract,
  assertTodoMatchesDesignContract,
  commitDesignContract,
  readDesignContract,
  type DesignContractDraft,
} from "./design-contract.js";

const brief = "为董事会制作 8 页经营月报，使用深蓝和琥珀金，16:9。";

function draft(): DesignContractDraft {
  const layouts = [
    "cover",
    "chart-led",
    "table-led",
    "editorial-asymmetric",
    "comparison",
    "chart-led",
    "decision",
    "conclusion",
  ] as const;
  return {
    audience: "董事会与经营班子",
    scene: "经营月会投屏讲解",
    purpose: "让管理层先看到结论，再定位差距和动作",
    designRead: "海军蓝承担结构，琥珀金只标记结论与风险，留白制造节奏。",
    necessaryJudgment: {
      removeOrDemote: ["装饰性卡片墙"],
      mustRemain: ["结论、证据、动作责任人"],
      inevitableRelationships: ["目标、实际、差距与动作必须在同一阅读路径中"],
    },
    tasteDials: {
      visualVariance: 4,
      informationDensity: 4,
      brandDistinction: 4,
      typeExpressiveness: 3,
      experimentRisk: 2,
    },
    typeSystem: {
      personality: "克制、权威、数字优先",
      title: "短句结论标题，显著大于正文",
      body: "紧凑但不贴边的中文正文",
      data: "等宽感数字与清晰单位",
      mixedScript: "中文为主，英文缩写不抢层级",
    },
    palette: {
      background: "#F7F8FA",
      text: "#172033",
      primary: "#153B63",
      accent: "#C8942F",
      neutral: "#8290A3",
      areaRules: ["主色面积不超过页面三分之一", "强调色只用于关键结论和风险"],
    },
    grid: "左右 48px 安全边距，12 栏对齐，页脚以上保留 24px 呼吸区",
    densityRules: ["一页一个判断", "表格优先完整，说明文字让位"],
    chartGrammar: ["直接标注关键值", "同一指标颜色跨页一致"],
    visualMemory: {
      feature: "细金色结论标尺",
      recurrence: "每个章节首尾各出现一次",
      avoid: "不要把标尺复制到每个卡片",
    },
    referenceUse: {
      adopt: ["深蓝结构与结论式标题"],
      adapt: ["按本月数据密度调整留白"],
      doNotCopy: ["不复制预览中的具体文字和图表数据"],
    },
    antiDefaultLocks: ["禁止平均卡片墙", "禁止每页相同左右分栏", "禁止无意义渐变"],
    slidePlan: layouts.map((layoutFamily, index) => ({
      pageId: `page-${String(index + 1).padStart(2, "0")}`,
      title: `第 ${index + 1} 页结论`,
      narrativeJob: `完成叙事任务 ${index + 1}`,
      layoutFamily,
      focalPoint: `焦点 ${index + 1}`,
    })),
    userOverrides: [
      { quote: "深蓝和琥珀金", effect: "覆盖参考配色但保留面积纪律" },
      { quote: "16:9", effect: "使用宽屏画布" },
    ],
  };
}

function commit(root: string, next: unknown = draft()) {
  return commitDesignContract(root, {
    brief,
    categoryId: "management-report",
    designSystemId: "consulting/marine-blue-research",
    references: [
      { sourceId: "openkimi:design.md", sha256: "a".repeat(64), role: "selected-design" },
      {
        sourceId: "openkimi-preview:consulting/marine-blue-research",
        sha256: "b".repeat(64),
        role: "selected-preview",
      },
    ],
    draft: next,
  });
}

describe("design contract", () => {
  it("commits a canonical non-renderable contract and replays identical input", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oss-design-contract-"));
    const first = commit(root);
    const second = commit(root);
    assert.equal(second.contractSha256, first.contractSha256);
    assert.deepEqual(readDesignContract(root), first);
    assert.ok(fs.existsSync(path.join(root, DESIGN_CONTRACT_REL)));
    assertTodoMatchesDesignContract(
      first,
      first.draft.slidePlan.map((slide) => ({
        pageId: slide.pageId,
        title: slide.title,
        layoutFamily: slide.layoutFamily,
      })),
    );
    assertPageMatchesDesignContract(first, "page-02", "chart-led");
  });

  it("rejects low-variety plans, triple repetition, invented overrides, and renderable fields", () => {
    const lowVariety = {
      ...draft(),
      slidePlan: draft().slidePlan.map((slide, index) => ({
        ...slide,
        layoutFamily: index < 4 ? "cover" : "chart-led",
      })),
    };
    assert.throws(
      () => commit(fs.mkdtempSync(path.join(os.tmpdir(), "oss-design-")), lowVariety),
      /at least 4 layout families|more than 2 adjacent/,
    );

    const badOverride = {
      ...draft(),
      userOverrides: [{ quote: "紫色霓虹", effect: "使用紫色" }],
    };
    assert.throws(
      () => commit(fs.mkdtempSync(path.join(os.tmpdir(), "oss-design-")), badOverride),
      /verbatim brief quote/,
    );

    const renderable = { ...draft(), elements: [{ bounds: [0, 0, 1, 1] }] };
    assert.throws(() => commit(fs.mkdtempSync(path.join(os.tmpdir(), "oss-design-")), renderable), /renderable field/);
  });

  it("rejects todo or page geometry that drifts from the committed plan", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oss-design-contract-"));
    const contract = commit(root);
    assert.throws(
      () => assertTodoMatchesDesignContract(contract, [{ pageId: "page-99", title: "错", layoutFamily: "cover" }]),
      /todo has 1 items|must be/,
    );
    assert.throws(
      () => assertPageMatchesDesignContract(contract, "page-02", "cover"),
      /must be committed layout family chart-led/,
    );
  });
});
