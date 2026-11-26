/**
 * Raw PPTX logo bytes. The derivative keeps metadata only; the first usable
 * candidate that fits {@link MATERIAL_MAX_LOGO_BYTES} is stored as `<id>.logo`.
 * Candidates above the cap are skipped, not a verification failure. A logo is
 * usable only when its bytes fully decode; a broken picture is skipped the
 * same way, and the chip says so instead of storing a blank image.
 */
import crypto from "node:crypto";
import { MATERIAL_MAX_LOGO_BYTES } from "@open-slidestudio/presentation-run/material-limits";
import { readCentralDirectory, readZipEntry } from "./zip-guard.mjs";
import { loadSharp } from "./optional-decoder.mjs";

export { MATERIAL_MAX_LOGO_BYTES };

const LOGO_FORMATS = new Set(["png", "jpeg", "gif", "webp"]);
const LOGO_MISMATCH = "模板 Logo 字节缺失或校验失败，请重新上传后再发送";
export const LOGO_IMAGE_CORRUPT_NOTE =
  "模板 Logo 图片已损坏，无法解码，未提取；如需使用 Logo，请换用有效图片后重新上传";

/** @param {import("node:crypto").BinaryLike} value */
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

/** @param {string} message */
function refuse(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/**
 * Same predicate as `isUsableLogo` in template-design-source.ts.
 * @param {Record<string, unknown>|null|undefined} entry
 */
export function isUsableLogo(entry) {
  if (!entry || entry.logoCandidate !== true) return false;
  if (typeof entry.part !== "string" || !entry.part.startsWith("ppt/media/") || entry.part.includes("..")) {
    return false;
  }
  if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) return false;
  if (typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
    return false;
  }
  if (typeof entry.width !== "number" || !Number.isSafeInteger(entry.width) || entry.width <= 0) {
    return false;
  }
  if (typeof entry.height !== "number" || !Number.isSafeInteger(entry.height) || entry.height <= 0) {
    return false;
  }
  return typeof entry.format === "string" && LOGO_FORMATS.has(entry.format);
}

/** @typedef {Record<string, unknown> & {logoCandidate?: unknown, bytes?: unknown, sha256?: unknown, part?: unknown}} LogoEntry */

/** @param {unknown} derivative @returns {LogoEntry[]} */
function mediaOf(derivative) {
  const record =
    derivative && typeof derivative === "object"
      ? /** @type {{["deck-template"]?: {media?: unknown}}} */ (derivative)
      : undefined;
  const media = record?.["deck-template"]?.media;
  if (!Array.isArray(media)) return [];
  return media.filter((entry) => entry && typeof entry === "object");
}

/**
 * Chinese chip note for a logo that was recognized but not extracted.
 * @param {number} bytes
 */
export function logoTooLargeNote(bytes) {
  const mb = Math.round(bytes / (1024 * 1024));
  return `模板 Logo 过大（约 ${mb} MB），未提取；如需使用 Logo，请换用较小的图片后重新上传`;
}

/**
 * Byte size of the first usable logo above the cap, when none of them fit.
 * @param {unknown} derivativeOrMedia
 * @returns {number|null}
 */
export function oversizedLogoBytes(derivativeOrMedia) {
  const media = /** @type {LogoEntry[]} */ (
    Array.isArray(derivativeOrMedia) ? derivativeOrMedia : mediaOf(derivativeOrMedia)
  );
  const usable = media.filter((entry) => isUsableLogo(entry));
  if (usable.some((entry) => typeof entry.bytes === "number" && entry.bytes <= MATERIAL_MAX_LOGO_BYTES)) {
    return null;
  }
  const oversized = usable.find((entry) => typeof entry.bytes === "number" && entry.bytes > MATERIAL_MAX_LOGO_BYTES);
  return typeof oversized?.bytes === "number" ? oversized.bytes : null;
}

/**
 * Append the oversized-logo note once. No-op when a later candidate fits.
 * @param {{summary?: {zh?: string}|null}} derivative
 */
export function ensureOversizedLogoNote(derivative) {
  const bytes = oversizedLogoBytes(derivative);
  if (!bytes) return;
  appendLogoNote(derivative, logoTooLargeNote(bytes), "模板 Logo 过大");
}

/**
 * True when every decodable logo is absent and at least one logo picture
 * failed a full decode. An oversized logo that did decode is not this case.
 * @param {unknown} derivativeOrMedia
 */
export function hasUndecodableLogo(derivativeOrMedia) {
  const media = /** @type {LogoEntry[]} */ (
    Array.isArray(derivativeOrMedia) ? derivativeOrMedia : mediaOf(derivativeOrMedia)
  );
  const flagged = media.filter((entry) => entry.logoCandidate === true);
  if (flagged.some((entry) => isUsableLogo(entry))) return false;
  return flagged.some((entry) => entry.logoUndecodable === true);
}

/**
 * Append the corrupt-logo note once. No-op when a later candidate decodes.
 * @param {{summary?: {zh?: string}|null}} derivative
 */
export function ensureCorruptLogoNote(derivative) {
  if (!hasUndecodableLogo(derivative)) return;
  appendLogoNote(derivative, LOGO_IMAGE_CORRUPT_NOTE, "模板 Logo 图片已损坏");
}

/**
 * @param {{summary?: {zh?: string}|null}} derivative
 * @param {string} note
 * @param {string} marker
 */
function appendLogoNote(derivative, note, marker) {
  const summary = derivative.summary && typeof derivative.summary === "object" ? derivative.summary : { zh: "" };
  const zh = typeof summary.zh === "string" ? summary.zh : "";
  if (!zh.includes(marker)) {
    summary.zh = zh ? `${zh} · ${note}` : note;
    derivative.summary = summary;
  }
}

/**
 * The first usable logo within the raw cap, or null when none fits.
 * A flagged candidate that cannot be verified, and no usable alternative,
 * is refused rather than dropped.
 * @param {unknown} derivative
 * @returns {Record<string, unknown>|null}
 */
export function fittingLogo(derivative) {
  const media = mediaOf(derivative);
  const flagged = media.filter((entry) => entry.logoCandidate === true);
  if (!flagged.length) return null;
  const usable = flagged.filter((entry) => isUsableLogo(entry));
  const fitting = usable.find((entry) => typeof entry.bytes === "number" && entry.bytes <= MATERIAL_MAX_LOGO_BYTES);
  if (fitting) return fitting;
  if (usable.length) return null;
  // A picture that failed to decode is not a verification failure. The chip
  // note explains it, and no `<id>.logo` is stored.
  if (flagged.some((entry) => entry.logoUndecodable === true)) return null;
  throw refuse(LOGO_MISMATCH);
}

/**
 * Raw bytes of the fitting logo, taken from the original package and checked
 * against the derivative metadata. Never stored inside the JSON.
 * @param {Uint8Array|Buffer} original
 * @param {unknown} derivative
 * @returns {Buffer|null}
 */
export function logoBytesOf(original, derivative) {
  const candidate = fittingLogo(derivative);
  if (!candidate) return null;
  const part = /** @type {string} */ (candidate.part);
  const expectedBytes = /** @type {number} */ (candidate.bytes);
  const expectedSha = /** @type {string} */ (candidate.sha256);
  /** @type {import("./zip-guard.mjs").ZipEntry|undefined} */
  let entry;
  try {
    entry = readCentralDirectory(original).find((item) => item.name === part);
  } catch {
    throw refuse(LOGO_MISMATCH);
  }
  if (!entry) throw refuse(LOGO_MISMATCH);
  /** @type {Uint8Array} */
  let raw;
  try {
    raw = readZipEntry(original, entry);
  } catch {
    throw refuse(LOGO_MISMATCH);
  }
  const bytes = Buffer.from(raw);
  if (bytes.length !== expectedBytes || digest(bytes) !== expectedSha) {
    throw refuse(LOGO_MISMATCH);
  }
  return bytes;
}

/**
 * Full pixel decode with sharp's default `failOn`. A metadata read is not
 * enough: a PNG can report width and height while its chunk CRC is wrong.
 * @param {Uint8Array|Buffer} bytes
 * @returns {Promise<boolean>}
 */
export async function imageFullyDecodes(bytes) {
  const sharp = await loadSharp();
  if (!sharp) return false;
  try {
    const decoded = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    const width = decoded.info.width;
    const height = decoded.info.height;
    return (
      typeof width === "number" && width > 0 && typeof height === "number" && height > 0 && decoded.data.length > 0
    );
  } catch {
    return false;
  }
}
