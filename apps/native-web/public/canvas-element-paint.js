import { appendTextRuns, escapeHtmlText } from "./rich-text-editor.js";
import { record } from "./generation-data.js";
import { t } from "./i18n.js";
/** @typedef {import("@open-slidestudio/canvas-session").RenderElement} RenderElement */
const SLIDE_FONT_STACK = 'Arial, "微软雅黑", "Microsoft YaHei", "PingFang SC", sans-serif';

/** @param {HTMLElement | null} node @param {RenderElement | null} el @param {boolean} liveRich */
export function applyTextStyleToNode(node, el, liveRich) {
  if (!node || !el) return;
  const [ha] = el.align || ["left", "top"];
  node.style.color = el.href ? el.color || "#2563EB" : el.color || "#111";
  node.style.fontSize = `${el.fontSize || 18}px`;
  if (!liveRich) {
    node.style.fontWeight = el.bold ? "700" : "400";
    node.style.fontStyle = el.italic ? "italic" : "normal";
    node.style.textDecoration = el.underline || el.href ? "underline" : "none";
  }
  node.style.fontFamily = el.fontFamily || SLIDE_FONT_STACK;
  node.style.lineHeight = el.lineHeight != null ? String(el.lineHeight) : "1.2";
  node.style.letterSpacing = el.letterSpacing != null ? `${el.letterSpacing}px` : "";
  node.style.textAlign = ha;
  if (el.backgroundColor) node.style.backgroundColor = el.backgroundColor;
}

/** @param {string | undefined} name */
export function iconKey(name) {
  return String(name || "star").replace(/^(fas|far|fab):/, "");
}

/** @param {RenderElement} el */
export function paintIconSvg(el) {
  const fill = escapeHtmlText(el.fillCss || "#000000");
  const name = iconKey(el.iconName);
  /** @type {Record<string, string>} */
  const d = {
    star: "M12 2l2.9 6.6L22 9.3l-5 4.7 1.4 7L12 17.8 5.6 21l1.4-7-5-4.7 7.1-.7z",
    heart:
      "M12 21s-6.7-4.4-9.3-8.2C.7 10 1.2 6.6 4 5.3 6.2 4.3 8.4 5 12 8.2c3.6-3.2 5.8-3.9 8-2.9 2.8 1.3 3.3 4.7 1.3 7.5C18.7 16.6 12 21 12 21z",
    check: "M9.2 16.6L4.8 12.2l1.4-1.4 3 3 8.6-8.6 1.4 1.4z",
    xmark: "M6.4 5l5.6 5.6L17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z",
    plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
    minus: "M5 11h14v2H5z",
    house: "M12 3l9 8h-2v9h-6v-6H11v6H5v-9H3z",
    user: "M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5z",
    gear: "M10 2h4l.6 2.4 2.2.9 2.1-1.4 2.8 2.8-1.4 2.1.9 2.2L23 10v4l-2.4.6-.9 2.2 1.4 2.1-2.8 2.8-2.1-1.4-2.2.9L14 23h-4l-.6-2.4-2.2-.9-2.1 1.4L2.3 18l1.4-2.1-.9-2.2L1 14v-4l2.4-.6.9-2.2L2.9 5.1 5.7 2.3l2.1 1.4 2.2-.9zm2 7a3 3 0 110 6 3 3 0 010-6z",
    lightbulb: "M9 21h6v-1H9zm3-19a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z",
    comment: "M4 4h16v12H7l-3 3z",
    envelope: "M3 6h18v12H3zm0 0l9 7 9-7",
    camera: "M9 6l1.5-2h3L15 6h4v12H5V6zm7 6a4 4 0 11-8 0 4 4 0 018 0z",
    file: "M6 3h8l4 4v14H6z",
    "magnifying-glass": "M10 4a6 6 0 014.9 9.6L20 18.7 18.7 20l-5.1-5.1A6 6 0 1110 4zm0 2a4 4 0 100 8 4 4 0 000-8z",
    bell: "M12 3a6 6 0 016 6v5l2 2H4l2-2V9a6 6 0 016-6zm-2 16h4a2 2 0 01-4 0z",
    bookmark: "M7 3h10v18l-5-3-5 3z",
    flag: "M5 3h1v18H5zm2 0h12l-3 4 3 4H7z",
    bolt: "M13 2L4 14h7l-1 8 10-14h-7z",
    circle: "M12 3a9 9 0 110 18 9 9 0 010-18z",
  };
  const path = d[name] || d.star;
  return `<svg viewBox="0 0 24 24" width="100%" height="100%"><path fill="${fill}" d="${path}"/></svg>`;
}

/**
 *  An icon drawn with the bundled Font Awesome glyph when the catalogue knows its code point, else the built-in SVG outline.
 * @param {RenderElement} el @param {Readonly<Record<string, string>>} faUnicode icon name to hex code point
 */
export function paintFaIcon(el, faUnicode) {
  const fill = escapeHtmlText(el.fillCss || "#000000");
  const raw = String(el.iconName || "fas:star");
  const [prefix, name] = raw.includes(":") ? raw.split(":") : ["fas", raw];
  const uni = name && Object.hasOwn(faUnicode, name) ? faUnicode[name] : undefined;
  if (!uni) return paintIconSvg(el);
  const family = prefix === "fab" ? "Font Awesome 6 Brands" : "Font Awesome 6 Free";
  const weight = prefix === "fas" ? 900 : 400;
  // uni is from the bundled fa-unicode map; fill/family are escaped above.
  return `<span class="fa-icon" style="font-family:'${family}';font-weight:${weight};color:${fill};font-size:80%">&#x${escapeHtmlText(uni)};</span>`;
}

/**
 *  The shape's SVG markup from the shared painter (`shape-paint.js`, a classic script), or null when it cannot draw the shape. A picture fill's project file becomes a loadable URL first;
 *  a plain rectangle drops its shadow here because its box casts it (`paintCanvasShape`).
 * @param {RenderElement} el @param {(src: string | undefined) => string} mediaUrl
 */
export function shapeSvgMarkup(el, mediaUrl) {
  if (typeof globalThis.shapePaintMarkup !== "function") return null;
  const picture = el.imageFill;
  const outline = el.shapeName === "rect" ? { ...el, shadow: undefined } : el;
  if (!picture) return globalThis.shapePaintMarkup(outline);
  return globalThis.shapePaintMarkup({
    ...outline,
    imageFill: { href: mediaUrl(picture.src), mode: picture.mode, crop: picture.crop, tile: picture.tile },
  });
}

/**
 *  Paint a shape into its `.el` box: the SVG outline when the painter can draw it, else a CSS box with the preset's corner rounding and border.
 * @param {HTMLElement} node @param {RenderElement} el @param {{mediaUrl: (src: string | undefined) => string}} context
 */
export function paintCanvasShape(node, el, { mediaUrl }) {
  const svg = shapeSvgMarkup(el, mediaUrl);
  if (svg) {
    node.style.background = "transparent";
    node.innerHTML = svg;
  } else {
    node.style.background = el.fillCss || "transparent";
    if (el.shapeName === "ellipse") node.style.borderRadius = "50%";
    if (el.shapeName === "roundRect") node.style.borderRadius = "12px";
    if (el.border?.width) {
      node.style.border = `${el.border.width}px ${el.border.style || "solid"} ${el.border.color || "#111"}`;
    }
  }
  if (el.shadow && (!svg || el.shapeName === "rect")) node.style.boxShadow = boxShadowCss(el.shadow);
}

/**
 *  The picture's clip is the render model's single clip-path, built from the same geometry the exporter writes for a preset or a custom path. An unclipped picture clears it.
 * @param {HTMLElement} node @param {RenderElement} el
 */
function applyPictureClip(node, el) {
  node.style.clipPath = el.clipPath || "";
}

/**
 * A layer that fills its element box and takes no pointer input, so the box keeps the pointer.
 * @param {string} className
 * @returns {HTMLElement}
 */
function fillLayer(className) {
  const layer = document.createElement("div");
  layer.className = className;
  layer.style.position = "absolute";
  layer.style.left = "0";
  layer.style.top = "0";
  layer.style.width = "100%";
  layer.style.height = "100%";
  layer.style.pointerEvents = "none";
  return layer;
}

/**
 *  The layer that draws a picture inside its element box. The clip belongs to this layer, so the selection handles on the box edge and the rotate handle outside the outline stay usable.
 * @param {HTMLElement} node @returns {HTMLElement}
 */
export function pictureSurface(node) {
  const existing = /** @type {HTMLElement | null} */ (node.querySelector(":scope > .el-picture"));
  if (existing) return existing;
  const surface = fillLayer("el-picture");
  node.insertBefore(surface, node.firstChild);
  return surface;
}

/**
 *  A clipped picture casts its shadow from the layer that holds its clip; a box shadow would follow the rectangle. Only a picture with media gets that layer.
 * @param {RenderElement} el
 */
export function shadowFollowsClip(el) {
  return Boolean(el.type === "image" && el.src && el.shadow && el.clipPath);
}

/**
 *  The layer that casts a clipped picture's shadow. It wraps the picture layer, so the drop shadow follows the clip instead of being cut off by it. The frame stops clipping so the
 *  shadow can leave the box; selection handles are siblings and take no shadow.
 * @param {HTMLElement} node @param {RenderElement} el @returns {HTMLElement}
 */
export function clipShadowLayer(node, el) {
  const existing = /** @type {HTMLElement | null} */ (node.querySelector(":scope > .el-shadow"));
  if (existing) return existing;
  const layer = fillLayer("el-shadow");
  layer.style.filter = dropShadowCss(el.shadow);
  node.insertBefore(layer, node.firstChild);
  node.style.overflow = "visible";
  return layer;
}

/** @param {RenderElement["shadow"]} shadow the render model's shadow, with every default filled in */
function dropShadowCss(shadow) {
  return shadow ? `drop-shadow(${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${shadow.color})` : "none";
}

/** @param {RenderElement["shadow"]} shadow the render model's shadow, with every default filled in */
export function boxShadowCss(shadow) {
  return shadow ? `${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${shadow.color}` : "";
}

/** @param {HTMLElement} node @param {RenderElement} el */
export function applyImageCropDisplay(node, el) {
  const crop = el.crop || {};
  const l = crop.left || 0;
  const t = crop.top || 0;
  const r = crop.right || 0;
  const b = crop.bottom || 0;
  node.style.backgroundSize = el.fit === "contain" ? "contain" : el.fit === "fill" ? "100% 100%" : "cover";
  node.style.backgroundPosition = "center";
  if (l || t || r || b) {
    const zw = 1 / Math.max(0.08, 1 - l - r);
    const zh = 1 / Math.max(0.08, 1 - t - b);
    node.style.backgroundSize = `${zw * 100}% ${zh * 100}%`;
    node.style.backgroundPosition = `${(l / Math.max(0.01, l + r)) * 100}% ${(t / Math.max(0.01, t + b)) * 100}%`;
  }
  applyPictureClip(node, el);
}

/** @param {HTMLElement | null} node @param {NonNullable<RenderElement["crop"]>} c */
export function paintCropChromeStyles(node, c) {
  if (!node) return;
  const l = c.left || 0;
  const t = c.top || 0;
  const r = c.right || 0;
  const b = c.bottom || 0;
  const frame = /** @type {HTMLElement | null} */ (node.querySelector(".crop-frame"));
  if (frame) {
    frame.style.left = `${l * 100}%`;
    frame.style.top = `${t * 100}%`;
    frame.style.right = `${r * 100}%`;
    frame.style.bottom = `${b * 100}%`;
  }
  const tDim = /** @type {HTMLElement | null} */ (node.querySelector(".crop-dim-t"));
  if (tDim) tDim.style.height = `${t * 100}%`;
  const bDim = /** @type {HTMLElement | null} */ (node.querySelector(".crop-dim-b"));
  if (bDim) bDim.style.height = `${b * 100}%`;
  const lDim = /** @type {HTMLElement | null} */ (node.querySelector(".crop-dim-l"));
  if (lDim) {
    lDim.style.width = `${l * 100}%`;
    lDim.style.top = `${t * 100}%`;
    lDim.style.bottom = `${b * 100}%`;
  }
  const rDim = /** @type {HTMLElement | null} */ (node.querySelector(".crop-dim-r"));
  if (rDim) {
    rDim.style.width = `${r * 100}%`;
    rDim.style.top = `${t * 100}%`;
    rDim.style.bottom = `${b * 100}%`;
  }
}

/** @param {HTMLElement} node @param {RenderElement} el @param {boolean} liveRich */
export function paintCanvasText(node, el, liveRich) {
  const [ha, va] = el.align || ["left", "top"];
  applyTextStyleToNode(node, el, liveRich);
  if (el.href) {
    node.dataset.href = el.href;
    node.title = el.href;
    node.classList.add("is-link");
  }
  if (el.wrap === false) node.style.whiteSpace = "nowrap";
  if (va === "middle" || va === "bottom") {
    node.style.display = "flex";
    node.style.flexDirection = "column";
    node.style.justifyContent = va === "bottom" ? "flex-end" : "center";
    node.style.alignItems = ha === "center" ? "center" : ha === "right" ? "flex-end" : "flex-start";
  }
  const runs = Array.isArray(el.runs) && el.runs.length ? el.runs : null;
  if (el.list) {
    const list = document.createElement(el.list === "number" ? "ol" : "ul");
    list.className = `text-list text-list-${el.list}`;
    const lines = String(el.text || "").split(/\n/);
    for (const line of lines) {
      const li = document.createElement("li");
      li.textContent = line;
      list.append(li);
    }
    node.append(list);
  } else if (runs) {
    appendTextRuns(node, runs);
  } else node.textContent = String(el.text || "");
}

/** @param {string | undefined} effect */
function animClass(effect) {
  const e = String(effect || "fade-in");
  if (e.includes("fly")) return "anim-play-fly";
  if (e.includes("zoom")) return "anim-play-zoom";
  if (e.includes("wipe")) return "anim-play-wipe";
  if (e.includes("float")) return "anim-play-float";
  return "anim-play-fade";
}

/**
 *  Rotate leads because a CSS transform list applies its last function first: flip in the box, then turn, as DrawingML does.
 * @param {RenderElement} el @param {number} [angle] a rotate drag's live angle
 */
export function elementTransform(el, angle = el.rotation) {
  const parts = angle ? [`rotate(${angle}deg)`] : [];
  if (el.flipH) parts.push("scaleX(-1)");
  if (el.flipV) parts.push("scaleY(-1)");
  return parts.join(" ");
}

/** @param {RenderElement} el @param {{ids: Set<string>, groups: import("@open-slidestudio/pptd-v2").Animation[][], step: number | null, opts: {playLast?: boolean}}} context */
export function createCanvasElement(el, { ids, groups, step, opts }) {
  const [x, y, w, h] = el.bounds;
  const node = document.createElement("div");
  node.className = `el ${el.type}${ids.has(el.id) ? " selected" : ""}`;
  node.dataset.id = el.id;
  const layoutRole = record(el).layoutRole;
  if (typeof layoutRole === "string" && layoutRole) node.dataset.layoutRole = layoutRole;
  // A master or layout copy is drawn on the page but is never picked there (see paintSlide).
  if (el.inherited) node.dataset.inherited = el.inherited.scope;
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  node.style.width = `${w}px`;
  node.style.height = `${h}px`;
  node.style.padding = "0";
  node.style.boxSizing = "border-box";
  node.style.opacity = String(el.opacity ?? 1);
  node.style.transform = elementTransform(el);
  if (el.hidden) node.classList.add("is-hidden");
  if (el.locked) node.classList.add("is-locked");
  // A shape casts its shadow when painted, and a clipped picture from its clip layer.
  if (el.shadow && el.type !== "shape" && !shadowFollowsClip(el)) node.style.boxShadow = boxShadowCss(el.shadow);
  if (step != null) {
    const gi = groups.findIndex((g) => g.some((a) => a.elementId === el.id));
    if (gi >= 0 && gi >= step) {
      node.classList.add("anim-hidden");
    } else if (gi >= 0 && gi === step - 1 && opts.playLast) {
      const hit = groups[gi]?.find((a) => a.elementId === el.id);
      node.classList.add(animClass(hit?.effect));
    }
  }

  return node;
}

/**
 *  The hint a click on a master or layout copy shows: where the copy came from. Double-click entry into that master or layout is wired by the layout editor.
 * @param {{scope: "master" | "layout", name: string}} inherited
 */
export function inheritedHint(inherited) {
  return inherited.scope === "master"
    ? t("来自母版『{name}』· 双击编辑", { name: inherited.name })
    : t("来自版式『{name}』· 双击编辑", { name: inherited.name });
}

/**
 *  A copy takes no selection, drag or text-edit handlers. Its click shows the hint, then reaches the page, where a copy counts as empty space (see isBlankPageTarget).
 * @param {HTMLElement} node @param {{scope: "master" | "layout", name: string}} inherited
 * @param {(message: string) => void} show
 */
export function attachInheritedHint(node, inherited, show) {
  node.addEventListener("click", () => show(inheritedHint(inherited)));
}
