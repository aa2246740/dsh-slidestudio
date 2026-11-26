/**
 *  Shared native shape SVG markup. Loaded by the editor (script tag) and driven by unit tests — keep this the only place that emits the <svg>.
 */
/** @import { ShapePaintInput, ShapePaintImageFill } from "./shape-paint.types.js" */
/** @import { RenderElement } from "@open-slidestudio/canvas-session" */
(function (root) {
  let gradientSerial = 0;
  let imageSerial = 0;

  /** @param {unknown} value @returns {value is Record<string, unknown>} */
  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * A custom path's viewBox: two finite positive sides. Undefined for a preset.
   * @param {unknown} value
   * @returns {[number, number] | undefined | null} null when present but invalid
   */
  function viewBoxInput(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [width, height] = value;
    const side = (/** @type {unknown} */ n) => typeof n === "number" && Number.isFinite(n) && n > 0;
    return side(width) && side(height) ? [Number(width), Number(height)] : null;
  }

  /** @param {unknown} value @returns {number | undefined} undefined when present but outside 0 to 1 */
  function cropSideInput(value) {
    if (value === undefined) return 0;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
  }

  /**
   * A picture-fill crop, kept only when every side is in range and some picture stays visible.
   * @param {unknown} value
   * @returns {{left: number, top: number, right: number, bottom: number} | undefined}
   */
  function cropInput(value) {
    if (!isRecord(value)) return undefined;
    const left = cropSideInput(value.left);
    const top = cropSideInput(value.top);
    const right = cropSideInput(value.right);
    const bottom = cropSideInput(value.bottom);
    if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
      return undefined;
    }
    if (left + right >= 1 || top + bottom >= 1) return undefined;
    return { left, top, right, bottom };
  }

  /** @param {unknown} value @returns {[number, number] | undefined} */
  function tileInput(value) {
    if (!Array.isArray(value) || value.length !== 2) return undefined;
    const [width, height] = value;
    const side = (/** @type {unknown} */ n) => typeof n === "number" && Number.isFinite(n) && n > 0;
    return side(width) && side(height) ? [Number(width), Number(height)] : undefined;
  }

  /**
   *  The render model's shadow for an outline drawn as SVG (a custom path or a non-rectangular preset). Undefined when absent or when a length is not a finite number.
   * @param {unknown} value
   * @returns {RenderElement["shadow"]}
   */
  function shadowInput(value) {
    if (!isRecord(value)) return undefined;
    const finite = (/** @type {unknown} */ n) => typeof n === "number" && Number.isFinite(n);
    const { blur, offsetX, offsetY, color } = value;
    if (!finite(blur) || !finite(offsetX) || !finite(offsetY) || typeof color !== "string") {
      return undefined;
    }
    return { blur: Number(blur), offsetX: Number(offsetX), offsetY: Number(offsetY), color };
  }

  /** @param {unknown} value @returns {ShapePaintImageFill | undefined | null} null when present but not an object */
  function imageFillInput(value) {
    if (value === undefined) return undefined;
    if (!isRecord(value)) return null;
    return {
      href: typeof value.href === "string" ? value.href : undefined,
      mode: value.mode === "tile" ? "tile" : "stretch",
      crop: cropInput(value.crop),
      tile: tileInput(value.tile),
    };
  }

  /** @param {unknown} value */
  function finiteNonNegative(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  /**
   * The outline style: colour and width, each optional. Null when present but malformed.
   * @param {unknown} border
   * @returns {{color: string | undefined, width: number | undefined} | null}
   */
  function borderInput(border) {
    if (border === undefined) return { color: undefined, width: undefined };
    if (!isRecord(border)) return null;
    const { color, width } = border;
    if (color !== undefined && typeof color !== "string") return null;
    if (width !== undefined && !finiteNonNegative(width)) return null;
    return {
      color: typeof color === "string" ? color : undefined,
      width: typeof width === "number" ? width : undefined,
    };
  }

  /** @param {unknown} value @returns {ShapePaintInput | null} */
  function paintInput(value) {
    if (!isRecord(value)) return null;
    const source = { ...value };
    for (const key of ["pathD", "pathStroke", "fillCss"]) {
      if (source[key] !== undefined && typeof source[key] !== "string") return null;
    }
    const viewBox = viewBoxInput(source.viewBox);
    const border = borderInput(source.border);
    const imageFill = imageFillInput(source.imageFill);
    if (viewBox === null || border === null || imageFill === null) return null;
    return {
      pathD: typeof source.pathD === "string" ? source.pathD : undefined,
      pathStroke: typeof source.pathStroke === "string" ? source.pathStroke : undefined,
      fillCss: typeof source.fillCss === "string" ? source.fillCss : undefined,
      viewBox,
      border,
      imageFill,
      shadow: shadowInput(source.shadow),
    };
  }

  /** Escape a model string before it lands inside an SVG attribute. */
  /** @param {string} value */
  function escAttr(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** @param {string} value */
  function splitGradientStops(value) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === "(") depth += 1;
      else if (value[i] === ")") depth = Math.max(0, depth - 1);
      else if (value[i] === "," && depth === 0) {
        out.push(value.slice(start, i).trim());
        start = i + 1;
      }
    }
    out.push(value.slice(start).trim());
    return out.filter(Boolean);
  }

  /** @param {string} css */
  function svgStopColor(css) {
    const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(css);
    if (!rgba) return { color: css, opacity: undefined };
    return {
      color: `rgb(${rgba[1]}, ${rgba[2]}, ${rgba[3]})`,
      opacity: rgba[4],
    };
  }

  /**
   * Gradient across the drawing box: presets use the 100 x 100 box, a custom path its viewBox.
   * @param {string} css
   * @param {[number, number]} box
   */
  function gradientPaint(css, box) {
    const match = /^linear-gradient\(\s*(-?[\d.]+)deg\s*,(.*)\)$/i.exec(css);
    if (!match) return null;
    const parts = splitGradientStops(match[2] ?? "");
    if (parts.length < 2) return null;
    const angle = Number(match[1]);
    if (!Number.isFinite(angle)) return null;
    const rad = ((angle - 90) * Math.PI) / 180;
    const [width, height] = box;
    const x1 = width / 2 - Math.cos(rad) * (width / 2);
    const y1 = height / 2 - Math.sin(rad) * (height / 2);
    const x2 = width / 2 + Math.cos(rad) * (width / 2);
    const y2 = height / 2 + Math.sin(rad) * (height / 2);
    const id = `oss-shape-gradient-${(gradientSerial += 1)}`;
    const stops = parts
      .map((part, index) => {
        let boundary = part.length;
        while (boundary > 0 && !/\s/.test(part.charAt(boundary - 1))) boundary -= 1;
        const last = part.slice(boundary);
        const hasOffset = boundary > 0 && /^-?[\d.]+%$/.test(last);
        const rawColor = (hasOffset ? part.slice(0, boundary) : part).trim();
        const offset = hasOffset ? last : `${Math.round((index / (parts.length - 1)) * 100)}%`;
        const paint = svgStopColor(rawColor);
        const opacity = paint.opacity == null ? "" : ` stop-opacity="${paint.opacity}"`;
        return `<stop offset="${escAttr(offset)}" stop-color="${escAttr(paint.color)}"${opacity}/>`;
      })
      .join("");
    return {
      fill: `url(#${id})`,
      defs: `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient></defs>`,
    };
  }

  /** @param {number} value */
  function roundUnit(value) {
    return String(Math.round(value * 1000) / 1000);
  }

  /**
   *  A picture fill, drawn through an SVG pattern. Stretch draws the whole picture across the box; tile repeats it at natural size. A crop scales the picture so the visible part fills that area. Null when no loadable URL is available.
   * @param {ShapePaintImageFill | undefined} imageFill
   * @param {[number, number]} box
   * @returns {{fill: string, defs: string} | null}
   */
  function imageFillPaint(imageFill, box) {
    if (!imageFill?.href) return null;
    const crop = imageFill.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const visibleWidth = 1 - crop.left - crop.right;
    const visibleHeight = 1 - crop.top - crop.bottom;
    const tile = imageFill.mode === "tile" ? imageFill.tile : undefined;
    // The picture's drawn size and the repeat cell that one pattern tile covers.
    const drawnWidth = tile ? tile[0] : box[0] / visibleWidth;
    const drawnHeight = tile ? tile[1] : box[1] / visibleHeight;
    const cellWidth = tile ? drawnWidth * visibleWidth : box[0];
    const cellHeight = tile ? drawnHeight * visibleHeight : box[1];
    const id = `oss-shape-image-${(imageSerial += 1)}`;
    const picture = `<image href="${escAttr(imageFill.href)}" x="${roundUnit(-crop.left * drawnWidth)}" y="${roundUnit(-crop.top * drawnHeight)}" width="${roundUnit(drawnWidth)}" height="${roundUnit(drawnHeight)}" preserveAspectRatio="none"/>`;
    return {
      fill: `url(#${id})`,
      defs: `<defs><pattern id="${id}" patternUnits="userSpaceOnUse" width="${roundUnit(cellWidth)}" height="${roundUnit(cellHeight)}">${picture}</pattern></defs>`,
    };
  }

  /** Keep in sync with svgFillFromFillCss in packages/pptd-v2. Omitted fill is no paint. */
  /** @param {string | undefined} fillCss */
  function svgFillFromFillCss(fillCss) {
    if (!fillCss || fillCss === "none" || fillCss === "transparent") return "none";
    return fillCss;
  }

  /**
   *  The body fill: a picture, else a gradient, else the CSS colour. Null when the fill is a gradient this painter cannot draw, so the caller keeps its CSS fallback.
   * @param {ShapePaintInput} el @param {[number, number]} box
   * @returns {{fill: string, defs: string} | null}
   */
  function bodyFill(el, box) {
    const rawFill = svgFillFromFillCss(el.fillCss);
    const picture = imageFillPaint(el.imageFill, box);
    if (picture) return picture;
    const gradient = gradientPaint(rawFill, box);
    if (gradient) return gradient;
    if (/^\s*linear-gradient\(/i.test(rawFill)) return null;
    return { fill: escAttr(rawFill), defs: "" };
  }

  /**
   * The body outline and the open leader path (a callout's pointer), both non-scaling.
   * @param {ShapePaintInput} el @param {string} fill
   */
  function shapePaths(el, fill) {
    const stroke = el.border?.color || "none";
    const sw = el.border?.width ?? 0;
    const hasStroke = Boolean(stroke) && stroke !== "none";
    const bodyStroke = sw > 0 && hasStroke ? escAttr(stroke) : "none";
    const bodySw = bodyStroke === "none" ? 0 : sw;
    const leaderStroke = hasStroke ? escAttr(stroke) : "#111";
    const leaderSw = el.border?.width === undefined ? 1.5 : sw;
    const body = el.pathD
      ? `<path d="${escAttr(el.pathD)}" fill="${fill}" stroke="${bodyStroke}" stroke-width="${bodySw}" fill-rule="evenodd" vector-effect="non-scaling-stroke"/>`
      : "";
    const extra = el.pathStroke
      ? `<path d="${escAttr(el.pathStroke)}" fill="none" stroke="${leaderStroke}" stroke-width="${leaderSw}" vector-effect="non-scaling-stroke"/>`
      : "";
    return body + extra;
  }

  /** @param {unknown} value */
  function shapePaintMarkup(value) {
    const el = paintInput(value);
    if (!el) return null;
    const box = el.viewBox ?? [100, 100];
    const paint = bodyFill(el, box);
    if (!paint) return null;
    if (!el.pathD && !el.pathStroke) return null;
    // The filter follows the drawn silhouette, the same outline the export's outer shadow follows.
    const shadow = el.shadow
      ? ` style="filter: drop-shadow(${roundUnit(el.shadow.offsetX)}px ${roundUnit(el.shadow.offsetY)}px ${roundUnit(el.shadow.blur)}px ${escAttr(el.shadow.color)})"`
      : "";
    return `<svg class="shape-paint"${shadow} viewBox="0 0 ${box[0]} ${box[1]}" width="100%" height="100%" overflow="visible" preserveAspectRatio="none">${paint.defs}${shapePaths(el, paint.fill)}</svg>`;
  }
  root.shapePaintMarkup = shapePaintMarkup;
})(typeof globalThis !== "undefined" ? globalThis : window);
