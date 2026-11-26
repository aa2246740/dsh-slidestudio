/**
 * `svg-raster-v1` — SVG materials. The markup is sanitized (svg-sanitize.mjs),
 * rasterized to a PNG by sharp's bundled librsvg, and from then on handled as an
 * ordinary image: palette, style data and the vision copy come from the shared
 * image parser run on the PNG. The derivative keeps the PNG (`raster`) and never
 * the SVG; materialization writes that PNG instead of the original, so no route
 * or project file ever holds SVG markup.
 */
import { MaterialRejection } from "../zip-guard.mjs";
import { buildSummaryZh } from "../summary.mjs";
import { IMAGE_PIXEL_LIMIT, imageParser, rasterCopy } from "./image.mjs";
import { requireSharp } from "../optional-decoder.mjs";
import { SVG_LIMITS, sanitizeSvg } from "./svg-sanitize.mjs";

/** The longest side of the PNG copy; smaller SVGs keep their declared size. */
export const SVG_RASTER_MAX_EDGE = 2048;
/** A PNG larger than this is rendered again at 70% of its edge, up to three times. */
const RASTER_MAX_BYTES = 4 * 1024 * 1024;
const RASTER_RETRIES = 3;

const CORRUPT_MESSAGE = "SVG 文件已损坏或内容不完整，无法解析；请重新导出后上传";
const TOO_BIG_MESSAGE = `SVG 文件超过 ${SVG_LIMITS.maxBytes / (1024 * 1024)}MB，无法处理；请简化后再上传`;
const CANVAS_MESSAGE = "SVG 画布像素超过 4000 万上限，无法处理；请缩小画布尺寸后再上传";
const HEAVY_MESSAGE = "SVG 渲染结果过大，无法处理；请简化图形或转成 PNG 后上传";

const REMOVAL_LABELS = {
  script: "脚本",
  "foreign-object": "内嵌网页内容",
  "external-reference": "外部链接",
  doctype: "DOCTYPE 声明",
};

/** @param {string[]} removed */
function removalWarning(removed) {
  const labels = removed.map((flag) => REMOVAL_LABELS[/** @type {keyof typeof REMOVAL_LABELS} */ (flag)]);
  const last = labels.pop();
  const joined = labels.length ? `${labels.join("、")}和${last}` : last;
  return {
    code: "svg-sanitized",
    message: `已移除 SVG 中的${joined}，按图片读取`,
  };
}

/** @param {unknown} error */
function classify(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /pixel limit|exceeds .*pixel/i.test(message)
    ? new MaterialRejection("too-large", CANVAS_MESSAGE)
    : new MaterialRejection("corrupt", CORRUPT_MESSAGE);
}

/**
 * Render sanitized markup at `density` (72 = the declared size).
 * @param {import("./image.mjs").SharpCtor} sharp
 * @returns {(markup: string, density: number) => Promise<Buffer>}
 */
const sharpRasterizer = (sharp) => (markup, density) =>
  sharp(Buffer.from(markup, "utf8"), { density, limitInputPixels: IMAGE_PIXEL_LIMIT }).png().toBuffer();

export const svgRasterParser = {
  id: "svg-raster-v1",
  engine: "@xmldom/xmldom + sharp (librsvg)",
  /** @type {"image"} */
  kind: "image",

  /**
   * @param {{name: string, bytes: Uint8Array}} input
   * @param {{rasterize?: (markup: string, density: number) => Promise<Buffer>}} [options]
   *   Test seam: replaces the renderer so a test can see exactly what it is given.
   * @returns {Promise<import("../derivative.mjs").ParserResult<object>>}
   */
  async parse({ name, bytes }, options = {}) {
    if (bytes.length > SVG_LIMITS.maxBytes) throw new MaterialRejection("too-large", TOO_BIG_MESSAGE);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);
    }
    const { markup, removed } = sanitizeSvg(text);
    const sharp = await requireSharp("svg");

    // The declared canvas is read before any rendering: an oversized one is refused here.
    let natural;
    try {
      natural = await sharp(Buffer.from(markup, "utf8"), {
        limitInputPixels: IMAGE_PIXEL_LIMIT,
      }).metadata();
    } catch (error) {
      throw classify(error);
    }
    const { width, height } = natural;
    if (!width || !height) throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);

    const rasterize = options.rasterize ?? sharpRasterizer(sharp);
    let edge = Math.min(SVG_RASTER_MAX_EDGE, Math.max(width, height));
    /** @type {Buffer | undefined} */
    let png;
    for (let attempt = 0; attempt <= RASTER_RETRIES && !png; attempt += 1) {
      const scale = edge / Math.max(width, height);
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));
      try {
        let rendered = await rasterize(markup, Math.ceil(72 * scale));
        const size = await sharp(rendered).metadata();
        if (size.width !== targetWidth || size.height !== targetHeight) {
          rendered = await sharp(rendered).resize(targetWidth, targetHeight, { fit: "fill" }).png().toBuffer();
        }
        if (rendered.length <= RASTER_MAX_BYTES) png = rendered;
      } catch (error) {
        throw classify(error);
      }
      edge = Math.max(1, Math.floor(edge * 0.7));
    }
    if (!png) throw new MaterialRejection("too-large", HEAVY_MESSAGE);

    const read = await imageParser.parse({ name, bytes: png });
    const image = /** @type {{width: number, height: number, dominant: string}} */ (read.payload);
    const raster = rasterCopy("png", png, image);
    const warnings = removed.length ? [removalWarning(removed)] : [];
    return {
      payload: {
        ...image,
        format: "svg",
        raster,
        svg: { declaredWidth: width, declaredHeight: height, removed },
      },
      status: read.status,
      summary: buildSummaryZh({
        parserId: this.id,
        width: image.width,
        height: image.height,
        dominant: image.dominant,
      }),
      warnings: [...read.warnings, ...warnings],
      truncated: { applied: false },
    };
  },
};
