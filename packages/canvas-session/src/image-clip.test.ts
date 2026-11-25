import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  titleOnlyCoverPage,
  type PptdElement,
  type PptdProject,
} from "@open-slidestudio/pptd-v2";
import { openSession, renderModel } from "./index.js";

/** A 1 × 1 PNG, so the render model can read a natural size for tiled fills. */
const PHOTO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const CLIP_PATH = "M 50 0 L 100 50 L 50 100 L 0 50 Z";

function coverProject(dir: string, elements: PptdElement[]): PptdProject {
  const project = createEmptyProject(dir, { title: "图片裁切" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("图片裁切"));
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.writeFileSync(path.join(dir, "media", "photo.png"), PHOTO_PNG);
  project.pages[0]!.page.elements = elements;
  saveProject(project);
  return project;
}

function renderedElements(elements: PptdElement[]): Record<string, unknown>[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-image-clip-"));
  coverProject(dir, elements);
  const session = openSession(dir);
  return renderModel(session).elements as unknown as Record<string, unknown>[];
}

const picture = (elementId: string, extra: Record<string, unknown>): PptdElement =>
  ({
    elementId,
    elementType: "image",
    bounds: [60, 80, 160, 80],
    src: "media/photo.png",
    fit: { mode: "fill" },
    ...extra,
  }) as unknown as PptdElement;

describe("picture clip render model (VAL-PPTD-004, VAL-PPTD-005)", () => {
  it("scales a custom clip path to the element box as a CSS clip-path", () => {
    const [clipped] = renderedElements([
      picture("clip-custom", {
        cropShape: {
          shapeName: "custom",
          geometry: { viewBox: [100, 100], path: CLIP_PATH },
        },
      }),
    ]);
    // Element 160 × 80 px: x scales by 1.6 and y by 0.8 from the 100 × 100 viewBox.
    assert.equal(clipped?.clipPath, 'path("M 80 0 L 160 40 L 80 80 L 0 40 Z")');
  });

  it("gives a preset clip the catalogue geometry at the element size", () => {
    const [clipped] = renderedElements([picture("clip-ellipse", { cropShape: { shapeName: "ellipse" } })]);
    assert.equal(clipped?.cropShape && (clipped.cropShape as { shapeName: string }).shapeName, "ellipse");
    assert.match(String(clipped?.clipPath), /^path\("M /);
    // The catalogue ellipse is a 100-unit box with radius 50; a 160 × 80 px box halves y and widens x.
    assert.match(String(clipped?.clipPath), /A 80 40 0 0 1 80 0 /, "arc radii scale to the box");
  });

  it("leaves an unclipped picture without a clip path", () => {
    const [plain] = renderedElements([picture("plain", {})]);
    assert.equal(plain?.clipPath, undefined);
  });

  it("falls back to the plain picture when a stored custom clip cannot be drawn", () => {
    const [arc] = renderedElements([
      picture("clip-arc", {
        cropShape: {
          shapeName: "custom",
          geometry: { viewBox: [100, 100], path: "M 0 0 A 10 10 0 0 1 20 20 Z" },
        },
      }),
    ]);
    assert.equal(arc?.clipPath, undefined);
  });
});

describe("picture fill render model (VAL-PPTD-006)", () => {
  const filled = (fill: Record<string, unknown>): PptdElement =>
    ({
      elementId: "fill-shape",
      elementType: "shape",
      shapeName: "rect",
      bounds: [40, 300, 200, 120],
      fill,
    }) as unknown as PptdElement;

  it("keeps a stretched picture fill as a source plus mode, never as a url() paint", () => {
    const [shape] = renderedElements([filled({ type: "image", src: "media/photo.png" })]);
    assert.deepEqual(shape?.imageFill, { src: "media/photo.png", mode: "stretch" });
    assert.doesNotMatch(String(shape?.fillCss), /url\(/);
  });

  it("carries a tile mode with a fill crop and the natural tile size in the preset box", () => {
    // A 1 px picture in a 200 × 120 px preset box spans 100 / 200 and 100 / 120 of the 100-unit box.
    const [shape] = renderedElements([
      filled({
        type: "image",
        src: "media/photo.png",
        mode: "tile",
        crop: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 },
      }),
    ]);
    assert.deepEqual(shape?.imageFill, {
      src: "media/photo.png",
      mode: "tile",
      crop: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 },
      tile: [0.5, 100 / 120],
    });
  });

  it("maps a tile into a custom path's viewBox rather than raw pixels", () => {
    // The 200 × 100 viewBox fills the 200 × 120 px box: 1 px is 1 unit across and 100 / 120 down.
    const [shape] = renderedElements([
      {
        elementId: "custom-fill-shape",
        elementType: "shape",
        shapeName: "custom",
        geometry: { viewBox: [200, 100], path: "M 0 0 L 200 0 L 200 100 Z" },
        bounds: [40, 300, 200, 120],
        fill: { type: "image", src: "media/photo.png", mode: "tile" },
      } as unknown as PptdElement,
    ]);
    assert.deepEqual(shape?.imageFill, {
      src: "media/photo.png",
      mode: "tile",
      tile: [1, 100 / 120],
    });
  });
});
