/**
 * Numbered mosaic of the session's images for `view_material {materialId:"all-images"}`
 * and the PDF page overview. The composition is a pure function of the ordered
 * tile bytes: one fixed grid rule, a fixed sharp pipeline and a built-in digit
 * font, so the same inputs always produce the same JPEG (and sha256), on this
 * machine and after a restart. Numbers are drawn as solid pixel blocks rather
 * than rendered text, so no installed font can change the output.
 */
import crypto from "node:crypto";
import { loadImageCodec } from "./image-codec.js";

export const IMAGE_OVERVIEW_SCHEMA = "image-overview/v1";
/** Long edge of the mosaic, matching the 1568 px limit of every other image block. */
export const IMAGE_OVERVIEW_MAX_EDGE = 1568;
/** 6 × 6 keeps every tile at least 250 px wide. */
export const IMAGE_OVERVIEW_MAX_TILES = 36;
export const IMAGE_OVERVIEW_PDF_MAX_PAGES = 12;
const GAP = 8;
const CANVAS_BACKGROUND = "#bdbdbd";
const JPEG_QUALITY = 88;
const MAX_INPUT_PIXELS = 50_000_000;

/** Distinct dark hues; white digits stay legible on every one of them. */
const BLOCK_COLORS: readonly (readonly [number, number, number])[] = [
  [0xc6, 0x28, 0x28],
  [0x15, 0x65, 0xc0],
  [0x2e, 0x7d, 0x32],
  [0x6a, 0x1b, 0x9a],
  [0xbf, 0x36, 0x0c],
  [0x00, 0x69, 0x5c],
  [0xad, 0x14, 0x57],
  [0x4e, 0x34, 0x2e],
  [0x28, 0x35, 0x93],
  [0x33, 0x69, 0x1e],
  [0x37, 0x47, 0x4f],
  [0x88, 0x0e, 0x4f],
];

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

export type OverviewTileInput = Readonly<{ number: number; bytes: Uint8Array }>;

export type OverviewTilePlacement = Readonly<{
  number: number;
  /** Cell origin inside the mosaic; the number block sits on this corner. */
  x: number;
  y: number;
  size: number;
  /** False when the tile bytes could not be decoded; the cell stays empty. */
  decoded: boolean;
}>;

export type ImageOverview = Readonly<{
  bytes: Buffer;
  sha256: string;
  width: number;
  height: number;
  columns: number;
  rows: number;
  tiles: readonly OverviewTilePlacement[];
}>;

/** Grid for `count` tiles: square-ish, never taller than wide, long edge ≤ 1568. */
export function overviewGrid(count: number): {
  columns: number;
  rows: number;
  cell: number;
  width: number;
  height: number;
} {
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const cell = Math.floor((IMAGE_OVERVIEW_MAX_EDGE - GAP * (columns + 1)) / columns);
  return {
    columns,
    rows,
    cell,
    width: columns * cell + GAP * (columns + 1),
    height: rows * cell + GAP * (rows + 1),
  };
}

function numberBlock(number: number, cell: number): { data: Buffer; width: number; height: number } {
  const scale = Math.min(14, Math.max(3, Math.floor(cell / 48)));
  const digits = String(number).split("");
  const padding = scale;
  const width = padding * 2 + digits.length * 3 * scale + (digits.length - 1) * scale;
  const height = padding * 2 + 5 * scale;
  const color = BLOCK_COLORS[(number - 1) % BLOCK_COLORS.length]!;
  const data = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = 255;
  }
  digits.forEach((digit, index) => {
    const glyph = GLYPHS[digit]!;
    const left = padding + index * 4 * scale;
    for (let row = 0; row < 5; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        if (glyph[row]![column] !== "1") continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const pixel = ((padding + row * scale + dy) * width + left + column * scale + dx) * 4;
            data[pixel] = 255;
            data[pixel + 1] = 255;
            data[pixel + 2] = 255;
          }
        }
      }
    }
  });
  return { data, width, height };
}

export function imageOverviewSha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Compose the ordered tiles (1..36) into one numbered JPEG mosaic. */
export async function composeImageOverview(tiles: readonly OverviewTileInput[]): Promise<ImageOverview> {
  if (tiles.length < 1 || tiles.length > IMAGE_OVERVIEW_MAX_TILES) {
    throw new RangeError(`图片总览需要 1–${IMAGE_OVERVIEW_MAX_TILES} 张图片，当前 ${tiles.length} 张`);
  }
  const numbers = new Set<number>();
  for (const tile of tiles) {
    if (!Number.isSafeInteger(tile.number) || tile.number < 1 || numbers.has(tile.number)) {
      throw new RangeError("图片总览的编号必须是互不重复的正整数");
    }
    numbers.add(tile.number);
  }
  const sharp = await loadImageCodec();
  const grid = overviewGrid(tiles.length);
  const layers: {
    input: Buffer;
    raw: { width: number; height: number; channels: 3 | 4 };
    left: number;
    top: number;
  }[] = [];
  const placements: OverviewTilePlacement[] = [];
  for (const [index, tile] of tiles.entries()) {
    const x = GAP + (index % grid.columns) * (grid.cell + GAP);
    const y = GAP + Math.floor(index / grid.columns) * (grid.cell + GAP);
    let decoded = true;
    try {
      const { data, info } = await sharp(Buffer.from(tile.bytes), {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: "error",
      })
        .rotate()
        .resize({
          width: grid.cell,
          height: grid.cell,
          fit: "inside",
          withoutEnlargement: true,
        })
        .flatten({ background: "#ffffff" })
        .toColourspace("srgb")
        .raw()
        .toBuffer({ resolveWithObject: true });
      layers.push({
        input: data,
        raw: { width: info.width, height: info.height, channels: info.channels as 3 | 4 },
        left: x + Math.floor((grid.cell - info.width) / 2),
        top: y + Math.floor((grid.cell - info.height) / 2),
      });
    } catch {
      decoded = false;
    }
    placements.push({ number: tile.number, x, y, size: grid.cell, decoded });
  }
  for (const placement of placements) {
    const block = numberBlock(placement.number, grid.cell);
    layers.push({
      input: block.data,
      raw: { width: block.width, height: block.height, channels: 4 },
      left: placement.x,
      top: placement.y,
    });
  }
  const bytes = await sharp({
    create: {
      width: grid.width,
      height: grid.height,
      channels: 3,
      background: CANVAS_BACKGROUND,
    },
  })
    .composite(layers)
    .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: "4:4:4", mozjpeg: false })
    .toBuffer();
  return {
    bytes,
    sha256: imageOverviewSha256(bytes),
    width: grid.width,
    height: grid.height,
    columns: grid.columns,
    rows: grid.rows,
    tiles: placements,
  };
}
