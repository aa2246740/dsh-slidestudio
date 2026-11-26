import zlib from "node:zlib";
import { loadProject, sanitizeProjectColors, toRgbHex, type PptdProject } from "@open-slidestudio/pptd-v2";

export type PngExportResult = {
  data: Buffer;
  filename: string;
  width: number;
  height: number;
  pageIndex: number;
  /** Solid fill only — not a visual of the page. Use harness render_page for #slide. */
  kind: "background-only";
};

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3;
      raw[i] = rgb[0];
      raw[i + 1] = rgb[1];
      raw[i + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function parseHexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    Number.parseInt(h.slice(0, 2), 16) || 0,
    Number.parseInt(h.slice(2, 4), 16) || 0,
    Number.parseInt(h.slice(4, 6), 16) || 0,
  ];
}

/**
 * Offline PNG of slide size + background color only.
 * This is not a picture of the page. Visual QA must use native #slide.
 */
export function exportPageToPng(source: string | PptdProject, pageIndex = 0): PngExportResult {
  const project = sanitizeProjectColors(typeof source === "string" ? loadProject(source) : source).project;
  const page = project.pages[pageIndex];
  if (!page) throw new Error(`page index out of range: ${pageIndex}`);
  const [width, height] = project.presentation.size;
  const bg = page.page.background as { type?: string; color?: string } | undefined;
  const hex =
    bg && (bg.type === "solid" || (!bg.type && bg.color))
      ? toRgbHex(bg.color, project.presentation.theme, "#ffffff")
      : bg?.type === "image"
        ? "#111111"
        : "#ffffff";
  return {
    data: solidPng(width, height, parseHexRgb(hex)),
    filename: `${(project.presentation.title ?? "slide").replace(/[^\w\u4e00-\u9fff-]+/g, "_")}-p${pageIndex + 1}.png`,
    width,
    height,
    pageIndex,
    kind: "background-only",
  };
}
