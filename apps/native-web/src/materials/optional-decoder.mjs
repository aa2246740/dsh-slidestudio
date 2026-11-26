/**
 * The optional `sharp` image decoder for material parsing. It is never a
 * package dependency: without it every text-bearing format still parses,
 * while pixel work (image style, SVG/AVIF rasters, logo and embedded-picture
 * decode checks) degrades to a typed `decoder-unavailable` outcome instead of
 * a misleading "corrupt" verdict or a crash.
 */
import { loadOptionalNative } from "../optional-native.mjs";
import { MaterialRejection } from "./zip-guard.mjs";

export const DECODER_UNAVAILABLE = "decoder-unavailable";

/** @type {Readonly<Record<"image"|"svg"|"avif", string>>} */
const MESSAGES = Object.freeze({
  image: "本机未安装可选的图片解码组件，暂时无法识别图片；安装后重新上传即可",
  svg: "SVG 已通过安全检查，但本机未安装可选的图片解码组件，无法转为图片；安装后重新上传即可",
  avif: "本机未安装可选的图片解码组件，无法把 AVIF 转为图片；请另存为 JPG/PNG 后上传",
});

/**
 * Minimal call shape of the sharp constructor used by the material parsers.
 * @typedef {(input?: Buffer|Uint8Array, options?: object) => any} SharpCtor
 */

/**
 * Image metadata fields the parsers read (sharp's `Metadata`, narrowed).
 * @typedef {{format?: string, width?: number, height?: number, orientation?: number,
 *   hasAlpha?: boolean, pages?: number, exif?: Buffer, channels?: number, space?: string,
 *   density?: number}} SharpMetadata
 */

/** @returns {Promise<SharpCtor|null>} */
export function loadSharp() {
  return loadOptionalNative("sharp");
}

/**
 * sharp, or the typed rejection that explains which capability is missing.
 * @param {"image"|"svg"|"avif"} purpose
 * @returns {Promise<SharpCtor>}
 */
export async function requireSharp(purpose) {
  const sharp = await loadSharp();
  if (!sharp) throw new MaterialRejection(DECODER_UNAVAILABLE, MESSAGES[purpose]);
  return sharp;
}
