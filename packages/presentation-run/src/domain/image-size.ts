/**
 * Pixel size of an image read from its header alone, so the overview table can
 * report a size for template photos without decoding them. Returns undefined
 * for any format or header it does not recognize.
 */
export type ImageSize = Readonly<{ width: number; height: number }>;

function valid(width: number, height: number): ImageSize | undefined {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : undefined;
}

function pngSize(bytes: Buffer): ImageSize | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return undefined;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return valid(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function jpegSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame && offset + 9 <= bytes.length) {
      return valid(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
    }
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

function gifSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 10 || !["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    return undefined;
  }
  return valid(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
}

function webpSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF") return undefined;
  if (bytes.toString("ascii", 8, 12) !== "WEBP") return undefined;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return valid(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8 ") {
    return valid(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  }
  return undefined;
}

export function sniffImageSize(bytes: Buffer): ImageSize | undefined {
  return pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes) ?? webpSize(bytes);
}

export function orientationOf(width: number, height: number): "landscape" | "portrait" | "square" {
  return width === height ? "square" : width > height ? "landscape" : "portrait";
}
