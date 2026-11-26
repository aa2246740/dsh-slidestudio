import { hubElement, nativeApi } from "./hub-dom.js";
import { record, text } from "./generation-data.js";
import { createAttachmentChips, parseAttachmentPublic, attachmentSendState } from "./attachment-chips.js";
import { applyLegacyAccept, renderAttachCopy } from "./attachment-limits.js";
import { embeddedImageSelection } from "./attachment-quota.js";
import { createVisionNotice, visionNoticeMirror } from "./vision-notice.js";
import { paintStyleSourceNotice } from "./material-scope.js";
import { t } from "./i18n.js";

export { formatBytes, parseAttachmentPublic } from "./attachment-chips.js";

/** @import { PublicAttachment, LocalAttachment } from "./attachment-chips.js" */

/** Send-gate truth table for the Hub (see attachmentSendState).
 * @param {Array<Pick<LocalAttachment, "name"|"status"|"parser"|"pdfRender"|"renderGaveUp"> & {id?: string}>} items
 * @param {{briefFilled: boolean, modelAcceptsImages?: boolean | null}} input
 * @returns {{disabled: boolean, reason: string}} */
export function hubSendState(items, { briefFilled, modelAcceptsImages }) {
  return attachmentSendState(items, { briefFilled, modelAcceptsImages });
}

/** Upload/retry/remove with one authoritative local selection, upload progress
 * and a close guard for in-flight uploads.
 * @param {{onChange: () => void, onMessage: (message: string) => void, onOpenModels?: () => void,
 *   styleNoticeContext?: () => {brief?: string, designSystemId?: string, stylePackName?: string}}} callbacks */
export function mountHubAttachments({ onChange, onMessage, onOpenModels, styleNoticeContext = () => ({}) }) {
  const row = hubElement("attach-row", HTMLElement);
  const modal = hubElement("attach-modal", HTMLElement);
  const modalList = hubElement("attach-modal-list", HTMLElement);
  const input = hubElement("attach-file", HTMLInputElement);
  void applyLegacyAccept(input, { apiPath: nativeApi });
  const confirmBox = hubElement("attach-close-confirm", HTMLElement);
  const closeText = hubElement("attach-close-text", HTMLElement);
  const styleNotice = document.getElementById("style-source-notice");
  let modelKey = "";
  const paintStyleNotice = (/** @type {LocalAttachment[]} */ current) =>
    paintStyleSourceNotice(styleNotice, styleNoticeContext(), current);

  const chips = createAttachmentChips({
    targets: [
      { key: "row", element: row, hideWhenEmpty: false },
      { key: "modal", element: modalList, hideWhenEmpty: false },
    ],
    controlPrefix: "chrome.createhub.attach",
    apiPath: nativeApi,
    onChange: () => {
      visionNotice.sync();
      paintStyleNotice(items);
      onChange();
    },
    onMessage,
  });
  const items = chips.items;

  const visionNotice = createVisionNotice({
    chips,
    control: "chrome.createhub.attach.vision.models",
    modelKey: () => modelKey,
    onAction: () => {
      if (onOpenModels) onOpenModels();
      else document.getElementById("btn-model")?.click();
    },
    noticeId: "vision-notice",
    // A capability change repaints the chips, which repaints the Hub send state.
    onCapabilityChange: () => chips.paint(),
  });
  row.after(visionNotice.element);
  // The same notice mirrors inside the model panel next to the capability row, so the user sees why 看图 is off exactly where the capability lives.
  const capabilityRow = document.getElementById("capability-row");
  if (capabilityRow) {
    const mirror = visionNoticeMirror("vision-notice-panel");
    capabilityRow.after(mirror);
    visionNotice.mirror(mirror);
  }
  /** Hide the modal (uploads keep running) and return focus to the trigger. */
  function closeModal() {
    const hadFocus = modal.contains(document.activeElement) || confirmBox.contains(document.activeElement);
    modal.hidden = true;
    confirmBox.hidden = true;
    const trigger = document.getElementById("btn-attach");
    trigger?.setAttribute("aria-expanded", "false");
    if (hadFocus) trigger?.focus();
  }
  /** Closing with in-flight uploads asks first; uploads continue in the background. */
  function requestClose() {
    const busy = chips.busyItems();
    if (!busy.length) {
      closeModal();
      return;
    }
    closeText.textContent = t("还有 {n} 个文件正在上传，关闭后会在后台继续上传，确定关闭吗？", {
      n: busy.length,
    });
    confirmBox.hidden = false;
    hubElement("btn-attach-cancel", HTMLButtonElement).focus();
  }
  const opener = hubElement("btn-attach", HTMLButtonElement);
  opener.addEventListener("click", () => {
    modal.hidden = false;
    opener.setAttribute("aria-expanded", "true");
  });

  hubElement("btn-attach-close", HTMLButtonElement).addEventListener("click", requestClose);
  hubElement("btn-attach-cancel", HTMLButtonElement).addEventListener("click", () => {
    confirmBox.hidden = true;
  });
  hubElement("btn-attach-confirm", HTMLButtonElement).addEventListener("click", closeModal);
  hubElement("btn-pick-files", HTMLButtonElement).addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    chips.ingestFiles(input.files);
    input.value = "";
  });
  hubElement("btn-demo-ref", HTMLButtonElement).addEventListener("click", async () => {
    try {
      const response = await fetch(nativeApi("/api/attachments/demo"), { method: "POST" });
      const data = record(await response.json());
      if (!response.ok) throw new Error(text(data.error) || response.statusText);
      if (!Array.isArray(data.attachments)) throw new Error(t("样例资料列表无效"));
      /** @type {unknown[]} */
      const values = data.attachments;
      const parsed = values.map(parseAttachmentPublic); // Validate all before changing the selection.
      let known = 0;
      for (const attachment of parsed) {
        if (!chips.addParsed(attachment)) known += 1;
      }
      closeModal();
      onMessage(known === parsed.length ? t("样例资料已在列表中，未重复添加") : t("已加入本地品牌样例"));
    } catch (error) {
      onMessage(error instanceof Error ? t(error.message) : t("样例加入失败"));
    }
  });
  const dropZone = document.getElementById("drop-zone");
  if (dropZone) {
    dropZone.addEventListener("click", () => input.click());
    dropZone.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      input.click();
    });
    bindDrop(dropZone, (files) => chips.ingestFiles(files));
  }
  bindDrop(modal.querySelector(".attach-modal"), (files) => chips.ingestFiles(files));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) requestClose();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || modal.hidden) return;
    if (!confirmBox.hidden) confirmBox.hidden = true;
    else requestClose();
  });
  return {
    selection: () => {
      const embedded = embeddedImageSelection(items);
      return items.flatMap((item) =>
        item.imageMaterials?.length
          ? item.imageMaterials.map(({ id, name, status }) => ({ id, name, status }))
          : [
              { id: item.id, name: item.name, status: item.status },
              ...(embedded.get(item)?.included ?? []).map(({ id, name, status }) => ({
                id,
                name,
                status,
              })),
            ],
      );
    },
    /** Read-only scope state for the Hub's explanatory notices. */
    items: () => items.map(({ kind, parser, name, status }) => ({ kind, parser, name, status })),
    /** Refresh reminders after the brief or selected style changes. */
    refreshStyleNotice: () => paintStyleNotice(items),
    /** @param {{briefFilled: boolean}} brief */
    sendState: (brief) => chips.sendState({ ...brief, modelAcceptsImages: visionNotice.acceptsImages() }),
    /** Test seam for the picker change event; the file input's FileList is read-only.
     * @param {ArrayLike<File>} files */
    ingestFiles: (files) => chips.ingestFiles(/** @type {FileList} */ (/** @type {unknown} */ (files))),
    /** @param {{provider?: string, model?: string, modelAcceptsImages?: boolean | null}} selection */
    setModel: (selection) => {
      modelKey = `${selection.provider || ""}/${selection.model || ""}`;
      // The picker passes the health result (including null for unknown). Omitting the field fetches health for this provider/model.
      if (Object.prototype.hasOwnProperty.call(selection, "modelAcceptsImages")) {
        visionNotice.report(selection.modelAcceptsImages);
        return;
      }
      visionNotice.refresh();
    },
    /** Re-evaluate the vision notice (model or chips changed). */
    syncVision: () => visionNotice.refresh(),
    /** Repaint every translated sentence after a language switch. */
    repaint: () => {
      renderAttachCopy();
      chips.paint();
    },
  };
}

/** @param {Element | null} target @param {(files: FileList | null | undefined) => void} ingest */
function bindDrop(target, ingest) {
  if (!target) return;
  for (const type of ["dragenter", "dragover"]) {
    target.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
      target.classList.add("is-dragover");
    });
  }
  target.addEventListener("dragleave", () => target.classList.remove("is-dragover"));
  target.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    target.classList.remove("is-dragover");
    if (event instanceof DragEvent) ingest(event.dataTransfer?.files);
  });
}
