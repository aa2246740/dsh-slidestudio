import { createPdfRenderPoller, pdfRenderPending } from "./attachment-pdf-render.js";
import { parseAttachmentPublic } from "./attachment-public.js";
import {
  countIncomingFiles,
  countSelectedAttachments,
  embeddedImageSelection,
  quotaMessageForAddition,
} from "./attachment-quota.js";
import { deleteAttachmentRecords } from "./attachment-leftovers.js";
import { oversizeReason } from "./attachment-limits.js";
import { postAttachmentFile, UPLOAD_FAILED } from "./attachment-upload.js";
import { formatBytes, renderAttachmentChip } from "./attachment-chip-view.js";
import { t } from "./i18n.js";

export { parseAttachmentPublic, formatBytes };
export { UPLOAD_STALL_MS, UPLOAD_TIMEOUT_MS } from "./attachment-upload.js";

/** @typedef {import("./attachment-public.js").PublicAttachment} PublicAttachment */
/** @typedef {{
 *  localId: string, name: string, status: "queued"|"uploading"|"parsing"|"parsed"|"unsupported"|"failed", progress: number, expanded?: boolean, file?: File, consumed?: boolean, id?: string,
 *  bytes?: number, kind?: PublicAttachment["kind"], parser?: string|null, summaryZh?: string, styleProfile?: PublicAttachment["styleProfile"], styleHintLine?: PublicAttachment["styleHintLine"],
 *  imageMetadata?: PublicAttachment["imageMetadata"], warnings?: {code: string, message: string}[], needsVision?: boolean, imageMaterials?: PublicAttachment[], embeddedImages?: PublicAttachment["embeddedImages"],
 *  documentSent?: boolean, sentEmbeddedIds?: string[], pdfRender?: PublicAttachment["pdfRender"], renderTimer?: ReturnType<typeof setTimeout> | 0, renderPolls?: number, renderGaveUp?: boolean, reason?: string, xhr?: XMLHttpRequest,
 *  }} LocalAttachment */

const UPLOAD_CONCURRENCY = 2;
const BUSY_STATES = ["queued", "uploading", "parsing"];

/** Reason both send surfaces show while a vision model waits for PDF page images (i18n key). */
export const PDF_RENDER_PENDING_REASON = "PDF 页面图片还在生成，完成后即可发送";

/** The one reason a send with no brief and no parsed material is held (i18n key). */
export const ATTACH_NEEDS_BRIEF = "请填写文稿要求，或添加至少一个已识别的参考资料";

/** Send-gate truth table shared by Hub and editor: busy chips wait, bad chips explain, a PDF
 * still rendering holds the send for a vision model (unknown counts as yes). Reasons are translated.
 * @param {Array<Pick<LocalAttachment, "name"|"status"|"parser"|"pdfRender"|"renderGaveUp"> & {id?: string}>} items
 * @param {{briefFilled: boolean, modelAcceptsImages?: boolean | null}} input */
export function attachmentSendState(items, { briefFilled, modelAcceptsImages }) {
  if (items.some((item) => BUSY_STATES.includes(item.status))) {
    return { disabled: true, reason: t("资料仍在上传或解析，请稍候") };
  }
  const bad = items.find((item) => item.status === "unsupported" || item.status === "failed");
  if (bad) {
    return {
      disabled: true,
      reason: t("资料“{name}”不能使用，请移除或重试后再发送", { name: bad.name }),
    };
  }
  if (modelAcceptsImages !== false && items.some((item) => pdfRenderPending(item))) {
    return { disabled: true, reason: t(PDF_RENDER_PENDING_REASON) };
  }
  if (!briefFilled && !items.some((item) => item.status === "parsed" && item.id)) {
    return { disabled: true, reason: t(ATTACH_NEEDS_BRIEF) };
  }
  return { disabled: false, reason: "" };
}

/** Local chip fields copied from a public record.
 * @param {PublicAttachment} attachment */
function publicFields(attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    bytes: attachment.size,
    kind: attachment.kind,
    parser: attachment.parser,
    styleProfile: attachment.styleProfile,
    styleHintLine: attachment.styleHintLine,
    imageMetadata: attachment.imageMetadata,
    status: attachment.status,
    summaryZh: attachment.summary?.zh || "",
    warnings: attachment.warnings,
    needsVision: attachment.needsVision,
    imageMaterials: attachment.imageMaterials,
    embeddedImages: attachment.embeddedImages,
    pdfRender: attachment.pdfRender,
    reason: attachment.message || "",
    progress: 100,
  };
}

/** Every record id one public upload owns: itself, pack children and extracted pictures.
 * @param {{id?: string, imageMaterials?: {id: string}[], embeddedImages?: {id: string}[]}} attachment */
export function ownedRecordIds(attachment) {
  return [
    attachment.id,
    ...(attachment.imageMaterials || []).map((image) => image.id),
    ...(attachment.embeddedImages || []).map((image) => image.id),
  ];
}

/** Per-file upload/chip engine; each item gets its own XHR, so one bad file fails alone.
 * @param {{
 *  targets: {key: string, element: HTMLElement, hideWhenEmpty?: boolean}[], controlPrefix: string, apiPath?: (path: string) => string, onChange?: () => void, onMessage?: (message: string) => void,
 *  onRemove?: (item: LocalAttachment) => void, embeddedContinues?: boolean, editUse?: boolean, }} options `embeddedContinues`: pictures that do not fit one send ride later sends (the
 *  editor); otherwise they are simply not sent (the Hub's single send). */
export function createAttachmentChips({
  targets,
  controlPrefix,
  apiPath = (path) => path,
  onChange,
  onMessage,
  onRemove,
  embeddedContinues = false,
  editUse = false,
}) {
  /** @type {LocalAttachment[]} */
  const items = [];
  const renderPoller = createPdfRenderPoller({
    apiPath,
    items,
    parse: parseAttachmentPublic,
    onUpdate: () => paintSoon(),
  });
  let sequence = 0;
  let paintFrame = 0;
  let active = 0;
  let visionBlocked = false;

  function paint() {
    const selection = embeddedImageSelection(items);
    for (const target of targets) {
      target.element.replaceChildren(
        ...items.map((item) =>
          renderAttachmentChip(item, target.key, {
            controlPrefix,
            editUse,
            embeddedContinues,
            visionBlocked,
            embedded: selection.get(item),
            onToggle: toggleItem,
            onRetry: retryItem,
            onRemove: removeItem,
          }),
        ),
      );
      if (target.hideWhenEmpty !== false) target.element.hidden = items.length === 0;
    }
    onChange?.();
  }
  function paintSoon() {
    if (paintFrame) return;
    paintFrame = requestAnimationFrame(() => {
      paintFrame = 0;
      paint();
    });
  }
  /** @param {LocalAttachment} item */
  function toggleItem(item) {
    item.expanded = !item.expanded;
    paint();
  }
  /** @param {LocalAttachment} item */
  function retryItem(item) {
    if (item.status !== "failed") return;
    item.status = "queued";
    item.reason = "";
    item.progress = 0;
    paint();
    pump();
  }
  /** Drop a chip locally; the server record is the caller's business.
   * @param {LocalAttachment} item */
  function dropLocal(item) {
    const index = items.indexOf(item);
    if (index < 0) return false;
    items.splice(index, 1);
    item.xhr?.abort();
    renderPoller.stop(item);
    return true;
  }
  /** @param {LocalAttachment} item */
  function removeItem(item) {
    if (!dropLocal(item)) return;
    onRemove?.(item);
    paint();
  }
  /** Start uploads while fewer than the concurrency limit are in flight. */
  function pump() {
    for (const item of items) {
      if (active >= UPLOAD_CONCURRENCY) break;
      if (item.status !== "queued") continue;
      item.status = "uploading";
      item.progress = 0;
      active += 1;
      void upload(item);
    }
    paintSoon();
  }
  /** @param {LocalAttachment} item @param {File} file */
  function send(item, file) {
    return postAttachmentFile({
      apiPath,
      file,
      onXhr: (xhr) => {
        item.xhr = xhr;
      },
      onProgress: (percent) => {
        item.progress = percent;
        paintSoon();
      },
      onUploaded: () => {
        if (items.includes(item) && item.status === "uploading") {
          item.status = "parsing";
          item.progress = 100;
          paintSoon();
        }
      },
    });
  }
  /** @param {LocalAttachment} item */
  async function upload(item) {
    const file = item.file;
    try {
      if (!file) throw new Error(t("没有可重试的文件"));
      const tooLarge = oversizeReason(file);
      if (tooLarge) throw new Error(tooLarge);
      const uploaded = await send(item, file);
      item.xhr = undefined;
      if (!items.includes(item)) return;
      applyPublic(item, uploaded);
      paint();
    } catch (error) {
      item.xhr = undefined;
      if (!items.includes(item)) return;
      item.status = "failed";
      item.reason = error instanceof Error ? error.message : UPLOAD_FAILED;
      item.progress = 0;
      paint();
    } finally {
      active = Math.max(0, active - 1);
      pump();
    }
  }
  /** @param {LocalAttachment} item @param {PublicAttachment} uploaded */
  function heldElsewhere(item, uploaded) {
    return items.some(
      (other) =>
        other !== item &&
        (other.id === uploaded.id ||
          other.imageMaterials?.some((image) => image.id === uploaded.id) ||
          other.embeddedImages?.some((image) => image.id === uploaded.id)),
    );
  }
  /** @param {LocalAttachment} item @param {PublicAttachment} uploaded */
  function applyPublic(item, uploaded) {
    if (uploaded.duplicateOf && heldElsewhere(item, uploaded)) {
      dropLocal(item);
      onMessage?.(t("已存在相同文件：{name}", { name: uploaded.name }));
      return;
    }
    const quotaMessage = quotaMessageForAddition(
      countSelectedAttachments(items.filter((other) => other !== item)),
      countSelectedAttachments([uploaded]),
    );
    if (quotaMessage) {
      dropLocal(item);
      // Remove an upload rejected after its expanded image count is known; a duplicate
      // shares its server record with an earlier selection, so it is kept.
      if (!uploaded.duplicateOf) void deleteAttachmentRecords(apiPath, ownedRecordIds(uploaded));
      onMessage?.(quotaMessage);
      paint();
      return;
    }
    Object.assign(item, publicFields(uploaded), { xhr: undefined });
    renderPoller.watch(item);
  }
  /** @param {FileList | ArrayLike<File> | null | undefined} files */
  function ingestFiles(files) {
    const incomingFiles = Array.from(files || []);
    const quotaMessage = quotaMessageForAddition(countSelectedAttachments(items), countIncomingFiles(incomingFiles));
    if (quotaMessage) {
      onMessage?.(quotaMessage);
      return;
    }
    for (const file of incomingFiles) {
      const reason = oversizeReason(file);
      items.push({
        localId: `local-${++sequence}`,
        name: file.name,
        file,
        status: reason ? "failed" : "queued",
        progress: 0,
        ...(reason ? { reason } : {}),
      });
    }
    if (!incomingFiles.length) return;
    paint();
    pump();
  }
  /** Push an already-recognized record (demo samples, restored selections).
   * @param {PublicAttachment} attachment
   * @param {{consumed?: boolean, documentSent?: boolean, sentEmbeddedIds?: string[]}} [extra] */
  function addParsed(attachment, extra = {}) {
    if (items.some((item) => item.id === attachment.id)) return false;
    const quotaMessage = quotaMessageForAddition(
      countSelectedAttachments(items),
      countSelectedAttachments([attachment]),
    );
    if (quotaMessage) {
      onMessage?.(quotaMessage);
      return false;
    }
    /** @type {LocalAttachment} */
    const item = {
      localId: `local-${++sequence}`,
      ...publicFields(attachment),
      consumed: extra.consumed,
      ...(extra.documentSent ? { documentSent: true, sentEmbeddedIds: extra.sentEmbeddedIds } : {}),
    };
    items.push(item);
    paint();
    renderPoller.watch(item);
    return true;
  }
  return {
    /** Live item list (callers must not mutate statuses directly). */
    items,
    ingestFiles,
    addParsed,
    removeItem,
    paint,
    /** Mark parsed needsVision chips when the selected model cannot see images.
     * @param {boolean} flag */
    setVisionBlocked(flag) {
      const next = flag === true;
      if (next === visionBlocked) return;
      visionBlocked = next;
      paint();
    },
    /** @returns {LocalAttachment[]} queued/uploading/parsing items */
    busyItems() {
      return items.filter((item) => BUSY_STATES.includes(item.status));
    },
    /** @param {{briefFilled: boolean, modelAcceptsImages?: boolean | null}} input */
    sendState: (input) => attachmentSendState(items, input),
  };
}
