/**
 * Natural pixel size of a PNG, GIF, JPEG or WebP file, read from its header bytes.
 * The exporter turns crop fractions into srcRect values with it, and the editor
 * sizes tiled picture fills, so both read the same numbers.
 */
function jpegSize(buf: Buffer): { w: number; h: number } | undefined {
  if (!(buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8)) return undefined;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = buf[off + 1]!;
    if (isSofMarker(marker)) {
      return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
    }
    const len = buf.readUInt16BE(off + 2);
    off += 2 + len;
  }
  return undefined;
}

function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function webpSize(buf: Buffer): { w: number; h: number } | undefined {
  if (!isWebp(buf)) return undefined;
  const fourcc = buf.toString("ascii", 12, 16);
  if (fourcc === "VP8X") {
    return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  }
  if (fourcc === "VP8 ") {
    return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

function isWebp(buf: Buffer): boolean {
  return buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
}

export function probeImageSize(buf: Buffer): { w: number; h: number } | undefined {
  // PNG: signature + IHDR dims at byte 16.
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // GIF: logical screen descriptor.
  if (buf.length > 10 && buf.toString("ascii", 0, 6).startsWith("GIF")) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  return jpegSize(buf) ?? webpSize(buf);
}
