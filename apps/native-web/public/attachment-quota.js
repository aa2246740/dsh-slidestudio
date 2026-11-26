import { QUOTA_COPY } from "./material-scope.js";
import { unsentEmbedded } from "./attachment-leftovers.js";

/** @import {EmbeddedImage} from "./attachment-embedded.js" */
/** @import { LocalAttachment } from "./attachment-chips.js" */

export const MAX_TURN_IMAGES = 20;
export const MAX_TURN_OTHER_ATTACHMENTS = 6;

const IMAGE_EXTENSION = /\.(?:jpe?g|png|webp|gif)$/i;
const ZIP_EXTENSION = /\.zip$/i;

/** @typedef {{images: number, others: number}} AttachmentCounts */

/** @param {string} name */
export function isImageAttachmentName(name) {
  return IMAGE_EXTENSION.test(name);
}

/** @param {string} name */
function isImagePackName(name) {
  return ZIP_EXTENSION.test(name);
}

/** @param {AttachmentCounts} counts */
export function attachmentQuotaMessage(counts) {
  if (counts.images > MAX_TURN_IMAGES) return QUOTA_COPY.imageQuota(MAX_TURN_IMAGES);
  if (counts.others > MAX_TURN_OTHER_ATTACHMENTS) {
    return QUOTA_COPY.otherQuota(MAX_TURN_OTHER_ATTACHMENTS);
  }
  return "";
}

/** @param {ArrayLike<{name?: string, kind?: string|null, parser?: string|null, imageMaterials?: unknown[], documentSent?: boolean}>} items */
export function countSelectedAttachments(items) {
  /** @type {AttachmentCounts} */
  const counts = { images: 0, others: 0 };
  for (const item of Array.from(items)) {
    if (item.parser === "image-pack-v1" || Array.isArray(item.imageMaterials)) {
      counts.images += item.imageMaterials?.length ?? 0;
    } else if (item.kind === "image" || isImageAttachmentName(item.name || "")) {
      counts.images += 1;
    } else if (!isImagePackName(item.name || "") && !item.documentSent) {
      // A document that was already sent is not sent again; only its pictures remain.
      counts.others += 1;
    }
  }
  return counts;
}

/**
 * @param {ArrayLike<{name: string}>} files
 * @returns {AttachmentCounts}
 */
export function countIncomingFiles(files) {
  /** @type {AttachmentCounts} */
  const counts = { images: 0, others: 0 };
  for (const file of Array.from(files)) {
    if (isImageAttachmentName(file.name)) counts.images += 1;
    else if (!isImagePackName(file.name)) counts.others += 1;
  }
  return counts;
}

/** @param {AttachmentCounts} current @param {AttachmentCounts} incoming */
export function quotaMessageForAddition(current, incoming) {
  return attachmentQuotaMessage({
    images: current.images + incoming.images,
    others: current.others + incoming.others,
  });
}

/**
 *  Pictures embedded in a DOCX/PDF ride along with their document, in upload order, as far as the per-turn image quota still has room after the user's own images.
 *  A document is never refused for its pictures; what does not fit is reported as `omitted`. Ids already selected elsewhere (a standalone upload dedupes onto the
 *  embedded record) are skipped so one id is never sent twice; pictures an earlier send already carried are not offered again.
 * @param {ArrayLike<Pick<LocalAttachment, "id"|"status"|"consumed"|"kind"|"parser"|"name"|"imageMaterials"|"documentSent"|"sentEmbeddedIds"|"embeddedImages">>} items
 * @returns {Map<unknown, {included: EmbeddedImage[], omitted: number}>}
 */
export function embeddedImageSelection(items) {
  const eligible = Array.from(items).filter((item) => item.id && item.status === "parsed" && !item.consumed);
  let room = MAX_TURN_IMAGES - countSelectedAttachments(eligible).images;
  const taken = new Set(eligible.flatMap((item) => [item.id, ...(item.imageMaterials || []).map((image) => image.id)]));
  const selection = new Map();
  for (const item of eligible) {
    const all = unsentEmbedded(item).filter((image) => !taken.has(image.id));
    if (!all.length) continue;
    const count = Math.max(0, Math.min(all.length, room));
    room -= count;
    const included = all.slice(0, count);
    for (const image of included) taken.add(image.id);
    selection.set(item, { included, omitted: all.length - count });
  }
  return selection;
}
