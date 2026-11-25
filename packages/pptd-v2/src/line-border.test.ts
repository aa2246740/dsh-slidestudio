import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UNSTYLED_LINE_COLOR, UNSTYLED_LINE_WIDTH, resolvedLineBorder, unstyledLineColor } from "./line-border.js";

describe("unstyled line border (ruling 112)", () => {
  it("is 2 px, the unit border.width uses for every element kind", () => {
    assert.equal(UNSTYLED_LINE_WIDTH, 2);
    assert.equal(UNSTYLED_LINE_COLOR, "#111111");
  });

  it("resolves a bare line to the theme primary at 2 px", () => {
    assert.deepEqual(resolvedLineBorder(undefined, { colors: { primary: "#2563EB" } }), {
      color: "#2563EB",
      width: 2,
    });
    assert.equal(unstyledLineColor({ colors: { primary: "#2563EB" } }), "#2563EB");
  });

  it("resolves a theme-token colour to the hex the export writes, so the editor paints it (M5-SCR-004)", () => {
    assert.deepEqual(resolvedLineBorder({ color: "$primary", width: 3 }, { colors: { primary: "#D97757" } }), {
      color: "#D97757",
      width: 3,
    });
    assert.deepEqual(resolvedLineBorder({ color: "#00aa00AA" }, undefined), {
      color: "#00AA00",
      width: 2,
    });
  });

  it("keeps an explicit colour and width, and falls back to #111111 for an invalid primary", () => {
    assert.deepEqual(resolvedLineBorder({ width: 3, color: "#00AA00" }, { colors: { primary: "#2563EB" } }), {
      width: 3,
      color: "#00AA00",
    });
    assert.deepEqual(resolvedLineBorder(undefined, { colors: { primary: "2563EB" } }), {
      color: "#111111",
      width: 2,
    });
  });
});
