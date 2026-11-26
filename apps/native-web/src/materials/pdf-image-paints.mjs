/**
 * Geometry of the images a PDF page paints, read from its operator list without
 * decoding anything: the graphics transform stack (q / Q / cm) places each image's
 * unit square on the page, and the determinant of that placement is its area.
 */

const IMAGE_PAINT_OPERATORS = new Set([
  "paintImageXObject",
  "paintImageXObjectRepeat",
  "paintInlineImageXObject",
  "paintInlineImageXObjectGroup",
  "paintImageMaskXObject",
  "paintImageMaskXObjectRepeat",
  "paintImageMaskXObjectGroup",
]);

/** @param {unknown} value @returns {value is number[]} */
function isMatrix(value) {
  return Array.isArray(value) && value.length >= 6 && value.slice(0, 6).every(Number.isFinite);
}

/**
 * @param {number[]} left
 * @param {number[]} right
 * @returns {[number, number, number, number, number, number]}
 */
function multiplyMatrix(left, right) {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = left;
  const [g = 0, h = 0, i = 0, j = 0, k = 0, l = 0] = right;
  return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
}

/**
 * Area and viewport matrix of a pdf.js page at scale 1, or undefined for a page
 * without a usable size.
 * @param {any} page
 * @returns {{area: number, matrix: number[]}|undefined}
 */
export function pageGeometry(page) {
  const viewport = page.getViewport?.({ scale: 1 });
  const width = Number(viewport?.width) || page.view?.[2] - page.view?.[0];
  const height = Number(viewport?.height) || page.view?.[3] - page.view?.[1];
  const area = width * height;
  if (!(area > 0)) return undefined;
  return {
    area,
    matrix: Array.isArray(viewport?.transform) ? viewport.transform : [1, 0, 0, 1, 0, 0],
  };
}

/**
 * Every image paint of a page in drawing order, with the area it covers in
 * viewport units. `key` is the pdf.js object id (what `unpdf.extractImages`
 * reports as `key`) and is absent for inline images and masks.
 * @param {{fnArray: number[], argsArray: unknown[]}} operatorList
 * @param {Map<number, string>} namesByOperator
 * @param {number[]} viewportMatrix
 * @returns {{key?: string, area: number}[]}
 */
export function imagePaints(operatorList, namesByOperator, viewportMatrix) {
  /** @type {{key?: string, area: number}[]} */
  const paints = [];
  walkTransforms(operatorList, namesByOperator, (operation, args, matrix) => {
    if (!operation || !IMAGE_PAINT_OPERATORS.has(operation)) return;
    const transformed = multiplyMatrix(viewportMatrix, matrix);
    paints.push({
      ...(typeof args[0] === "string" ? { key: args[0] } : {}),
      area: Math.abs(transformed[0] * transformed[3] - transformed[1] * transformed[2]),
    });
  });
  return paints;
}

/** @param {unknown[]} args @returns {number[]|undefined} the matrix an operator carries */
function placementMatrix(args) {
  if (isMatrix(args)) return args;
  return isMatrix(args[0]) ? args[0] : undefined;
}

/**
 * Walk an operator list tracking the current transform: q / Q save and restore it,
 * cm concatenates onto it (a plain cm opens no save frame, so the next Q still restores
 * the matrix saved by its own q). With `forms`, paintFormXObjectBegin/End also open and
 * close a frame around the form's placement matrix, as pdf.js save()s around a form.
 * Every other operation reaches `visit` with the matrix in force.
 * @param {{fnArray: number[], argsArray: unknown[]}} operatorList
 * @param {Map<number, string>} namesByOperator
 * @param {(operation: string|undefined, args: unknown[], matrix: number[]) => void} visit
 * @param {{forms?: boolean, matrixOf?: (args: unknown[]) => number[]|undefined}} [options]
 */
export function walkTransforms(
  operatorList,
  namesByOperator,
  visit,
  { forms = false, matrixOf = placementMatrix } = {},
) {
  let matrix = [1, 0, 0, 1, 0, 0];
  /** @type {number[][]} */
  const saved = [];
  for (let i = 0; i < operatorList.fnArray.length; i += 1) {
    const operation = namesByOperator.get(/** @type {number} */ (operatorList.fnArray[i]));
    const args = /** @type {unknown[]} */ (operatorList.argsArray[i] ?? []);
    const opensForm = forms && operation === "paintFormXObjectBegin";
    if (operation === "save" || opensForm) saved.push(matrix);
    if (operation === "restore" || (forms && operation === "paintFormXObjectEnd")) {
      matrix = saved.pop() ?? matrix;
    } else if (operation === "transform" || opensForm) {
      const transform = matrixOf(args);
      if (transform) matrix = multiplyMatrix(matrix, transform);
    } else if (operation !== "save") {
      visit(operation, args, matrix);
    }
  }
}
