import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/** A 1 × 1 PNG; the bytes must survive the export unchanged. */
const PHOTO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const CLIP_PATH = "M 50 0 L 100 50 L 50 100 L 0 50 Z";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Four picture kinds with no alt text: plain, custom-clipped, preset-cropped, shape image fill. */
function fourKindProject(): PptdProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-picture-alt-"));
  const project = createEmptyProject(dir, { title: "图片说明" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("图片说明"));
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.writeFileSync(path.join(dir, "media", "photo.png"), PHOTO_PNG);
  const elements: Record<string, unknown>[] = [
    {
      elementId: "pic-plain",
      elementType: "image",
      src: "media/photo.png",
      bounds: [40, 40, 200, 150],
      fit: { mode: "fill" },
    },
    {
      elementId: "pic-custom",
      elementType: "image",
      src: "media/photo.png",
      bounds: [260, 40, 200, 200],
      fit: { mode: "fill" },
      crop: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 },
      cropShape: { shapeName: "custom", geometry: { viewBox: [100, 100], path: CLIP_PATH } },
    },
    {
      elementId: "pic-ellipse",
      elementType: "image",
      src: "media/photo.png",
      bounds: [500, 40, 200, 160],
      fit: { mode: "fill" },
      crop: { left: 0.1, top: 0.2, right: 0.05, bottom: 0.25 },
      cropShape: { shapeName: "ellipse" },
    },
    {
      elementId: "fill-rect",
      elementType: "shape",
      shapeName: "rect",
      bounds: [40, 300, 200, 120],
      fill: { type: "image", src: "media/photo.png" },
    },
  ];
  project.pages[0]!.page.elements = elements as unknown as PptdElement[];
  saveProject(project);
  return project;
}

/** Speaker notes, a bar chart and a picture background, with no picture elements. */
function richProject(): PptdProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-picture-rich-"));
  const project = createEmptyProject(dir, { title: "图片说明" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("图片说明"));
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.writeFileSync(path.join(dir, "media", "photo.png"), PHOTO_PNG);
  const page = project.pages[0]!.page;
  page.background = { type: "image", src: "media/photo.png" };
  page.notes = "讲稿：开场说明";
  page.elements = [
    {
      elementId: "chart-bar",
      elementType: "chart",
      bounds: [40, 300, 500, 200],
      data: {
        cols: ["月", "收入"],
        rows: [
          ["1月", 10],
          ["2月", 20],
        ],
      },
      series: [{ type: "bar", name: "收入", encode: { x: "月", y: "收入" } }],
      legend: false,
    },
  ] as unknown as PptdElement[];
  saveProject(project);
  return project;
}

/** Every XML and relationships part, decoded, so each scan covers docProps, charts and notes too. */
async function textParts(zip: JSZip): Promise<Map<string, string>> {
  const parts = new Map<string, string>();
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name]!.dir || !/\.(?:xml|rels)$/.test(name)) continue;
    parts.set(name, await zip.file(name)!.async("string"));
  }
  return parts;
}

/** The `<p:pic>` whose cNvPr name is `name`, so attribute checks never read a neighbouring object. */
function pictureByName(xml: string, name: string): string | undefined {
  return [...xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)]
    .map((match) => match[0])
    .find((block) => block.includes(` name="${name}"`));
}

function lintXml(xml: string, label: string): void {
  assertWellFormedXml(xml, label);
}

describe("exported PPTX carries no local file-system path (VAL-PPTD-017)", () => {
  it("writes none of the project directory, repo path, /Users/, /Volumes/ or file:// into any XML or rels part", async () => {
    const project = fourKindProject();
    const result = await exportProjectToPptx(project);
    const zip = await JSZip.loadAsync(result.data);
    const forbidden = [project.rootDir, repoRoot, "/Users/", "/Volumes/", "file://"];
    const hits: string[] = [];
    for (const [name, xml] of await textParts(zip)) {
      for (const needle of forbidden) {
        if (xml.includes(needle)) hits.push(`${name} contains ${needle}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it("leaves descr absent on plain and preset-cropped pictures, and never names a file", async () => {
    const project = fourKindProject();
    const result = await exportProjectToPptx(project);
    const zip = await JSZip.loadAsync(result.data);
    const slide = await zip.file("ppt/slides/slide1.xml")!.async("string");
    for (const name of ["pic-plain", "pic-ellipse"]) {
      const pic = pictureByName(slide, name);
      assert.ok(pic, `${name} stays a picture object`);
      const cNvPr = pic.match(/<p:cNvPr\b[^>]*>/)?.[0] ?? "";
      assert.doesNotMatch(cNvPr, /\sdescr=/, `${name} carries no descr without alt text`);
    }
    assert.equal(pictureByName(slide, "pic-custom"), undefined, "custom clip is a p:sp");
    assert.doesNotMatch(slide, /descr="[^"]*(?:photo\.png|media\/)/, "no descr names a media file");
    lintXml(slide, "slide1.xml");
  });

  it("still resolves each picture through the slide rels to ppt/media/*", async () => {
    const project = fourKindProject();
    const result = await exportProjectToPptx(project);
    const zip = await JSZip.loadAsync(result.data);
    const slide = await zip.file("ppt/slides/slide1.xml")!.async("string");
    const rels = await zip.file("ppt/slides/_rels/slide1.xml.rels")!.async("string");
    for (const name of ["pic-plain", "pic-ellipse"]) {
      const rId = pictureByName(slide, name)?.match(/<a:blip r:embed="([^"]+)"/)?.[1];
      assert.ok(rId, `${name} names its picture`);
      const target = rels.match(new RegExp(`<Relationship\\b[^>]*Id="${rId}"[^>]*/>`))?.[0];
      const packaged = target?.match(/Target="\.\.\/(media\/[^"]+)"/)?.[1];
      assert.ok(packaged?.startsWith("media/"), `${name} resolves to ppt/media/*`);
      assert.ok(zip.file(`ppt/${packaged}`), `ppt/${packaged} is packaged`);
    }
  });

  it("notes, a chart, a picture background and the chart workbook carry no local path", async () => {
    const project = richProject();
    const result = await exportProjectToPptx(project);
    const zip = await JSZip.loadAsync(result.data);
    const forbidden = [project.rootDir, repoRoot, "/Users/", "/Volumes/", "file://"];
    const hits: string[] = [];
    const scan = (name: string, xml: string) => {
      for (const needle of forbidden) {
        if (xml.includes(needle)) hits.push(`${name} contains ${needle}`);
      }
    };
    for (const [name, xml] of await textParts(zip)) scan(name, xml);
    const workbooks = Object.keys(zip.files).filter((name) => /^ppt\/embeddings\/[^/]+\.xlsx$/.test(name));
    assert.ok(workbooks.length > 0, "the chart carries an embedded workbook");
    for (const name of workbooks) {
      const workbook = await JSZip.loadAsync(await zip.file(name)!.async("nodebuffer"));
      for (const [inner, xml] of await textParts(workbook)) scan(`${name}!${inner}`, xml);
    }
    assert.ok(zip.file("ppt/notesSlides/notesSlide1.xml"), "notes part exists");
    assert.ok(zip.file("ppt/charts/chart1.xml"), "chart part exists");
    assert.deepEqual(hits, []);
  });
});
