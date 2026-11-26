import { t } from "./i18n.js";

/** A document whose embedded pictures did not all fit one editor turn stays in the
 *  composer after its first send: the document is not sent again, and the pictures left ride along with later sends, a quota's worth at a time.
 * @typedef {{id?: string, embeddedImages?: {id: string}[], documentSent?: boolean, sentEmbeddedIds?: string[]}} LeftoverItem */

const MAX_EMBEDDED = 40;

/** DELETE one upload and its derived image records (the editor is single-user local, so no
 *  owner scope applies); resolves to the ids the server kept (the delete failed and was not a 404). The caller decides when removal also deletes (the editor) or only discards an over-quota upload (the Hub).
 * @param {(path: string) => string} apiPath @param {Array<string | undefined>} ids @returns {Promise<Set<string>>} */
export async function deleteAttachmentRecords(apiPath, ids) {
  const failed = new Set();
  await Promise.all(
    [...new Set(ids.filter((id) => typeof id === "string"))].map(async (id) => {
      try {
        const response = await fetch(apiPath(`/api/attachments/${encodeURIComponent(id)}`), {
          method: "DELETE",
        });
        if (!response.ok && response.status !== 404) failed.add(id);
      } catch {
        failed.add(id);
      }
    }),
  );
  return failed;
}

/** Pictures of the document that no earlier send has carried.
 * @template {{id: string}} Image
 * @param {{embeddedImages?: Image[], sentEmbeddedIds?: string[]}} item
 * @returns {Image[]} */
export function unsentEmbedded(item) {
  const sent = new Set(item.sentEmbeddedIds || []);
  return (item.embeddedImages || []).filter((image) => !sent.has(image.id));
}

/** How many pictures stay unsent once `sentIds` have gone out with this send.
 * @param {LeftoverItem} item @param {ReadonlySet<string>} sentIds */
export function remainingAfter(item, sentIds) {
  return unsentEmbedded(item).filter((image) => !sentIds.has(image.id)).length;
}

/** Record that the document and the pictures among `sentIds` have been sent. Only called
 * for a document that still has pictures left.
 * @param {LeftoverItem} item @param {ReadonlySet<string>} sentIds */
export function markDocumentSent(item, sentIds) {
  const carried = (item.embeddedImages || []).filter((image) => sentIds.has(image.id));
  item.documentSent = true;
  item.sentEmbeddedIds = [...new Set([...(item.sentEmbeddedIds || []), ...carried.map((image) => image.id)])];
}

/** Chip status line of a document that was sent and still holds pictures.
 * @param {LeftoverItem} item */
export function leftoverStatus(item) {
  return t("文档已发送 · 内嵌图片还剩 {n} 张待发送", { n: unsentEmbedded(item).length });
}

/** What survives a reload; ids that are not strings are dropped.
 * @param {unknown} value @returns {string[]} */
export function restoredSentIds(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((id) => typeof id === "string" && id).slice(0, MAX_EMBEDDED);
}
