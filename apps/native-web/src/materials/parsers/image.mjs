/**
 * `image-sharp-v1` — PNG/JPEG/WebP/GIF materials through sharp. Reads the
 * real dimensions (EXIF-orientation-aware), alpha, frame count, a dominant
 * colour plus a deterministic Lab style profile, and produces a
 * normalized JPEG copy for the model's vision path (EXIF rotation applied,
 * fitted inside 1568×1568, flattened onto white, quality 85). The pixel
 * limit makes decompression bombs fail fast, long before any decode.
 */
import crypto from "node:crypto";
import { MaterialRejection } from "../zip-guard.mjs";
import { buildSummaryZh } from "../summary.mjs";
import { extractImageStyle, imageMetadata, IMAGE_DERIVATIVE_VERSION } from "../image-style.mjs";
import { loadSharp, requireSharp } from "../optional-decoder.mjs";

export { loadSharp };

const CORRUPT_MESSAGE = "文件已损坏或内容不完整，无法解析；请重新导出后上传";
export const TOO_LARGE_MESSAGE = "图片像素超过 4000 万上限，无法处理；请缩小图片尺寸后再上传";

/** Same limit the pipeline documents: 40 megapixels. */
export const IMAGE_PIXEL_LIMIT = 40_000_000;
const NORMALIZED_MAX = 1568;
const PALETTE_SIZE = 4;
const SAMPLE_SIZE = 64;

/** @typedef {import("../optional-decoder.mjs").SharpCtor} SharpCtor */

/**
 * The raster an SVG or AVIF upload was converted to, as the derivative keeps it. The hash lets
 * materialization verify the file it writes in place of the upload.
 * @param {"png"|"jpeg"} format @param {Buffer} buffer @param {{width: number, height: number}} size
 */
export function rasterCopy(format, buffer, { width, height }) {
  return {
    format,
    width,
    height,
    bytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    data: buffer.toString("base64"),
  };
}

/**
 * sharp failures become stable rejections; the pixel limit is a size
 * problem, everything else means the bytes are unreadable.
 * @param {unknown} error
 * @returns {MaterialRejection}
 */
function classifySharpError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/pixel limit|exceeds .*pixel/i.test(message)) {
    return new MaterialRejection("too-large", TOO_LARGE_MESSAGE);
  }
  return new MaterialRejection("corrupt", CORRUPT_MESSAGE);
}

/**
 * Sharp pipeline bound to the intake limits.
 * @param {SharpCtor} sharp @param {Uint8Array} bytes
 */
const open = (sharp, bytes) =>
  sharp(bytes, {
    limitInputPixels: IMAGE_PIXEL_LIMIT,
    failOn: "error",
    animated: false,
  });

export const imageParser = {
  id: "image-sharp-v1",
  engine: "sharp",
  /** @type {"image"} */
  kind: "image",

  /**
   * @param {{name: string, bytes: Uint8Array}} input
   * @returns {Promise<import("../derivative.mjs").ParserResult<object>>}
   */
  async parse({ bytes }) {
    const sharp = await requireSharp("image");

    /** @type {import("../optional-decoder.mjs").SharpMetadata} */
    let meta;
    try {
      meta = await open(sharp, bytes).metadata();
    } catch (error) {
      throw classifySharpError(error);
    }
    const orientation = meta.orientation ?? 1;
    // Orientations 5-8 are 90° rotations/transpositions: display swaps axes.
    const swap = orientation >= 5 && orientation <= 8;
    const width = swap ? meta.height : meta.width;
    const height = swap ? meta.width : meta.height;
    if (!width || !height) throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);

    /** @type {{dominant: string, palette: string[]}} */
    let colors;
    try {
      colors = await extractColors(sharp, bytes);
    } catch (error) {
      throw classifySharpError(error);
    }

    /** @type {{format: string, width: number, height: number, bytes: number, sha256: string, data: string}} */
    let normalized;
    try {
      const copy = await open(sharp, bytes)
        .rotate()
        .resize(NORMALIZED_MAX, NORMALIZED_MAX, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 85 })
        .toBuffer();
      const copyMeta = await sharp(copy).metadata();
      normalized = {
        format: "jpeg",
        width: copyMeta.width ?? width,
        height: copyMeta.height ?? height,
        bytes: copy.length,
        sha256: crypto.createHash("sha256").update(copy).digest("hex"),
        data: copy.toString("base64"),
      };
    } catch (error) {
      throw classifySharpError(error);
    }

    const frames = meta.pages ?? 1;
    /** @type {string[]} */
    const extra = [];
    if (meta.hasAlpha) extra.push("含透明像素");
    if (frames > 1) extra.push(`${frames} 帧`);
    extra.push("已生成规范化副本");

    let style = {};
    const warnings = [];
    try {
      style = await extractImageStyle(bytes, meta);
    } catch {
      warnings.push({
        code: "image-style-unavailable",
        message: "图片已识别，但未能提取配色线索；仍可放入页面或交给支持看图的模型查看",
      });
    }
    const payload = {
      version: IMAGE_DERIVATIVE_VERSION,
      format: meta.format ?? "unknown",
      width,
      height,
      hasAlpha: Boolean(meta.hasAlpha),
      frames,
      exifOrientation: orientation,
      ...imageMetadata(width, height, meta.exif),
      ...style,
      dominant: colors.dominant,
      palette: colors.palette,
      normalized,
    };
    return {
      payload,
      status: "ok",
      summary: buildSummaryZh({
        parserId: this.id,
        format: payload.format,
        width,
        height,
        dominant: colors.dominant,
        extra,
      }),
      warnings,
      truncated: { applied: false },
    };
  },
};

/**
 * Dominant colour + small palette from one 64px-wide downsample, bucketed at
 * 4 bits per channel. One decode serves both, so a 40 MP image costs a
 * single pass.
 * @param {SharpCtor} sharp @param {Uint8Array} bytes
 * @returns {Promise<{dominant: string, palette: string[]}>}
 */
async function extractColors(sharp, bytes) {
  const { data, info } = await open(sharp, bytes)
    .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  /** @type {Map<number, {count: number, r: number, g: number, b: number}>} */
  const buckets = new Map();
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = channels > 1 ? data[i + 1] : r;
    const b = channels > 2 ? data[i + 2] : r;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const acc = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    acc.count += 1;
    acc.r += r;
    acc.g += g;
    acc.b += b;
    buckets.set(key, acc);
  }
  if (!buckets.size) return { dominant: "#000000", palette: ["#000000"] };
  const ranked = [...buckets.values()].sort((a, b) => b.count - a.count);
  /** @type {string[]} */
  const palette = [];
  for (const acc of ranked) {
    const hex = hexOf(acc.r / acc.count, acc.g / acc.count, acc.b / acc.count);
    if (!palette.includes(hex)) palette.push(hex);
    if (palette.length >= PALETTE_SIZE) break;
  }
  return { dominant: palette[0] ?? "#000000", palette };
}

/** @param {number} r @param {number} g @param {number} b */
function hexOf(r, g, b) {
  /** @param {number} value */
  const toHex = (value) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
