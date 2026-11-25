import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Fill } from "@open-slidestudio/pptd-v2";
import { fillCss } from "./fill-css.js";

describe("fillCss for gradients", () => {
  it("paints a gradient with one stop as that stop's solid colour, as the exporter writes it", () => {
    const fill: Fill = {
      type: "gradient",
      gradientType: "linear",
      angle: 90,
      stops: [{ position: 0, color: "#112233" }],
    };
    assert.equal(fillCss(fill, undefined), "#112233");
  });

  it("keeps a gradient with two stops as a CSS linear gradient", () => {
    const fill: Fill = {
      type: "gradient",
      gradientType: "linear",
      angle: 90,
      stops: [
        { position: 0, color: "#112233" },
        { position: 1, color: "#445566" },
      ],
    };
    assert.equal(fillCss(fill, undefined), "linear-gradient(180deg, #112233 0%, #445566 100%)");
  });

  it("gives a gradient with no stop no paint", () => {
    const fill: Fill = { type: "gradient", gradientType: "linear", angle: 0, stops: [] };
    assert.equal(fillCss(fill, undefined), undefined);
  });

  it("gives a one-stop gradient whose colour is empty no paint, not an invalid CSS gradient", () => {
    const fill: Fill = {
      type: "gradient",
      gradientType: "linear",
      angle: 0,
      stops: [{ position: 0, color: "" }],
    };
    assert.equal(fillCss(fill, undefined), undefined);
  });
});

describe("fillCss for solid fills and pictures", () => {
  it("paints a solid colour and gives an empty one no paint, as the export writes nothing for it", () => {
    const solid: Fill = { type: "solid", color: "#112233" };
    const empty: Fill = { type: "solid", color: "" };
    assert.equal(fillCss(solid, undefined), "#112233");
    assert.equal(fillCss(empty, undefined), undefined);
  });

  it("keeps the picture placeholder colour a picture fill paints when it cannot be drawn", () => {
    const picture: Fill = { type: "image", src: "media/photo.png" };
    assert.equal(fillCss(picture, undefined), "#E5E7EB");
  });
});
