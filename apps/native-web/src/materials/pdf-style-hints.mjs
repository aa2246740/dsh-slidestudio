import { normalizeSourceFonts } from "@open-slidestudio/pptd-v2";
import { imagePaints, pageGeometry } from "./pdf-image-paints.mjs";

export const MAX_PDF_STYLE_PAGES = 30;
export const MAX_PDF_STYLE_OPERATORS_PER_PAGE = 100_000;
export const MAX_PDF_STYLE_OPERATORS_TOTAL = 300_000;

/** Image decoding is deliberately disabled during vector-only inspection. */
export const PDF_DOCUMENT_OPTIONS = Object.freeze({
  fontExtraProperties: true,
  isEvalSupported: false,
  maxImageSize: 1,
});

const TEXT_OPERATORS = new Set(["showText", "showSpacedText", "nextLineShowText", "nextLineSetSpacingShowText"]);
const TEXT_FILL_MODES = new Set([0, 2, 4, 6]);
const TEXT_STROKE_MODES = new Set([1, 2, 5, 6]);
const FILL_OPERATORS = new Set(["fill", "eoFill"]);
const STROKE_OPERATORS = new Set(["stroke", "closeStroke"]);
const COMBINED_OPERATORS = new Set(["fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"]);
const STANDARD_PDF_FONTS = new Set([
  "courier",
  "courier-bold",
  "courier-boldoblique",
  "courier-oblique",
  "helvetica",
  "helvetica-bold",
  "helvetica-boldoblique",
  "helvetica-oblique",
  "symbol",
  "times-bold",
  "times-bolditalic",
  "times-italic",
  "times-roman",
  "zapfdingbats",
]);
const MAX_NEUTRAL_COLORS = 12;

/**
 * @typedef {{getPage:(pageNumber:number)=>Promise<{
 *   commonObjs:{get:(id:string)=>unknown},
 *   getOperatorList:()=>Promise<{fnArray:number[],argsArray:unknown[]}>,
 *   cleanup?:()=>void
 * }>}} StylePdfProxy
 */

/**
 * Derive advisory colours and font names from PDF vector operators.
 * Any failure is contained here so callers can preserve successful text extraction.
 * @param {{
 *   unpdf: typeof import("unpdf"),
 *   proxy: object,
 *   pageCount: number,
 * }} input
 * @returns {Promise<{
 *   schema:string, source:string, pagesScanned:number,
 *   accentColors:{hex:string,share:number,roles:string[]}[],
 *   neutralColors:{hex:string}[],
 *   fonts:{source:string,share:number,mapped:{latin:string,ea:string}}[],
 *   producer?:string
 * }|undefined>}
 */
export async function extractPdfStyleProfile({ unpdf, proxy, pageCount }) {
  try {
    const pdfjs = await unpdf.getResolvedPDFJS();
    const ops = pdfjs.OPS;
    const pdfProxy = /** @type {StylePdfProxy} */ (proxy);
    const namesByOperator = new Map(Object.entries(ops).map(([name, operator]) => [operator, name]));
    /** @type {Map<string, {uses:number, roles:Set<string>}>} */
    const colors = new Map();
    /** @type {Map<string, number>} */
    const fonts = new Map();
    let pagesScanned = 0;
    let totalOperators = 0;

    for (let pageNumber = 1; pageNumber <= Math.min(pageCount, MAX_PDF_STYLE_PAGES); pageNumber += 1) {
      const page = await pdfProxy.getPage(pageNumber);
      try {
        const operatorList = await page.getOperatorList();
        const functions = operatorList.fnArray;
        if (
          functions.length > MAX_PDF_STYLE_OPERATORS_PER_PAGE ||
          totalOperators + functions.length > MAX_PDF_STYLE_OPERATORS_TOTAL
        ) {
          return undefined;
        }
        totalOperators += functions.length;
        scanPageOperators(page, operatorList, namesByOperator, colors, fonts);
        pagesScanned += 1;
      } finally {
        page.cleanup?.();
      }
    }

    const accentCounts = [...colors.entries()]
      .filter(([hex]) => !isNeutralColor(hex))
      .sort(([hexA, a], [hexB, b]) => b.uses - a.uses || hexA.localeCompare(hexB));
    const accentUseCount = accentCounts.reduce((total, [, item]) => total + item.uses, 0);
    const accentColors = accentCounts.slice(0, 5).map(([hex, item]) => ({
      hex,
      share: ratio(item.uses, accentUseCount),
      roles: ["text", "fill", "stroke"].filter((role) => item.roles.has(role)),
    }));

    const neutralColors = [...colors.entries()]
      .filter(([hex]) => isNeutralColor(hex))
      .sort(([hexA, a], [hexB, b]) => b.uses - a.uses || hexA.localeCompare(hexB))
      .slice(0, MAX_NEUTRAL_COLORS)
      .map(([hex]) => ({ hex }));

    const fontUseCount = [...fonts.values()].reduce((total, count) => total + count, 0);
    const fontHints = [...fonts.entries()]
      .sort(([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB))
      .slice(0, 4)
      .map(([source, count]) => {
        const mapped = normalizeSourceFonts({
          major: { latin: source, ea: source, hans: source },
          minor: { latin: source, ea: source, hans: source },
        }).major.mapped;
        return {
          source,
          share: ratio(count, fontUseCount),
          mapped: { latin: mapped.latin, ea: mapped.ea },
        };
      });

    if (accentColors.length === 0 && fontHints.length === 0) return undefined;

    const profile = {
      schema: "style-profile/v1",
      source: "pdf-vector-ops",
      pagesScanned,
      accentColors,
      neutralColors,
      fonts: fontHints,
    };
    const producer = await producerOf(unpdf, proxy);
    return producer ? { ...profile, producer } : profile;
  } catch {
    return undefined;
  }
}

/**
 * Image area is measured from the PDF graphics transform without decoding
 * the image stream. A failed or over-budget page is omitted so its wording
 * remains neutral rather than guessing that it is a scan.
 * @param {{unpdf:typeof import("unpdf"),proxy:object,pageNumbers:number[]}} input
 */
export async function extractPdfPageImageCoverage({ unpdf, proxy, pageNumbers }) {
  /** @type {Map<number,number>} */
  const coverageByPage = new Map();
  try {
    const pdfjs = await unpdf.getResolvedPDFJS();
    const namesByOperator = new Map(Object.entries(pdfjs.OPS).map(([name, operator]) => [operator, name]));
    const pdfProxy = /** @type {{getPage:(n:number)=>Promise<any>}} */ (proxy);
    let totalOperators = 0;
    for (const pageNumber of [...new Set(pageNumbers)]) {
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 40 || coverageByPage.size >= 40) {
        continue;
      }
      let page;
      try {
        page = await pdfProxy.getPage(pageNumber);
        const operatorList = await page.getOperatorList();
        const length = operatorList.fnArray.length;
        if (length > MAX_PDF_STYLE_OPERATORS_PER_PAGE || totalOperators + length > MAX_PDF_STYLE_OPERATORS_TOTAL) {
          continue;
        }
        totalOperators += length;
        const geometry = pageGeometry(page);
        if (!geometry) continue;
        const imageArea = imagePaints(operatorList, namesByOperator, geometry.matrix).reduce(
          (sum, paint) => sum + paint.area,
          0,
        );
        coverageByPage.set(pageNumber, Math.min(1, imageArea / geometry.area));
      } catch {
        // Keep this page unknown; text extraction and other pages remain valid.
      } finally {
        page?.cleanup?.();
      }
    }
  } catch {
    return coverageByPage;
  }
  return coverageByPage;
}

/**
 * @param {{commonObjs:{get:(id:string)=>unknown}}} page
 * @param {{fnArray:number[],argsArray:unknown[]}} operatorList
 * @param {Map<number, string>} namesByOperator
 * @param {Map<string, {uses:number, roles:Set<string>}>} colors
 * @param {Map<string, number>} fonts
 */
function scanPageOperators(page, operatorList, namesByOperator, colors, fonts) {
  let state = initialStyleState();
  // PDF `q` saves a copy of the whole graphics state; `Q` pops it back. Without
  // this stack a colour set inside q…Q would keep leaking into later paints.
  const saved = [];
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operatorId = operatorList.fnArray[index];
    if (operatorId === undefined) continue;
    const operation = namesByOperator.get(operatorId);
    if (!operation) continue;
    if (operation === "save") {
      saved.push(state);
      state = cloneStyleState(state);
      continue;
    }
    if (operation === "restore") {
      state = saved.pop() ?? state;
      continue;
    }
    const operationArgs = /** @type {unknown[]} */ (operatorList.argsArray[index] ?? []);
    scanOperator(operation, operationArgs, page, state, namesByOperator, colors, fonts);
  }
}

/** @typedef {{fillColor:string,strokeColor:string,fontName:string|undefined,textRenderingMode:number}} StyleState */

/** @returns {StyleState} */
function initialStyleState() {
  return {
    fillColor: "#000000",
    strokeColor: "#000000",
    fontName: undefined,
    textRenderingMode: 0,
  };
}

/** @param {StyleState} state @returns {StyleState} */
function cloneStyleState(state) {
  return { ...state };
}

/**
 * @param {string} operation
 * @param {unknown[]} operationArgs
 * @param {{commonObjs:{get:(id:string)=>unknown}}} page
 * @param {StyleState} state
 * @param {Map<number, string>} namesByOperator
 * @param {Map<string, {uses:number, roles:Set<string>}>} colors
 * @param {Map<string, number>} fonts
 */
function scanOperator(operation, operationArgs, page, state, namesByOperator, colors, fonts) {
  if (operation === "setFillRGBColor") {
    state.fillColor = parseRgbColor(operationArgs) ?? state.fillColor;
  } else if (operation === "setStrokeRGBColor") {
    state.strokeColor = parseRgbColor(operationArgs) ?? state.strokeColor;
  } else if (operation === "setFillGray") {
    state.fillColor = parseGrayColor(operationArgs) ?? state.fillColor;
  } else if (operation === "setStrokeGray") {
    state.strokeColor = parseGrayColor(operationArgs) ?? state.strokeColor;
  } else if (operation === "setFillCMYKColor") {
    state.fillColor = parseCmykColor(operationArgs) ?? state.fillColor;
  } else if (operation === "setStrokeCMYKColor") {
    state.strokeColor = parseCmykColor(operationArgs) ?? state.strokeColor;
  } else if (operation === "setFont") {
    state.fontName = commonFontName(page.commonObjs, operationArgs[0]);
  } else if (operation === "setTextRenderingMode") {
    state.textRenderingMode = parseTextRenderingMode(operationArgs);
  } else if (TEXT_OPERATORS.has(operation)) {
    recordTextStyle(state, colors, fonts);
  } else if (operation === "constructPath") {
    const paintId = operationArgs[0];
    const paintOperator = typeof paintId === "number" ? namesByOperator.get(paintId) : undefined;
    if (paintOperator) {
      addPaintColors(colors, state.fillColor, state.strokeColor, paintOperator);
    }
  } else {
    addPaintColors(colors, state.fillColor, state.strokeColor, operation);
  }
}

/**
 * @param {unknown[]} operationArgs
 */
function parseTextRenderingMode(operationArgs) {
  const mode = numericValue(operationArgs);
  return mode !== undefined && Number.isInteger(mode) && mode >= 0 && mode <= 7 ? mode : -1;
}

/**
 * @param {StyleState} state
 * @param {Map<string, {uses:number, roles:Set<string>}>} colors
 * @param {Map<string, number>} fonts
 */
function recordTextStyle(state, colors, fonts) {
  if (!TEXT_FILL_MODES.has(state.textRenderingMode) && !TEXT_STROKE_MODES.has(state.textRenderingMode)) {
    return;
  }
  addTextColor(colors, state.fillColor, state.strokeColor, state.textRenderingMode);
  if (state.fontName && !isStandardPdfFont(state.fontName)) {
    fonts.set(state.fontName, (fonts.get(state.fontName) ?? 0) + 1);
  }
}

/** @param {Map<string, {uses:number, roles:Set<string>}>} counts @param {string} value @param {"text"|"fill"|"stroke"} role */
function addColor(counts, value, role) {
  const current = counts.get(value) ?? { uses: 0, roles: new Set() };
  current.uses += 1;
  current.roles.add(role);
  counts.set(value, current);
}

/**
 * @param {Map<string, {uses:number, roles:Set<string>}>} colors
 * @param {string} fillColor
 * @param {string} strokeColor
 * @param {number} mode
 */
function addTextColor(colors, fillColor, strokeColor, mode) {
  if (TEXT_FILL_MODES.has(mode)) addColor(colors, fillColor, "text");
  if (TEXT_STROKE_MODES.has(mode)) addColor(colors, strokeColor, "text");
}

/**
 * @param {Map<string, {uses:number, roles:Set<string>}>} colors
 * @param {string} fillColor
 * @param {string} strokeColor
 * @param {string} operation
 */
function addPaintColors(colors, fillColor, strokeColor, operation) {
  if (FILL_OPERATORS.has(operation)) addColor(colors, fillColor, "fill");
  else if (STROKE_OPERATORS.has(operation)) addColor(colors, strokeColor, "stroke");
  else if (COMBINED_OPERATORS.has(operation)) {
    addColor(colors, fillColor, "fill");
    addColor(colors, strokeColor, "stroke");
  }
}

/** @param {unknown} args */
function parseRgbColor(args) {
  if (!Array.isArray(args)) return undefined;
  const first = args[0];
  if (typeof first === "string" && /^#[\da-f]{6}$/i.test(first)) return first.toUpperCase();
  const values = Array.isArray(first) ? first : args;
  if (values.length < 3 || values.slice(0, 3).some((value) => typeof value !== "number")) {
    return undefined;
  }
  return `#${values
    .slice(0, 3)
    .map((value) =>
      Math.round(scaleColorChannel(/** @type {number} */ (value)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase()}`;
}

/** @param {unknown} args */
function parseGrayColor(args) {
  const value = numericValue(args);
  if (value === undefined) return undefined;
  return parseRgbColor([value, value, value]);
}

/** @param {unknown} args */
function parseCmykColor(args) {
  if (!Array.isArray(args)) return undefined;
  const values = Array.isArray(args[0]) ? args[0] : args;
  if (values.length < 4 || values.slice(0, 4).some((value) => typeof value !== "number")) {
    return undefined;
  }
  const cyan = clampUnit(scaleUnit(/** @type {number} */ (values[0])));
  const magenta = clampUnit(scaleUnit(/** @type {number} */ (values[1])));
  const yellow = clampUnit(scaleUnit(/** @type {number} */ (values[2])));
  const key = clampUnit(scaleUnit(/** @type {number} */ (values[3])));
  return parseRgbColor([
    1 - Math.min(1, cyan * (1 - key) + key),
    1 - Math.min(1, magenta * (1 - key) + key),
    1 - Math.min(1, yellow * (1 - key) + key),
  ]);
}

/** @param {unknown} args */
function numericValue(args) {
  if (!Array.isArray(args)) return undefined;
  const value = Array.isArray(args[0]) ? args[0][0] : args[0];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** @param {number} value */
function scaleColorChannel(value) {
  return Math.min(255, Math.max(0, value <= 1 ? value * 255 : value));
}

/** @param {number} value */
function scaleUnit(value) {
  return value <= 1 ? value : value / 255;
}

/** @param {number} value */
function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

/** @param {{get:(id:string)=>unknown}} commonObjects @param {unknown} id */
function commonFontName(commonObjects, id) {
  if (typeof id !== "string") return undefined;
  try {
    const font = /** @type {{name?:unknown, baseFontName?:unknown}} */ (commonObjects.get(id));
    const rawName =
      typeof font?.name === "string" ? font.name : typeof font?.baseFontName === "string" ? font.baseFontName : "";
    const name = rawName
      .replace(/^[A-Z]{6}\+/, "")
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 120);
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} font */
function isStandardPdfFont(font) {
  return STANDARD_PDF_FONTS.has(font.toLowerCase().replace(/[-_ ]/g, "-"));
}

/** @param {string} hex */
function isNeutralColor(hex) {
  const red = parseInt(hex.slice(1, 3), 16) / 255;
  const green = parseInt(hex.slice(3, 5), 16) / 255;
  const blue = parseInt(hex.slice(5, 7), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const lightness = (maximum + minimum) / 2;
  const saturation = maximum === minimum ? 0 : (maximum - minimum) / (1 - Math.abs(2 * lightness - 1));
  return saturation < 0.12 || lightness > 0.92 || lightness < 0.1;
}

/** @param {number} part @param {number} total */
function ratio(part, total) {
  return total ? Math.round((part / total) * 10000) / 10000 : 0;
}

/** @param {typeof import("unpdf")} unpdf @param {object} proxy */
async function producerOf(unpdf, proxy) {
  try {
    const meta = await unpdf.getMeta(/** @type {Parameters<typeof unpdf.getMeta>[0]} */ (proxy));
    const info = meta?.info;
    const value = info?.Creator ?? info?.Producer;
    if (typeof value !== "string") return undefined;
    const producer = value.trim().slice(0, 120);
    return producer || undefined;
  } catch {
    return undefined;
  }
}
