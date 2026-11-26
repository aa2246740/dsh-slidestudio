/**
 * Content recognition for the formats that have no fixed leading magic bytes:
 * SVG (an XML root element) and the ISO-BMFF photo family (HEIC, which is
 * refused because no decoder is bundled, and AVIF, which sharp decodes and
 * intake converts to a PNG or JPEG the page media pipeline can place).
 */

/** @typedef {{ok: false, code: string, message: string}} Refusal */

export const HEIC_MESSAGE =
  "暂不支持 HEIC 照片；请在手机相册里把照片导出为 JPG（或在 iPhone「设置 → 相机 → 格式」里选「兼容性最佳」）后再上传";

/** Brands that carry HEVC-coded stills. `mif1`/`msf1` alone are generic and also used by AVIF. */
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);
const GENERIC_BRANDS = new Set(["mif1", "msf1"]);

const PROLOG_WINDOW = 8192;
const SVG_ROOT = /^<(?:[A-Za-z_][\w.-]*:)?svg[\s>/]/;

/**
 * @param {Uint8Array} bytes
 * @returns {{major: string, compatible: string[]} | null} the `ftyp` brands, or null when the
 *   file does not start with an ISO base media file type box
 */
function isoBmffBrands(bytes) {
  if (bytes.length < 16) return null;
  /** Four bytes starting at `at`, as the ASCII tag they spell. @param {number} at */
  const brandAt = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (brandAt(4) !== "ftyp") return null;
  const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const end = declared >= 16 && declared <= bytes.length ? declared : Math.min(bytes.length, 64);
  const compatible = [];
  for (let at = 16; at + 4 <= end; at += 4) compatible.push(brandAt(at));
  return { major: brandAt(8), compatible };
}

/**
 * Which photo family an ISO-BMFF file belongs to. A generic `mif1` major brand is
 * decided by the compatible brands, and AVIF wins over HEIC when both appear.
 * @param {Uint8Array} bytes
 * @returns {"heic" | "avif" | null}
 */
export function isoPhotoFamily(bytes) {
  const brands = isoBmffBrands(bytes);
  if (!brands) return null;
  const { major, compatible } = brands;
  if (AVIF_BRANDS.has(major)) return "avif";
  if (HEIC_BRANDS.has(major)) return "heic";
  if (!GENERIC_BRANDS.has(major) && major !== "miaf") return null;
  if (compatible.some((brand) => AVIF_BRANDS.has(brand))) return "avif";
  if (compatible.some((brand) => HEIC_BRANDS.has(brand))) return "heic";
  return null;
}

/**
 * True when the document's root element is `<svg>`. The XML prolog, a BOM,
 * comments and a DOCTYPE (including an internal subset) may come first; any
 * other leading content means the file is something else that merely mentions SVG.
 * @param {Uint8Array} bytes
 */
export function looksLikeSvg(bytes) {
  // TextDecoder drops a leading BOM by default.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, PROLOG_WINDOW));
  let at = 0;
  for (;;) {
    while (at < head.length && /\s/.test(head[at] ?? "")) at += 1;
    if (head.startsWith("<?", at)) {
      const close = head.indexOf("?>", at + 2);
      if (close < 0) return false;
      at = close + 2;
    } else if (head.startsWith("<!--", at)) {
      const close = head.indexOf("-->", at + 4);
      if (close < 0) return false;
      at = close + 3;
    } else if (/^<!DOCTYPE/i.test(head.slice(at, at + 9))) {
      const close = doctypeEnd(head, at + 9);
      if (close < 0) return false;
      at = close;
    } else {
      break;
    }
  }
  return SVG_ROOT.test(head.slice(at, at + 64));
}

/**
 * Index just past a DOCTYPE declaration that starts before `from`, skipping quoted
 * literals and an internal subset in square brackets. -1 when it never closes.
 * @param {string} text @param {number} from
 */
export function doctypeEnd(text, from) {
  let depth = 0;
  /** @type {string | null} */
  let quote = null;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
    } else if (char === ">" && depth <= 0) {
      return at + 1;
    }
  }
  return -1;
}

/**
 * HEIC is refused for lack of a decoder. The brand decides, never the file name.
 * @param {Uint8Array} bytes
 * @returns {Refusal | null}
 */
export function heicRefusal(bytes) {
  return isoPhotoFamily(bytes) === "heic" ? { ok: false, code: "unsupported-type", message: HEIC_MESSAGE } : null;
}

/**
 * Names whose content could not be read as what they claim: a `.svg` that is not SVG
 * (message supplied by the caller) and a `.heic`/`.heif` of any content.
 * @param {string} extension @param {string} notSvgMessage
 * @returns {Refusal | null}
 */
export function extensionRefusal(extension, notSvgMessage) {
  if (extension === ".svg") return { ok: false, code: "unsupported-type", message: notSvgMessage };
  if (extension === ".heic" || extension === ".heif") {
    return { ok: false, code: "unsupported-type", message: HEIC_MESSAGE };
  }
  return null;
}

/**
 * Which presentation package this is, from its main part's declared content type.
 * @param {string} contentTypes @param {string} template @param {string} presentation
 */
export const presentationMime = (contentTypes, template, presentation) =>
  contentTypes.includes("presentationml.template.main+xml") ? template : presentation;
