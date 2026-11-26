import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { loadProject, saveProject, type ChartElement, type ImageElement } from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "./export-pptd.js";

/*
 * The exported package after the editor attachment operations (VAL-EDIT-001, 002, 004): a replaced
 * picture's media part is the new file with the crop window it had, an updated chart carries the
 * new numbers in its cache and its embedded workbook, and a re-adopted palette reaches the theme.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const committed = path.join(repoRoot, "test-fixtures", "edit-ops-project");

const sha256 = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");

function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-edit-ops-"));
  fs.cpSync(committed, dir, { recursive: true });
  return dir;
}

const JPEG_DC_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const JPEG_DC_SYMBOLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const JPEG_AC_COUNTS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const JPEG_AC_SYMBOLS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14,
  0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09,
  0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a,
  0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65,
  0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88,
  0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
  0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
  0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

function jpegMarker(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function jpegHuffman(tableClass: number, counts: number[], symbols: number[]): Buffer {
  return jpegMarker(0xc4, Buffer.from([tableClass, ...counts, ...symbols]));
}

/** Mid-gray baseline JPEG: every block is DC category 0 (`00`) then AC EOB (`1010`). */
function jpegEntropy(blocks: number): Buffer {
  const packed: number[] = [];
  let acc = 0;
  let bits = 0;
  const emit = (bit: number): void => {
    acc = (acc << 1) | bit;
    bits += 1;
    if (bits === 8) {
      packed.push(acc);
      acc = 0;
      bits = 0;
    }
  };
  for (let block = 0; block < blocks; block += 1) {
    for (const bit of [0, 0, 1, 0, 1, 0]) emit(bit);
  }
  if (bits > 0) {
    acc = (acc << (8 - bits)) | ((1 << (8 - bits)) - 1);
    packed.push(acc);
  }
  const stuffed: number[] = [];
  for (const byte of packed) {
    stuffed.push(byte);
    if (byte === 0xff) stuffed.push(0x00);
  }
  return Buffer.from(stuffed);
}

/** A valid baseline grayscale JPEG of the requested pixel size, with no native image library. */
function writeJpeg(file: string, width: number, height: number): Buffer {
  const sof = Buffer.alloc(9);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1;
  sof[6] = 1;
  sof[7] = 0x11;
  sof[8] = 0;
  const quant = jpegMarker(0xdb, Buffer.from([0x00, ...new Array<number>(64).fill(1)]));
  const frame = jpegMarker(0xc0, sof);
  const scan = jpegMarker(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0]));
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const bytes = Buffer.concat([
    Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x00,
    ]),
    quant,
    jpegHuffman(0x00, JPEG_DC_COUNTS, JPEG_DC_SYMBOLS),
    jpegHuffman(0x10, JPEG_AC_COUNTS, JPEG_AC_SYMBOLS),
    frame,
    scan,
    jpegEntropy(blocks),
    Buffer.from([0xff, 0xd9]),
  ]);
  fs.writeFileSync(file, bytes);
  return bytes;
}

type ExportedPicture = { mediaSha256: string; srcRect: string };

/** The named picture of a slide: its media part's hash and its crop window. */
async function pictureOf(zip: JSZip, slide: number, name: string): Promise<ExportedPicture> {
  const xml = await zip.file(`ppt/slides/slide${slide}.xml`)!.async("string");
  const pic = xml.split(/(?=<p:pic>)/).find((chunk) => chunk.startsWith("<p:pic>") && chunk.includes(`name="${name}"`));
  assert.ok(pic, `slide ${slide} has a picture named ${name}`);
  const rid = pic.match(/r:embed="([^"]+)"/)?.[1];
  const rels = await zip.file(`ppt/slides/_rels/slide${slide}.xml.rels`)!.async("string");
  const target =
    new RegExp(`Id="${rid}"[^>]*Target="\\.\\./media/([^"]+)"`).exec(rels)?.[1] ??
    new RegExp(`Target="\\.\\./media/([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1];
  assert.ok(target, `the picture's media part for ${rid}`);
  const media = await zip.file(`ppt/media/${target}`)!.async("uint8array");
  const srcRect = pic.match(/<a:srcRect\b[^>]*\/>/)?.[0];
  assert.ok(srcRect, "the picture keeps a crop window");
  return { mediaSha256: sha256(media), srcRect };
}

/** a:srcRect sides, in thousandths of a percent. */
const sides = (srcRect: string): number[] =>
  ["l", "t", "r", "b"].map((side) => Number(new RegExp(`${side}="(\\d+)"`).exec(srcRect)![1]));

/**
 * The crop window worked out from the editor's meaning: the crop fractions apply to the picture as
 * drawn cover-fitted in its box, so the window is the centred visible part of the file narrowed by
 * the crop.
 */
function expectedSides(
  crop: { left: number; top: number; right: number; bottom: number },
  box: [number, number],
  natural: [number, number],
): number[] {
  const scale = Math.max(box[0] / natural[0], box[1] / natural[1]);
  const visibleW = Math.min(1, box[0] / (natural[0] * scale));
  const visibleH = Math.min(1, box[1] / (natural[1] * scale));
  const x0 = (1 - visibleW) / 2;
  const y0 = (1 - visibleH) / 2;
  return [
    x0 + crop.left * visibleW,
    y0 + crop.top * visibleH,
    1 - (x0 + (1 - crop.right) * visibleW),
    1 - (y0 + (1 - crop.bottom) * visibleH),
  ].map((fraction) => fraction * 100000);
}

async function exportZip(dir: string): Promise<JSZip> {
  const result = await exportProjectToPptx(dir);
  return JSZip.loadAsync(result.data);
}

/** Replace page 3's picture file, leaving every other field of the element as the editor kept it. */
function replacePhoto(dir: string, src: string): void {
  const project = loadProject(dir);
  const photo = project.pages[2]!.page.elements.find((element) => element.elementId === "photo") as ImageElement;
  photo.src = src;
  saveProject(project);
}

describe("export of an edited edit-ops project", () => {
  it("VAL-EDIT-001: a replaced picture exports as the new file with the crop window it had", async () => {
    const dir = copyFixture();
    try {
      const before = await pictureOf(await exportZip(dir), 3, "photo");
      const jpeg = writeJpeg(path.join(dir, "media/new-photo.jpg"), 1600, 1067);
      replacePhoto(dir, "media/new-photo.jpg");
      const after = await pictureOf(await exportZip(dir), 3, "photo");

      assert.equal(after.mediaSha256, sha256(jpeg), "the picture part is the new file");
      assert.notEqual(after.mediaSha256, before.mediaSha256);
      assert.equal(after.srcRect, before.srcRect, "the crop window is unchanged");
      const crop = { left: 0.1, top: 0.05, right: 0.15, bottom: 0.1 };
      sides(after.srcRect).forEach((side, index) => {
        assert.ok(Math.abs(side - expectedSides(crop, [480, 320], [1600, 1067])[index]!) <= 1, `side ${index}`);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("VAL-EDIT-001: a picture of another aspect keeps its crop fields and exports the window cover-fit gives it", async () => {
    const dir = copyFixture();
    try {
      const jpeg = writeJpeg(path.join(dir, "media/portrait.jpg"), 800, 1200);
      replacePhoto(dir, "media/portrait.jpg");
      const photo = loadProject(dir).pages[2]!.page.elements.find(
        (element) => element.elementId === "photo",
      ) as ImageElement;
      assert.deepEqual(photo.crop, { left: 0.1, top: 0.05, right: 0.15, bottom: 0.1 });
      assert.deepEqual(photo.bounds, [60, 150, 480, 320]);

      const exported = await pictureOf(await exportZip(dir), 3, "photo");
      assert.equal(exported.mediaSha256, sha256(jpeg));
      sides(exported.srcRect).forEach((side, index) => {
        const expected = expectedSides(photo.crop as never, [480, 320], [800, 1200])[index]!;
        assert.ok(Math.abs(side - expected) <= 1, `side ${index}: ${side} vs ${expected}`);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("VAL-EDIT-002: an updated chart keeps its kind and carries the new numbers in its cache and workbook", async () => {
    const dir = copyFixture();
    try {
      const rows = [
        ["Q1", 820.5, 410.25],
        ["Q2", 905, 470.75],
        ["Q3", 990.25, 520],
        ["Q4", 1080, 585.5],
      ];
      const project = loadProject(dir);
      const chart = project.pages[1]!.page.elements.find(
        (element) => element.elementId === "sales-chart",
      ) as ChartElement;
      chart.data = { cols: chart.data.cols, rows };
      saveProject(project);

      const zip = await exportZip(dir);
      const name = Object.keys(zip.files).find((file) => /^ppt\/charts\/chart\d+\.xml$/.test(file))!;
      const xml = await zip.file(name)!.async("string");
      assert.match(xml, /<c:barChart>[\s\S]*?<c:grouping val="stacked"\/>/, "still a stacked bar");

      const series = xml.match(/<c:ser>[\s\S]*?<\/c:ser>/g) ?? [];
      assert.equal(series.length, 2);
      const points = (ser: string, tag: "cat" | "val") => {
        const block = ser.match(new RegExp(`<c:${tag}>([\\s\\S]*?)</c:${tag}>`))?.[1] ?? "";
        return [...block.matchAll(/<c:pt idx="(\d+)"[^>]*><c:v>([^<]*)<\/c:v><\/c:pt>/g)]
          .sort((a, b) => Number(a[1]) - Number(b[1]))
          .map((match) => match[2]!);
      };
      series.forEach((ser, index) => {
        assert.deepEqual(
          points(ser, "cat"),
          rows.map((row) => row[0]),
        );
        assert.deepEqual(
          points(ser, "val").map(Number),
          rows.map((row) => row[index + 1]),
        );
      });

      const rel = await zip.file(name.replace("ppt/charts/", "ppt/charts/_rels/") + ".rels")!.async("string");
      const embedded = rel.match(/Target="\.\.\/embeddings\/([^"]+\.xlsx)"/)?.[1];
      assert.ok(embedded, "the chart has an embedded workbook");
      const workbook = await JSZip.loadAsync(await zip.file(`ppt/embeddings/${embedded}`)!.async("uint8array"));
      const sheet = await workbook.file("xl/worksheets/sheet1.xml")!.async("string");
      // Text cells hold shared-string indices (t="s"); only numeric cells carry values.
      const numbers = [...sheet.matchAll(/<c r="[A-Z]+\d+"([^>]*?)>([\s\S]*?)<\/c>/g)]
        .filter((match) => !/\bt="(?:s|str|inlineStr)"/.test(match[1]!))
        .map((match) => match[2]!.match(/<v>([^<]*)<\/v>/)?.[1])
        .filter((value): value is string => value !== undefined && Number.isFinite(Number(value)))
        .map(Number)
        .sort((a, b) => a - b);
      assert.deepEqual(
        numbers,
        rows.flatMap((row) => row.slice(1) as number[]).sort((a, b) => a - b),
        "the workbook holds the new values and no old ones",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("VAL-EDIT-004: a re-adopted palette reaches the exported theme", async () => {
    const dir = copyFixture();
    try {
      const project = loadProject(dir);
      project.presentation.theme = {
        ...project.presentation.theme,
        colors: { ...project.presentation.theme?.colors, accent1: "#C8102E" },
      };
      saveProject(project);
      const zip = await exportZip(dir);
      const theme = await zip.file("ppt/theme/theme1.xml")!.async("string");
      assert.match(theme, /<a:accent1>\s*<a:srgbClr val="C8102E"\s*\/>\s*<\/a:accent1>/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
