/**
 * `avif-raster-v1` — AVIF photos. The editor, the media route and the exporter place only PNG,
 * JPEG, GIF and WebP, so sharp decodes the upload and the derivative keeps a raster at the
 * source size instead: a PNG when the picture has an alpha channel, otherwise a JPEG at quality
 * 90. From then on it is an ordinary image: palette, style data and the vision copy come from
 * the shared image parser run on that raster. Materialization writes the raster in place of the
 * upload, so no project file or route ever holds AVIF bytes.
 */
import { MaterialRejection } from "../zip-guard.mjs";
import { buildSummaryZh } from "../summary.mjs";
import { IMAGE_PIXEL_LIMIT, TOO_LARGE_MESSAGE, imageParser, rasterCopy } from "./image.mjs";
import { requireSharp } from "../optional-decoder.mjs";

/** The raster travels inside the derivative as base64, which the store caps at 54 MiB. */
export const AVIF_RASTER_MAX_BYTES = 16 * 1024 * 1024;
/** A raster above the budget is rendered again at 70% of its edge, up to three times. */
const RASTER_RETRIES = 3;
const EDGE_STEP = 0.7;
const JPEG_QUALITY = 90;

const CORRUPT_MESSAGE = "AVIF 图片已损坏、内容不完整或无法解码；请转成 PNG 或 JPG 后再上传";
const HEAVY_MESSAGE = "AVIF 图片转换后仍然过大，无法处理；请缩小图片尺寸或转成 JPG 后再上传";

/** @param {unknown} error */
function classify(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /pixel limit|exceeds .*pixel/i.test(message)
    ? new MaterialRejection("too-large", TOO_LARGE_MESSAGE)
    : new MaterialRejection("corrupt", CORRUPT_MESSAGE);
}

export const avifRasterParser = {
  id: "avif-raster-v1",
  engine: "sharp (libheif/aom)",
  /** @type {"image"} */
  kind: "image",

  /**
   * @param {{name: string, bytes: Uint8Array}} input
   * @param {{maxRasterBytes?: number}} [options] Test seam: replaces the raster byte budget.
   * @returns {Promise<import("../derivative.mjs").ParserResult<object>>}
   */
  async parse({ name, bytes }, options = {}) {
    const maxBytes = options.maxRasterBytes ?? AVIF_RASTER_MAX_BYTES;
    const sharp = await requireSharp("avif");
    const open = () => sharp(bytes, { limitInputPixels: IMAGE_PIXEL_LIMIT, failOn: "error", animated: false });

    // libheif applies the file's own rotation, so these are the displayed dimensions.
    let meta;
    try {
      meta = await open().metadata();
    } catch (error) {
      throw classify(error);
    }
    const { width, height } = meta;
    if (!width || !height) throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);
    const format = meta.hasAlpha ? "png" : "jpeg";

    /** @type {Buffer | undefined} */
    let converted;
    let edge = Math.max(width, height);
    for (let attempt = 0; attempt <= RASTER_RETRIES && !converted; attempt += 1) {
      try {
        let pipeline = open().rotate();
        if (attempt > 0) {
          pipeline = pipeline.resize(edge, edge, { fit: "inside", withoutEnlargement: true });
        }
        const buffer = await (format === "png" ? pipeline.png() : pipeline.jpeg({ quality: JPEG_QUALITY })).toBuffer();
        if (buffer.length <= maxBytes) converted = buffer;
      } catch (error) {
        throw classify(error);
      }
      edge = Math.max(1, Math.floor(edge * EDGE_STEP));
    }
    if (!converted) throw new MaterialRejection("too-large", HEAVY_MESSAGE);

    const read = await imageParser.parse({ name, bytes: converted });
    const image = /** @type {{width: number, height: number, dominant: string}} */ (read.payload);
    const label = format === "png" ? "PNG" : "JPG";
    const downscaled = image.width < width || image.height < height;
    return {
      payload: { ...image, format: "avif", raster: rasterCopy(format, converted, image) },
      status: read.status,
      summary: buildSummaryZh({
        parserId: this.id,
        width: image.width,
        height: image.height,
        dominant: image.dominant,
        extra: [...(meta.hasAlpha ? ["含透明像素"] : []), `已转为 ${label} 图片`],
      }),
      warnings: [
        ...read.warnings,
        ...(downscaled
          ? [
              {
                code: "avif-downscaled",
                message: `图片较大，已从 ${width}×${height} 缩小到 ${image.width}×${image.height} 后转为 ${label}`,
              },
            ]
          : []),
      ],
      truncated: { applied: false },
    };
  },
};
