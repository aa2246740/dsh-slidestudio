import crypto from "node:crypto";
import fs from "node:fs";

/** Exclusive create records ownership before writing, so partial failures roll back.
 * @param {string} file @param {Uint8Array|Buffer|string} data @param {string[]} created */
export function writeExclusive(file, data, created) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const fd = fs.openSync(file, "wx");
  created.push(file);
  try {
    let offset = 0;
    while (offset < buffer.length) {
      const wrote = fs.writeSync(fd, buffer, offset, buffer.length - offset);
      if (wrote <= 0) throw Object.assign(new Error("写入附件失败"), { code: "EIO" });
      offset += wrote;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The envelope remains self-contained until Host gains a multi-artifact handoff.
 * Sidecar files are additional hash-bound copies, never authoritative replacements.
 * @param {unknown} derivative
 * @param {{pointer: string, body: string, file: string, invalid: string, changed: string}} sidecar
 * @returns {Buffer|undefined}
 */
function sidecarBytes(derivative, { pointer: pointerKey, body: bodyKey, file, invalid, changed }) {
  if (!derivative || typeof derivative !== "object") return undefined;
  const deck = /** @type {Record<string,unknown>} */ (derivative)["deck-template"];
  if (!deck || typeof deck !== "object") return undefined;
  const { [pointerKey]: pointer, [bodyKey]: body } = /** @type {Record<string,unknown>} */ (deck);
  if (!pointer) return undefined;
  if (typeof pointer !== "object" || !body || typeof body !== "object") throw new Error(invalid);
  const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`);
  const claimed = /** @type {Record<string,unknown>} */ (pointer);
  if (claimed.file !== file || crypto.createHash("sha256").update(bytes).digest("hex") !== claimed.sha256) {
    throw new Error(changed);
  }
  return bytes;
}

const DETAIL = {
  pointer: "detail",
  body: "templateDetail",
  file: "template-detail.json",
  invalid: "资料解析明细凭据无效，请重新上传",
  changed: "资料解析明细已变化，请重新上传",
};
const KIT = {
  pointer: "kit",
  body: "templateKit",
  file: "template-kit.json",
  invalid: "模板组件凭据无效，请重新上传",
  changed: "模板组件已变化，请重新上传",
};

/** @param {unknown} derivative */
export const templateDetailBytes = (derivative) => sidecarBytes(derivative, DETAIL);

/** @param {unknown} derivative */
export const templateKitBytes = (derivative) => sidecarBytes(derivative, KIT);

/** @param {Buffer|undefined} expected @param {string} file @param {(file:string)=>Buffer} read
 * @param {{missing: string, changed: string}} messages */
function verifySidecar(expected, file, read, { missing, changed }) {
  if (!expected) return;
  let actual;
  try {
    actual = read(file);
  } catch {
    throw new Error(missing);
  }
  if (!actual.equals(expected)) throw new Error(changed);
}

/** @param {unknown} derivative @param {string} file @param {(file:string)=>Buffer} read */
export function verifyTemplateDetail(derivative, file, read) {
  verifySidecar(templateDetailBytes(derivative), file, read, {
    missing: "资料解析明细缺失或已变化，请重新上传",
    changed: DETAIL.changed,
  });
}

/** @param {unknown} derivative @param {string} file @param {(file:string)=>Buffer} read */
export function verifyTemplateKit(derivative, file, read) {
  verifySidecar(templateKitBytes(derivative), file, read, {
    missing: "模板组件缺失或已变化，请重新上传",
    changed: KIT.changed,
  });
}
