/**
 * Ledger-only summary lines for projects sealed before
 * `delivery-provenance.v1.json` existed: the design receipts and the material
 * chunks the run ledger recorded as returned to the Agent.
 */
import path from "node:path";
import {
  array,
  aspectLabels,
  canonicalMaterialId,
  readJson,
  record,
  recordsById,
  text,
} from "./delivery-note-shared.mjs";

/** @param {unknown} value */
function isSafeIndex(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** @param {string} agentDir @param {Record<string, unknown>} manifest */
export function designLine(agentDir, manifest) {
  const receipts = array(readJson(path.join(agentDir, "presentation-receipts.v1.json")).receipts);
  const runtime = readJson(path.join(agentDir, "runtime.json"));
  const materials = recordsById(manifest.materials);
  const hasSelection = Object.hasOwn(runtime, "adoptedSourceIds");
  const adoptedIds = new Set(array(runtime.adoptedSourceIds).map(text).map(canonicalMaterialId).filter(Boolean));
  const adopted = receipts
    .map(record)
    .filter((receipt) => receipt.state === "adopted" || receipt.state === "executed")
    .filter((receipt) => {
      const id = canonicalMaterialId(text(receipt.sourceId));
      return id && materials.has(id) && (!hasSelection || adoptedIds.has(id));
    });
  if (!adopted.length) {
    return "设计：没有采用上传资料作为设计源，配色和版式由智能助手自行选择。";
  }
  const names = adopted
    .map((receipt) => text(materials.get(canonicalMaterialId(text(receipt.sourceId)))?.name))
    .filter(Boolean);
  const aspects = new Set(adopted.flatMap((receipt) => array(receipt.aspects).map(text).filter(Boolean)));
  const labels = aspectLabels(aspects);
  const source = names.length ? names.map((name) => `「${name}」`).join("、") : `${adopted.length} 项上传资料`;
  return `设计：已采用${source}的${labels.length ? labels.join("、") : "设计资料"}。`;
}

/** @param {unknown[]} facts @returns {Map<string, Set<string>>} returned chunk keys by material id */
function returnedChunks(facts) {
  /** @type {Map<string, Set<string>>} */
  const chunksByMaterial = new Map();
  for (const value of facts) {
    const fact = record(value);
    if (fact.type !== "material.chunk-returned") continue;
    const materialId = text(fact.materialId);
    if (!materialId || !isSafeIndex(fact.chunkIndex)) continue;
    const chunks = chunksByMaterial.get(materialId) ?? new Set();
    chunks.add(`${text(fact.part) || "text"}:${fact.chunkIndex}`);
    chunksByMaterial.set(materialId, chunks);
  }
  return chunksByMaterial;
}

/**
 * Sum of explicit text/document chunk totals, from the manifest parts and the
 * read facts. PDF page counts and DOCX block counts are never chunk totals.
 * @param {Record<string, unknown>[]} parts
 */
function knownChunkTotal(parts) {
  /** @type {Map<string, number>} */
  const totals = new Map();
  for (const part of parts) {
    const rawCount = part.chunkCount ?? part.chunks;
    const count = isSafeIndex(rawCount) ? Number(rawCount) : 0;
    if (["text", "document"].includes(text(part.part)) && count > 0) totals.set(text(part.part), count);
  }
  return [...totals.values()].reduce((sum, count) => sum + count, 0);
}

/** @param {unknown[]} facts @param {Record<string, unknown>} manifest */
export function materialReadLines(facts, manifest) {
  const materials = recordsById(manifest.materials);
  const chunksByMaterial = returnedChunks(facts);
  if (!chunksByMaterial.size) return ["参考资料：本次没有记录资料分段读取。"];

  return [...chunksByMaterial].flatMap(([id, chunks]) => {
    const material = materials.get(id);
    const name = text(material?.name) || "未命名资料";
    const reads = facts.map(record).filter((fact) => fact.type === "material.chunk-returned" && fact.materialId === id);
    if (material?.kind === "table") return tableReadLines(name, reads);
    const knownTotal = knownChunkTotal([...array(material?.parts).map(record), ...reads]);
    const read = [...chunks].filter((key) => key.startsWith("text:") || key.startsWith("document:")).length;
    return knownTotal
      ? `参考资料：「${name}」已读取 ${read}/${knownTotal} 段文字。`
      : `参考资料：「${name}」已读取 ${read} 段文字。`;
  });
}

/** @param {Record<string, unknown>} fact @returns {{start: number, end: number, total: number} | undefined} */
function rowWindow(fact) {
  const { rowStart: start, rowEnd: end, rowTotal: total } = fact;
  if (!isSafeIndex(start) || !isSafeIndex(end) || !isSafeIndex(total)) return undefined;
  const window = { start: Number(start), end: Number(end), total: Number(total) };
  if (window.start < 1 || window.end < window.start || window.total < window.end) return undefined;
  return window;
}

/** @param {{start: number, end: number}[]} windows rows covered by possibly overlapping windows */
function coveredRows(windows) {
  let end = 0;
  let read = 0;
  for (const window of [...windows].sort((a, b) => a.start - b.start)) {
    read += Math.max(0, window.end - Math.max(end, window.start - 1));
    end = Math.max(end, window.end);
  }
  return read;
}

/** @param {string} name @param {Record<string, unknown>[]} reads */
function tableReadLines(name, reads) {
  /** @type {Map<string, {start: number, end: number, total: number}[]>} */
  const parts = new Map();
  for (const fact of reads) {
    const window = rowWindow(fact);
    if (!window) continue;
    const part = text(fact.part);
    const windows = parts.get(part) ?? [];
    windows.push(window);
    parts.set(part, windows);
  }
  if (!parts.size) return [`参考资料：「${name}」未记录已读取的行数。`];
  return [...parts].map(([part, windows]) => {
    const sheet = part.startsWith("sheet:") ? `工作表「${part.slice(6)}」` : "";
    const sorted = [...windows].sort((a, b) => a.start - b.start);
    return `参考资料：「${name}」${sheet}已读取 ${coveredRows(windows)}/${sorted[0]?.total} 行。`;
  });
}
