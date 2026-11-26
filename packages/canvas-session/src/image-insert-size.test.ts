import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, listComposedPage, saveProject, titleOnlyCoverPage } from "@open-slidestudio/pptd-v2";
import { insertImage, openSession, renderModel } from "./index.js";

/** Default frame that insertImage keeps when the picture cannot be sized. */
const DEFAULT_BOUNDS = [80, 80, 360, 200];

function pngFile(w: number, h: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([sig, ihdr]);
}

/** JPEG: SOI, then a baseline SOF0 segment that carries the frame size. */
function jpegFile(w: number, h: number): Buffer {
  const buf = Buffer.alloc(20);
  buf.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  buf.writeUInt16BE(h, 7);
  buf.writeUInt16BE(w, 9);
  buf[11] = 0x03;
  return buf;
}

function gifFile(w: number, h: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(w, 6);
  buf.writeUInt16LE(h, 8);
  return buf;
}

/** WebP extended (VP8X) container: the canvas size is stored minus one, in 24-bit fields. */
function webpFile(w: number, h: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(24, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(w - 1, 24, 3);
  buf.writeUIntLE(h - 1, 27, 3);
  return buf;
}

function openImageSession(): { dir: string; session: ReturnType<typeof openSession> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-image-size-"));
  const project = createEmptyProject(dir, { title: "图片尺寸" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("图片尺寸"));
  saveProject(project);
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  return { dir, session: openSession(dir, { allowedControlIds: ["insert.image"] }) };
}

function insertedBounds(session: ReturnType<typeof openSession>, src?: string): number[] {
  insertImage(session, "insert.image", src);
  return renderModel(session).elements.at(-1)!.bounds;
}

describe("insertImage sizes a picture from its file header", () => {
  it("reads PNG, JPEG, GIF and WebP natural sizes", () => {
    const cases: [string, Buffer, number, number][] = [
      ["photo.png", pngFile(240, 160), 240, 160],
      ["photo.jpg", jpegFile(320, 200), 320, 200],
      ["photo.gif", gifFile(200, 100), 200, 100],
      ["photo.webp", webpFile(320, 200), 320, 200],
    ];
    for (const [name, bytes, w, h] of cases) {
      const { dir, session } = openImageSession();
      fs.writeFileSync(path.join(dir, "media", name), bytes);
      const bounds = insertedBounds(session, `media/${name}`);
      assert.deepEqual(bounds, [80, 80, w, h], `${name} keeps its natural size`);
    }
  });

  it("sizes a picture by its bytes when the file extension is wrong", () => {
    const { dir, session } = openImageSession();
    fs.writeFileSync(path.join(dir, "media", "mislabelled.jpg"), pngFile(240, 160));
    assert.deepEqual(insertedBounds(session, "media/mislabelled.jpg"), [80, 80, 240, 160]);
  });

  it("keeps the default frame when the picture file is missing", () => {
    const { session } = openImageSession();
    assert.deepEqual(insertedBounds(session, "media/absent.png"), DEFAULT_BOUNDS);
  });

  it("keeps the default frame when the file is not an image", () => {
    const { dir, session } = openImageSession();
    fs.writeFileSync(path.join(dir, "media", "notes.png"), "not an image, just text");
    assert.deepEqual(insertedBounds(session, "media/notes.png"), DEFAULT_BOUNDS);
  });
});
