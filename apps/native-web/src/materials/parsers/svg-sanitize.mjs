/**
 * Whitelist sanitizer for untrusted SVG. The input is parsed into a DOM and a
 * fresh document is written from it: only known SVG elements survive, every
 * link must point inside the file (`#id`) or be an embedded PNG/JPEG/GIF/WebP
 * data URI, and CSS keeps only local `url(#id)` references. Scripts, event
 * handlers, `foreignObject`, entities, processing instructions and comments
 * never reach the output, so what is rasterized next cannot fetch or execute
 * anything. The original markup is discarded after this step.
 */
import { DOMParser } from "@xmldom/xmldom";
import { MaterialRejection } from "../zip-guard.mjs";
import { doctypeEnd } from "../detect-formats.mjs";

export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

export const SVG_LIMITS = Object.freeze({
  /** Longest SVG text the parser reads (checked on bytes before decoding). */
  maxBytes: 5 * 1024 * 1024,
  maxElements: 20_000,
  maxDepth: 64,
});

/** Removal categories, in the order the warning lists them. */
export const SVG_REMOVAL_ORDER = ["script", "foreign-object", "external-reference", "doctype"];

const NOT_SVG_MESSAGE = "文件不是有效的 SVG 图片；请重新导出为 SVG 或 PNG 后再上传";
const CORRUPT_MESSAGE = "SVG 文件已损坏或内容不完整，无法解析；请重新导出后上传";
const COMPLEX_MESSAGE = "SVG 结构过于复杂（元素或嵌套层数过多），无法处理；请简化后再上传";
const ENTITY_MESSAGE =
  "SVG 含有 DOCTYPE 实体声明，出于安全考虑不予接收；请用矢量软件重新导出为不含 DTD 的 SVG，或转成 PNG 后上传";

/** Static drawing elements. Animation, scripting, `a`, metadata and editor extras are left out. */
const ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "switch",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath", "title", "desc",
  "image", "marker", "style",
  "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask",
  "filter", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite",
  "feDiffuseLighting", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB",
  "feFuncG", "feFuncR", "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feOffset",
  "fePointLight", "feSpecularLighting", "feSpotLight", "feTile",
]); // prettier-ignore
const LINK_ELEMENTS = new Set(["image", "feImage"]);
const RASTER_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]*$/i;
const ATTRIBUTE_NAME = /^[A-Za-z_][\w.-]*$/;
// Browsers ignore control characters and spaces inside a URL, so they are dropped before it is judged.
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000- \u007f-\u009f]+/g;

/** Counts `<` characters cheaply, so a node bomb is refused before a DOM is built.
 * @param {string} text */
function angleBrackets(text) {
  let count = 0;
  for (let at = text.indexOf("<"); at >= 0; at = text.indexOf("<", at + 1)) count += 1;
  return count;
}

/**
 * Resolve CSS escapes so `u\72l(` cannot hide a `url(` from the filters below.
 * @param {string} css
 */
function unescapeCss(css) {
  return css
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/\\(.)/gs, "$1");
}

/**
 * @param {string} css
 * @param {Set<string>} flags
 */
function cleanCss(css, flags) {
  let out = unescapeCss(css).replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@import\b/i.test(out)) {
    flags.add("external-reference");
    out = out.replace(/@import\b[^;{}]*;?/gi, "");
  }
  out = out.replace(/@font-face\s*\{[^}]*\}/gi, () => {
    flags.add("external-reference");
    return "";
  });
  // Up to the first `)`: whatever is left of a quoted value after it is plain text, and the
  // scan goes on from there, so another url( inside it is judged on its own.
  return out.replace(/url\(([^)]*)\)/gi, (_, argument) => {
    const target = String(argument)
      .trim()
      .replace(/^["']+|["']+$/g, "")
      .trim();
    if (target.startsWith("#")) return `url(${target})`;
    flags.add("external-reference");
    return "none";
  });
}

/**
 * A link survives only as `#id`, or as an embedded raster on image elements.
 * @param {string} element @param {string} value @param {Set<string>} flags
 * @returns {string | null}
 */
function cleanLink(element, value, flags) {
  const compact = value.replace(CONTROL_OR_SPACE, "");
  if (compact.startsWith("#")) return compact;
  if (LINK_ELEMENTS.has(element) && RASTER_DATA_URI.test(compact)) return compact;
  flags.add(/^javascript:/i.test(compact) ? "script" : "external-reference");
  return null;
}

/** @param {string} text */
const escapeText = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** @param {string} text */
const escapeAttribute = (text) => escapeText(text).replace(/"/g, "&quot;");

/**
 * Parse strictly: xmldom repairs mismatched tags and unquoted attributes and only
 * reports them through the handler, so any message at all rejects the file.
 * @param {string} source
 * @returns {DomElement}
 */
function parseDocument(source) {
  /** @type {string[]} */
  const problems = [];
  const note = (/** @type {unknown} */ message) => {
    problems.push(String(message));
  };
  const Parser =
    /** @type {new (options: object) => {parseFromString(text: string, type: string): {documentElement: unknown} | undefined}} */ (
      /** @type {unknown} */ (DOMParser)
    );
  let root;
  try {
    root = new Parser({
      errorHandler: { warning: note, error: note, fatalError: note },
    }).parseFromString(source, "text/xml")?.documentElement;
  } catch {
    throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);
  }
  if (!root || problems.length) throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);
  return /** @type {DomElement} */ (root);
}

/**
 * The shared DOM view plus the namespace-aware members this sanitizer reads.
 * @typedef {Omit<import("./ooxml.mjs").DomNode, "attributes" | "firstChild" | "nextSibling"> & {
 *   localName: string, namespaceURI: string | null,
 *   firstChild: DomElement | null, nextSibling: DomElement | null,
 *   attributes: {length: number, [index: number]: {name: string, localName: string,
 *     namespaceURI: string | null, value: string}},
 *   getAttribute(name: string): string | null,
 * }} DomElement
 * @typedef {{flags: Set<string>, rootNamespace: string | null, elements: number}} WalkState
 */

/**
 * One attribute as written into the clean SVG, or null when it is dropped: namespace
 * declarations, foreign namespaces, event handlers and unsafe links never survive.
 * @param {string} name element local name
 * @param {DomElement["attributes"][number]} attribute
 * @param {WalkState} state
 * @returns {{text: string, link: boolean}|null}
 */
function keptAttribute(name, attribute, state) {
  const local = attribute.localName;
  const space = attribute.namespaceURI ?? null;
  const value = attribute.value;
  if (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:")) return null;
  if (space !== null && space !== XLINK_NAMESPACE && space !== XML_NAMESPACE) return null;
  if (space === XML_NAMESPACE && local !== "space" && local !== "lang") return null;
  if (!ATTRIBUTE_NAME.test(local)) return null;
  if (/^on/i.test(local)) {
    state.flags.add("script");
    return null;
  }
  let cleaned = value;
  let link = false;
  if (local === "href" && space !== XML_NAMESPACE) {
    const cleanedLink = cleanLink(name, value, state.flags);
    if (cleanedLink === null) return null;
    cleaned = cleanedLink;
    link = true;
  } else if (local === "style" || /url\s*\(|@import/i.test(value)) {
    cleaned = cleanCss(value, state.flags);
  }
  const written = space === XML_NAMESPACE ? `xml:${local}` : local;
  return { text: ` ${written}="${escapeAttribute(cleaned)}"`, link };
}

/**
 * @param {DomElement} element
 * @param {WalkState} state
 * @returns {{name: string, attributes: string} | null} null when the element must be dropped
 */
function openElement(element, state) {
  const name = element.localName;
  if (name === "script") {
    state.flags.add("script");
    return null;
  }
  if (name === "foreignObject") {
    state.flags.add("foreign-object");
    return null;
  }
  const namespace = element.namespaceURI ?? null;
  if (!ELEMENTS.has(name) || namespace !== state.rootNamespace) return null;
  let attributes = "";
  let hasLink = false;
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes[index];
    const kept = attribute ? keptAttribute(name, attribute, state) : null;
    if (!kept) continue;
    attributes += kept.text;
    if (kept.link) hasLink = true;
  }
  // A picture whose source was removed would only draw nothing.
  if (LINK_ELEMENTS.has(name) && !hasLink) return null;
  return { name, attributes };
}

/**
 * @param {DomElement} node
 * @param {WalkState} state
 * @param {number} depth
 * @returns {string}
 */
function writeChildren(node, state, depth) {
  let out = "";
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3 || child.nodeType === 4) {
      out += escapeText(child.nodeValue ?? "");
    } else if (child.nodeType === 1) {
      out += writeElement(child, state, depth + 1);
    }
  }
  return out;
}

/**
 * @param {DomElement} element
 * @param {WalkState} state
 * @param {number} depth
 * @returns {string}
 */
function writeElement(element, state, depth) {
  state.elements += 1;
  if (depth > SVG_LIMITS.maxDepth || state.elements > SVG_LIMITS.maxElements) {
    throw new MaterialRejection("too-large", COMPLEX_MESSAGE);
  }
  // A link element keeps its content; the link itself is not carried over.
  if (element.localName === "a" && (element.namespaceURI ?? null) === state.rootNamespace) {
    const text = writeChildren(element, state, depth);
    const hrefs = ["href", "xlink:href"].map((name) => element.getAttribute(name));
    if (hrefs.some((value) => value !== null && !value.trim().startsWith("#"))) {
      state.flags.add(
        hrefs.some((value) => /^javascript:/i.test((value ?? "").replace(CONTROL_OR_SPACE, "")))
          ? "script"
          : "external-reference",
      );
    }
    return text;
  }
  const opened = openElement(element, state);
  if (!opened) return "";
  if (opened.name === "style") {
    const css = cleanCss(element.textContent ?? "", state.flags);
    return `<style${opened.attributes}>${escapeText(css)}</style>`;
  }
  const inner = writeChildren(element, state, depth);
  return inner
    ? `<${opened.name}${opened.attributes}>${inner}</${opened.name}>`
    : `<${opened.name}${opened.attributes}/>`;
}

/**
 * Cut a DOCTYPE out of the prolog. A declaration with an internal subset can
 * define entities, so the file is refused instead.
 * @param {string} text
 * @param {Set<string>} flags
 */
function withoutDoctype(text, flags) {
  if (/<!ENTITY/i.test(text)) throw new MaterialRejection("unsupported-type", ENTITY_MESSAGE);
  const start = text.search(/<!DOCTYPE/i);
  if (start < 0) return text;
  const end = doctypeEnd(text, start + 9);
  if (end < 0) throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);
  if (text.slice(start, end).includes("[")) {
    throw new MaterialRejection("unsupported-type", ENTITY_MESSAGE);
  }
  flags.add("doctype");
  return `${text.slice(0, start)}${text.slice(end)}`;
}

/**
 * @param {string} text decoded SVG source
 * @returns {{markup: string, removed: string[]}} a clean document and which active parts were removed
 */
export function sanitizeSvg(text) {
  const flags = new Set();
  if (angleBrackets(text) > SVG_LIMITS.maxElements * 3) {
    throw new MaterialRejection("too-large", COMPLEX_MESSAGE);
  }
  const source = withoutDoctype(text, flags);
  const root = parseDocument(source);
  if (root.localName !== "svg") throw new MaterialRejection("unsupported-type", NOT_SVG_MESSAGE);
  const rootNamespace = root.namespaceURI ?? null;
  if (rootNamespace !== null && rootNamespace !== SVG_NAMESPACE) {
    throw new MaterialRejection("unsupported-type", NOT_SVG_MESSAGE);
  }
  const state = { flags, rootNamespace, elements: 0 };
  const body = writeElement(root, state, 1);
  if (!body) throw new MaterialRejection("unsupported-type", NOT_SVG_MESSAGE);
  const markup = body.replace(/^<svg/, `<svg xmlns="${SVG_NAMESPACE}"`);
  return { markup, removed: SVG_REMOVAL_ORDER.filter((flag) => flags.has(flag)) };
}
