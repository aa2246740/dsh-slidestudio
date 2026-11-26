import { MAX_PDF_STYLE_PAGES } from "./pdf-style-hints.mjs";

/** @typedef {{version?:number,styleProfile?:Record<string,unknown>,
 * orientation?:string|number,logoLike?:boolean,screenshotLike?:boolean,takenAt?:string,
 * width?:number,height?:number,origin?:"docx"|"pdf",note?:string,
 * position?:{paragraph?:number,page?:number},parent?:{materialId:string,name:string},
 * pack?:{imageCount?:number,images?:Record<string,unknown>[],ignoredNames?:string[]}}} StoredImage */

const ORIENTATIONS = ["landscape", "portrait", "square"];

/** The suffix a style hint carries by source: a Word theme stays a clue, a PDF
 * vector profile is the freestyle palette hint. Image pixel profiles get no
 * hint line — the image metadata line owns that chip. */
const HINT_SUFFIX = Object.freeze({
  "docx-theme": "风格只作线索，不作为设计来源",
  "pdf-vector-ops": "风格参考；自由风格下可作配色来源",
});

/** @param {unknown} value @param {number} max */
const hintWord = (value, max) =>
  typeof value === "string"
    ? value
        .replace(/[\r\n\t]+/g, " ")
        .trim()
        .slice(0, max)
    : "";

/**
 * The expanded chip's one style-hint line for a publishable profile: accents
 * and the first mapped font, worded by source. Undefined for sources without a
 * hint (image pixels) or a profile without usable values.
 * @param {Record<string, unknown>} profile
 * @returns {string|undefined}
 */
function styleHintLine(profile) {
  const suffix = HINT_SUFFIX[/** @type {keyof typeof HINT_SUFFIX} */ (profile.source)];
  if (!suffix) return undefined;
  const parts = [];
  const hexes = Array.isArray(profile.accentColors)
    ? profile.accentColors
        .map((entry) =>
          entry && typeof entry === "object" ? /** @type {Record<string, unknown>} */ (entry).hex : undefined,
        )
        .filter((hex) => typeof hex === "string" && /^#[0-9a-f]{6}$/i.test(hex))
    : [];
  if (hexes.length) parts.push(`强调色 ${hexes.join("、")}`);
  const font = Array.isArray(profile.fonts) ? profile.fonts[0] : undefined;
  if (font && typeof font === "object") {
    const stored = /** @type {Record<string, unknown>} */ (font);
    const mapped =
      stored.mapped && typeof stored.mapped === "object" ? /** @type {Record<string, unknown>} */ (stored.mapped) : {};
    const source = hintWord(stored.source, 80);
    const ea = hintWord(mapped.ea, 40);
    if (source && ea) parts.push(`字体 ${source} → ${ea}`);
  }
  return parts.length ? `风格线索：${parts.join("；")}（${suffix}）` : undefined;
}

/**
 * The orientation word the browser may show. Pre-M4 image records kept the numeric EXIF
 * orientation, but their width and height were already display-oriented, so the word is read
 * from them. Any other value is not published.
 * @param {StoredImage} image
 * @returns {string|undefined}
 */
function publicOrientation(image) {
  if (typeof image.orientation === "number") {
    const { width, height } = image;
    if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) {
      return undefined;
    }
    return width === height ? "square" : width > height ? "landscape" : "portrait";
  }
  return typeof image.orientation === "string" && ORIENTATIONS.includes(image.orientation)
    ? image.orientation
    : undefined;
}

/** @param {StoredImage} image */
function publicImageMetadata(image) {
  const orientation = publicOrientation(image);
  if (!orientation) return undefined;
  return {
    orientation,
    ...(typeof image.logoLike === "boolean" ? { logoLike: image.logoLike } : {}),
    ...(typeof image.screenshotLike === "boolean" ? { screenshotLike: image.screenshotLike } : {}),
    ...(image.takenAt ? { takenAt: image.takenAt } : {}),
  };
}

/**
 * The style profile the public contract can carry. An image pixel profile counts no pages. A
 * PDF profile must count 1..30 measured pages; vector-less copies stored before that window
 * reported 0, and the contract rejects them. A Word theme profile (CAP-33) publishes only
 * when it carries both accents and fonts: with neither there is no hint to show.
 * @param {unknown} profile
 * @returns {Record<string, unknown>|undefined}
 */
function publishableStyleProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return undefined;
  const stored = /** @type {Record<string, unknown>} */ (profile);
  if (stored.source === "image-pixels") return stored;
  if (stored.source === "docx-theme") {
    return Array.isArray(stored.accentColors) &&
      stored.accentColors.length > 0 &&
      stored.accentColors.length <= 5 &&
      Array.isArray(stored.fonts) &&
      stored.fonts.length > 0 &&
      stored.fonts.length <= 4
      ? stored
      : undefined;
  }
  const pagesScanned = stored.pagesScanned;
  return typeof pagesScanned === "number" &&
    Number.isInteger(pagesScanned) &&
    pagesScanned >= 1 &&
    pagesScanned <= MAX_PDF_STYLE_PAGES
    ? stored
    : undefined;
}

/**
 * Public projection of a stored record's style profile and image metadata. The stored record
 * is only read, never changed.
 * @param {{document?:{styleProfile?:unknown},image?:StoredImage}} derivative
 */
export function publicStyleProfile(derivative) {
  const document = derivative.image ?? derivative.document;
  const profile =
    document && typeof document === "object" && !Array.isArray(document)
      ? publishableStyleProfile(document.styleProfile)
      : undefined;
  const imageMetadata = derivative.image ? publicImageMetadata(derivative.image) : undefined;
  const hintLine = profile ? styleHintLine(profile) : undefined;
  return {
    ...(profile ? { styleProfile: profile } : {}),
    ...(hintLine ? { styleHintLine: hintLine } : {}),
    ...(imageMetadata ? { imageMetadata } : {}),
  };
}

/**
 * Child image materials the browser must also select: the members of an image
 * pack (which replace the pack), or the pictures embedded in a DOCX/PDF (which
 * ride along with their document).
 * @param {import("../attachments.mjs").StoredDerivative} derivative
 */
export function publicImageChildren(derivative) {
  const packImages = derivative.image?.pack?.images;
  if (derivative.parser?.id === "image-pack-v1" && Array.isArray(packImages)) {
    return { imageMaterials: packImages };
  }
  const embedded = derivative.document?.embeddedImages?.images;
  return Array.isArray(embedded) && embedded.length ? { embeddedImages: embedded } : {};
}
