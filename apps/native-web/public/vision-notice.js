import {
  createHealthRequestGate,
  healthModelAcceptsImages,
  healthSelectionMatches,
  modalitiesFor,
  resolveImageCapability,
} from "./hub-health-state.js";
import { t } from "./i18n.js";

/** Source sentence (i18n key); painted through t() on every sync. */
export const VISION_NOTICE_TEXT =
  "当前模型无法识别图片内容。图片仍可放进幻灯片（尺寸、主色、Logo 摆放等信息可用），但 Agent 看不到画面；如需识别，请换用支持看图的模型。";
const VISION_ACTION_TEXT = "换看图模型";

/**
 * @param {{
 *  chips: ReturnType<import("./attachment-chips.js").createAttachmentChips>, control: string, modelKey: () => string, onAction?: () => void, fetchImpl?: (path: string) => Promise<Response>, noticeId?: string,
 *  onCapabilityChange?: () => void, }} options */
export function createVisionNotice({ chips, control, modelKey, onAction, fetchImpl, noticeId, onCapabilityChange }) {
  const element = document.createElement("p");
  element.className = "vision-notice";
  if (noticeId) element.id = noticeId;
  element.setAttribute("role", "status");
  element.hidden = true;
  const message = document.createTextNode(t(VISION_NOTICE_TEXT));
  element.append(message);
  const action = document.createElement("button");
  action.type = "button";
  action.dataset.control = control;
  action.textContent = t(VISION_ACTION_TEXT);
  action.addEventListener("click", (event) => {
    // Prevent document hideMenus from closing the picker immediately.
    event.stopPropagation();
    onAction?.();
  });
  element.append(action);

  /** @type {HTMLElement[]} */
  const mirrors = [];
  const gate = createHealthRequestGate();
  let catalog = /** @type {unknown} */ (null);
  /** @type {boolean | null} */
  let accepts = null;
  let boundKey = "";
  /** @type {Promise<void> | null} */
  let loading = null;
  /** @type {boolean | null} */
  let published = null;

  function fullKey() {
    return String(modelKey() || "").trim();
  }

  function acceptsImagesNow() {
    return boundKey === fullKey() ? accepts : null;
  }

  /** @param {string} key */
  function parseKey(key) {
    const slash = key.indexOf("/");
    if (slash < 0) return { provider: "", model: key };
    return { provider: key.slice(0, slash), model: key.slice(slash + 1) };
  }

  function blocked() {
    const needs = chips.items.some((item) => item.status === "parsed" && item.needsVision === true);
    return Boolean(needs && accepts === false && boundKey === fullKey());
  }

  function sync() {
    const blockedFlag = blocked();
    chips.setVisionBlocked(blockedFlag);
    message.textContent = t(VISION_NOTICE_TEXT);
    action.textContent = t(VISION_ACTION_TEXT);
    element.hidden = !blockedFlag;
    for (const mirror of mirrors) {
      mirror.textContent = t(VISION_NOTICE_TEXT);
      mirror.hidden = !blockedFlag;
    }
    publish();
  }

  function publish() {
    const next = acceptsImagesNow();
    if (next === published) return;
    published = next;
    onCapabilityChange?.();
  }

  /** @param {boolean | null | undefined} modelAcceptsImages */
  function report(modelAcceptsImages) {
    const key = fullKey();
    const parsed = parseKey(key);
    if (parsed.model) gate.begin(parsed);
    accepts = modelAcceptsImages === true ? true : modelAcceptsImages === false ? false : null;
    boundKey = key;
    sync();
  }

  /**
   * @param {{id: number, selection: {provider: string, model: string}}} request
   * @param {string} key
   */
  async function load(request, key) {
    const parsed = request.selection;
    const params = new URLSearchParams();
    if (parsed.provider) params.set("provider", parsed.provider);
    if (parsed.model) params.set("model", parsed.model);
    const healthPromise = (fetchImpl || fetch)(`/slides/health?${params}`);
    const modelsPromise = (fetchImpl || fetch)("/slides/models");
    /** @type {boolean | null} */
    let healthAccepts = null;
    let sawHealth = false;
    try {
      const response = await healthPromise;
      if (!gate.isCurrent(request, parseKey(fullKey()))) return;
      if (response.ok) {
        const data = await response.json();
        if (
          data &&
          typeof data === "object" &&
          "selection" in data &&
          data.selection != null &&
          !healthSelectionMatches(request.selection, data.selection)
        ) {
          return;
        }
        healthAccepts = healthModelAcceptsImages(data);
        sawHealth = true;
      }
    } catch {
      // Health is optional; catalog can still decide.
    }
    if (!gate.isCurrent(request, parseKey(fullKey()))) return;
    try {
      const response = await modelsPromise;
      if (!gate.isCurrent(request, parseKey(fullKey()))) return;
      if (response.ok) catalog = await response.json();
    } catch {
      // Keep previous catalog on failure.
    }
    if (!gate.isCurrent(request, parseKey(fullKey()))) return;
    accepts = resolveImageCapability(
      sawHealth ? healthAccepts : null,
      modalitiesFor(catalog, parsed.provider, parsed.model),
    );
    boundKey = key;
    sync();
  }

  function refresh() {
    const key = fullKey();
    const parsed = parseKey(key);
    if (!parsed.model) {
      accepts = null;
      boundKey = key;
      sync();
      return;
    }
    const request = gate.begin(parsed);
    accepts = resolveImageCapability(null, modalitiesFor(catalog, parsed.provider, parsed.model));
    boundKey = key;
    sync();
    const task = load(request, key);
    loading = task;
    void task.finally(() => {
      if (loading === task) loading = null;
    });
  }

  return {
    element,
    /** @param {HTMLElement} el */
    mirror(el) {
      mirrors.push(el);
      el.hidden = !blocked();
    },
    sync,
    refresh,
    report,
    acceptsImages: acceptsImagesNow,
    ready() {
      return loading || Promise.resolve();
    },
  };
}

/** @param {string} [id] */
export function visionNoticeMirror(id) {
  const element = document.createElement("p");
  element.className = "vision-notice is-mirror";
  if (id) element.id = id;
  element.setAttribute("role", "status");
  element.hidden = true;
  element.textContent = t(VISION_NOTICE_TEXT);
  return element;
}
