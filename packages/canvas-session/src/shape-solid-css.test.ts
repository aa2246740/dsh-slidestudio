import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Fill, ShapeElement } from "@open-slidestudio/pptd-v2";
import { shapeRenderFields } from "./shape-model.js";

/*
 * M5-SCR-R3-001: the render model's `solidCss` is the one opaque solid colour a shape's fill
 * shows (pptd-v2 `opaqueSolidHex`). A chart takes its surface from it, so the editor and the
 * export read the same colour for the same panel.
 */
function panel(fill: Fill | undefined): ShapeElement {
  return {
    elementId: "panel",
    elementType: "shape",
    shapeName: "rect",
    bounds: [0, 0, 100, 60],
    fill,
  };
}

describe("shapeRenderFields solidCss", () => {
  it("is the colour of an opaque solid fill, which is also its fillCss", () => {
    const fields = shapeRenderFields(panel({ type: "solid", color: "#112233" }), undefined);
    assert.equal(fields.solidCss, "#112233");
    assert.equal(fields.fillCss, "#112233");
  });

  it("is the colour of a gradient with exactly one stop, as the export writes it", () => {
    const fill: Fill = {
      type: "gradient",
      gradientType: "linear",
      angle: 0,
      stops: [{ position: 0, color: "#112233" }],
    };
    assert.equal(shapeRenderFields(panel(fill), undefined).solidCss, "#112233");
  });

  it("is unset for a gradient of two stops, a translucent fill, a picture and no fill", () => {
    const twoStops: Fill = {
      type: "gradient",
      gradientType: "linear",
      angle: 0,
      stops: [
        { position: 0, color: "#112233" },
        { position: 1, color: "#FFFFFF" },
      ],
    };
    const picture: Fill = { type: "image", src: "media/photo.png" };
    const translucent: Fill = { type: "solid", color: "#11223380" };
    assert.equal(shapeRenderFields(panel(twoStops), undefined).solidCss, undefined);
    assert.equal(shapeRenderFields(panel(translucent), undefined).solidCss, undefined);
    assert.equal(shapeRenderFields(panel(picture), undefined).solidCss, undefined);
    assert.equal(shapeRenderFields(panel(undefined), undefined).solidCss, undefined);
  });
});
