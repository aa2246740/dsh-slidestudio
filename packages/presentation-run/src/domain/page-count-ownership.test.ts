import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { composeBodyRules } from "./compose-ir.js";
import { assertSkillDeck } from "./deck-page-count.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { pageCountRequirementFromBrief, type PageCountRequirement } from "./page-count-requirement.js";
import { planWriteFeedback } from "./plan-coverage.js";
import { ensureRunLedger } from "./run-ledger.js";
import type { SkillDeckInput } from "./skill-pages.js";

const UNSPECIFIED: PageCountRequirement = { kind: "unspecified" };
const exact = (count: number): PageCountRequirement => ({ kind: "exact", count });

const FINAL_HUB_PROMPT =
  "向管理层汇报 2026 年第三季度运营情况，固定 6 页。页序和职责：第 1 页给出本季度结论；第 2 页列出关键指标（数据取自附件 CSV）；第 3 页说明问题与原因；第 4 页列出风险；第 5 页给出行动计划；第 6 页提出资源需求。企业要求：背景保持白色；金额统一写“万元”；每页标题不超过 16 个字；每页要点不超过 4 条；不得使用“遥遥领先”“史上最”等夸张词；第 2 页的数字必须与附件一致。";

// Sentences that carry only the user's own total; the reference never speaks here.
const USER_TOTAL: readonly (readonly [string, PageCountRequirement])[] = [
  ["固定 7 页，参考稿由系统生成约 12 页", exact(7)],
  ["参考稿由系统生成约 12 页，固定 7 页", exact(7)],
  ["制作一份参考附件风格的 7 页汇报", exact(7)],
  ["请生成一份参考原稿配色的 7 页汇报", exact(7)],
  ["按附件模板的配色做一份 3 页", exact(3)],
  ["固定 7 页，参考稿为 12 页", exact(7)],
  ["参考稿约 12 页，共 7 页", exact(7)],
  ["做 16 页左右，参考附件共 30 页", { kind: "approximate", count: 16 }],
  [FINAL_HUB_PROMPT, exact(6)],
];

// Sentences that only describe the reference's own size or history.
const REFERENCE_ONLY: readonly string[] = [
  "参考稿由系统生成 12 页，按当前业务内容重新组织",
  "参考为 6–8 页",
  "参考稿共 12 页",
  "12 页的参考稿，按内容重新组织",
  "附件是一份 20 页的原稿",
  "原稿制作了 20 页，模板做成 10 页",
];

describe("page counts belong to the user or to the reference, never both", () => {
  it("reads the user's total next to a reference that speaks for itself", () => {
    for (const [text, expected] of USER_TOTAL) {
      assert.deepEqual(pageCountRequirementFromBrief(text), expected, text.slice(0, 40));
    }
  });

  it("sets no target from a reference description alone", () => {
    for (const text of REFERENCE_ONLY) {
      assert.deepEqual(pageCountRequirementFromBrief(text), UNSPECIFIED, text);
    }
  });

  it("a reference description never changes the user's result, on either side of it", () => {
    for (const [user, expected] of USER_TOTAL) {
      for (const reference of REFERENCE_ONLY) {
        for (const joined of [`${user}，${reference}`, `${reference}，${user}`]) {
          assert.deepEqual(pageCountRequirementFromBrief(joined), expected, `${user.slice(0, 20)} + ${reference}`);
        }
      }
    }
  });

  it("keeps the user's count when the reference noun only modifies what the user asks for", () => {
    for (const [text, expected] of [
      ["制作一份 7 页的参考附件风格汇报", exact(7)],
      ["以参考稿为准做 7 页", exact(7)],
      ["参考稿的风格做 3 页", exact(3)],
      ["做 5 页，要求参考稿的配色", exact(5)],
      ["做一份 12 页的参考稿风格汇报", exact(12)],
      ["参考McKinsey风格做 7 页", exact(7)],
    ] as const) {
      assert.deepEqual(pageCountRequirementFromBrief(text), expected, text);
    }
  });

  it("drops a reference's own size property in every phrasing, but not the ask after it", () => {
    for (const text of ["参考稿页数为 12", "参考稿的页数是 12 页", "参考稿与附件共 12 页", "参考稿是蓝色风格"]) {
      assert.deepEqual(pageCountRequirementFromBrief(text), UNSPECIFIED, text);
    }
    assert.deepEqual(pageCountRequirementFromBrief("参考稿是蓝色风格做 7 页"), exact(7));
    assert.deepEqual(pageCountRequirementFromBrief("参考稿 12 页做 3 页"), exact(3));
    assert.deepEqual(pageCountRequirementFromBrief("参考稿由系统生成约 12 页做 7 页"), exact(7));
    assert.deepEqual(pageCountRequirementFromBrief("固定 7 页参考稿由系统生成约 12 页"), exact(7));
  });
});

function deck(count: number): SkillDeckInput {
  return {
    title: "合成归属检查",
    pages: Array.from({ length: count }, (_, index) => ({
      id: `p${String(index + 1).padStart(2, "0")}`,
      elements: [
        {
          elementId: "title",
          elementType: "text" as const,
          bounds: [80, 40, 800, 60] as const,
          content: { text: `合成页 ${index + 1}`, fontSize: 28 },
        },
      ],
    })),
  };
}

const plan = (count: number) => Array.from({ length: count }, (_, i) => ({ pageId: `p${i + 1}` }));

describe("ownership reaches the plan and compose consumers", () => {
  for (const brief of [
    "固定 7 页，参考稿由系统生成约 12 页",
    "制作一份参考附件风格的 7 页汇报",
    "参考稿由系统生成约 12 页，固定 7 页",
  ]) {
    it(`fixes seven pages for: ${brief}`, () => {
      for (const count of [6, 8, 12]) {
        assert.match(planWriteFeedback(undefined, plan(count), brief).countMismatch ?? "", /固定 7 页/, `${count}`);
        const rules = composeBodyRules(brief);
        assert.throws(() => assertSkillDeck(deck(count), rules), /固定 7 页/, `${count}`);
      }
      assert.equal(planWriteFeedback(undefined, plan(7), brief).countMismatch, undefined);
      assert.doesNotThrow(() => assertSkillDeck(deck(7), composeBodyRules(brief)));
    });
  }

  it("sets no target when only the reference states a count", () => {
    for (const brief of REFERENCE_ONLY) {
      const rules = composeBodyRules(`${brief}，做一份协作流程介绍`);
      assert.deepEqual(rules.pageCount, UNSPECIFIED, brief);
      for (const count of [3, 5, 12]) {
        assert.equal(planWriteFeedback(undefined, plan(count), brief).countMismatch, undefined);
        assert.doesNotThrow(() => assertSkillDeck(deck(count), rules), `${brief} ${count}`);
      }
    }
  });
});

const CONTEXT = { commandId: "count-ownership", contextEpochId: "count-ownership-epoch" };

function fixture(t: TestContext, brief: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "count-ownership-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "合成归属" });
  writeDomainRuntime(root, { brief });
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

function writeTodo(root: string, count: number) {
  return runDomainHand(
    "write_todo",
    {
      items: Array.from({ length: count }, (_, index) => ({
        pageId: `p${String(index + 1).padStart(2, "0")}`,
        title: `合成页 ${index + 1}`,
        layoutFamily: "content",
        exhibits: ["none"],
      })),
      __openSlideStudio: CONTEXT,
    },
    root,
  );
}

describe("ownership through the real write_todo hand", () => {
  for (const brief of ["固定 7 页，参考稿由系统生成约 12 页", "制作一份参考附件风格的 7 页汇报"]) {
    it(`refuses six and eight planned pages for: ${brief}`, async (t) => {
      for (const count of [6, 8]) {
        const planned = await writeTodo(fixture(t, brief), count);
        assert.equal(planned.ok, false, planned.detail);
        assert.equal((planned.payload as { error?: string }).error, "page_count_mismatch");
      }
      const accepted = await writeTodo(fixture(t, brief), 7);
      assert.equal(accepted.ok, true, accepted.detail);
    });
  }

  it("accepts any planned count when only the reference states one", async (t) => {
    const brief = "参考稿由系统生成 12 页，按当前业务内容重新组织";
    for (const count of [3, 12]) {
      const planned = await writeTodo(fixture(t, brief), count);
      assert.equal(planned.ok, true, planned.detail);
    }
  });
});
