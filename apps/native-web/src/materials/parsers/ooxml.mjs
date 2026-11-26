/**
 * Shared OOXML plumbing for the office parsers: a guarded zip reader (the
 * central-directory gate runs before anything is inflated) plus small
 * namespace-tolerant DOM helpers on top of @xmldom/xmldom. Lookups match by
 * local name so callers never hardcode the prefix a producer happens to use.
 *
 * The xmldom instance types omit the runtime onError hook and node shape we
 * rely on, so every DOM value is viewed through the structural `DomNode`
 * typedef below instead of the library's namespace.
 */
import { DOMParser } from "@xmldom/xmldom";
import { corruptZip, readCentralDirectory, readZipEntry } from "../zip-guard.mjs";

/**
 * Minimal structural view of one DOM node (element, attribute or text).
 * @typedef {{
 *   nodeType: number,
 *   nodeName: string,
 *   nodeValue: string|null,
 *   textContent: string|null,
 *   firstChild: DomNode|null,
 *   nextSibling: DomNode|null,
 *   parentNode: DomNode|null,
 *   attributes: DomAttributes|null,
 * }} DomNode
 */

/** @typedef {{length: number} & {[index: number]: DomNode}} DomAttributes */

/** @typedef {(level: string, message: string) => void} XmlErrorSink */

/** @typedef {{parseFromString(text: string, mimeType: string): unknown}} XmlParserInstance */

/** @typedef {new (options?: {onError?: XmlErrorSink}) => XmlParserInstance} XmlParserCtor */

/** Element node type. */
const ELEMENT = 1;
/** Text node type. */
const TEXT = 3;

/** Read-only OOXML package view: lazy per-entry inflation with a cache. */
export class PackageReader {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    this.entries = readCentralDirectory(bytes);
    /** @type {Map<string, import("../zip-guard.mjs").ZipEntry>} */
    this.byName = new Map(this.entries.map((entry) => [entry.name, entry]));
    /** @type {Map<string, Uint8Array>} */
    this.cache = new Map();
  }

  /** @param {string} name */
  has(name) {
    return this.byName.has(name);
  }

  /** @param {string} name @returns {Uint8Array|undefined} */
  read(name) {
    const entry = this.byName.get(name);
    if (!entry) return undefined;
    if (!this.cache.has(name)) this.cache.set(name, readZipEntry(this.bytes, entry));
    return /** @type {Uint8Array} */ (this.cache.get(name));
  }

  /** @param {string} name @returns {string|undefined} */
  text(name) {
    const bytes = this.read(name);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }
}

/** @param {string} part */
export function corruptPart(part) {
  const error = corruptZip();
  error.message = `文件已损坏或内容不完整（${part} 解析失败），无法解析；请重新导出后上传`;
  return error;
}

/**
 * Parse one XML part with a DOM parser; error-level problems reject the file
 * as corrupt instead of letting half-parsed structures through.
 * @param {string} text @param {string} part
 * @returns {DomNode}
 */
export function parseXml(text, part) {
  const problems = [];
  const parser = /** @type {XmlParserCtor} */ (/** @type {unknown} */ (DOMParser));
  let document;
  try {
    document = new parser({
      onError: (level, message) => {
        if (level === "error" || level === "fatal") problems.push(String(message));
      },
    }).parseFromString(text, "text/xml");
  } catch {
    throw corruptPart(part);
  }
  const root = /** @type {DomNode|null} */ (
    /** @type {unknown} */ (document && typeof document === "object" ? documentElementOf(document) : null)
  );
  if (!root || problems.length) throw corruptPart(part);
  return root;
}

/** xmldom documents expose documentElement; read it defensively.
 * @param {unknown} document
 */
function documentElementOf(document) {
  return /** @type {{documentElement?: unknown}} */ (document).documentElement;
}

/** Local name of an element or attribute (prefix stripped).
 * @param {DomNode} node
 * @returns {string}
 */
export function localNameOf(node) {
  const colon = node.nodeName.indexOf(":");
  return colon >= 0 ? node.nodeName.slice(colon + 1) : node.nodeName;
}

/**
 * All child nodes (elements and text), in document order.
 * @param {DomNode} node
 * @returns {DomNode[]}
 */
export function childNodesOf(node) {
  const out = [];
  for (let child = node.firstChild; child; child = child.nextSibling) out.push(child);
  return out;
}

/**
 * Direct element children regardless of name, in document order.
 * @param {DomNode} node
 * @returns {DomNode[]}
 */
export function childElements(node) {
  const out = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === ELEMENT) out.push(child);
  }
  return out;
}

/**
 * Direct element children with a matching local name, in document order.
 * @param {DomNode} node @param {string} local
 * @returns {DomNode[]}
 */
export function childrenOf(node, local) {
  const out = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === ELEMENT && localNameOf(child) === local) out.push(child);
  }
  return out;
}

/**
 * @param {DomNode} node @param {string} local
 * @returns {DomNode|null}
 */
export function firstOf(node, local) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === ELEMENT && localNameOf(child) === local) return child;
  }
  return null;
}

/**
 * All descendant elements with a matching local name, in document order.
 * @param {DomNode} node @param {string} local
 * @returns {DomNode[]}
 */
export function descendantsOf(node, local) {
  /** @type {DomNode[]} */
  const out = [];
  /** @param {DomNode} current */
  const walk = (current) => {
    for (let child = current.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== ELEMENT) continue;
      if (localNameOf(child) === local) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/**
 * Attribute by prefixed or local name; an exact qualified match wins over a
 * local-name match (r:id vs the plain id on the same element).
 * @param {DomNode} node @param {string} name
 * @returns {string|null}
 */
export function attrOf(node, name) {
  const attrs = node.attributes;
  if (!attrs) return null;
  for (let i = 0; i < attrs.length; i += 1) {
    const attr = attrs[i];
    if (attr && attr.nodeName === name) return attr.nodeValue;
  }
  const local = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
  for (let i = 0; i < attrs.length; i += 1) {
    const attr = attrs[i];
    if (attr && localNameOf(attr) === local) return attr.nodeValue;
  }
  return null;
}

/** Concatenated text of descendant text nodes (no element markup).
 * @param {DomNode} node
 * @returns {string}
 */
export function textOf(node) {
  let out = "";
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === TEXT) out += child.nodeValue ?? "";
    else if (child.nodeType === ELEMENT) out += textOf(child);
  }
  return out;
}

/** Relationship of one part: type is the last URI segment of the Type. @typedef {{type: string, target: string, external: boolean}} PartRelationship */

/**
 * Relationship map of one part: id → {type, target, external}.
 * @param {PackageReader} pkg @param {string} partPath
 * @returns {Map<string, PartRelationship>}
 */
export function parseRels(pkg, partPath) {
  const slash = partPath.lastIndexOf("/");
  const dir = slash >= 0 ? partPath.slice(0, slash) : "";
  const base = slash >= 0 ? partPath.slice(slash + 1) : partPath;
  const relsPath = `${dir}/_rels/${base}.rels`;
  const xml = pkg.text(relsPath);
  /** @type {Map<string, PartRelationship>} */
  const rels = new Map();
  if (xml === undefined) return rels;
  for (const element of descendantsOf(parseXml(xml, relsPath), "Relationship")) {
    const type = attrOf(element, "Type") ?? "";
    rels.set(attrOf(element, "Id") ?? "", {
      type: type.slice(type.lastIndexOf("/") + 1),
      target: attrOf(element, "Target") ?? "",
      external: attrOf(element, "TargetMode") === "External",
    });
  }
  return rels;
}

/** Resolve a relationship target against the part that carries it.
 * @param {string} basePart @param {string} target
 * @returns {string}
 */
export function resolvePartPath(basePart, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = basePart.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

/** "#RRGGBB" from a 6-digit hex value; anything else passes through as null.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function normalizeHex(value) {
  if (!value) return null;
  const raw = value.trim().replace(/^#/, "").toUpperCase();
  return /^[0-9A-F]{6}$/.test(raw) ? `#${raw}` : null;
}

/**
 * Spreadsheet cell reference → 1-based row and column ("C4" → {row: 4, col: 3}).
 * @param {string} ref
 * @returns {{row: number, col: number}|null}
 */
export function parseCellRef(ref) {
  const match = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
  if (!match) return null;
  let col = 0;
  for (const char of match[1] ?? "") col = col * 26 + (char.charCodeAt(0) - 64);
  return { row: Number(match[2]), col };
}

/**
 * Pad or trim an array to exactly `length`, filling with `fill`.
 * @template T
 * @param {T[]} array @param {number} length @param {T|null} [fill]
 * @returns {(T|null)[]}
 */
export function padded(array, length, fill = null) {
  if (array.length >= length) return array.slice(0, length);
  return [...array, ...Array.from({ length: length - array.length }, () => fill)];
}
