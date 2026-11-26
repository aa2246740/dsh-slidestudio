/**
 * The 「配色与字体」 line of the 「资料使用情况」 card: which adopted design source
 * supplied which aspect, read from `design` of `delivery-provenance.v1.json`.
 */
import { array, aspectLabels, canonicalMaterialId, record, text } from "./delivery-note-shared.mjs";

/**
 * Aspects per canonical material id. Older files store one plain aspect list
 * for every source (`legacy`), newer ones a row (or map entry) per source.
 * @param {Record<string, unknown>} design
 */
function designAspects(design) {
  const raw = design.designAspects;
  const legacy = Array.isArray(raw) && raw.every((value) => typeof value === "string") ? raw.map(text) : undefined;
  const rows = Array.isArray(raw)
    ? raw.map(record)
    : Object.entries(record(raw)).map(([source, aspects]) => ({ source, aspects }));
  /** @type {Map<string, string[]>} */
  const byId = new Map(
    rows.flatMap((row) =>
      typeof row.source === "string" ? [[canonicalMaterialId(row.source), array(row.aspects).map(text)]] : [],
    ),
  );
  /** @param {string} id */
  return (id) => legacy ?? byId.get(id) ?? [];
}

/**
 * @param {Record<string, unknown>} design
 * @param {Map<string, Record<string, unknown>>} materialsById
 */
function adoptedParts(design, materialsById) {
  const aspectsOf = designAspects(design);
  /** @type {string[]} */
  const parts = [];
  const seen = new Set();
  let builtInCount = 0;
  let selfDirected = false;
  for (const rawId of array(design.adoptedSourceIds).map(text).filter(Boolean)) {
    const id = canonicalMaterialId(rawId);
    if (seen.has(id)) continue;
    seen.add(id);
    const name = text(materialsById.get(id)?.name);
    if (name) {
      const labels = aspectLabels(new Set(aspectsOf(id)));
      if (labels.length) parts.push(`${labels.join("/")} 来自『${name}』`);
    } else if (id === "agent-self-directed-plan") {
      selfDirected = true;
    } else if (!rawId.includes("material:")) {
      // An unresolvable material reference is never counted as an upload or a built-in source.
      builtInCount += 1;
    }
  }
  if (builtInCount) parts.push(`参考了 ${builtInCount} 个内置设计参考`);
  if (selfDirected) parts.push("设计由智能助手自主确定");
  return parts;
}

/**
 * @param {Record<string, unknown>} design
 * @param {Map<string, Record<string, unknown>>} materialsById
 * @returns {string}
 */
export function provenanceDesignLine(design, materialsById) {
  const parts = adoptedParts(design, materialsById);
  const pack = text(design.designSystemId);
  if (parts.length) {
    const adopted = parts.join("；");
    return pack ? `配色与字体：以风格包「${pack}」为准；${adopted}。` : `配色与字体：${adopted}。`;
  }
  if (pack) return `配色与字体：以风格包「${pack}」为准。`;
  const hints = array(design.styleHintsUsed).map(text).filter(Boolean);
  return `配色与字体：未采用 PPT 设计源；配色由智能助手选择${
    hints.length ? `，参考了风格线索 ${hints.join("、")}` : ""
  }。`;
}
