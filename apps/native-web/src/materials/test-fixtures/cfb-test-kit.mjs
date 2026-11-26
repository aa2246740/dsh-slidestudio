import assert from "node:assert/strict";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { buildCfb } from "./cfb-writer.mjs";
import { LEGACY_FIXTURES } from "./legacy-office-fixtures.mjs";

export const BUDGET_MS = 100;
/** @typedef {import("./cfb-writer.mjs").CfbItem} CfbItem */
/** @typedef {import("./cfb-writer.mjs").CfbLayout} CfbLayout */
/** @typedef {import("../cfb.mjs").LegacyClassification} LegacyClassification */
/** @typedef {Omit<LegacyClassification, "reason">} LegacyShape */

export const sha256 = (/** @type {crypto.BinaryLike} */ bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * Runs one classification and fails when it takes the budget or more.
 * @template T
 * @param {string} label
 * @param {() => T} run
 * @returns {T}
 */
export function timed(label, run) {
  const started = performance.now();
  const value = run();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < BUDGET_MS, `${label} took ${elapsed.toFixed(1)} ms, budget ${BUDGET_MS} ms`);
  return value;
}

export const extensionOf = (/** @type {string} */ name) => name.slice(name.lastIndexOf("."));
export const fixture = (/** @type {string} */ name) => LEGACY_FIXTURES[name];
/** @param {LegacyShape} classification @returns {LegacyShape} */
export const shape = ({ ok, family, vendor, encrypted, macro, wpsSecure }) => ({
  ok,
  family,
  vendor,
  encrypted,
  macro,
  wpsSecure,
});
/** @type {LegacyShape} */
export const REJECTED = {
  ok: false,
  family: null,
  vendor: "ms",
  encrypted: false,
  macro: false,
  wpsSecure: false,
};
/** @param {CfbItem[]} items @param {3|4} [majorVersion] */
export const build = (items, majorVersion = 3) => buildCfb({ items, majorVersion });

/**
 * Rewrites one FAT entry of a built file.
 * @param {Buffer} bytes
 * @param {CfbLayout} layout
 * @param {number} id
 * @param {number} value
 */
export function setFat(bytes, layout, id, value) {
  const perSector = layout.sectorSize / 4;
  const fatSector = layout.fatSectors[Math.floor(id / perSector)];
  bytes.writeUInt32LE(value, (fatSector + 1) * layout.sectorSize + (id % perSector) * 4);
}

/**
 * The writer lays a big stream out in consecutive sectors.
 * @param {CfbLayout} layout
 * @param {string} path
 */
export function streamSectors(layout, path) {
  const { start, size } = layout.streams[path];
  return Array.from({ length: Math.ceil(size / layout.sectorSize) }, (_, i) => start + i);
}

/**
 * Byte offset of a directory entry.
 * @param {CfbLayout} layout
 * @param {string} path
 */
export function entryOffset(layout, path) {
  const id = layout.entryIds[path];
  const sector = layout.directorySectors[Math.floor((id * 128) / layout.sectorSize)];
  return (sector + 1) * layout.sectorSize + ((id * 128) % layout.sectorSize);
}

export const filler = (/** @type {number} */ count) =>
  Array.from({ length: count }, (_, i) => ({
    path: `F${String(i).padStart(4, "0")}`,
    data: new Uint8Array(0),
  }));
