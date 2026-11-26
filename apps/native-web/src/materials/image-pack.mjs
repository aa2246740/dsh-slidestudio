/**
 * Safe image-pack inspection. The central directory is validated before any
 * entry is inflated; only JPG/PNG/WebP/GIF paths become image materials.
 */
import path from "node:path";
import { MaterialRejection, readCentralDirectory } from "./zip-guard.mjs";

export const IMAGE_PACK_MAX_IMAGES = 20;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const NO_IMAGES_MESSAGE = "暂不支持无受支持图片的 ZIP 压缩包；请上传包含 JPG、PNG、WebP 或 GIF 图片的压缩包";
const TOO_MANY_IMAGES_MESSAGE = `图片包最多包含 ${IMAGE_PACK_MAX_IMAGES} 张图片；请拆分后再上传`;

/**
 * @typedef {{entry: import("./zip-guard.mjs").ZipEntry, name: string}} ImagePackEntry
 */

/**
 * Read the bounded central directory and identify image entries without
 * inflating their payloads. Names are reduced to a safe basename before they
 * are exposed or stored as individual materials.
 * @param {Uint8Array} bytes
 * @returns {{images: ImagePackEntry[], ignoredNames: string[], entryCount: number}}
 */
export function inspectImagePack(bytes) {
  const entries = readCentralDirectory(bytes);
  /** @type {ImagePackEntry[]} */
  const images = [];
  /** @type {string[]} */
  const ignoredNames = [];
  for (const entry of entries) {
    const normalized = entry.name.replaceAll("\\", "/");
    const macMetadata = normalized.split("/").includes("__MACOSX");
    if (macMetadata) {
      const basename = path.posix.basename(normalized);
      ignoredNames.push(basename === "__MACOSX" ? "__MACOSX" : `__MACOSX/${displayEntryName(basename)}`);
      continue;
    }
    if (normalized.endsWith("/")) continue;
    const basename = path.posix.basename(normalized);
    const extension = path.posix.extname(basename).toLowerCase();
    if (!basename || basename === "." || basename === ".." || !IMAGE_EXTENSIONS.has(extension)) {
      ignoredNames.push(displayEntryName(normalized));
      continue;
    }
    images.push({ entry, name: basename });
  }
  if (!images.length) throw new MaterialRejection("unsupported-type", NO_IMAGES_MESSAGE);
  if (images.length > IMAGE_PACK_MAX_IMAGES) {
    throw new MaterialRejection("too-many-images", TOO_MANY_IMAGES_MESSAGE);
  }
  return { images, ignoredNames, entryCount: entries.length };
}

/**
 * Keep archive paths out of user-facing warnings and bound their length.
 * @param {string} name
 */
function displayEntryName(name) {
  const basename = path.posix.basename(name.replaceAll("\\", "/")) || name;
  return Array.from(basename).slice(0, 100).join("");
}

/**
 * Convert ignored archive entries into one bounded, user-visible warning.
 * @param {string[]} ignoredNames
 * @returns {{code: string, message: string}|undefined}
 */
export function ignoredImagePackWarning(ignoredNames) {
  if (!ignoredNames.length) return undefined;
  const shown = ignoredNames.slice(0, 5).join("、");
  const remainder = ignoredNames.length > 5 ? `等 ${ignoredNames.length} 个条目` : "";
  return {
    code: "non-image-entry",
    message: `图片包中的 ${ignoredNames.length} 个非图片条目未加入：${shown}${remainder}`,
  };
}
