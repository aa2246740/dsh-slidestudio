import { CONVERSION_COPY, materialScope } from "./material-scope.js";
import { pdfRenderNoteElement } from "./attachment-pdf-render.js";
import { MAX_TURN_IMAGES } from "./attachment-quota.js";
import { embeddedImageLines } from "./attachment-embedded.js";
import { leftoverStatus } from "./attachment-leftovers.js";
import { UPLOAD_FAILED } from "./attachment-upload.js";
import { t } from "./i18n.js";

/** @import { LocalAttachment } from "./attachment-chips.js" */
/** @import { EmbeddedImage } from "./attachment-embedded.js" */
/** @import { ScopeCopy } from "./material-scope.js" */

/**
 * What one paint knows beyond the item itself.
 * @typedef {{
 *  controlPrefix: string, editUse: boolean, embeddedContinues: boolean, visionBlocked: boolean,
 *  embedded: {included: EmbeddedImage[], omitted: number} | undefined,
 *  onToggle: (item: LocalAttachment) => void, onRetry: (item: LocalAttachment) => void,
 *  onRemove: (item: LocalAttachment) => void, }} ChipContext
 */

/** @param {string} body the shapes inside the icon's 24-unit viewBox */
const kindIcon = (body) =>
  `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${body}</svg>`;

const PAGE_OUTLINE = '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/>';
/** @type {Record<string, string>} */
const KIND_ICONS = {
  image: kindIcon(
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  ),
  table: kindIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>'),
  document: kindIcon(`${PAGE_OUTLINE}<path d="M14 3v5h5M9 13h6M9 17h6"/>`),
  "deck-template": kindIcon('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M12 17v4M8 21h8"/>'),
  text: kindIcon(`${PAGE_OUTLINE}<path d="M14 3v5h5"/>`),
};
const GENERIC_ICON = KIND_ICONS.text || "";

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Status line of a parsed chip: the conversion mark, the size and any picture count.
 * @param {LocalAttachment} item */
function parsedStatus(item) {
  if (item.parser === "image-pack-v1") {
    return t("已识别 · 图片包 · {n} 张图片", { n: item.imageMaterials?.length ?? 0 });
  }
  // Converted legacy uploads carry this summary prefix; pictures ride along.
  const mark = /^（由 (.+?) 转换）/.exec(item.summaryZh || "")?.[1];
  const head = `${mark ? CONVERSION_COPY.badge(mark) : t(CONVERSION_COPY.plain)} · ${formatBytes(item.bytes ?? 0)}`;
  return item.embeddedImages?.length ? `${head}${t(" · 内嵌图片 {n} 张", { n: item.embeddedImages.length })}` : head;
}

/** @param {LocalAttachment} item */
export function chipStatusText(item) {
  if (item.consumed) return t("已发送，待清理");
  if (item.status === "parsed") return item.documentSent ? leftoverStatus(item) : parsedStatus(item);
  if (item.status === "queued") return t("排队中");
  if (item.status === "uploading") return t("上传中 {n}%", { n: item.progress });
  if (item.status === "parsing") return t("解析中");
  if (item.status === "unsupported") {
    return t("不支持 · {reason}", { reason: t(item.reason || "该文件类型暂不支持") });
  }
  return t("失败 · {reason}", { reason: t(item.reason || UPLOAD_FAILED) });
}

/** @param {string} tag @param {string} className @param {string} [text] */
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** @param {LocalAttachment} item @param {ChipContext} context @param {ScopeCopy|null} material */
function chipMain(item, context, material) {
  const main = node("span", "chip-main");
  main.append(node("b", "", item.name), node("small", "chip-status", chipStatusText(item)));
  if (material) main.append(node("small", "chip-scope", material.label));
  const seesPictures = item.needsVision === true || Boolean(context.embedded?.included.length);
  if (item.status === "parsed" && context.visionBlocked && seesPictures) {
    main.append(node("small", "chip-vision-note", t("当前模型无法识别图片内容")));
  }
  const renderNote = pdfRenderNoteElement(item);
  if (renderNote) main.append(renderNote);
  if (item.status === "uploading") {
    const progress = node("i", "chip-progress");
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    progress.setAttribute("aria-valuenow", String(item.progress));
    progress.setAttribute("aria-label", t("{name} 上传进度", { name: item.name }));
    const bar = node("i", "chip-progress-bar");
    bar.style.width = `${Math.min(100, Math.max(0, item.progress))}%`;
    progress.append(bar);
    main.append(progress);
  }
  return { main, renderNote };
}

/** Scope, edit-use and style lines from the material table.
 * @param {ChipContext} context @param {ScopeCopy|null} material @returns {[string, string][]} */
function scopeLines(context, material) {
  if (!material) return [];
  /** @type {[string, string][]} */
  const lines = [[material.detail, "chip-scope-detail"]];
  if (context.editUse && material.editUse) lines.push([material.editUse, "chip-edit-use"]);
  if (material.styleHintLine) lines.push([material.styleHintLine, "chip-style-hint"]);
  return lines;
}

/** Warnings and the failure reason, translated where the dictionary knows them.
 * @param {LocalAttachment} item @returns {[string, string][]} */
function problemLines(item) {
  /** @type {[string, string][]} */
  const lines = [];
  for (const warning of item.warnings || []) {
    if (warning?.message) lines.push([t(warning.message), ""]);
  }
  if (item.reason && item.status !== "parsed") lines.push([t(item.reason), ""]);
  return lines;
}

/** Expanded detail lines in their fixed order: summary, scope, use, style, pictures, render, warnings.
 * @param {LocalAttachment} item @param {ChipContext} context @param {ScopeCopy|null} material
 * @param {boolean} hasRenderNote @returns {[string, string][]} */
function detailLines(item, context, material, hasRenderNote) {
  /** @type {[string, string][]} */
  const lines = item.summaryZh ? [[t(item.summaryZh), ""]] : [];
  lines.push(...scopeLines(context, material));
  const embedded = embeddedImageLines(item.embeddedImages || [], context.embedded?.omitted ?? 0, MAX_TURN_IMAGES, {
    sentIds: new Set(item.sentEmbeddedIds || []),
    documentSent: item.documentSent === true,
    continues: context.embeddedContinues,
  });
  for (const line of embedded) lines.push([line, "chip-embedded-detail"]);
  if (hasRenderNote && item.pdfRender?.message) {
    lines.push([t(item.pdfRender.message), "chip-render-detail"]);
  }
  lines.push(...problemLines(item));
  if (!lines.length) lines.push([t("暂无识别结果"), ""]);
  return lines;
}

/** @param {LocalAttachment} item @param {ChipContext} context */
function chipActions(item, context) {
  const actions = node("span", "chip-actions");
  if (item.status === "failed") {
    const retry = /** @type {HTMLButtonElement} */ (node("button", "chip-retry", t("重试")));
    retry.type = "button";
    retry.dataset.control = `${context.controlPrefix}.chip.retry`;
    retry.title = t("重新上传该文件");
    retry.setAttribute("aria-label", t("重新上传 {name}", { name: item.name }));
    retry.addEventListener("click", (event) => {
      event.stopPropagation();
      context.onRetry(item);
    });
    actions.append(retry);
  }
  const remove = /** @type {HTMLButtonElement} */ (node("button", "chip-remove", "×"));
  remove.type = "button";
  remove.dataset.control = `${context.controlPrefix}.chip.remove`;
  remove.title = t("移除");
  remove.setAttribute("aria-label", t("移除附件 {name}", { name: item.name }));
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    context.onRemove(item);
  });
  actions.append(remove);
  return actions;
}

/** One chip: an expand toggle (icon, name, status, notes), the detail and its actions.
 * @param {LocalAttachment} item @param {string} scope the target key, keeps ids unique
 * @param {ChipContext} context */
export function renderAttachmentChip(item, scope, context) {
  const chip = node("div", `reference-chip is-${item.status}`);
  chip.dataset.localId = item.localId;
  if (item.id) chip.dataset.attachId = item.id;
  const detailId = `chip-detail-${item.localId}-${scope}`;
  const toggle = /** @type {HTMLButtonElement} */ (node("button", "chip-toggle"));
  toggle.type = "button";
  toggle.dataset.control = `${context.controlPrefix}.chip.expand`;
  toggle.setAttribute("aria-expanded", String(Boolean(item.expanded)));
  toggle.setAttribute("aria-controls", detailId);
  toggle.title = t("查看识别详情");
  const icon = node("span", "chip-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = (item.kind && KIND_ICONS[item.kind]) || GENERIC_ICON;
  const material = item.status === "parsed" ? materialScope(item.kind, item.parser, item) : null;
  const { main, renderNote } = chipMain(item, context, material);
  toggle.append(icon, main);
  toggle.addEventListener("click", () => context.onToggle(item));
  const detail = node("div", "chip-detail");
  detail.id = detailId;
  detail.hidden = !item.expanded;
  for (const [line, className] of detailLines(item, context, material, Boolean(renderNote))) {
    detail.append(node("p", className, line));
  }
  chip.append(toggle, detail, chipActions(item, context));
  return chip;
}
