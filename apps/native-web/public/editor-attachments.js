import { editorElement as $ } from "./editor-dom.js";
import { createAttachmentChips, ownedRecordIds, parseAttachmentPublic } from "./attachment-chips.js";
import { applyLegacyAccept, renderAttachCopy } from "./attachment-limits.js";
import { embeddedImageSelection } from "./attachment-quota.js";
import { deleteAttachmentRecords, markDocumentSent, remainingAfter, restoredSentIds } from "./attachment-leftovers.js";
import { createVisionNotice } from "./vision-notice.js";
import { paintStyleSourceNotice } from "./material-scope.js";
import { t } from "./i18n.js";

/** @typedef {{id: string, name: string, bytes: number, packId?: string, consumed?: boolean}} AgentAttachment */
/** @import { LocalAttachment } from "./attachment-chips.js" */

const MAX_TURN_ITEMS = 26;

/** @param {string} projectKey */
function storageKey(projectKey) {
  return `oss.editor.agent-attachments:${projectKey || "default"}`;
}

/**
 * @param {{projectKey: () => string, apiPath: (path: string) => string,
 *  onBusy?: (busy: boolean) => void, onMessage?: (message: string) => void, onItemsChanged?: (pending: AgentAttachment[]) => void, styleNoticeContext?: () => {designSystemId?: string, stylePackName?: string},
 *  vision?: {modelKey: () => string, onOpenModelPicker: () => void}, }} options */
export function mountEditorAttachments({
  projectKey,
  apiPath,
  onBusy,
  onMessage,
  onItemsChanged,
  styleNoticeContext = () => ({}),
  vision,
}) {
  const box = $("agent-attachments");
  const input = $("agent-attachment-file");
  if (!box || !input) throw new Error("编辑器附件控件缺失：#agent-attachments / #agent-attachment-file");
  void applyLegacyAccept(input, { apiPath });

  let lastBusy = false;
  const styleNotice = document.getElementById("style-source-notice");
  const briefInput = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("work-brief"));
  const paintStyleNotice = (/** @type {LocalAttachment[]} */ current) =>
    paintStyleSourceNotice(styleNotice, { ...styleNoticeContext(), brief: briefInput?.value || "" }, current);
  const chips = createAttachmentChips({
    targets: [{ key: "composer", element: box }],
    controlPrefix: "chrome.workspace.assistant.attach",
    apiPath,
    embeddedContinues: true,
    editUse: true,
    onChange: () => {
      visionNotice?.sync();
      paintStyleNotice(items);
      persist();
      onItemsChanged?.(pending());
      const busy = chips.busyItems().length > 0;
      if (busy !== lastBusy) {
        lastBusy = busy;
        onBusy?.(busy);
      }
    },
    onMessage,
    onRemove: (item) => {
      if (!item.id) return;
      void deleteAttachmentRecords(apiPath, ownedRecordIds(item));
    },
  });
  const items = chips.items;

  function pending() {
    const embedded = embeddedImageSelection(items);
    return items
      .filter((item) => item.id && item.status === "parsed" && !item.consumed)
      .flatMap((item) =>
        item.imageMaterials?.length
          ? item.imageMaterials.map((image) => ({
              id: image.id,
              name: image.name,
              bytes: image.size,
              packId: /** @type {string} */ (item.id),
            }))
          : [
              ...(item.documentSent
                ? []
                : [
                    {
                      id: /** @type {string} */ (item.id),
                      name: item.name,
                      bytes: item.bytes || 0,
                    },
                  ]),
              ...(embedded.get(item)?.included ?? []).map((image) => ({
                id: image.id,
                name: image.name,
                bytes: image.size,
              })),
            ],
      );
  }

  function persist() {
    try {
      localStorage.setItem(
        storageKey(projectKey()),
        JSON.stringify(
          items
            .filter((item) => item.id)
            .map((item) => ({
              id: item.id,
              name: item.name,
              bytes: item.bytes || 0,
              consumed: Boolean(item.consumed),
              ...(item.documentSent ? { documentSent: true, sentEmbeddedIds: item.sentEmbeddedIds || [] } : {}),
            })),
        ),
      );
    } catch {
      // Storage unavailable; keep in-tab chips.
    }
  }

  async function restore() {
    /** @type {unknown} */
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(storageKey(projectKey())) || "[]");
    } catch {
      saved = [];
    }
    if (!Array.isArray(saved) || !saved.length) return;
    for (const entry of saved.slice(0, MAX_TURN_ITEMS)) {
      const id = String(/** @type {{id?: unknown}} */ (entry)?.id || "");
      if (!id) continue;
      try {
        const response = await fetch(apiPath(`/api/attachments/${encodeURIComponent(id)}`));
        if (!response.ok) continue;
        const rec = parseAttachmentPublic(await response.json());
        if (rec.status !== "parsed") continue;
        const sentDocument = /** @type {{documentSent?: unknown}} */ (entry)?.documentSent === true;
        chips.addParsed(rec, {
          consumed: Boolean(entry?.consumed),
          ...(sentDocument
            ? {
                documentSent: true,
                sentEmbeddedIds: restoredSentIds(/** @type {{sentEmbeddedIds?: unknown}} */ (entry).sentEmbeddedIds),
              }
            : {}),
        });
      } catch {
        // Drop stale chip if sidecar restarted.
      }
    }
  }

  /** @param {Pick<AgentAttachment, "id" | "packId">[]} sent */
  async function consumeSent(sent) {
    /** @param {readonly {id: string}[] | undefined} images */
    const idsOf = (images) => (images || []).map((image) => image.id);
    const sentIds = new Set(sent.map((attachment) => attachment.id));
    const holding = new Set(
      items.filter((item) => {
        const embeddedIds = idsOf(item.embeddedImages);
        const touched = sentIds.has(item.id || "") || embeddedIds.some((id) => sentIds.has(id));
        return touched && embeddedIds.length > 0 && remainingAfter(item, sentIds) > 0;
      }),
    );
    for (const item of holding) markDocumentSent(item, sentIds);
    const finished = items.filter((item) => {
      if (!item.id || holding.has(item)) return false;
      const childIds = idsOf(item.imageMaterials);
      const embeddedIds = idsOf(item.embeddedImages);
      const sentPack = childIds.length > 0 && childIds.every((id) => sentIds.has(id));
      return sentPack || sentIds.has(item.id) || embeddedIds.some((id) => sentIds.has(id));
    });
    const heldIds = new Set([...holding].flatMap((item) => [item.id, ...idsOf(item.embeddedImages)]));
    /** @type {(string|undefined)[]} */
    const candidateIds = [
      ...sent.map((attachment) => attachment.id),
      ...sent.map((attachment) => attachment.packId),
      ...finished.flatMap((item) => [item.id, ...idsOf(item.embeddedImages)]),
    ];
    const idsToDelete = /** @type {string[]} */ (
      candidateIds.filter((id) => typeof id === "string" && id && !heldIds.has(id))
    );
    const failed = await deleteAttachmentRecords(apiPath, idsToDelete);
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (!item || !item.id || !finished.includes(item)) continue;
      const childIds = idsOf(item.imageMaterials);
      const embeddedIds = idsOf(item.embeddedImages);
      if ([item.id, ...childIds, ...embeddedIds].some((id) => failed.has(id))) item.consumed = true;
      else items.splice(index, 1);
    }
    chips.paint();
    if (failed.size) onMessage?.(t("Agent 已收到附件，但有附件清理失败；可用 × 重试清理。"));
  }

  const visionNotice = vision
    ? createVisionNotice({
        chips,
        control: "chrome.workspace.assistant.attach.vision.models",
        modelKey: vision.modelKey,
        onAction: vision.onOpenModelPicker,
        noticeId: "agent-vision-notice",
        onCapabilityChange: () => chips.paint(),
      })
    : null;
  if (visionNotice) {
    box.after(visionNotice.element);
    visionNotice.refresh();
  }
  briefInput?.addEventListener("input", () => paintStyleNotice(items));

  $("composer-plus")?.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const files = [...(input.files || [])];
    input.value = "";
    if (!files.length) return;
    chips.ingestFiles(/** @type {FileList} */ (/** @type {unknown} */ (files)));
  });

  return {
    pending,
    gate: () => {
      const send = chips.sendState({
        briefFilled: true,
        modelAcceptsImages: visionNotice?.acceptsImages() ?? null,
      });
      return send.disabled ? send.reason : "";
    },
    busy: () => chips.busyItems().length > 0,
    consumeSent,
    restore,
    refreshVision: () => visionNotice?.refresh(),
    refreshStyleNotice: () => paintStyleNotice(items),
    /** @param {ArrayLike<File>} files */
    ingestFiles: (files) => chips.ingestFiles(files),
    /** Repaint every translated sentence after a language switch. */
    repaint: () => {
      renderAttachCopy();
      chips.paint();
    },
  };
}
