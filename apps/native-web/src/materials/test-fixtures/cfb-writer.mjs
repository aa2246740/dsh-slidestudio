/**
 * Test-only writer for Compound File Binary containers (MS-CFB): the OLE2
 * files legacy .doc/.xls/.ppt and the WPS formats are stored in. It lays out
 * the header, DIFAT, FAT, directory (red-black sibling trees), MiniFAT and mini
 * stream the way Office does, so the reader is exercised on real structure.
 * Never imported by production code.
 */

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const NOSTREAM = 0xffffffff;
const MINI_SECTOR = 64;
const MINI_CUTOFF = 4096;
const ENTRY_SIZE = 128;
const HEADER_DIFAT = 109;

/**
 * @typedef {{path: string, data?: Uint8Array}} CfbItem a stream, or a storage
 *   when `data` is absent; "A/B" puts B inside the storage A
 * @typedef {{
 *   sectorSize: number,
 *   fatSectors: number[],
 *   difatSectors: number[],
 *   directorySectors: number[],
 *   miniFatSectors: number[],
 *   miniStreamSectors: number[],
 *   entryIds: Record<string, number>,
 *   streams: Record<string, {start: number, size: number, mini: boolean}>,
 * }} CfbLayout where everything went, so a test can damage exactly one structure
 * @typedef {{
 *   name: string, type: 1|2|5, data: Uint8Array, children: Map<string, CfbNode>,
 *   id: number, left: number, right: number, child: number, color: 0|1,
 *   start: number, size: number, mini: boolean,
 * }} CfbNode
 */

/** @param {string} name @param {1|2|5} type @returns {CfbNode} */
function makeNode(name, type) {
  return {
    name,
    type,
    data: new Uint8Array(0),
    children: new Map(),
    id: 0,
    left: NOSTREAM,
    right: NOSTREAM,
    child: NOSTREAM,
    color: 1,
    start: ENDOFCHAIN,
    size: 0,
    mini: false,
  };
}

/** @param {CfbItem[]} items */
function buildTree(items) {
  const root = makeNode("Root Entry", 5);
  for (const { path, data } of items) {
    const parts = path.split("/");
    let node = root;
    parts.forEach((part, index) => {
      if (!part || part.length > 31) throw new Error(`CFB name out of range: "${part}"`);
      const last = index === parts.length - 1;
      let next = node.children.get(part);
      if (!next) {
        next = makeNode(part, last && data ? 2 : 1);
        node.children.set(part, next);
      } else if (last) {
        throw new Error(`CFB entry written twice: ${path}`);
      }
      node = next;
    });
    if (data) node.data = data;
  }
  return root;
}

/** CFB compares names by length first, then by upper-cased UTF-16 code units. @param {CfbNode} a @param {CfbNode} b */
function compareNames(a, b) {
  if (a.name.length !== b.name.length) return a.name.length - b.name.length;
  const [upperA, upperB] = [a.name.toUpperCase(), b.name.toUpperCase()];
  return upperA < upperB ? -1 : upperA > upperB ? 1 : 0;
}

/**
 * Links siblings into one balanced tree. Nodes on the last, incomplete level
 * are red, the rest black, which keeps every path equally black.
 * @param {CfbNode[]} sorted
 * @returns {number} directory id of the tree's root
 */
function linkSiblings(sorted) {
  const levels = Math.floor(Math.log2(sorted.length)) + 1;
  const perfect = sorted.length === 2 ** levels - 1;
  /** @param {number} low @param {number} high @param {number} depth @returns {number} */
  const build = (low, high, depth) => {
    if (low > high) return NOSTREAM;
    const mid = (low + high) >> 1;
    const node = /** @type {CfbNode} */ (sorted[mid]);
    node.color = !perfect && depth === levels - 1 ? 0 : 1;
    node.left = build(low, mid - 1, depth + 1);
    node.right = build(mid + 1, high, depth + 1);
    return node.id;
  };
  return build(0, sorted.length - 1, 0);
}

/** Numbers the entries (siblings contiguous, parents first) and links each storage's children. @param {CfbNode} root */
function numberEntries(root) {
  /** @type {CfbNode[]} */
  const ordered = [root];
  const queue = [root];
  while (queue.length) {
    const storage = /** @type {CfbNode} */ (queue.shift());
    const children = [...storage.children.values()].sort(compareNames);
    for (const child of children) {
      child.id = ordered.length;
      ordered.push(child);
      if (child.type === 1) queue.push(child);
    }
    if (children.length) storage.child = linkSiblings(children);
  }
  return ordered;
}

/** @param {Uint8Array} data @param {number} unit */
const unitsOf = (data, unit) => Math.ceil(data.length / unit);

/**
 * @param {Buffer} bytes
 * @param {{majorVersion: number, directoryCount: number, fatCount: number, miniFatCount: number,
 *   difatCount: number, fatSectors: number[], difatSectors: number[], directorySectors: number[],
 *   miniFatSectors: number[]}} layout
 */
function writeHeader(bytes, layout) {
  const { majorVersion, fatSectors } = layout;
  Buffer.from(SIGNATURE).copy(bytes, 0);
  bytes.writeUInt16LE(0x3e, 24);
  bytes.writeUInt16LE(majorVersion, 26);
  bytes.writeUInt16LE(0xfffe, 28);
  bytes.writeUInt16LE(majorVersion === 4 ? 12 : 9, 30);
  bytes.writeUInt16LE(6, 32);
  bytes.writeUInt32LE(majorVersion === 4 ? layout.directoryCount : 0, 40);
  bytes.writeUInt32LE(layout.fatCount, 44);
  bytes.writeUInt32LE(layout.directorySectors[0] ?? ENDOFCHAIN, 48);
  bytes.writeUInt32LE(MINI_CUTOFF, 56);
  bytes.writeUInt32LE(layout.miniFatSectors[0] ?? ENDOFCHAIN, 60);
  bytes.writeUInt32LE(layout.miniFatCount, 64);
  bytes.writeUInt32LE(layout.difatSectors[0] ?? ENDOFCHAIN, 68);
  bytes.writeUInt32LE(layout.difatCount, 72);
  for (let i = 0; i < HEADER_DIFAT; i += 1) {
    bytes.writeUInt32LE(fatSectors[i] ?? FREESECT, 76 + i * 4);
  }
}

/**
 * @param {{items: CfbItem[], majorVersion?: 3|4}} spec
 * @returns {{bytes: Buffer, layout: CfbLayout}}
 */
export function buildCfb({ items, majorVersion = 3 }) {
  const sectorSize = majorVersion === 4 ? 4096 : 512;
  const perSector = sectorSize / 4;
  const root = buildTree(items);
  const nodes = numberEntries(root);
  const streams = nodes.filter((node) => node.type === 2 && node.data.length > 0);
  const small = streams.filter((node) => node.data.length < MINI_CUTOFF);
  const big = streams.filter((node) => node.data.length >= MINI_CUTOFF);

  /** @type {number[]} */
  const miniFat = [];
  const miniChunks = small.map((node) => {
    const count = unitsOf(node.data, MINI_SECTOR);
    node.start = miniFat.length;
    node.mini = true;
    for (let i = 0; i < count; i += 1)
      miniFat.push(i === count - 1 ? ENDOFCHAIN : node.start + i + 1);
    const padded = Buffer.alloc(count * MINI_SECTOR);
    padded.set(node.data);
    return padded;
  });
  const miniStream = Buffer.concat(miniChunks);

  const directoryCount = unitsOf(new Uint8Array(nodes.length * ENTRY_SIZE), sectorSize);
  const miniFatCount = Math.ceil((miniFat.length * 4) / sectorSize);
  const miniStreamCount = unitsOf(miniStream, sectorSize);
  const bigCounts = big.map((node) => unitsOf(node.data, sectorSize));
  /** @type {Map<CfbNode, number[]>} */
  const bigSectors = new Map();
  const others =
    directoryCount + miniFatCount + miniStreamCount + bigCounts.reduce((sum, n) => sum + n, 0);
  /** @param {number} fats */
  const difatFor = (fats) =>
    fats > HEADER_DIFAT ? Math.ceil((fats - HEADER_DIFAT) / (perSector - 1)) : 0;
  let fatCount = 1;
  while (fatCount * perSector < others + fatCount + difatFor(fatCount)) fatCount += 1;
  const difatCount = difatFor(fatCount);
  const total = others + fatCount + difatCount;
  let cursor = 0;
  /** @param {number} count */
  const take = (count) => Array.from({ length: count }, () => cursor++);
  const fatSectors = take(fatCount);
  const difatSectors = take(difatCount);
  const directorySectors = take(directoryCount);
  const miniFatSectors = take(miniFatCount);
  const miniStreamSectors = take(miniStreamCount);
  big.forEach((node, i) => {
    const sectors = take(/** @type {number} */ (bigCounts[i]));
    node.start = /** @type {number} */ (sectors[0]);
    node.mini = false;
    bigSectors.set(node, sectors);
  });
  root.start = miniStreamSectors[0] ?? ENDOFCHAIN;
  root.size = miniStream.length;
  for (const node of streams) node.size = node.data.length;

  const fat = new Uint32Array(fatCount * perSector).fill(FREESECT);
  /** @param {number[]} sectors */
  const chain = (sectors) => sectors.forEach((id, i) => (fat[id] = sectors[i + 1] ?? ENDOFCHAIN));
  for (const id of fatSectors) fat[id] = FATSECT;
  for (const id of difatSectors) fat[id] = DIFSECT;
  chain(directorySectors);
  chain(miniFatSectors);
  chain(miniStreamSectors);
  for (const sectors of bigSectors.values()) chain(sectors);

  const bytes = Buffer.alloc((total + 1) * sectorSize);
  /** @param {number} id */
  const at = (id) => (id + 1) * sectorSize;
  writeHeader(bytes, {
    majorVersion,
    directoryCount,
    fatCount,
    miniFatCount,
    difatCount,
    fatSectors,
    difatSectors,
    directorySectors,
    miniFatSectors,
  });
  difatSectors.forEach((id, k) => {
    const first = HEADER_DIFAT + k * (perSector - 1);
    for (let i = 0; i < perSector - 1; i += 1) {
      bytes.writeUInt32LE(fatSectors[first + i] ?? FREESECT, at(id) + i * 4);
    }
    bytes.writeUInt32LE(difatSectors[k + 1] ?? ENDOFCHAIN, at(id) + (perSector - 1) * 4);
  });
  fatSectors.forEach((id, k) => {
    for (let i = 0; i < perSector; i += 1) {
      bytes.writeUInt32LE(fat[k * perSector + i] ?? FREESECT, at(id) + i * 4);
    }
  });
  miniFat.forEach((value, i) => {
    const sector = /** @type {number} */ (miniFatSectors[Math.floor((i * 4) / sectorSize)]);
    bytes.writeUInt32LE(value, at(sector) + ((i * 4) % sectorSize));
  });
  miniFatSectors.forEach((id, k) => {
    const written = Math.min(perSector, Math.max(0, miniFat.length - k * perSector));
    for (let i = written; i < perSector; i += 1) bytes.writeUInt32LE(FREESECT, at(id) + i * 4);
  });
  miniStreamSectors.forEach((id, k) => {
    miniStream.copy(bytes, at(id), k * sectorSize, (k + 1) * sectorSize);
  });
  for (const [node, sectors] of bigSectors) {
    sectors.forEach((id, k) => {
      Buffer.from(node.data.subarray(k * sectorSize, (k + 1) * sectorSize)).copy(bytes, at(id));
    });
  }

  const directoryBase = at(/** @type {number} */ (directorySectors[0]));
  const slots = directoryCount * (sectorSize / ENTRY_SIZE);
  for (let i = 0; i < slots; i += 1) {
    const base = directoryBase + i * ENTRY_SIZE;
    const node = nodes[i];
    if (!node) {
      bytes.writeUInt32LE(NOSTREAM, base + 68);
      bytes.writeUInt32LE(NOSTREAM, base + 72);
      bytes.writeUInt32LE(NOSTREAM, base + 76);
      continue;
    }
    Buffer.from(`${node.name}\0`, "utf16le").copy(bytes, base);
    bytes.writeUInt16LE((node.name.length + 1) * 2, base + 64);
    bytes.writeUInt8(node.type, base + 66);
    bytes.writeUInt8(node.color, base + 67);
    bytes.writeUInt32LE(node.left, base + 68);
    bytes.writeUInt32LE(node.right, base + 72);
    bytes.writeUInt32LE(node.child, base + 76);
    bytes.writeUInt32LE(node.start, base + 116);
    bytes.writeUInt32LE(node.size, base + 120);
  }

  /** @type {Record<string, number>} */
  const entryIds = {};
  /** @type {Record<string, {start: number, size: number, mini: boolean}>} */
  const layoutStreams = {};
  for (const { path } of items) {
    let node = root;
    for (const part of path.split("/")) node = /** @type {CfbNode} */ (node.children.get(part));
    entryIds[path] = node.id;
    if (node.type === 2)
      layoutStreams[path] = { start: node.start, size: node.size, mini: node.mini };
  }
  return {
    bytes,
    layout: {
      sectorSize,
      fatSectors,
      difatSectors,
      directorySectors,
      miniFatSectors,
      miniStreamSectors,
      entryIds,
      streams: layoutStreams,
    },
  };
}
