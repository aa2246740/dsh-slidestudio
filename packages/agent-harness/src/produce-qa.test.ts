import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { qaPaintedPage, qaScriptFidelity, repairPaintedPage } from "./produce-qa.js";
import type { HostPageCopy } from "./exhibit-paint.js";
import type { SkillPageInput } from "./skill-pages.js";

describe("produce QA", () => {
  it("flags overflow and clamps it", () => {
    const page: SkillPageInput = {
      id: "p",
      pageType: "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [40, 500, 980, 80],
          content: { text: "overflow", fontSize: 20 },
        },
      ],
    };
    assert.ok(qaPaintedPage(page).some((i) => i.code === "overflow"));
    const fixed = repairPaintedPage(page);
    assert.ok(fixed.elements[0]!.bounds[0] + fixed.elements[0]!.bounds[2] <= 960);
    assert.ok(fixed.elements[0]!.bounds[1] + fixed.elements[0]!.bounds[3] <= 540);
    assert.equal(
      qaPaintedPage(fixed).some((i) => i.code === "overflow"),
      false,
    );
  });

  it("flags a dropped locked number", () => {
    const scripted: HostPageCopy[] = [
      {
        id: "a",
        pageType: "content",
        title: "利润表",
        lines: ["营业收入 12,860 万"],
        body: "营业收入 12,860 / 12,110",
      },
    ];
    const painted: SkillPageInput[] = [
      {
        id: "a",
        pageType: "content",
        elements: [
          {
            elementId: "title",
            elementType: "text",
            bounds: [40, 40, 400, 40],
            content: { text: "利润表 大约1.3亿", fontSize: 20 },
          },
        ],
      },
    ];
    assert.ok(qaScriptFidelity(painted, scripted).some((i) => i.code === "missing_number"));
  });
});
