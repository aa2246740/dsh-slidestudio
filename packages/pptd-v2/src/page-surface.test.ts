import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PICTURE_SURFACE_COLOR, pageSurface } from "./page-surface.js";
import { elementFillPaint } from "./theme.js";
import type { Fill, Page, PptdElement } from "./types.js";

/*
 * Ruling 131: one page-surface rule for the editor and the export. The editor paints the surface
 * it gets from here, and the exporter reads its chart ink from the same surface.
 */
const SIZE: [number, number] = [960, 540];
const PHOTO: Fill = { type: "image", src: "media/photo.png" };

function backdrop(fill: Fill): PptdElement {
  return {
    elementId: "backdrop",
    elementType: "shape",
    shapeName: "rect",
    bounds: [0, 0, 960, 540],
    fill,
  } as PptdElement;
}

function page(elements: PptdElement[], background?: Fill): Pick<Page, "elements" | "background"> {
  return { elements, background };
}

const gradient = (stops: { position: number; color: string }[]): Fill =>
  ({ type: "gradient", gradientType: "linear", angle: 0, stops }) as Fill;

describe("pageSurface: the one rule the editor and the export share", () => {
  it("takes a picture page background as the #111111 placeholder surface", () => {
    assert.equal(PICTURE_SURFACE_COLOR, "#111111");
    assert.deepEqual(pageSurface(page([], PHOTO), SIZE), {
      fill: { type: "solid", color: "#111111" },
      from: "background",
    });
  });

  it("takes a picture background inherited from a layout the same way", () => {
    // Saving a page materialises the layout's picture as its background, with the inherited flag.
    const inherited: Page = { elements: [], background: PHOTO, backgroundInherited: true };
    assert.deepEqual(pageSurface(inherited, SIZE), {
      fill: { type: "solid", color: "#111111" },
      from: "background",
    });
  });

  it("lets a solid, one-stop or two-stop gradient backdrop be the surface", () => {
    const solid = { type: "solid", color: "#112233" } as Fill;
    const oneStop = gradient([{ position: 0, color: "#445566" }]);
    const twoStops = gradient([
      { position: 0, color: "#112233" },
      { position: 1, color: "#FFFFFF" },
    ]);
    assert.deepEqual(pageSurface(page([backdrop(solid)]), SIZE), { fill: solid, from: "backdrop" });
    assert.deepEqual(pageSurface(page([backdrop(oneStop)]), SIZE), {
      fill: oneStop,
      from: "backdrop",
    });
    assert.deepEqual(pageSurface(page([backdrop(twoStops)]), SIZE), {
      fill: twoStops,
      from: "backdrop",
    });
  });

  it("gives a picture backdrop no surface, so the page background shows through", () => {
    const solidBackground = { type: "solid", color: "#223344" } as Fill;
    assert.deepEqual(pageSurface(page([backdrop(PHOTO)], solidBackground), SIZE), {
      fill: solidBackground,
      from: "background",
    });
    assert.equal(pageSurface(page([backdrop(PHOTO)]), SIZE), undefined);
  });

  it("keeps a solid page background as a solid fill, including the untyped legacy form", () => {
    const typed = { type: "solid", color: "#445566" } as Fill;
    const untyped = { color: "#445566" } as unknown as Fill;
    const expected = { fill: { type: "solid", color: "#445566" }, from: "background" };
    assert.deepEqual(pageSurface(page([], typed), SIZE), expected);
    assert.deepEqual(pageSurface(page([], untyped), SIZE), expected);
  });

  it("keeps a two-stop page gradient as the surface and gives a gradient without stops none", () => {
    const twoStops = gradient([
      { position: 0, color: "#07111F" },
      { position: 1, color: "#DCE8F5" },
    ]);
    assert.deepEqual(pageSurface(page([], twoStops), SIZE), {
      fill: twoStops,
      from: "background",
    });
    assert.equal(pageSurface(page([], gradient([])), SIZE), undefined);
  });

  it("shows white when the page has no background and no surface backdrop", () => {
    assert.equal(pageSurface(page([]), SIZE), undefined);
    assert.equal(pageSurface(page([], { type: "solid", color: "" } as Fill), SIZE), undefined);
  });
});

describe("the surface paint the exporter reads its chart ink from", () => {
  it("paints a solid surface as its colour, and a gradient as its first stop", () => {
    const solid = pageSurface(page([], { type: "solid", color: "#112233" } as Fill), SIZE);
    const twoStops = pageSurface(
      page(
        [],
        gradient([
          { position: 0, color: "#07111F" },
          { position: 1, color: "#DCE8F5" },
        ]),
      ),
      SIZE,
    );
    assert.deepEqual(solid && elementFillPaint("shape", solid.fill), {
      type: "solid",
      hex: "#112233",
      alpha: 1,
    });
    assert.deepEqual(twoStops && elementFillPaint("shape", twoStops.fill), {
      type: "solid",
      hex: "#07111F",
      alpha: 1,
    });
  });

  it("paints a picture surface as the placeholder colour", () => {
    const picture = pageSurface(page([], PHOTO), SIZE);
    assert.deepEqual(picture && elementFillPaint("shape", picture.fill), {
      type: "solid",
      hex: "#111111",
      alpha: 1,
    });
  });
});
