import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Fill, Page, PptdElement } from "@open-slidestudio/pptd-v2";
import { insertedChartFill, renderPageSurface } from "./page-surface.js";

/*
 * M5-SCR-R3-001 on the page: a full-page plain rectangle stands in for the page surface when its
 * fill is one solid colour or a gradient of two or more stops, as the export's pageSurfaceColor
 * reads it. A picture backdrop is not a surface, so the page background shows.
 */
const SIZE: [number, number] = [960, 540];
const THEME = undefined;
const WHITE = "#FFFFFF";
const PAGE_WHITE = "#ffffff";

function backdrop(fill: Fill): PptdElement {
  return {
    elementId: "backdrop",
    elementType: "shape",
    shapeName: "rect",
    bounds: [0, 0, 960, 540],
    fill,
  };
}

function page(elements: PptdElement[], background?: Fill): Page {
  return { elements, background };
}

const gradient = (stops: { position: number; color: string }[]): Fill => ({
  type: "gradient",
  gradientType: "linear",
  angle: 0,
  stops,
});

describe("renderPageSurface: the page surface the editor paints", () => {
  it("lets a solid or one-stop gradient backdrop set the page colour", () => {
    const solid = renderPageSurface(page([backdrop({ type: "solid", color: "#112233" })]), SIZE, THEME);
    const oneStop = renderPageSurface(page([backdrop(gradient([{ position: 0, color: "#445566" }]))]), SIZE, THEME);
    assert.equal(solid.backgroundCss, "#112233");
    assert.equal(oneStop.backgroundCss, "#445566");
  });

  it("keeps a two-stop gradient backdrop as a CSS gradient, which the export reads by its first stop", () => {
    const twoStops = gradient([
      { position: 0, color: "#112233" },
      { position: 1, color: "#FFFFFF" },
    ]);
    const surface = renderPageSurface(page([backdrop(twoStops)]), SIZE, THEME);
    assert.equal(surface.backgroundCss, "linear-gradient(90deg, #112233 0%, #FFFFFF 100%)");
  });

  it("gives a picture backdrop no surface, so the page background shows as the export shows it", () => {
    const picture: Fill = { type: "image", src: "media/photo.png" };
    const surface = renderPageSurface(page([backdrop(picture)], { type: "solid", color: "#223344" }), SIZE, THEME);
    assert.equal(surface.backgroundCss, "#223344");
    const onWhite = renderPageSurface(page([backdrop(picture)]), SIZE, THEME);
    assert.equal(onWhite.backgroundCss, PAGE_WHITE);
  });
});

describe("insertedChartFill: the background a new chart takes", () => {
  it("copies the solid colour of a one-stop gradient backdrop, the colour the page shows", () => {
    const fill = insertedChartFill(page([backdrop(gradient([{ position: 0, color: "#112233" }]))]), SIZE);
    assert.deepEqual(fill, { type: "solid", color: "#112233" });
  });

  it("does not copy a two-stop gradient backdrop, and falls back to the page background", () => {
    const fill = insertedChartFill(
      page(
        [
          backdrop(
            gradient([
              { position: 0, color: "#112233" },
              { position: 1, color: "#FFFFFF" },
            ]),
          ),
        ],
        { type: "solid", color: "#EEEEEE" },
      ),
      SIZE,
    );
    assert.deepEqual(fill, { type: "solid", color: "#EEEEEE" });
  });

  it("is white on a page with no solid surface", () => {
    assert.deepEqual(insertedChartFill(page([]), SIZE), { type: "solid", color: WHITE });
  });
});
