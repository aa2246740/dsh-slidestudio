/**
 * Whether a stored record may answer a re-upload of the same bytes: the
 * derivative must satisfy the current intake contract (reuse-policy), every
 * listed child must still exist, and a deck's logo must match what intake
 * would store today.
 */
import crypto from "node:crypto";
import { listedChildrenIntact } from "./embedded-images.mjs";
import { fittingLogo, hasUndecodableLogo, imageFullyDecodes, oversizedLogoBytes } from "./logo-bytes.mjs";
import { reusableDerivative } from "./reuse-policy.mjs";

/** @typedef {import("../attachments.mjs").StoredRecord} StoredRecord */
/** @typedef {import("../attachments.mjs").AttachmentStore} AttachmentStore */

/** @param {import("node:crypto").BinaryLike} value */
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

/**
 * @param {AttachmentStore} store @param {StoredRecord|undefined} record
 * @returns {Promise<boolean>}
 */
export async function recordReusable(store, record) {
  if (!record || !reusableDerivative(record) || !listedChildrenIntact(store, record)) return false;
  return logoMatches(store, record);
}

/** @param {StoredRecord} record @param {string} note */
function summaryExplains(record, note) {
  const zh = record.derivative.summary?.zh;
  return typeof zh === "string" && zh.includes(note);
}

/**
 * A stored deck is reusable only when `<id>.logo` is the first fitting
 * candidate and those bytes fully decode, or no candidate fits and the
 * summary already explains that the logo was too large or could not be
 * decoded.
 * @param {AttachmentStore} store @param {StoredRecord} record
 * @returns {Promise<boolean>}
 */
async function logoMatches(store, record) {
  let candidate;
  try {
    candidate = fittingLogo(record.derivative);
  } catch {
    return false;
  }
  if (!candidate) {
    const corruptExplained = !hasUndecodableLogo(record.derivative) || summaryExplains(record, "模板 Logo 图片已损坏");
    const oversizeExplained = !oversizedLogoBytes(record.derivative) || summaryExplains(record, "模板 Logo 过大");
    return corruptExplained && oversizeExplained;
  }
  try {
    const bytes = store.regularFile(store.paths(record.meta.id).logo);
    if (bytes.length !== candidate.bytes || digest(bytes) !== candidate.sha256) return false;
    return await imageFullyDecodes(bytes);
  } catch {
    return false;
  }
}
