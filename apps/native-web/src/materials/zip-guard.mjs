/**
 * Zip safety gate for untrusted uploads. Every OOXML file is scanned through
 * its central directory BEFORE any bytes are inflated: entry count, declared
 * per-entry size, declared total size and the compression-ratio bomb check all
 * run on header metadata, so hostile archives are rejected without spending
 * memory on them. Rejections use the shared failure-record shape.
 */
import { inflateRawSync } from "node:zlib";

export const ZIP_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  ratioLimit: 200,
  ratioMinEntryBytes: 1024 * 1024,
});

const CORRUPT_MESSAGE = "文件已损坏或内容不完整，无法解析；请重新导出后上传";
const LIMIT_MESSAGE = "文件内部结构超出安全限制（条目过多或解压后体积过大），已拒收";

/** A rejection with a stable machine code and a user-facing Chinese message. */
export class MaterialRejection extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @param {string} [message] */
export function corruptZip(message = CORRUPT_MESSAGE) {
  return new MaterialRejection("corrupt", message);
}

/**
 * @typedef {{name: string, compressedSize: number, uncompressedSize: number,
 *   method: number, offset: number}} ZipEntry
 */

/** @param {Uint8Array} bytes @param {number} offset */
function u32(bytes, offset) {
  const b = (/** @type {number} */ i) => bytes[i] ?? 0;
  return (b(offset) | (b(offset + 1) << 8) | (b(offset + 2) << 16) | (b(offset + 3) * 0x1000000)) >>> 0;
}

/** @param {Uint8Array} bytes @param {number} offset */
function u16(bytes, offset) {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

/** Locate the End of Central Directory record. @param {Uint8Array} bytes */
function findEocd(bytes) {
  // EOCD is at least 22 bytes; a comment of up to 64 KiB may precede it.
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      return i;
    }
  }
  return -1;
}

/**
 * Read the central directory of an in-memory zip. Never inflates entry data.
 * Throws `corrupt` when the structure is unreadable and `archive-limit` when
 * the declared layout exceeds the safety limits (including zip64 markers).
 * @param {Uint8Array} bytes @param {Partial<typeof ZIP_LIMITS>} [limits]
 * @returns {ZipEntry[]}
 */
export function readCentralDirectory(bytes, limits = {}) {
  const policy = { ...ZIP_LIMITS, ...limits };
  const eocd = findEocd(bytes);
  if (eocd < 0) throw corruptZip();
  const entriesDeclared = u16(bytes, eocd + 10);
  let cdOffset = u32(bytes, eocd + 16);
  const cdSize = u32(bytes, eocd + 12);
  const zip64Marker = entriesDeclared === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff;
  if (zip64Marker || (entriesDeclared > 0 && cdOffset + cdSize > bytes.length)) {
    // Zip64 archives from untrusted callers fall under the same structural
    // limit: nothing about them is inflated before this check.
    throw new MaterialRejection("archive-limit", LIMIT_MESSAGE);
  }
  if (entriesDeclared === 0) return [];
  if (cdOffset + 4 > bytes.length || u32(bytes, cdOffset) !== 0x02014b50) throw corruptZip();
  /** @type {ZipEntry[]} */
  const entries = [];
  let cursor = cdOffset;
  for (let index = 0; index < entriesDeclared; index += 1) {
    if (cursor + 46 > bytes.length || u32(bytes, cursor) !== 0x02014b50) throw corruptZip();
    const method = u16(bytes, cursor + 10);
    const compressedSize = u32(bytes, cursor + 20);
    const uncompressedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const offset = u32(bytes, cursor + 42);
    if (cursor + 46 + nameLength > bytes.length) throw corruptZip();
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.push({ name, compressedSize, uncompressedSize, method, offset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assertZipLimits(entries, policy);
  return entries;
}

/**
 * Enforce declared-size limits on central-directory metadata alone.
 * @param {ZipEntry[]} entries @param {Partial<typeof ZIP_LIMITS>} [limits]
 */
export function assertZipLimits(entries, limits = {}) {
  const policy = { ...ZIP_LIMITS, ...limits };
  if (entries.length > policy.maxEntries) throw new MaterialRejection("archive-limit", LIMIT_MESSAGE);
  let total = 0;
  for (const entry of entries) {
    if (entry.uncompressedSize > policy.maxEntryBytes) {
      throw new MaterialRejection("archive-limit", LIMIT_MESSAGE);
    }
    if (
      entry.uncompressedSize > policy.ratioMinEntryBytes &&
      (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > policy.ratioLimit)
    ) {
      throw new MaterialRejection("archive-limit", LIMIT_MESSAGE);
    }
    total += entry.uncompressedSize;
    if (total > policy.maxTotalBytes) throw new MaterialRejection("archive-limit", LIMIT_MESSAGE);
  }
}

/**
 * Inflate exactly one entry after the central directory has passed the guard.
 * Node's `inflateRawSync` accepts a `maxOutputLength` ceiling that stops the
 * inflate inside zlib — an entry whose central directory under-declares its
 * size fails with `ERR_BUFFER_TOO_LARGE` (mapped to `archive-limit`) without
 * materializing the expanded output first. The exact-length re-check against
 * the declared size still catches an over-declared entry afterward.
 * @param {Uint8Array} bytes @param {ZipEntry} entry
 * @returns {Uint8Array}
 */
export function readZipEntry(bytes, entry) {
  if (entry.method !== 0 && entry.method !== 8) throw corruptZip();
  if (entry.offset + 30 > bytes.length || u32(bytes, entry.offset) !== 0x04034b50) throw corruptZip();
  const nameLength = u16(bytes, entry.offset + 26);
  const extraLength = u16(bytes, entry.offset + 28);
  const dataStart = entry.offset + 30 + nameLength + extraLength;
  if (dataStart + entry.compressedSize > bytes.length) throw corruptZip();
  const payload = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) {
    if (payload.length !== entry.uncompressedSize) throw corruptZip();
    return payload;
  }
  // Inflate with a hard output ceiling one byte above the declared size so a
  // truthful entry fits exactly while a lying entry stops at the boundary.
  // `entry.uncompressedSize` was already bounded by maxEntryBytes in
  // `assertZipLimits`; clamp again here so direct callers stay safe.
  const cap = Math.min(entry.uncompressedSize, ZIP_LIMITS.maxEntryBytes) + 1;
  /** @type {Buffer} */
  let inflated;
  try {
    inflated = inflateRawSync(payload, { maxOutputLength: cap });
  } catch (error) {
    if (error instanceof RangeError && /** @type {NodeJS.ErrnoException} */ (error).code === "ERR_BUFFER_TOO_LARGE") {
      // The directory under-declared this entry: reject before expanding.
      throw new MaterialRejection("archive-limit", LIMIT_MESSAGE);
    }
    throw corruptZip();
  }
  if (inflated.length !== entry.uncompressedSize) throw corruptZip();
  return inflated;
}
