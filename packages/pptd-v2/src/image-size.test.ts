import assert from "node:assert/strict";
import { test } from "node:test";
import { probeImageSize } from "./image-size.js";

const le24 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];

/** PNG signature, then an IHDR chunk whose width and height sit at bytes 16 and 20. */
function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** GIF89a header with the logical screen size as little-endian 16-bit values. */
function gif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** SOI, a JFIF APP0 segment the walker must skip, then a baseline SOF0 that carries the size. */
function jpeg(width: number, height: number): Buffer {
  const app0 = [
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ];
  const sof0 = [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
  ];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

/** A RIFF WEBP file whose first chunk is `chunk`, padded the way a real file is. */
function webp(chunk: string, payload: number[]): Buffer {
  const header = Buffer.alloc(20);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(12 + payload.length, 4);
  header.write("WEBP", 8, "ascii");
  header.write(chunk, 12, "ascii");
  header.writeUInt32LE(payload.length, 16);
  return Buffer.concat([header, Buffer.from(payload), Buffer.alloc(8)]);
}

test("reads the IHDR size of a PNG", () => {
  assert.deepEqual(probeImageSize(png(640, 480)), { w: 640, h: 480 });
});

test("reads the logical screen size of a GIF", () => {
  assert.deepEqual(probeImageSize(gif(320, 200)), { w: 320, h: 200 });
});

test("skips the APP0 segment and reads the SOF0 size of a JPEG", () => {
  assert.deepEqual(probeImageSize(jpeg(1024, 768)), { w: 1024, h: 768 });
});

test("reads the canvas size of a lossy, lossless and extended WebP", () => {
  // VP8 payload: frame tag, start code 9d 01 2a, then 16-bit width and height.
  const lossy = webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xc8, 0x00]);
  assert.deepEqual(probeImageSize(lossy), { w: 320, h: 200 });
  // VP8L payload: signature 0x2f, then width-1 and height-1 packed as 14-bit fields.
  const lossless = webp("VP8L", [0x2f, 0x63, 0x40, 0x0c, 0x00]);
  assert.deepEqual(probeImageSize(lossless), { w: 100, h: 50 });
  // VP8X payload: flags and reserved bytes, then canvas width-1 and height-1 as 24-bit values.
  const extended = webp("VP8X", [0x10, 0, 0, 0, ...le24(639), ...le24(479)]);
  assert.deepEqual(probeImageSize(extended), { w: 640, h: 480 });
});

test("returns undefined for empty, text, truncated or unknown bytes", () => {
  assert.equal(probeImageSize(Buffer.alloc(0)), undefined);
  assert.equal(probeImageSize(Buffer.from("not an image at all, just text.")), undefined);
  assert.equal(probeImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), undefined);
});
