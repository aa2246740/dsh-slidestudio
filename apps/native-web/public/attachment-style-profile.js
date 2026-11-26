import { INVALID_REPLY, record } from "./generation-data.js";

/** @param {StyleProfile|undefined} profile @param {unknown} kind
 * @param {unknown} parser @param {unknown} imageMetadata */
export function assertStyleProfileContext(profile, kind, parser, imageMetadata) {
  if (imageMetadata !== undefined && kind !== "image") throw new Error(INVALID_REPLY);
  if (!profile) return;
  const image = kind === "image" && profile.source === "image-pixels";
  const pdf =
    kind === "document" &&
    typeof parser === "string" &&
    parser.startsWith("pdf-unpdf-") &&
    profile.source !== "image-pixels" &&
    profile.source !== "docx-theme";
  const word =
    kind === "document" &&
    typeof parser === "string" &&
    parser.startsWith("docx-ooxml-") &&
    profile.source === "docx-theme";
  if (!image && !pdf && !word) throw new Error(INVALID_REPLY);
}

/**
 * @typedef {{
 *  schema:"style-profile/v1", source:string, pagesScanned:number, accentColors:{hex:string,share:number,roles:string[]}[], neutralColors:{hex:string}[],
 *  fonts:{source:string,share:number,mapped:{latin:string,ea:string}}[], producer?:string, rasterHeavyPages?:number[] }} PdfStyleProfile
 * @typedef {Omit<PdfStyleProfile, "pagesScanned"|"neutralColors"|"producer"|"rasterHeavyPages"> & {source:"docx-theme"}} DocxThemeStyleProfile
 * @typedef {{schema:"style-profile/v1",source:"image-pixels",accentColors:{hex:string,share:number}[],
 * neutralColors:{hex:string}[],background:string,contrastPairs:{fg:string,bg:string,ratio:number}[]}} ImageStyleProfile
 * @typedef {PdfStyleProfile|DocxThemeStyleProfile|ImageStyleProfile} StyleProfile
 */

/** @param {unknown} value @returns {unknown[]} */
const arrayOf = (value) => (Array.isArray(value) ? value : []);

/** @param {unknown} value @param {number} max */
const boundedArray = (value, max) => Array.isArray(value) && value.length <= max;

/** Bounds of the PDF projection: 1-30 scanned pages, at most 5 accents, 12 neutrals, 4 fonts.
 * @param {Record<string, unknown>} profile */
function validPdfProfileShape(profile) {
  const pages = profile.pagesScanned;
  return (
    profile.schema === "style-profile/v1" &&
    typeof pages === "number" &&
    Number.isSafeInteger(pages) &&
    pages >= 1 &&
    pages <= 30 &&
    boundedArray(profile.accentColors, 5) &&
    boundedArray(profile.neutralColors, 12) &&
    boundedArray(profile.fonts, 4)
  );
}

/**
 * Strictly validate the bounded public projection of a material style profile.
 * @param {unknown} value
 * @returns {StyleProfile|undefined}
 */
export function parsePublicStyleProfile(value) {
  if (value === undefined) return undefined;
  const profile = record(value);
  if (profile.source === "image-pixels") return parseImageProfile(profile);
  if (profile.source === "docx-theme") return parseDocxThemeProfile(profile);
  const pagesScanned = profile.pagesScanned;
  if (!validPdfProfileShape(profile) || typeof profile.source !== "string") {
    throw new Error(INVALID_REPLY);
  }
  const accentColors = arrayOf(profile.accentColors).map(parseAccentColor);
  const neutralColors = arrayOf(profile.neutralColors).map(parseNeutralColor);
  const fonts = arrayOf(profile.fonts).map(parseFont);
  const rasterHeavyPages = profile.rasterHeavyPages;
  if (
    rasterHeavyPages !== undefined &&
    (!Array.isArray(rasterHeavyPages) || rasterHeavyPages.some((page) => !Number.isSafeInteger(page) || page < 1))
  ) {
    throw new Error(INVALID_REPLY);
  }
  if (profile.producer !== undefined && typeof profile.producer !== "string") {
    throw new Error(INVALID_REPLY);
  }
  return {
    schema: "style-profile/v1",
    source: profile.source,
    pagesScanned: /** @type {number} */ (pagesScanned),
    accentColors,
    neutralColors,
    fonts,
    ...(typeof profile.producer === "string" ? { producer: profile.producer } : {}),
    ...(Array.isArray(rasterHeavyPages) ? { rasterHeavyPages: /** @type {number[]} */ ([...rasterHeavyPages]) } : {}),
  };
}

/**
 *  A Word theme profile: accents plus at least one font, no pages and no neutrals — the theme carries nothing else the contract publishes.
 * @param {Record<string, unknown>} profile @returns {DocxThemeStyleProfile}
 */
function parseDocxThemeProfile(profile) {
  if (
    profile.schema !== "style-profile/v1" ||
    !Array.isArray(profile.accentColors) ||
    profile.accentColors.length < 1 ||
    profile.accentColors.length > 5 ||
    !Array.isArray(profile.fonts) ||
    profile.fonts.length < 1 ||
    profile.fonts.length > 4
  ) {
    throw new Error(INVALID_REPLY);
  }
  return {
    schema: "style-profile/v1",
    source: "docx-theme",
    accentColors: profile.accentColors.map((value) => {
      const color = parseAccentColor(value);
      if (color.roles.length !== 1 || color.roles[0] !== "fill") {
        throw new Error(INVALID_REPLY);
      }
      return color;
    }),
    fonts: profile.fonts.map(parseFont),
  };
}

/** @param {Record<string, unknown>} profile @returns {ImageStyleProfile} */
function parseImageProfile(profile) {
  if (
    profile.schema !== "style-profile/v1" ||
    !Array.isArray(profile.accentColors) ||
    profile.accentColors.length > 5 ||
    !Array.isArray(profile.neutralColors) ||
    profile.neutralColors.length > 8 ||
    !Array.isArray(profile.contrastPairs) ||
    profile.contrastPairs.length > 7
  )
    throw new Error(INVALID_REPLY);
  return {
    schema: "style-profile/v1",
    source: "image-pixels",
    accentColors: profile.accentColors.map((value) => {
      const color = record(value);
      const { hex, share } = parseAccentColor({ ...color, roles: ["fill"] });
      return { hex, share };
    }),
    neutralColors: profile.neutralColors.map(parseNeutralColor),
    background: parseNeutralColor({ hex: profile.background }).hex,
    contrastPairs: profile.contrastPairs.map((value) => {
      const pair = record(value);
      if (typeof pair.ratio !== "number" || !Number.isFinite(pair.ratio) || pair.ratio < 1 || pair.ratio > 21)
        throw new Error(INVALID_REPLY);
      return {
        fg: parseNeutralColor({ hex: pair.fg }).hex,
        bg: parseNeutralColor({ hex: pair.bg }).hex,
        ratio: pair.ratio,
      };
    }),
  };
}

/** @param {unknown} value @returns {{hex:string,share:number,roles:string[]}} */
function parseAccentColor(value) {
  const color = record(value);
  if (
    typeof color.hex !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(color.hex) ||
    typeof color.share !== "number" ||
    !Number.isFinite(color.share) ||
    color.share < 0 ||
    color.share > 1 ||
    !Array.isArray(color.roles) ||
    color.roles.length < 1 ||
    color.roles.length > 3 ||
    new Set(color.roles).size !== color.roles.length ||
    color.roles.some((role) => !["text", "fill", "stroke"].includes(role))
  ) {
    throw new Error(INVALID_REPLY);
  }
  return { hex: color.hex.toUpperCase(), share: color.share, roles: [...color.roles] };
}

/** @param {unknown} value @returns {{hex:string}} */
function parseNeutralColor(value) {
  const color = record(value);
  if (typeof color.hex !== "string" || !/^#[0-9a-f]{6}$/i.test(color.hex)) {
    throw new Error(INVALID_REPLY);
  }
  return { hex: color.hex.toUpperCase() };
}

/** @param {unknown} value @returns {{source:string,share:number,mapped:{latin:string,ea:string}}} */
function parseFont(value) {
  const font = record(value);
  const mapped = record(font.mapped);
  if (
    typeof font.source !== "string" ||
    typeof font.share !== "number" ||
    !Number.isFinite(font.share) ||
    font.share < 0 ||
    font.share > 1 ||
    typeof mapped.latin !== "string" ||
    typeof mapped.ea !== "string"
  ) {
    throw new Error(INVALID_REPLY);
  }
  return {
    source: font.source,
    share: font.share,
    mapped: { latin: mapped.latin, ea: mapped.ea },
  };
}
