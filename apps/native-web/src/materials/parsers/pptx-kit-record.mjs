/** What a stored template kit must look like for a record to be reused, kept free of parser code. */
import { createHash } from "node:crypto";

export const TEMPLATE_KIT_SCHEMA = "template-kit/v1";
/** Bumping this re-parses every stored template once, as a parser id change does. */
export const TEMPLATE_KIT_VERSION = 4;
const TEMPLATE_KIT_FILE = "template-kit.json";
export const TEMPLATE_KIT_MAX_BYTES = 256 * 1024;

/** @param {unknown} kit */
export const kitBytes = (kit) => Buffer.from(`${JSON.stringify(kit, null, 2)}\n`);

/** @param {unknown} kit */
export function kitPointer(kit) {
  return {
    file: TEMPLATE_KIT_FILE,
    sha256: createHash("sha256").update(kitBytes(kit)).digest("hex"),
  };
}

/** The pointer and the embedded kit must both be present and current.
 * @param {unknown} deck */
export function kitCurrent(deck) {
  const { kit, templateKit } = /** @type {Record<string, any>} */ (deck ?? {});
  return (
    kit?.file === TEMPLATE_KIT_FILE &&
    /^[0-9a-f]{64}$/.test(kit?.sha256 ?? "") &&
    templateKit?.schema === TEMPLATE_KIT_SCHEMA &&
    templateKit?.version === TEMPLATE_KIT_VERSION
  );
}
