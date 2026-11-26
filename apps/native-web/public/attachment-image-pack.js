import { INVALID_REPLY } from "./generation-data.js";

/**
 * @template {Readonly<{kind: string|null, status: string, parser: string|null, imageMaterials?: unknown[]}>} T
 * @param {unknown} value @param {unknown} parser @param {unknown} kind @param {string} status
 * @param {(value: unknown) => T} parseChild @returns {T[]|undefined}
 */
export function parseImageMaterials(value, parser, kind, status, parseChild) {
  const isImagePack = parser === "image-pack-v1";
  if (value === undefined) {
    if (isImagePack && status === "parsed") throw new Error(INVALID_REPLY);
    return undefined;
  }
  if (!isImagePack || kind !== "image" || !Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error(INVALID_REPLY);
  }
  const imageMaterials = /** @type {unknown[]} */ (value).map(parseChild);
  if (
    imageMaterials.some(
      (image) =>
        image.kind !== "image" ||
        image.status !== "parsed" ||
        image.parser !== "image-sharp-v1" ||
        image.imageMaterials !== undefined,
    )
  ) {
    throw new Error(INVALID_REPLY);
  }
  return imageMaterials;
}
