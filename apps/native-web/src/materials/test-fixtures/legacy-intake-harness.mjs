/**
 * Stand-ins for the legacy intake tests: an in-memory ownerless store with the
 * surface legacy intake uses, converter fakes, and the design copy written out
 * independently of the code under test.
 */
import crypto from "node:crypto";
import { LEGACY_CONVERSION_RULE } from "../derivative.mjs";
import { LEGACY_FIXTURES } from "./legacy-office-fixtures.mjs";

/**
 * @typedef {import("../legacy-intake.mjs").LegacyDerivative} LegacyDerivative
 * @typedef {{derivative: LegacyDerivative, converted?: Uint8Array,
 *   meta: {id: string, originalSha256: string, convertedSha256?: string}}} MemoryRecord
 * @typedef {import("../legacy-convert.mjs").ConvertSuccess} ConvertSuccess
 * @typedef {import("../legacy-convert.mjs").ConvertFailure} ConvertFailure
 * @typedef {import("../legacy-intake.mjs").LegacyConverterLike} LegacyConverterLike
 */

/** The Chinese copy of the design's failure table, written out independently of the code. */
export const COPY = {
  encrypted: "文件已加密（设有打开密码），无法读取；请取消密码后再上传",
  wpsSecure:
    "这是 WPS 加密文档，只能在 WPS 中打开；请在 WPS 中取消文档加密，再另存为 .docx / .xlsx / .pptx 后上传",
  macro: "文件包含宏，出于安全考虑不予接收；请另存为不含宏的 .pptx / .docx / .xlsx 后再上传",
  corrupt: "文件已损坏或内容不完整，无法转换；请在 Office 或 WPS 中打开后另存为新格式再上传",
  tooLarge: "转换后的文件超过 50 MB，无法使用；请精简后另存为新格式再上传",
  timeout:
    "旧格式文件转换时间过长，已停止；请在 Office 或 WPS 中另存为 .pptx / .docx / .xlsx 后再上传",
  oom: "旧格式文件转换占用内存过大，已停止；请拆分文件，或另存为新格式后再上传",
  busy: "当前转换任务较多，请稍后重试；也可以先另存为新格式再上传",
  failed: "旧格式文件转换失败；请在 Office 或 WPS 中另存为新格式后再上传",
};

/** key, upload name, code, message: refused before any conversion. */
export const PRECHECKS = /** @type {const} */ ([
  ["legacy-encrypted.doc", "legacy-encrypted.doc", "encrypted", COPY.encrypted],
  ["legacy-filepass.xls", "legacy-filepass.xls", "encrypted", COPY.encrypted],
  ["legacy-encrypted.ppt", "legacy-encrypted.ppt", "encrypted", COPY.encrypted],
  ["wps-secure.dps", "wps-secure.dps", "encrypted", COPY.wpsSecure],
  ["wps-secure.doc", "wps-secure.wps", "encrypted", COPY.wpsSecure],
  ["wps-secure.xls", "wps-secure.et", "encrypted", COPY.wpsSecure],
  ["legacy-macro.doc", "legacy-macro.doc", "macro-enabled", COPY.macro],
  ["legacy-vba.xls", "legacy-vba.xls", "macro-enabled", COPY.macro],
  ["legacy-xlm.xls", "legacy-xlm.xls", "macro-enabled", COPY.macro],
  ["legacy-macro.ppt", "legacy-macro.ppt", "macro-enabled", COPY.macro],
  ["legacy-truncated.ppt", "legacy-truncated.ppt", "corrupt", COPY.corrupt],
]);

/** @param {Uint8Array} bytes */
export const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** @param {string} key a LEGACY_FIXTURES name */
export function legacy(key) {
  const fixture = LEGACY_FIXTURES[/** @type {keyof typeof LEGACY_FIXTURES} */ (key)];
  if (!fixture) throw new Error(`no legacy fixture named ${key}`);
  return fixture.build();
}

let storeSequence = 0;

/**
 * The store surface legacy intake uses, in memory and without owners. A refused
 * upload is never reused, and a stored conversion is reused only under the
 * current conversion rule (the same answers the attachment store gives).
 */
export class MemoryStore {
  constructor() {
    this.root = `memory-store-${(storeSequence += 1)}`;
    /** @type {MemoryRecord[]} */
    this.records = [];
    /** @type {Record<string, unknown>[]} */
    this.recordInputs = [];
  }

  /** @param {string} name */
  nextId(name) {
    return `${crypto.randomUUID()}-${name.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
  }

  /**
   * @param {string} name @param {Uint8Array} bytes @param {string|null} declaredMime
   * @param {string|null} detectedMime @param {boolean} extensionMismatch
   */
  sourceOf(name, bytes, declaredMime, detectedMime, extensionMismatch) {
    const lower = name.toLowerCase();
    const dot = lower.lastIndexOf(".");
    return {
      name,
      bytes: bytes.length,
      sha256: sha(bytes),
      declaredMime,
      detectedMime,
      extension: dot > 0 ? lower.slice(dot) : "",
      extensionMismatch,
    };
  }

  /** @param {Uint8Array} bytes */
  async findByHash(bytes) {
    const hash = sha(bytes);
    return this.records.find(
      (record) =>
        record.meta.originalSha256 === hash &&
        !record.derivative.errorCode &&
        (!record.derivative.conversion ||
          record.derivative.conversion.rule === LEGACY_CONVERSION_RULE),
    );
  }

  /**
   * @param {{name: string, bytes: Uint8Array, derivative: LegacyDerivative, converted?: Uint8Array}} input
   * @returns {Promise<MemoryRecord>}
   */
  async record(input) {
    this.recordInputs.push({ ...input });
    const { bytes, derivative, converted } = input;
    /** @type {MemoryRecord} */
    const record = {
      meta: {
        id: derivative.materialId,
        originalSha256: sha(bytes),
        ...(converted ? { convertedSha256: sha(converted) } : {}),
      },
      derivative,
      ...(converted ? { converted } : {}),
    };
    this.records.push(record);
    return record;
  }

  /** The stored converted packages. */
  convertedPackages() {
    return this.records.flatMap((record) => (record.converted ? [record.converted] : []));
  }
}

/**
 * The memory store as the intake store type; it implements only the fields intake reads.
 * @param {MemoryStore} store @returns {import("../legacy-intake.mjs").LegacyIntakeStore}
 */
export const asIntakeStore = (store) => /** @type {never} */ (store);

/** A parse pool that must not be reached: rejections never parse anything. */
export const throwingPool = {
  /** @returns {Promise<never>} */
  run() {
    throw new Error("a legacy rejection must not reach the parse pool");
  },
};

/**
 * @param {Uint8Array} bytes @param {string} to @param {Partial<ConvertSuccess>} [extra]
 * @returns {ConvertSuccess}
 */
export const success = (bytes, to, extra = {}) => ({
  ok: true,
  bytes: Buffer.from(bytes),
  durationMs: 120,
  peakRssMb: 210,
  engineVersion: "26.2.3.2",
  isolation: "sandbox-exec",
  to,
  ...extra,
});

/**
 * A converter stand-in: `outputs` maps an input's sha256 to what `run` answers.
 * @param {Map<string, ConvertSuccess|ConvertFailure>} outputs
 * @param {{available?: boolean, waitReady?: () => Promise<boolean>}} [state]
 */
export function fakeConverter(outputs, { available = true, waitReady } = {}) {
  /** @type {{family: string, vendor?: string, sha256: string}[]} */
  const calls = [];
  return {
    calls,
    get available() {
      return available;
    },
    ready: async () => ({ available }),
    ...(waitReady ? { waitReady } : {}),
    info: () => ({ available, isolation: "sandbox-exec", engineVersion: "26.2.3.2" }),
    /** @param {{bytes: Uint8Array, family: string, vendor?: string}} input */
    async run(input) {
      calls.push({ family: input.family, vendor: input.vendor, sha256: sha(input.bytes) });
      return (
        outputs.get(sha(input.bytes)) ??
        /** @type {ConvertFailure} */ ({
          ok: false,
          code: "convert-failed",
          message: "no output registered",
        })
      );
    },
  };
}

/**
 * Wraps a real converter so a test can count how often intake actually ran it.
 * @param {LegacyConverterLike} converter
 */
export function spied(converter) {
  /** @type {{family: string}[]} */
  const calls = [];
  return {
    calls,
    get available() {
      return converter.available;
    },
    ready: () => converter.ready(),
    info: () => converter.info(),
    /** @param {{bytes: Uint8Array, family: string, vendor?: string}} input */
    run: (input) => {
      calls.push(input);
      return converter.run(input);
    },
  };
}
