import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pageCountRequirementFromBrief } from "./page-count-requirement.js";
import { planWriteFeedback } from "./plan-coverage.js";

const UNSPECIFIED = { kind: "unspecified" } as const;

const FINAL_ACCEPTANCE_BRIEF =
  "向管理层汇报 2026 年第三季度运营情况，固定 6 页。页序和职责：第 1 页结论，第 2 页证据，第 3 页风险，第 4 页对比，第 5 页计划，第 6 页行动。";

describe("ordinal pages are never a total", () => {
  it("ignores 第 n 页 with or without a space", () => {
    for (const text of [
      "第 1 页结论，第 2 页证据，第 3 页行动",
      "第1页结论，第2页证据，第3页行动",
      "第 1 页结论",
      "第  2  页证据",
      "第 １ 页结论，第 ２ 页证据",
    ]) {
      assert.deepEqual(pageCountRequirementFromBrief(text), UNSPECIFIED, text);
    }
  });

  it("still reads an explicit total that follows the ordinals", () => {
    assert.deepEqual(pageCountRequirementFromBrief("第 1 页结论，第 2 页证据，第 3 页行动，共 3 页"), {
      kind: "exact",
      count: 3,
    });
    assert.deepEqual(pageCountRequirementFromBrief("第1页结论，第2页证据，共3页"), {
      kind: "exact",
      count: 3,
    });
  });

  it("reads the total wherever it sits relative to the page order", () => {
    assert.deepEqual(pageCountRequirementFromBrief(FINAL_ACCEPTANCE_BRIEF), {
      kind: "exact",
      count: 6,
    });
    assert.deepEqual(
      pageCountRequirementFromBrief(
        "页序和职责：第 1 页结论，第 2 页证据，第 3 页风险，第 4 页对比，第 5 页计划，第 6 页行动。固定 6 页。",
      ),
      { kind: "exact", count: 6 },
    );
  });

  it("does not reject a three-page plan whose brief only numbers its pages", () => {
    const plan = [{ pageId: "p01" }, { pageId: "p02" }, { pageId: "p03" }];
    const feedback = planWriteFeedback(undefined, plan, "第 1 页结论，第 2 页证据，第 3 页行动");
    assert.equal(feedback.countMismatch, undefined);
    assert.deepEqual(feedback.hints, []);
  });
});

describe("reference page counts never become the user's target", () => {
  it("keeps the user's fixed total next to a reference count in any form", () => {
    for (const text of [
      "固定 7 页，参考稿约 12 页",
      "固定 7 页，参考稿大约 12 页",
      "固定 7 页，参考稿 12 页左右",
      "固定 7 页，参考稿 6–8 页",
      "固定 7 页，参考稿有 6-8 页",
      "固定 7 页，参考稿共约 12 页",
      "参考稿约 12 页，固定 7 页",
      "参考稿 12 页左右，固定 7 页",
      "参考稿 6–8 页，固定 7 页",
      "固定 7 页，参考稿 12 页",
    ]) {
      assert.deepEqual(pageCountRequirementFromBrief(text), { kind: "exact", count: 7 }, text);
    }
  });

  it("is unspecified when only a reference count is present", () => {
    for (const text of [
      "参考稿约 12 页",
      "参考稿大概 12 页",
      "参考稿 12 页左右",
      "参考稿 6–8 页",
      "参考稿有 6-8 页",
      "参考稿 6 到 8 页",
      "参考稿 6~8 页",
      "附件约 20 页",
      "模板大约有 12 页",
      "参考稿 12 页",
    ]) {
      assert.deepEqual(pageCountRequirementFromBrief(text), UNSPECIFIED, text);
    }
  });

  it("never plans against a reference-only count", () => {
    const plan = Array.from({ length: 5 }, (_, index) => ({ pageId: `p${index + 1}` }));
    for (const brief of ["参考稿约 12 页，做一份汇报", "参考稿 6–8 页，做一份汇报"]) {
      assert.equal(planWriteFeedback(undefined, plan, brief).countMismatch, undefined, brief);
    }
  });

  it("does not strip the user's own approximate or range wording", () => {
    assert.deepEqual(pageCountRequirementFromBrief("约 7 页"), { kind: "approximate", count: 7 });
    assert.deepEqual(pageCountRequirementFromBrief("做一份 7 页左右的汇报"), {
      kind: "approximate",
      count: 7,
    });
    assert.deepEqual(pageCountRequirementFromBrief("6–8 页"), { kind: "range", min: 6, max: 8 });
    assert.deepEqual(pageCountRequirementFromBrief("做 6 到 8 页"), {
      kind: "range",
      min: 6,
      max: 8,
    });
    assert.deepEqual(pageCountRequirementFromBrief("约 7 页，参考稿约 12 页"), {
      kind: "approximate",
      count: 7,
    });
    assert.deepEqual(pageCountRequirementFromBrief("6–8 页，参考稿 12 页左右"), {
      kind: "range",
      min: 6,
      max: 8,
    });
  });
});

describe("a reference clause only describes the reference", () => {
  const REFERENCE_FORMS = [
    "参考稿为约 12 页",
    "参考稿为 12 页",
    "参考稿是 12 页",
    "参考稿是大约 12 页",
    "参考稿有 12 页",
    "参考稿有约 12 页",
    "参考稿共约 12 页",
    "参考稿约 12 页",
    "参考稿 12 页左右",
    "参考稿 12 页上下",
    "参考稿为 6–8 页",
    "参考稿是 6-8 页",
    "参考稿有 6 到 8 页",
    "参考稿为 6–8 页左右",
    "参考稿页数为 12",
    "原稿为约 12 页",
    "参考资料是约 12 页",
    "附件有大约 12 页",
    "模板为 6~8 页",
    "示例是 12 页",
    "一份 12 页的参考稿",
  ];

  it("never turns a reference count into a target, in any phrasing", () => {
    for (const text of REFERENCE_FORMS) {
      assert.deepEqual(pageCountRequirementFromBrief(text), UNSPECIFIED, text);
      assert.deepEqual(pageCountRequirementFromBrief(`${text}，按当前业务内容重新组织`), UNSPECIFIED, text);
    }
  });

  it("keeps the user's total whichever side of the reference clause it is on", () => {
    for (const text of REFERENCE_FORMS) {
      for (const [total, expected] of [
        ["固定 7 页", { kind: "exact", count: 7 }],
        ["共 7 页", { kind: "exact", count: 7 }],
        ["约 7 页", { kind: "approximate", count: 7 }],
        ["6–8 页", { kind: "range", min: 6, max: 8 }],
      ] as const) {
        assert.deepEqual(pageCountRequirementFromBrief(`${total}，${text}`), expected, text);
        assert.deepEqual(pageCountRequirementFromBrief(`${text}，${total}`), expected, text);
        assert.deepEqual(pageCountRequirementFromBrief(`${text}；${total}。`), expected, text);
      }
    }
  });

  it("matches the failing probes of the second review", () => {
    for (const [text, expected] of [
      ["固定 7 页，参考稿为约 12 页", { kind: "exact", count: 7 }],
      ["参考稿为 6–8 页，按当前业务内容重新组织", UNSPECIFIED],
      ["参考稿约 12 页，共 7 页", { kind: "exact", count: 7 }],
      ["固定 7 页，参考稿约 12 页", { kind: "exact", count: 7 }],
      ["第 1 页结论，第 2 页证据，第 3 页行动", UNSPECIFIED],
    ] as const) {
      assert.deepEqual(pageCountRequirementFromBrief(text), expected, text);
    }
  });

  it("keeps a count the user asks for inside a clause that also names a reference", () => {
    for (const text of [
      "按附件模板的配色、字体和 Logo 做一份 3 页公司介绍。",
      "参考附件的风格做 3 页",
      "参考稿 12 页做 3 页",
    ]) {
      assert.deepEqual(pageCountRequirementFromBrief(text), { kind: "exact", count: 3 }, text);
    }
  });

  it("does not let a reference clause hide the ordinal rule or the page order", () => {
    assert.deepEqual(
      pageCountRequirementFromBrief("参考稿约 12 页。页序和职责：第 1 页结论，第 2 页证据，第 3 页行动。固定 3 页。"),
      { kind: "exact", count: 3 },
    );
  });

  it("plans against the user's total, not the reference count", () => {
    const plan = (count: number) => Array.from({ length: count }, (_, i) => ({ pageId: `p${i}` }));
    for (const count of [6, 8, 12]) {
      assert.match(
        planWriteFeedback(undefined, plan(count), "固定 7 页，参考稿为约 12 页").countMismatch ?? "",
        /固定 7 页/,
        String(count),
      );
    }
    assert.equal(planWriteFeedback(undefined, plan(7), "固定 7 页，参考稿为约 12 页").countMismatch, undefined);
    for (const count of [5, 9]) {
      assert.equal(
        planWriteFeedback(undefined, plan(count), "参考稿为 6–8 页，按当前业务内容重新组织").countMismatch,
        undefined,
        String(count),
      );
    }
  });
});
