/**
 * The legacy-conversion half of a material record (CAP-37, M8). The store
 * keeps `<id>.converted` — the OOXML package the sandboxed converter
 * produced — beside the uploaded original, and the project receives the
 * pair. Every verification treats the two files as one material: tampering
 * either fails the whole record with a Chinese re-upload reason and nothing
 * is partially materialized. Extraction keeps `material-store.ts` at its
 * module budget.
 */
import fs from "node:fs";
import path from "node:path";
import { inputSha256 } from "./material-input.js";
import { MaterialVerificationError } from "./material-errors.js";

const fail = (message: string): never => {
  throw new MaterialVerificationError(message);
};

/** Target extensions the converter is allowed to declare for a family. */
const CONVERTED_TARGETS: ReadonlySet<string> = new Set([".pptx", ".docx", ".xlsx"]);

/**
 * The verified converted package of a store record, or `undefined` when the
 * record is not a conversion (no meta pin and no derivative receipt). The
 * derivative is already re-hashed against the attachment, so its `conversion`
 * receipt is the authority; the meta pin must agree with it, and the stored
 * package must re-hash against both.
 */
export function verifiedConvertedPackage(input: {
  file: string;
  name: string;
  meta: Record<string, unknown>;
  derivative: Record<string, unknown>;
  read: (file: string) => Buffer;
}): Buffer | undefined {
  const metaSha256 = input.meta.convertedSha256;
  const conversion = input.derivative.conversion;
  const derivativeSha256 =
    conversion && typeof conversion === "object" && !Array.isArray(conversion)
      ? (conversion as Record<string, unknown>).convertedSha256
      : undefined;
  if (metaSha256 === undefined && derivativeSha256 === undefined) return undefined;
  if (typeof derivativeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(derivativeSha256)) {
    return fail(`资料「${input.name}」解析凭据无效，请重新上传后再发送`);
  }
  if (metaSha256 !== undefined && metaSha256 !== derivativeSha256) {
    return fail(`资料「${input.name}」的校验信息已变化，请重新上传后再发送`);
  }
  const to = conversion && typeof conversion === "object" ? (conversion as Record<string, unknown>).to : "";
  if (typeof to !== "string" || !CONVERTED_TARGETS.has(to)) {
    return fail(`资料「${input.name}」解析凭据无效，请重新上传后再发送`);
  }
  const bytes = input.read(input.file);
  if (inputSha256(bytes) !== derivativeSha256) {
    return fail(`资料「${input.name}」转换结果已变化，请重新上传后再发送`);
  }
  return bytes;
}

/**
 * The `.pptx`/`.docx`/`.xlsx` target extension a verified conversion
 * declares — the project copy is written as `converted.<to>`.
 */
export function convertedTargetExtension(derivative: Record<string, unknown>): string | undefined {
  const conversion = derivative.conversion;
  const to =
    conversion && typeof conversion === "object" && !Array.isArray(conversion)
      ? (conversion as Record<string, unknown>).to
      : undefined;
  return typeof to === "string" && CONVERTED_TARGETS.has(to) ? to : undefined;
}

/** Write the project half of the pair: `converted.<ext>` beside `original.<ext>`. */
export function writeConvertedPackage(dir: string, bytes: Buffer, extension: string): void {
  if (!CONVERTED_TARGETS.has(extension)) {
    fail("资料转换结果无效，请重新上传后再发送");
  }
  fs.writeFileSync(path.join(dir, `converted${extension}`), bytes);
}
