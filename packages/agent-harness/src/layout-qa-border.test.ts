import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PptdElement } from "@open-slidestudio/pptd-v2";
import { reviewSkillPages } from "./layout-qa.js";
import type { SkillPageInput } from "./skill-pages.js";

const title: PptdElement = {
  elementId: "title",
  elementType: "text",
  bounds: [40, 20, 880, 40],
  content: { text: "决策矩阵", fontSize: 28, color: "#111111" },
} as PptdElement;

/** Four cells that carry only a border; `width` is set only when given. */
function borderedMatrix(border: { color: string; width?: number }): SkillPageInput {
  return {
    id: "bordered-matrix",
    elements: [
      title,
      ...[0, 1, 2, 3].map(
        (index): PptdElement =>
          ({
            elementId: `cell-${index}`,
            elementType: "shape",
            exhibitRole: "matrix",
            shapeName: "rect",
            bounds: [100 + (index % 2) * 220, 120 + Math.floor(index / 2) * 120, 200, 100],
            border,
          }) as PptdElement,
      ),
      ...["投入", "收益"].map(
        (text, index): PptdElement =>
          ({
            elementId: `label-${index}`,
            elementType: "text",
            exhibitRole: "matrix",
            bounds: [120 + index * 220, 140, 100, 24],
            content: { text },
          }) as PptdElement,
      ),
    ],
  };
}

const matrixTodo = [{ title: "决策", exhibits: ["diagram:matrix" as const] }];

describe("coloured borders without a stored width (agent-harness)", () => {
  it("count as a visible 1 px cell, the width the canvas and export draw", () => {
    const review = reviewSkillPages([borderedMatrix({ color: "#111111" })], {
      mode: "compose",
      todos: matrixTodo,
    });
    assert.equal(
      review.issues.some((issue) => issue.code === "missing_requested_exhibit"),
      false,
      JSON.stringify(review.issues),
    );
  });

  it("stay invisible when the stored width is an explicit 0", () => {
    const review = reviewSkillPages([borderedMatrix({ color: "#111111", width: 0 })], {
      mode: "compose",
      todos: matrixTodo,
    });
    assert.ok(
      review.issues.some((issue) => issue.code === "missing_requested_exhibit"),
      JSON.stringify(review.issues),
    );
  });
});
