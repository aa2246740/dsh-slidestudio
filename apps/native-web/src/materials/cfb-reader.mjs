/**
 * Bounds-checked reader for Compound File Binary (MS-CFB) containers.
 *
 * The input is untrusted. Every sector id, chain, size and offset is checked
 * against the file; chain walks are loop-guarded and share one step budget;
 * the directory is capped at 4096 entries; a stream can never be larger than
 * the file. Any damage ends in a CfbError. Nothing here runs unbounded.
 */

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENDOFCHAIN = 0xfffffffe;
const NOSTREAM = 0xffffffff;
const HEADER_DIFAT = 109;
const ENTRY_SIZE = 128;
const MINI_SECTOR = 64;
const MINI_CUTOFF = 4096;
const MAX_ENTRIES = 4096;
const MAX_SECTORS = 1 << 18;

export class CfbError extends Error {
  /** @param {string} code @param {string} [detail] */
  constructor(code, detail = code) {
    super(detail);
    this.name = "CfbError";
    this.code = code;
  }
}

/** @param {string} code @param {string} [detail] @returns {never} */
function fail(code, detail) {
  throw new CfbError(code, detail);
}

/**
 * @typedef {{name: string, path: string, type: "storage"|"stream", start: number, size: number}} CfbEntry
 * @typedef {{size: number, read: (offset: number, length: number) => Buffer}} CfbStream
 * @typedef {{
 *   entries: CfbEntry[],
 *   has: (path: string) => boolean,
 *   stream: (path: string) => CfbStream | undefined,
 * }} Cfb
 * @typedef {{name: string, type: number, left: number, right: number, child: number,
 *   start: number, size: number}} RawEntry
 */

/** Copies a sector's little-endian u32 words into `target` from index `at`. @param {Uint8Array} sector @param {Uint32Array} target @param {number} at */
function readWords(sector, target, at) {
  const words = new DataView(sector.buffer, sector.byteOffset, sector.byteLength);
  for (let i = 0; i < sector.byteLength / 4; i += 1) target[at + i] = words.getUint32(i * 4, true);
}

/**
 * A stream over sector-sized pieces.
 * @param {number} size
 * @param {number} unit bytes per sector of this stream's allocation table
 * @param {number[]} ids the stream's sectors in order
 * @param {(id: number, from: number, to: number) => Uint8Array} piece
 * @returns {CfbStream}
 */
function makeStream(size, unit, ids, piece) {
  return {
    size,
    read(offset, length) {
      const inside = Number.isInteger(offset) && Number.isInteger(length) && offset >= 0 && length >= 0;
      if (!inside || offset + length > size) fail("bad-stream");
      const out = Buffer.alloc(length);
      for (let written = 0; written < length;) {
        const position = offset + written;
        const from = position % unit;
        const take = Math.min(unit - from, length - written);
        const id = ids[Math.floor(position / unit)] ?? fail("bad-chain");
        out.set(piece(id, from, from + take), written);
        written += take;
      }
      return out;
    },
  };
}

class CfbReader {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    if (bytes.length < 512 || !SIGNATURE.every((byte, i) => bytes[i] === byte)) fail("not-cfb");
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.major = this.u16(26);
    const shift = this.u16(30);
    const knownLayout = (this.major === 3 && shift === 9) || (this.major === 4 && shift === 12);
    if (this.u16(28) !== 0xfffe || !knownLayout || this.u16(32) !== 6 || this.u32(56) !== MINI_CUTOFF) {
      fail("bad-header");
    }
    this.sectorSize = 1 << shift;
    this.perSector = this.sectorSize / 4;
    // A last sector shorter than a whole one is tolerated: some writers leave it so.
    this.sectorCount = Math.ceil(bytes.length / this.sectorSize) - 1;
    if (this.sectorCount > MAX_SECTORS) fail("too-large");
    this.budget = 4 * this.sectorCount + 1024;
    this.fat = this.readFat();
    /** @type {{table: Uint32Array, container: CfbStream} | undefined} */
    this.mini = undefined;
  }

  /** @param {number} offset */
  u16(offset) {
    return this.view.getUint16(offset, true);
  }

  /** @param {number} offset */
  u32(offset) {
    return this.view.getUint32(offset, true);
  }

  /** @param {number} id */
  startOf(id) {
    return (id + 1) * this.sectorSize;
  }

  /** @param {number} id */
  sectorAt(id) {
    if (id >= this.sectorCount) fail("bad-sector");
    return this.bytes.subarray(this.startOf(id), this.startOf(id) + this.sectorSize);
  }

  /** Structure sectors (FAT, DIFAT, MiniFAT, directory) must be complete. @param {number} id */
  wholeSector(id) {
    const sector = this.sectorAt(id);
    if (sector.length < this.sectorSize) fail("truncated");
    return sector;
  }

  /** FAT sector ids from the header DIFAT and the DIFAT chain. @param {number} fatCount */
  fatSectorIds(fatCount) {
    /** @type {number[]} */
    const fatIds = [];
    for (let i = 0; i < HEADER_DIFAT; i += 1) {
      const id = this.u32(76 + i * 4);
      if (id !== NOSTREAM) fatIds.push(id);
    }
    const difatCount = this.u32(72);
    if (difatCount > this.sectorCount) fail("bad-fat");
    let difatId = this.u32(68);
    const difatSeen = new Set();
    for (let k = 0; k < difatCount; k += 1) {
      if (difatSeen.has(difatId)) fail("bad-chain");
      difatSeen.add(difatId);
      const words = new Uint32Array(this.perSector);
      readWords(this.wholeSector(difatId), words, 0);
      for (let i = 0; i < this.perSector - 1; i += 1) {
        const id = /** @type {number} */ (words[i]);
        if (id !== NOSTREAM) fatIds.push(id);
      }
      difatId = /** @type {number} */ (words[this.perSector - 1]);
    }
    if (difatCount > 0 && difatId !== ENDOFCHAIN) fail("bad-chain");
    if (fatIds.length < fatCount) fail("bad-fat");
    return fatIds;
  }

  readFat() {
    const fatCount = this.u32(44);
    if (fatCount === 0 || fatCount > this.sectorCount) fail("bad-fat");
    const fat = new Uint32Array(fatCount * this.perSector);
    this.fatSectorIds(fatCount)
      .slice(0, fatCount)
      .forEach((id, k) => readWords(this.wholeSector(id), fat, k * this.perSector));
    return fat;
  }

  /**
   * Walks a chain to its end. A chain longer than the table has entries is a
   * loop; all walks together share one budget so shared chains cannot multiply the work.
   * @param {ArrayLike<number>} table @param {number} start
   */
  chain(table, start) {
    /** @type {number[]} */
    const ids = [];
    const limit = Math.min(table.length, table === this.fat ? this.sectorCount : table.length);
    let id = start;
    while (id !== ENDOFCHAIN) {
      if (id >= limit) fail("bad-sector");
      this.budget -= 1;
      if (ids.length >= limit || this.budget < 0) fail("bad-chain");
      ids.push(id);
      id = /** @type {number} */ (table[id]);
    }
    return ids;
  }

  /** @param {number[]} directory @param {number} id @returns {RawEntry} */
  readEntry(directory, id) {
    const perDirectorySector = this.sectorSize / ENTRY_SIZE;
    const sector = this.wholeSector(/** @type {number} */ (directory[Math.floor(id / perDirectorySector)]));
    const at = sector.byteOffset + (id % perDirectorySector) * ENTRY_SIZE;
    const entry = new DataView(sector.buffer, at, ENTRY_SIZE);
    const nameLength = entry.getUint16(64, true);
    if (nameLength < 2 || nameLength > 64 || nameLength % 2) fail("bad-directory");
    const name = Buffer.from(sector.buffer, at, nameLength - 2).toString("utf16le");
    if (name.includes("/")) fail("bad-directory");
    // Version 3 files must keep the high size dword zero but many writers do not.
    const high = this.major === 4 ? entry.getUint32(124, true) * 2 ** 32 : 0;
    return {
      name,
      type: entry.getUint8(66),
      left: entry.getUint32(68, true),
      right: entry.getUint32(72, true),
      child: entry.getUint32(76, true),
      start: entry.getUint32(116, true),
      size: entry.getUint32(120, true) + high,
    };
  }

  /** The root entry and every storage/stream below it, each visited once. */
  readDirectory() {
    const directory = this.chain(this.fat, this.u32(48));
    if (directory.length === 0) fail("bad-directory");
    const slots = directory.length * (this.sectorSize / ENTRY_SIZE);
    if (slots > MAX_ENTRIES) fail("too-many-entries");
    const root = this.readEntry(directory, 0);
    if (root.type !== 5) fail("bad-directory");
    /** @type {CfbEntry[]} */
    const entries = [];
    const visited = new Uint8Array(slots);
    visited[0] = 1;
    const pending = [{ id: root.child, parent: "" }];
    for (let next = pending.pop(); next; next = pending.pop()) {
      const { id, parent } = next;
      if (id === NOSTREAM) continue;
      if (id >= slots || visited[id]) fail("bad-directory");
      visited[id] = 1;
      const entry = this.readEntry(directory, id);
      if (entry.type !== 1 && entry.type !== 2) fail("bad-directory");
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      entries.push({
        name: entry.name,
        path,
        type: entry.type === 1 ? "storage" : "stream",
        start: entry.start,
        size: entry.size,
      });
      pending.push({ id: entry.left, parent }, { id: entry.right, parent });
      if (entry.type === 1) pending.push({ id: entry.child, parent: path });
    }
    return { root, entries };
  }

  /** @param {number} start @param {number} size */
  bigStream(start, size) {
    const ids = this.chain(this.fat, start);
    const need = Math.ceil(size / this.sectorSize);
    if (ids.length < need) fail("bad-chain");
    for (let i = 0; i < need; i += 1) {
      const have = this.bytes.length - this.startOf(/** @type {number} */ (ids[i]));
      if (have < (i === need - 1 ? size - i * this.sectorSize : this.sectorSize)) fail("truncated");
    }
    return makeStream(size, this.sectorSize, ids, (id, from, to) =>
      this.bytes.subarray(this.startOf(id) + from, this.startOf(id) + to),
    );
  }

  /** @param {RawEntry} root */
  miniParts(root) {
    if (this.mini) return this.mini;
    if (root.size > this.bytes.length) fail("bad-stream");
    const tableIds = this.chain(this.fat, this.u32(60));
    const table = new Uint32Array(tableIds.length * this.perSector);
    tableIds.forEach((id, k) => readWords(this.wholeSector(id), table, k * this.perSector));
    this.mini = { table, container: this.bigStream(root.start, root.size) };
    return this.mini;
  }

  /** @param {RawEntry} root @param {number} start @param {number} size */
  miniStream(root, start, size) {
    const { table, container } = this.miniParts(root);
    const ids = this.chain(table, start);
    const need = Math.ceil(size / MINI_SECTOR);
    if (ids.length < need) fail("bad-chain");
    for (let i = 0; i < need; i += 1) {
      const required = i === need - 1 ? size - i * MINI_SECTOR : MINI_SECTOR;
      if ((ids[i] ?? 0) * MINI_SECTOR + required > container.size) fail("bad-sector");
    }
    return makeStream(size, MINI_SECTOR, ids, (id, from, to) => container.read(id * MINI_SECTOR + from, to - from));
  }

  /** @param {RawEntry} root @param {CfbEntry} entry */
  openStream(root, entry) {
    if (entry.size > this.bytes.length) fail("bad-stream");
    if (entry.size === 0) return makeStream(0, 1, [], () => new Uint8Array(0));
    return entry.size < MINI_CUTOFF
      ? this.miniStream(root, entry.start, entry.size)
      : this.bigStream(entry.start, entry.size);
  }
}

/**
 * Opens a container: validates the header, DIFAT, FAT and directory. Stream
 * contents are read (and their chains validated) only when `stream()` asks.
 * @param {Uint8Array} bytes
 * @returns {Cfb}
 */
export function openCfb(bytes) {
  const reader = new CfbReader(bytes);
  const { root, entries } = reader.readDirectory();
  const byPath = new Map(entries.map((entry) => [entry.path.toLowerCase(), entry]));
  /** @type {Map<string, CfbStream>} */
  const opened = new Map();
  return {
    entries,
    has: (path) => byPath.has(path.toLowerCase()),
    stream(path) {
      const key = path.toLowerCase();
      const entry = byPath.get(key);
      if (!entry || entry.type !== "stream") return undefined;
      const known = opened.get(key);
      if (known) return known;
      const stream = reader.openStream(root, entry);
      opened.set(key, stream);
      return stream;
    },
  };
}
