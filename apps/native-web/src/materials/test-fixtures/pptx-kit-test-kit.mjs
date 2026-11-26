import assert from "node:assert/strict";
import crypto from "node:crypto";
import { expandTemplateComponent, loadTemplateKit, parseComponentRef } from "@open-slidestudio/presentation-run";
import { runParseJob } from "../parse-worker.mjs";
import { shape, tableFrame, textBox } from "./kit-pptx.mjs";
import { loadOptionalNative } from "../../optional-native.mjs";

export const sharp = await loadOptionalNative("sharp");
export const NO_SHARP = sharp ? false : "sharp is not installed";

export const sha = (/** @type {crypto.BinaryLike | Buffer<ArrayBuffer>} */ bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * The parts of a parsed deck-template payload the kit suites read.
 * `templateKit` stays untyped: suites inspect its components, assets and receipt ad hoc.
 * @typedef {{templateKit: any, photos: {processed: {file: string, sha256: string}}[],
 *   templateDetail: {assets: {file: string, content: string}[]}, logo: {mediaId: string},
 *   logos: {sha256: string}[]}} DeckTemplate
 * @typedef {import("../derivative.mjs").Derivative & {"deck-template": DeckTemplate, summary: {zh: string}}} DeckDerivative
 */

/** A successful deck parse always carries the deck-template payload and a summary. */
export const parseDeck = (/** @type {Buffer<ArrayBuffer>} */ bytes, name = "kit-fixture.pptx") =>
  /** @type {Promise<DeckDerivative>} */ (
    runParseJob({ materialId: `cccccccc-cccc-cccc-cccc-cccccccccccc-${name}`, name, bytes })
  );
export const kitOf = (/** @type {DeckDerivative} */ derivative) => derivative["deck-template"].templateKit;
export const imagesOf = (/** @type {{ components: any[]; }} */ templateKit) =>
  templateKit.components.flatMap((/** @type {{ elements: any[]; }} */ component) =>
    component.elements.filter((/** @type {{ elementType: string; }} */ element) => element.elementType === "image"),
  );

/**
 * What write_page does with `material:<id>#<component>`: the gate's lookup, then the expansion.
 * @param {{ [x: string]: unknown; }} derivative
 * @param {string} componentId
 */
export function expandReference(derivative, componentId) {
  const loaded = loadTemplateKit(derivative);
  assert.ok(loaded, "the kit is current");
  const parsed = /** @type {NonNullable<ReturnType<typeof parseComponentRef>>} */ (
    parseComponentRef(`material:${derivative.materialId}#${componentId}`)
  );
  const component = loaded.components.find((entry) => entry.id === parsed.componentId);
  assert.ok(component, `the kit has ${componentId}`);
  return expandTemplateComponent(component, {
    usedIds: new Set(),
    mediaFor: (file) => `project/${file}`,
  });
}

export const BODY_TEXT = "这是一段合成的正文，只用来让页面不被当作稀疏页，内容长度超过一百个字符。".repeat(3);
export const textLine = (/** @type {number} */ id, /** @type {string} */ text) =>
  textBox({ id, text, x: 500000, y: 1500000, w: 6000000, h: 800000 });
export const tableBlock = tableFrame({ id: 3, x: 500000, y: 1500000, w: 6000000, h: 800000 });
export const decoration = (/** @type {string} */ color) =>
  shape({ id: 90, color, x: 400000, y: 300000, w: 800000, h: 200000 });
