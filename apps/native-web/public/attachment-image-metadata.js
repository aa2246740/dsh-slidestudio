import { INVALID_REPLY, record } from "./generation-data.js";
import { t } from "./i18n.js";

/** @typedef {{orientation:"landscape"|"portrait"|"square",logoLike?:boolean,screenshotLike?:boolean,takenAt?:string}} ImageMetadata */

const ORIENTATIONS = ["landscape", "portrait", "square"];
const TAKEN_AT = /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/;

/** @param {unknown} value */
const optionalBoolean = (value) => value === undefined || typeof value === "boolean";

/** @param {unknown} value @returns {ImageMetadata|undefined} */
export function parseImageMetadata(value) {
  if (value === undefined) return undefined;
  const data = record(value);
  const takenAtOk = data.takenAt === undefined || (typeof data.takenAt === "string" && TAKEN_AT.test(data.takenAt));
  if (
    !ORIENTATIONS.includes(String(data.orientation)) ||
    !optionalBoolean(data.logoLike) ||
    !optionalBoolean(data.screenshotLike) ||
    !takenAtOk
  ) {
    throw new Error(INVALID_REPLY);
  }
  return {
    orientation: /** @type {ImageMetadata["orientation"]} */ (data.orientation),
    ...(typeof data.logoLike === "boolean" ? { logoLike: data.logoLike } : {}),
    ...(typeof data.screenshotLike === "boolean" ? { screenshotLike: data.screenshotLike } : {}),
    ...(typeof data.takenAt === "string" ? { takenAt: data.takenAt } : {}),
  };
}

/** Localized list separator shared by the material copy ("、" in Chinese). */
export function listSeparator() {
  return t("、");
}

/** @param {Record<string, unknown>} data */
function orientationLabel(data) {
  /** @type {Record<string, string>} */
  const labels = { landscape: "横向", portrait: "纵向", square: "方形" };
  return typeof data.orientation === "string" && Object.hasOwn(labels, data.orientation)
    ? t(labels[data.orientation] || "")
    : "";
}

/** @param {Record<string, unknown>} item */
function accentLine(item) {
  const profile = record(item.styleProfile);
  if (profile.source !== "image-pixels" || !Array.isArray(profile.accentColors)) return "";
  const colors = profile.accentColors
    .map((color) => record(color))
    .filter((color) => typeof color.hex === "string" && /^#[0-9a-f]{6}$/i.test(color.hex));
  if (!colors.length) return "";
  const list = colors
    .map((color) =>
      t("{hex}（{pct}%）", {
        hex: String(color.hex),
        pct: Math.round(Number(color.share) * 100),
      }),
    )
    .join(listSeparator());
  return t("强调色 {colors}", { colors: list });
}

/** Pixel-statistics clue line of an image chip, or "" when nothing is known.
 * @param {Record<string,unknown>} item */
export function imageMetadataLine(item) {
  const data = record(item.imageMetadata);
  const parts = [
    orientationLabel(data),
    data.logoLike === true ? t("疑似 Logo") : "",
    data.screenshotLike === true ? t("疑似截图") : "",
    typeof data.takenAt === "string" ? t("拍摄时间 {at}", { at: data.takenAt }) : "",
    accentLine(item),
  ].filter(Boolean);
  return parts.length ? t("图片线索：{parts}（像素统计，不代表已看图）", { parts: parts.join(t("；")) }) : "";
}
