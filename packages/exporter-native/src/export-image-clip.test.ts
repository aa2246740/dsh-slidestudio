import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  titleOnlyCoverPage,
  type PptdElement,
  type PptdProject,
} from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "./export-pptd.js";
import { assertWellFormedXml } from "./xml-lint.js";

/** A 1 × 1 PNG: the bytes the asset must keep through the export. */
const PHOTO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const CLIP_PATH = "M 50 0 L 100 50 L 50 100 L 0 50 Z";

/** Elements are written as plain JSON, the way the write path stores them. */
function clipProject(elements: Record<string, unknown>[]): PptdProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-image-clip-"));
  const project = createEmptyProject(dir, { title: "图片裁切" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("图片裁切"));
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.writeFileSync(path.join(dir, "media", "photo.png"), PHOTO_PNG);
  project.pages[0]!.page.elements = elements as unknown as PptdElement[];
  saveProject(project);
  return project;
}

async function exported(elements: Record<string, unknown>[]) {
  const result = await exportProjectToPptx(clipProject(elements));
  const zip = await JSZip.loadAsync(result.data);
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  const rels = await zip.file("ppt/slides/_rels/slide1.xml.rels")!.async("string");
  return { result, zip, xml, rels };
}

/** The whole `<p:sp>` or `<p:pic>` whose cNvPr name is `name`, so counts never leak across objects. */
function elementByName(xml: string, tag: "sp" | "pic", name: string): string | undefined {
  return [...xml.matchAll(new RegExp(`<p:${tag}>[\\s\\S]*?<\\/p:${tag}>`, "g"))]
    .map((match) => match[0])
    .find((block) => block.includes(`name="${name}"`));
}

/** Count a DrawingML path command such as moveTo, lnTo, close. */
function commandCount(shape: string, command: string): number {
  return (shape.match(new RegExp(`<a:${command}(?=[\\s/>])`, "g")) ?? []).length;
}

/** Assert srcRect l/t/r/b equal the expected values in 1/1000 % (±1). */
function assertSrcRect(block: string, expected: { l: number; t: number; r: number; b: number }): void {
  const rect = block.match(/<a:srcRect\b[^>]*\/>/)?.[0];
  assert.ok(rect, "a:srcRect is present");
  for (const side of ["l", "t", "r", "b"] as const) {
    const value = Number(rect.match(new RegExp(`\\s${side}="(-?\\d+)"`))?.[1]);
    assert.ok(Math.abs(value - expected[side]) <= 1, `srcRect ${side}=${value} should equal ${expected[side]} (±1)`);
  }
}

/** Resolve a relationship id through the slide rels to the packaged media bytes. */
async function mediaForRelationship(zip: JSZip, rels: string, rId: string): Promise<Buffer> {
  const relationships = [...rels.matchAll(/<Relationship\b[^>]*\/>/g)].map((m) => m[0]);
  const rel = relationships.find((tag) => tag.includes(`Id="${rId}"`));
  assert.ok(rel, `relationship ${rId} exists in slide rels`);
  const target = rel.match(/Target="([^"]+)"/)?.[1] ?? "";
  assert.ok(target.startsWith("../media/"), `${rId} targets packaged media: ${target}`);
  const part = zip.file(path.posix.normalize(path.posix.join("ppt/slides", target)));
  assert.ok(part, `${target} is packaged`);
  return Buffer.from(await part.async("uint8array"));
}

const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

function lintXml(xml: string, label: string): void {
  assertWellFormedXml(xml, label);
}

describe("preset cropShape export (VAL-PPTD-005)", () => {
  const PRESETS = ["ellipse", "roundRect", "hexagon"] as const;
  for (const shapeName of PRESETS) {
    it(`exports a ${shapeName} crop as prstGeom ${shapeName} with the crop as srcRect`, async () => {
      const { xml, result } = await exported([
        {
          elementId: `photo-${shapeName}`,
          elementType: "image",
          src: "media/photo.png",
          bounds: [40, 40, 240, 160],
          fit: { mode: "fill" },
          crop: { left: 0.1, top: 0.2, right: 0.05, bottom: 0.25 },
          cropShape: { shapeName },
        },
      ]);
      const pic = elementByName(xml, "pic", `photo-${shapeName}`);
      assert.ok(pic, "the cropped image stays a picture object");
      assert.match(pic, new RegExp(`<a:prstGeom prst="${shapeName}">`));
      assert.doesNotMatch(pic, /<a:prstGeom prst="rect">/);
      assertSrcRect(pic, { l: 10000, t: 20000, r: 5000, b: 25000 });
      assert.deepEqual(result.report.degradations, []);
      lintXml(xml, "slide1.xml");
    });
  }
});

describe("image clipped by a custom path (VAL-PPTD-004)", () => {
  it("exports one p:sp with custGeom and a blipFill whose blip resolves to the asset", async () => {
    const { xml, zip, rels } = await exported([
      {
        elementId: "clip-photo",
        elementType: "image",
        src: "media/photo.png",
        bounds: [40, 40, 200, 200],
        fit: { mode: "fill" },
        crop: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 },
        cropShape: {
          shapeName: "custom",
          geometry: { viewBox: [100, 100], path: CLIP_PATH },
        },
      },
    ]);
    assert.equal(elementByName(xml, "pic", "clip-photo"), undefined, "no picture object remains");
    const shape = elementByName(xml, "sp", "clip-photo");
    assert.ok(shape, "the clipped image is one p:sp");
    assert.equal((shape.match(/<a:custGeom>/g) ?? []).length, 1);
    assert.match(shape, /<a:path w="100" h="100">/);
    assert.equal(commandCount(shape, "moveTo"), 1);
    assert.equal(commandCount(shape, "lnTo"), 3);
    assert.equal(commandCount(shape, "close"), 1);
    const spPr = shape.match(/<p:spPr>[\s\S]*?<\/p:spPr>/)?.[0] ?? "";
    assert.doesNotMatch(spPr, /<a:solidFill>/, "the fill is the picture, not a solid colour");
    assert.ok(spPr.indexOf("<a:custGeom>") < spPr.indexOf("<a:blipFill"), "a:blipFill follows a:custGeom in p:spPr");
    const blipFill = spPr.match(/<a:blipFill\b[\s\S]*?<\/a:blipFill>/)?.[0] ?? "";
    assertSrcRect(blipFill, { l: 10000, t: 10000, r: 10000, b: 10000 });
    const rId = blipFill.match(/<a:blip r:embed="([^"]+)"/)?.[1];
    assert.ok(rId, "the blipFill names its picture by relationship id");
    assert.equal(sha256(await mediaForRelationship(zip, rels, rId)), sha256(PHOTO_PNG));
    lintXml(xml, "slide1.xml");
  });

  it("degrades an undrawable clip path to the plain picture and reports shape-as-rect", async () => {
    const { xml, result } = await exported([
      {
        elementId: "arc-clip",
        elementType: "image",
        src: "media/photo.png",
        bounds: [40, 40, 200, 200],
        fit: { mode: "fill" },
        cropShape: {
          shapeName: "custom",
          geometry: { viewBox: [100, 100], path: "M 0 0 A 10 10 0 0 1 20 20 Z" },
        },
      },
    ]);
    assert.match(elementByName(xml, "pic", "arc-clip") ?? "", /<a:prstGeom prst="rect">/);
    assert.deepEqual(
      result.report.degradations.map(({ elementId, kind }) => ({ elementId, kind })),
      [{ elementId: "arc-clip", kind: "shape-as-rect" }],
    );
  });
});

describe("shape image fill export (VAL-PPTD-006)", () => {
  const fillShape = (elementId: string, fill: Record<string, unknown>) => ({
    elementId,
    elementType: "shape",
    shapeName: "rect",
    bounds: [40, 300, 200, 120],
    fill,
  });

  it("stretches the picture across the shape as a:blipFill inside p:spPr", async () => {
    const { xml, zip, rels, result } = await exported([
      fillShape("fill-stretch", { type: "image", src: "media/photo.png" }),
    ]);
    const shape = elementByName(xml, "sp", "fill-stretch");
    assert.ok(shape, "the filled shape stays one p:sp");
    const spPr = shape.match(/<p:spPr>[\s\S]*?<\/p:spPr>/)?.[0] ?? "";
    const blipFill = spPr.match(/<a:blipFill\b[\s\S]*?<\/a:blipFill>/)?.[0] ?? "";
    assert.ok(blipFill, "p:spPr carries a:blipFill");
    assert.match(blipFill, /<a:stretch><a:fillRect\/><\/a:stretch>/);
    assert.doesNotMatch(spPr, /<a:noFill\/>|<a:solidFill>/);
    assert.equal(elementByName(xml, "pic", "fill-stretch"), undefined);
    const rId = blipFill.match(/<a:blip r:embed="([^"]+)"/)?.[1];
    assert.ok(rId);
    assert.equal(sha256(await mediaForRelationship(zip, rels, rId)), sha256(PHOTO_PNG));
    assert.deepEqual(result.report.degradations, []);
    lintXml(xml, "slide1.xml");
  });

  it("tiles the picture with a:tile when the fill mode is tile", async () => {
    const { xml } = await exported([fillShape("fill-tile", { type: "image", src: "media/photo.png", mode: "tile" })]);
    const blipFill = elementByName(xml, "sp", "fill-tile")?.match(/<a:blipFill\b[\s\S]*?<\/a:blipFill>/)?.[0] ?? "";
    assert.match(blipFill, /<a:tile\b[^>]*\/>/);
    assert.doesNotMatch(blipFill, /<a:stretch>/);
  });

  it("writes the fill crop as a:srcRect on the fill's blip", async () => {
    const { xml } = await exported([
      fillShape("fill-crop", {
        type: "image",
        src: "media/photo.png",
        crop: { left: 0.2, top: 0.1, right: 0.1, bottom: 0.3 },
      }),
    ]);
    const blipFill = elementByName(xml, "sp", "fill-crop")?.match(/<a:blipFill\b[\s\S]*?<\/a:blipFill>/)?.[0] ?? "";
    assertSrcRect(blipFill, { l: 20000, t: 10000, r: 10000, b: 30000 });
  });
});

/** The a:blip of a picture fill: self-closing, or with effects such as a:alphaModFix inside it. */
function blipOf(block: string): string | undefined {
  return block.match(/<a:blip\b[^>]*\/>/)?.[0] ?? block.match(/<a:blip\b[^>]*>[\s\S]*?<\/a:blip>/)?.[0];
}

describe("image-filled shape opacity (M5-SCR-005)", () => {
  const photoShape = (elementId: string, extra: Record<string, unknown> = {}) => ({
    elementId,
    elementType: "shape",
    shapeName: "rect",
    bounds: [40, 300, 200, 120],
    fill: { type: "image", src: "media/photo.png" },
    ...extra,
  });
  const solidSibling = {
    elementId: "solid-sibling",
    elementType: "shape",
    shapeName: "rect",
    bounds: [300, 300, 200, 120],
    fill: { type: "solid", color: "#2563EB" },
  };

  it("an image-filled shape at opacity 0 with no border exports with the rest of the deck", async () => {
    const { xml, result } = await exported([photoShape("fill-hidden", { opacity: 0 }), solidSibling]);

    assert.equal(elementByName(xml, "sp", "fill-hidden"), undefined, "no visible paint, no shape");
    assert.equal(elementByName(xml, "pic", "fill-hidden-image-fill"), undefined, "no stray carrier");
    assert.ok(elementByName(xml, "sp", "solid-sibling"), "the rest of the deck still exports");
    assert.deepEqual(
      result.report.degradations.filter((degradation) => degradation.kind === "error"),
      [],
    );
    lintXml(xml, "slide1.xml");
  });

  it("writes the element opacity 0.3 as a:alphaModFix amt=30000 on the fill's a:blip", async () => {
    const { xml, zip, rels, result } = await exported([photoShape("fill-translucent", { opacity: 0.3 })]);
    const shape = elementByName(xml, "sp", "fill-translucent");
    assert.ok(shape, "the translucent shape stays one p:sp");
    const blip = blipOf(shape.match(/<a:blipFill\b[\s\S]*?<\/a:blipFill>/)?.[0] ?? "");

    assert.ok(blip, "the fill carries an a:blip");
    assert.match(blip, /<a:alphaModFix amt="30000"\/>/);
    const rId = blip.match(/<a:blip\b[^>]*\br:embed="([^"]+)"/)?.[1];
    assert.ok(rId);
    assert.equal(sha256(await mediaForRelationship(zip, rels, rId)), sha256(PHOTO_PNG));
    assert.deepEqual(result.report.degradations, []);
    lintXml(xml, "slide1.xml");
  });

  it("writes no alpha on an opaque image fill", async () => {
    const { xml } = await exported([photoShape("fill-opaque")]);
    const blip = blipOf(
      elementByName(xml, "sp", "fill-opaque")?.match(/<a:blipFill\b[\s\S]*?<\/a:blipFill>/)?.[0] ?? "",
    );

    assert.ok(blip);
    assert.doesNotMatch(blip, /alphaModFix/);
  });

  it("keeps a bordered shape at opacity 0 drawn, with its picture fully transparent", async () => {
    const { xml } = await exported([
      photoShape("fill-bordered", {
        opacity: 0,
        border: { color: "#111111", width: 2 },
      }),
    ]);
    const shape = elementByName(xml, "sp", "fill-bordered");
    assert.ok(shape, "the outline keeps the shape in the deck");
    const blip = blipOf(shape.match(/<a:blipFill\b[\s\S]*?<\/a:blipFill>/)?.[0] ?? "");

    assert.match(blip ?? "", /<a:alphaModFix amt="0"\/>/);
    lintXml(xml, "slide1.xml");
  });
});
