import { formatsNote, MODAL_COPY } from "./material-scope.js";
import { t } from "./i18n.js";

const MIB = 1048576;
const DECK_LIMIT_MB = 50;
const OTHER_LIMIT_MB = 20;

/** The browser-side size check; the server answers 413 in the same words.
 * @param {{name: string, size: number}} file */
export function oversizeReason({ name, size }) {
  const deck = /\.(pptx|potx|pdf)$/i.test(name);
  if (size <= (deck ? DECK_LIMIT_MB : OTHER_LIMIT_MB) * MIB) return "";
  return deck ? t("文件超过 50MB 上限，请压缩或拆分后再上传") : t("图片等文件不能超过 20MB；PPT 和 PDF 不能超过 50MB");
}

const LEGACY_SUFFIX = ",.ppt,.doc,.xls,.dps,.et,.wps";

/** Last health answer, so a language switch can repaint the modal sentence. */
let legacyOn = false;

/** Paint the Hub modal's sentences from the shared table (VAL-FMT-007). Runs before
 * the health check so the copy is present even when health is unreachable, and again
 * after a language switch. */
export function renderAttachCopy() {
  const note = document.getElementById("attach-formats-note");
  if (note) note.textContent = formatsNote(legacyOn);
  const capability = document.querySelector(".attach-capability-note");
  if (capability) capability.textContent = t(MODAL_COPY.capabilityNote);
}

/** @param {(path: string) => string} apiPath */
async function legacyConvertAvailable(apiPath) {
  try {
    const response = await fetch(apiPath("/api/health"));
    if (!response.ok) return false;
    /** @type {unknown} */
    const data = await response.json();
    const info =
      data && typeof data === "object"
        ? /** @type {{legacyConvert?: {available?: unknown}}} */ (data).legacyConvert
        : undefined;
    return info?.available === true;
  } catch {
    // Keep the round-1 picker and the fallback sentence.
    return false;
  }
}

/** Widen a file picker and swap the modal's legacy sentence when the service converts
 * legacy files; both surfaces (Hub modal, editor composer) follow the same switch.
 * Resolves to whether legacy conversion is on.
 * @param {HTMLInputElement} input @param {{apiPath: (path: string) => string}} options */
export async function applyLegacyAccept(input, { apiPath }) {
  legacyOn = false;
  renderAttachCopy();
  const on = await legacyConvertAvailable(apiPath);
  if (!on) return false;
  legacyOn = true;
  if (!input.accept.includes(".wps")) input.accept += LEGACY_SUFFIX;
  renderAttachCopy();
  return true;
}
