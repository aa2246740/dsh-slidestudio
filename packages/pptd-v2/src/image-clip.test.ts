import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalWritePageIssues, isCanonicalWritePageArgs } from "./write-page-schema.js";

const CJK = /[\u4e00-\u9fff]/;
const CLIP = { viewBox: [100, 100], path: "M 50 0 L 100 50 L 50 100 L 0 50 Z" };

/** A picture as write_page receives it: plain JSON, not yet typed as a PPTD element. */
function photo(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    elementId: id,
    elementType: "image",
    bounds: [40, 40, 240, 160],
    src: "media/photo.png",
    fit: { mode: "fill" },
    ...extra,
  };
}

/** A plain rectangle whose fill is a picture. */
function imageFilled(id: string, fill: Record<string, unknown>): Record<string, unknown> {
  return {
    elementId: id,
    elementType: "shape",
    bounds: [40, 300, 200, 120],
    shapeName: "rect",
    fill,
  };
}

test("accepts preset and custom picture clips", () => {
  const preset = photo("clip-preset", { cropShape: { shapeName: "ellipse" } });
  const custom = photo("clip-custom", {
    crop: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 },
    cropShape: { shapeName: "custom", geometry: CLIP },
  });
  const args = { id: "clip-page", elements: [preset, custom] };
  assert.deepEqual(canonicalWritePageIssues(args), []);
  assert.equal(isCanonicalWritePageArgs(args), true);
});

test("refuses a custom picture clip without geometry and geometry on a preset clip, naming each element in Chinese", () => {
  const missing = photo("clip-missing", { cropShape: { shapeName: "custom" } });
  const onPreset = photo("clip-on-preset", { cropShape: { shapeName: "ellipse", geometry: CLIP } });
  const issues = canonicalWritePageIssues({ id: "clip-page", elements: [missing, onPreset] });
  assert.ok(
    issues.some((issue) => issue.includes('elementId "clip-missing"') && CJK.test(issue)),
    issues.join("\n"),
  );
  assert.ok(
    issues.some((issue) => issue.includes('elementId "clip-on-preset"') && CJK.test(issue)),
    issues.join("\n"),
  );
});

test("refuses an undrawable custom picture clip path with the Chinese path message", () => {
  const arc = photo("clip-arc", {
    cropShape: {
      shapeName: "custom",
      geometry: { viewBox: [100, 100], path: "M 0 0 A 10 10 0 0 1 20 20 Z" },
    },
  });
  const issues = canonicalWritePageIssues({ id: "clip-page", elements: [arc] });
  assert.ok(
    issues.some((issue) => issue.includes('elementId "clip-arc"') && CJK.test(issue)),
    issues.join("\n"),
  );
});

test("refuses a picture crop outside 0 to 1 or with no visible area, naming the element", () => {
  const badCrops = [{ left: -0.1 }, { right: 1.2 }, { left: 0.6, right: 0.5 }, { top: 0.5, bottom: 0.5 }];
  for (const crop of badCrops) {
    const issues = canonicalWritePageIssues({
      id: "crop-page",
      elements: [photo("crop-bad", { crop })],
    });
    assert.ok(
      issues.some((issue) => issue.includes('elementId "crop-bad"') && CJK.test(issue)),
      `${JSON.stringify(crop)} -> ${issues.join(" | ")}`,
    );
  }
});

test("accepts stretch and tile picture fills with a crop, and refuses a bad fill crop in Chinese", () => {
  const stretch = imageFilled("fill-stretch", { type: "image", src: "media/photo.png" });
  const tile = imageFilled("fill-tile", {
    type: "image",
    src: "media/photo.png",
    mode: "tile",
    crop: { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 },
  });
  const args = { id: "fill-page", elements: [stretch, tile] };
  assert.deepEqual(canonicalWritePageIssues(args), []);
  assert.equal(isCanonicalWritePageArgs(args), true);

  const badCrop = imageFilled("fill-bad-crop", {
    type: "image",
    src: "media/photo.png",
    crop: { left: 0.7, right: 0.4 },
  });
  const issues = canonicalWritePageIssues({ id: "fill-page", elements: [badCrop] });
  assert.ok(
    issues.some((issue) => issue.includes('elementId "fill-bad-crop"') && CJK.test(issue)),
    issues.join("\n"),
  );
});

test("refuses a picture fill mode other than stretch or tile", () => {
  const wrap = imageFilled("fill-wrap", { type: "image", src: "media/photo.png", mode: "wrap" });
  assert.ok(canonicalWritePageIssues({ id: "fill-page", elements: [wrap] }).length > 0);
});
