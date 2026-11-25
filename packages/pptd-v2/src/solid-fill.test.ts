import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Fill } from "./types.js";
import { opaqueSolidHex, solidFillColor } from "./solid-fill.js";
import { shapePaintFill, solidFillPaint } from "./theme.js";

const solid = (color: string): Fill => ({ type: "solid", color }) as Fill;
const gradient = (stops: { position: number; color: string; alpha?: number }[]): Fill =>
  ({ type: "gradient", gradientType: "linear", angle: 0, stops }) as Fill;
const picture: Fill = { type: "image", src: "media/photo.png" } as Fill;

describe("solidFillColor: the one solid colour a fill shows", () => {
  it("is the colour of a solid fill, and of an untyped fill that has a colour", () => {
    assert.equal(solidFillColor(solid("#112233")), "#112233");
    assert.equal(solidFillColor({ color: "#445566" }), "#445566");
  });

  it("is the one stop's colour for a gradient with exactly one stop", () => {
    assert.equal(solidFillColor(gradient([{ position: 0, color: "#112233" }])), "#112233");
  });

  it("is undefined for a gradient with two or more stops, a zero-stop gradient and a picture", () => {
    const two = gradient([
      { position: 0, color: "#112233" },
      { position: 1, color: "#FFFFFF" },
    ]);
    assert.equal(solidFillColor(two), undefined);
    assert.equal(solidFillColor(gradient([])), undefined);
    assert.equal(solidFillColor(picture), undefined);
  });

  it("is undefined for no fill, an empty colour and a one-stop gradient without a colour", () => {
    assert.equal(solidFillColor(undefined), undefined);
    assert.equal(solidFillColor(solid("")), undefined);
    assert.equal(solidFillColor(gradient([{ position: 0, color: "" }])), undefined);
  });
});

describe("opaqueSolidHex: the surface a plain panel gives a chart", () => {
  it("is the hex of an opaque solid fill and of a one-stop gradient", () => {
    assert.equal(opaqueSolidHex(solid("#112233")), "#112233");
    assert.equal(opaqueSolidHex(gradient([{ position: 0, color: "#112233" }])), "#112233");
  });

  it("is undefined for a translucent colour, which is not a surface", () => {
    assert.equal(opaqueSolidHex(solid("#11223380")), undefined);
    assert.equal(opaqueSolidHex(gradient([{ position: 0, color: "#11223380" }])), undefined);
  });

  it("is undefined for a picture, a multi-stop gradient and no fill", () => {
    assert.equal(opaqueSolidHex(picture), undefined);
    assert.equal(
      opaqueSolidHex(
        gradient([
          { position: 0, color: "#112233" },
          { position: 1, color: "#FFFFFF" },
        ]),
      ),
      undefined,
    );
    assert.equal(opaqueSolidHex(undefined), undefined);
  });
});

describe("solidFillPaint and shapePaintFill share the one colour", () => {
  it("paints a one-stop gradient as its stop, with element opacity applied", () => {
    const paint = solidFillPaint(gradient([{ position: 0, color: "#112233" }]), 0.5);
    assert.deepEqual(paint, { type: "solid", hex: "#112233", alpha: 0.5 });
  });

  it("gives no solid paint to a two-stop gradient, which keeps its first stop as the degrade paint", () => {
    const two = gradient([
      { position: 0, color: "#112233" },
      { position: 1, color: "#FFFFFF" },
    ]);
    assert.equal(solidFillPaint(two), undefined);
    assert.deepEqual(shapePaintFill(two), { hex: "#112233", alpha: 1 });
  });
});
