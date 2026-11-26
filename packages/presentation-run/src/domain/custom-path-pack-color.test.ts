import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Fill } from "@open-slidestudio/pptd-v2";
import { writePageSchemaError, writePageSchemaIssues } from "./layout-qa.js";
import type { SkillPageInput } from "./skill-pages.js";
import { packColorWriteContextFrom, PACK_COLOR_ERROR } from "./theme-pack.js";

const pine = () => packColorWriteContextFrom({ designSystemId: "consulting/pine-green-strategy" });

/** A custom path whose only colours sit in its fill. The geometry carries no colour. */
function customPathPage(fill: Fill): SkillPageInput {
  return {
    id: "custom-path",
    pageType: "content",
    elements: [
      {
        elementId: "wave",
        elementType: "shape",
        bounds: [40, 80, 400, 200],
        shapeName: "custom",
        geometry: { viewBox: [100, 50], path: "M 0 25 C 25 0 75 50 100 25 Z" },
        fill,
      },
      {
        elementId: "title",
        elementType: "text",
        bounds: [40, 24, 600, 40],
        content: { text: "自定义路径色板检查", fontSize: 24 },
      },
    ],
  };
}

describe("custom path colours follow pack_color", () => {
  it("refuses a gradient stop outside the adopted palette exactly like a solid fill", () => {
    const gradient: Fill = {
      type: "gradient",
      gradientType: "linear",
      angle: 90,
      stops: [
        { position: 0, color: "#03522C" },
        { position: 1, color: "#3366FF" },
      ],
    };
    const page = customPathPage(gradient);
    const error = writePageSchemaError(writePageSchemaIssues(page, pine()), page, pine());
    assert.equal(error?.error, PACK_COLOR_ERROR);
    assert.match(error?.detail ?? "", /#3366FF/);

    const solid = customPathPage({ type: "solid", color: "#3366FF" });
    const solidError = writePageSchemaError(writePageSchemaIssues(solid, pine()), solid, pine());
    assert.equal(solidError?.error, PACK_COLOR_ERROR);
  });

  it("accepts gradient stops that come from the adopted palette", () => {
    const page = customPathPage({
      type: "gradient",
      gradientType: "linear",
      angle: 90,
      stops: [
        { position: 0, color: "#03522C" },
        { position: 1, color: "#03522C" },
      ],
    });
    assert.equal(
      writePageSchemaIssues(page, pine()).some((issue) => issue.code === "pack_color"),
      false,
    );
  });
});
