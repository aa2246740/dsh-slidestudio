/**
 * Synthetic legacy Office and WPS files for the CFB precheck: the few records
 * of the Word FIB, the Excel BIFF8 workbook globals and the PowerPoint record
 * stream that decide encryption, macros and vendor, wrapped by the test-only
 * CFB writer. Nothing here is taken from a real document except the public
 * WPS secure-document notice sentences. Every build is byte-identical on every
 * run.
 */
import { buildCfb } from "./cfb-writer.mjs";

/** @typedef {import("./cfb-writer.mjs").CfbItem} CfbItem */
/**
 * @typedef {{
 *   ok: boolean, family: "doc"|"xls"|"ppt"|null, vendor: "ms"|"wps",
 *   encrypted: boolean, macro: boolean, wpsSecure: boolean,
 * }} LegacyExpectation
 * @typedef {{build: () => Buffer, expect: LegacyExpectation, declares: string}} LegacyFixture
 */

/** @param {number} length @param {number} seed deterministic filler bytes */
export function seededBytes(length, seed) {
  let state = seed >>> 0;
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    bytes[i] = (t ^ (t >>> 14)) & 0xff;
  }
  return bytes;
}

const SUMMARY = "\u0005SummaryInformation";
/** The notice WPS writes into a secure document as its only readable text, per script. */
const WPS_DECOY = {
  simplified:
    "此文件仅WPS能打开，操作当前文件会造成文件损坏 此文件为私密文档，请使用WPS Office打开",
  traditional:
    "此檔案僅WPS可開啟，對當前檔案執行作業會令其損壞 此檔案為私密檔案，請使用WPS Office開啟",
};

/** @param {number} size @param {Buffer} body padded with zeros to at least `size` */
const padded = (size, body) =>
  body.length >= size ? body : Buffer.concat([body, Buffer.alloc(size - body.length)]);

/**
 * The Word 97+ FIB base: wIdent, nFib and the flag word whose bit 8 is fEncrypted.
 * @param {{encrypted: boolean, decoy: false|keyof typeof WPS_DECOY, size: number}} options
 */
function wordDocumentStream({ encrypted, decoy, size }) {
  const fib = Buffer.alloc(512);
  fib.writeUInt16LE(0xa5ec, 0);
  fib.writeUInt16LE(0x00c1, 2);
  fib.writeUInt16LE(0x0804, 6);
  fib.writeUInt16LE(0x0200 | (encrypted ? 0x0100 : 0), 10);
  fib.writeUInt16LE(0x00bf, 12);
  if (encrypted) fib.writeUInt32LE(0x28, 14);
  const text = Buffer.from(decoy ? WPS_DECOY[decoy] : "synthetic body text", "utf16le");
  return padded(size, Buffer.concat([fib, text]));
}

/** @param {number} id @param {Uint8Array} [data] */
function biffRecord(id, data = new Uint8Array(0)) {
  const record = Buffer.alloc(4 + data.length);
  record.writeUInt16LE(id, 0);
  record.writeUInt16LE(data.length, 2);
  record.set(data, 4);
  return record;
}

/** BOUNDSHEET8 `dt` values: worksheet, XLM macro sheet, chart sheet, VBA module. */
export const SHEET_TYPE = { worksheet: 0, macro: 1, chart: 2, vba: 6 };
const SUBSTREAM_BOF = { 0: 0x0010, 1: 0x0040, 2: 0x0020, 6: 0x0006 };

/** @param {number} substream BOF `dt`: 5 for the workbook globals */
function biffBof(substream) {
  const data = Buffer.alloc(16);
  data.writeUInt16LE(0x0600, 0);
  data.writeUInt16LE(substream, 2);
  data.writeUInt16LE(0x0dbb, 4);
  data.writeUInt16LE(0x07cc, 6);
  data.writeUInt32LE(6, 12);
  return biffRecord(0x0809, data);
}

/**
 * BIFF8 workbook: globals with an optional FILEPASS, one BOUNDSHEET8 per sheet
 * and a small substream for each.
 * @param {{filepass: boolean, sheets: number[], size: number}} options
 */
function workbookStream({ filepass, sheets, size }) {
  /** @param {number[]} positions */
  const globals = (positions) =>
    Buffer.concat([
      biffBof(5),
      ...(filepass ? [biffRecord(0x002f, Buffer.from([0, 0, 0x34, 0x12, 0x78, 0x56]))] : []),
      biffRecord(0x0042, Buffer.from([0xb0, 0x04])),
      ...sheets.flatMap((type, i) => {
        const name = Buffer.from(`S${i + 1}`, "latin1");
        const data = Buffer.alloc(8 + name.length);
        data.writeUInt32LE(positions[i] ?? 0, 0);
        data[5] = type;
        data[6] = name.length;
        name.copy(data, 8);
        return [biffRecord(0x0085, data)];
      }),
      biffRecord(0x000a),
    ]);
  const substreams = sheets.map((type) =>
    Buffer.concat([
      biffBof(/** @type {Record<number, number>} */ (SUBSTREAM_BOF)[type] ?? 0x10),
      biffRecord(0x000a),
    ]),
  );
  const length = globals([]).length;
  let position = length;
  const positions = substreams.map((sub) => {
    const here = position;
    position += sub.length;
    return here;
  });
  return padded(size, Buffer.concat([globals(positions), ...substreams]));
}

/** @param {number} verInst @param {number} type @param {number} length */
function pptHeader(verInst, type, length) {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(verInst, 0);
  header.writeUInt16LE(type, 2);
  header.writeUInt32LE(length, 4);
  return header;
}

const PPT_TOKEN = { plain: 0xe391c05f, encrypted: 0xf3d1c4df };

/** @param {number} persistId @param {number} offset a PersistDirectoryAtom with one entry */
function persistDirectory(persistId, offset) {
  const entry = Buffer.alloc(8);
  entry.writeUInt32LE(((1 << 20) | persistId) >>> 0, 0);
  entry.writeUInt32LE(offset, 4);
  return Buffer.concat([pptHeader(0, 0x1772, 8), entry]);
}

/**
 * A UserEditAtom: 0x1C bytes of data, or 0x20 with encryptSessionPersistIdRef.
 * @param {{length: number, lastEdit: number, persistOffset: number, seed: number}} fields
 */
function userEditAtom({ length, lastEdit, persistOffset, seed }) {
  const atom = Buffer.alloc(8 + length);
  pptHeader(0, 0x0ff5, length).copy(atom, 0);
  atom.writeUInt32LE(0x100, 8);
  atom.writeUInt16LE(0x03f4, 12);
  atom[15] = 3;
  atom.writeUInt32LE(lastEdit, 16);
  atom.writeUInt32LE(persistOffset, 20);
  atom.writeUInt32LE(1, 24);
  atom.writeUInt32LE(seed, 28);
  if (length >= 0x20) atom.writeUInt32LE(3, 8 + 0x1c);
  return atom;
}

/**
 * PowerPoint 97+ streams: a DocumentContainer (with a VbaInfo container when
 * asked), a PersistDirectoryAtom and the UserEditAtom the Current User stream
 * points at. The VbaInfo container sits inside the document's
 * DocInfoListContainer (RT_List 0x07D0) — the nesting MS-PPT §2.4.4 defines
 * (DocumentContainer → DocInfoListContainer → VBAInfoContainer → VBAInfoAtom);
 * `vbaPlacement: "document"` keeps the old direct child for the reader's
 * defensive path. `incremental` adds a second edit session whose persist
 * directory does not list the document, so the reader has to follow
 * offsetLastEdit. `scramble` overwrites everything before the persist
 * directory, the way a stream cipher leaves the edit records readable.
 * @param {{
 *   userEditLength: number, vba: "none"|"empty"|"macros", token: keyof typeof PPT_TOKEN,
 *   scramble: boolean, size: number, incremental: boolean,
 *   vbaPlacement?: "docInfoList"|"document",
 * }} options
 * @returns {{document: Buffer, currentUser: Buffer}}
 */
function powerPointStreams({
  userEditLength,
  vba,
  token,
  scramble,
  size,
  incremental,
  vbaPlacement = "docInfoList",
}) {
  const vbaInfo =
    vba === "none"
      ? Buffer.alloc(0)
      : Buffer.concat([
          pptHeader(0xf, 0x03ff, 8 + 12),
          pptHeader(0x2, 0x0400, 12),
          Buffer.from([1, 0, 0, 0, vba === "macros" ? 1 : 0, 0, 0, 0, 2, 0, 0, 0]),
        ]);
  const vbaRecord =
    vbaInfo.length === 0
      ? Buffer.alloc(0)
      : vbaPlacement === "document"
        ? vbaInfo
        : Buffer.concat([pptHeader(0x0, 0x07d0, vbaInfo.length), vbaInfo]);
  const body = Buffer.concat([pptHeader(0x1, 0x03e9, 0x28), Buffer.alloc(0x28), vbaRecord]);
  const document = Buffer.concat([pptHeader(0xf, 0x03e8, body.length), body]);
  const firstEditLength = incremental ? 0x1c : userEditLength;
  const tailLength = 16 + 8 + firstEditLength + (incremental ? 16 + 8 + userEditLength : 0);
  const slackLength = Math.max(0, size - document.length - tailLength - 8);
  const slack = Buffer.concat([pptHeader(0xf, 0x03ee, slackLength), Buffer.alloc(slackLength)]);
  const persistOffset = document.length + slack.length;
  const firstPersist = persistDirectory(1, 0);
  const firstEditOffset = persistOffset + firstPersist.length;
  const firstEdit = userEditAtom({
    length: firstEditLength,
    lastEdit: 0,
    persistOffset,
    seed: 2,
  });
  const tail = [firstPersist, firstEdit];
  let editOffset = firstEditOffset;
  if (incremental) {
    const secondPersistOffset = firstEditOffset + firstEdit.length;
    const secondPersist = persistDirectory(2, 0);
    editOffset = secondPersistOffset + secondPersist.length;
    const secondEdit = userEditAtom({
      length: userEditLength,
      lastEdit: firstEditOffset,
      persistOffset: secondPersistOffset,
      seed: 3,
    });
    tail.push(secondPersist, secondEdit);
  }
  const stream = Buffer.concat([document, slack, ...tail]);
  if (scramble) seededBytes(persistOffset, 0x5ec).copy(stream, 0);
  const currentUser = Buffer.alloc(8 + 0x18);
  pptHeader(0, 0x0ff6, 0x18).copy(currentUser, 0);
  currentUser.writeUInt32LE(0x14, 8);
  currentUser.writeUInt32LE(PPT_TOKEN[token], 12);
  currentUser.writeUInt32LE(editOffset, 16);
  currentUser.writeUInt16LE(0x03f4, 22);
  currentUser[24] = 3;
  currentUser.writeUInt32LE(8, 28);
  return { document: stream, currentUser };
}

/**
 * @typedef {{
 *   encrypted?: boolean, decoy?: false|keyof typeof WPS_DECOY, size?: number,
 *   macros?: boolean, wpsMarker?: boolean,
 * }} WordOptions
 * @param {WordOptions} [options] @returns {CfbItem[]}
 */
export function wordItems({
  encrypted = false,
  decoy = false,
  size = 1024,
  macros = false,
  wpsMarker = false,
} = {}) {
  return [
    { path: "WordDocument", data: wordDocumentStream({ encrypted, decoy, size }) },
    { path: "1Table", data: seededBytes(256, 11) },
    { path: SUMMARY, data: seededBytes(96, 12) },
    ...(macros
      ? [
          { path: "Macros" },
          { path: "Macros/VBA" },
          { path: "Macros/VBA/_VBA_PROJECT", data: seededBytes(64, 13) },
        ]
      : []),
    ...(wpsMarker
      ? [{ path: "WpsCustomData", data: Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }]
      : []),
  ];
}

/**
 * @typedef {{
 *   filepass?: boolean, sheets?: number[], size?: number,
 *   vbaStorage?: boolean, wpsMarker?: boolean, book?: boolean,
 * }} ExcelOptions
 * @param {ExcelOptions} [options] @returns {CfbItem[]}
 */
export function excelItems({
  filepass = false,
  sheets = [SHEET_TYPE.worksheet],
  size = 512,
  vbaStorage = false,
  wpsMarker = false,
  book = false,
} = {}) {
  return [
    { path: book ? "Book" : "Workbook", data: workbookStream({ filepass, sheets, size }) },
    { path: SUMMARY, data: seededBytes(96, 21) },
    ...(vbaStorage
      ? [
          { path: "_VBA_PROJECT_CUR" },
          { path: "_VBA_PROJECT_CUR/VBA" },
          { path: "_VBA_PROJECT_CUR/VBA/_VBA_PROJECT", data: seededBytes(64, 22) },
        ]
      : []),
    ...(wpsMarker ? [{ path: "ETExtData", data: seededBytes(202, 23) }] : []),
  ];
}

/**
 * @typedef {{
 *   userEditLength?: number, vba?: "none"|"empty"|"macros", token?: keyof typeof PPT_TOKEN,
 *   scramble?: boolean, size?: number, incremental?: boolean,
 *   vbaPlacement?: "docInfoList"|"document",
 * }} PowerPointOptions
 * @param {PowerPointOptions} [options] @returns {CfbItem[]}
 */
export function pptItems({
  userEditLength = 0x1c,
  vba = "none",
  token = "plain",
  scramble = false,
  size = 512,
  incremental = false,
  vbaPlacement = "docInfoList",
} = {}) {
  const { document, currentUser } = powerPointStreams({
    userEditLength,
    vba,
    token,
    scramble,
    size,
    incremental,
    vbaPlacement,
  });
  return [
    { path: "PowerPoint Document", data: document },
    { path: "Current User", data: currentUser },
    { path: SUMMARY, data: seededBytes(96, 31) },
  ];
}

/** @param {CfbItem[]} items @param {3|4} [majorVersion] */
export const container = (items, majorVersion = 3) => buildCfb({ items, majorVersion }).bytes;

/** @type {LegacyExpectation} */
const PLAIN = {
  ok: true,
  family: null,
  vendor: "ms",
  encrypted: false,
  macro: false,
  wpsSecure: false,
};
/** @param {Partial<LegacyExpectation>} change @returns {LegacyExpectation} */
const expects = (change) => ({ ...PLAIN, ...change });

/** The on-disk synthetic legacy set: file name → bytes and the property it declares. @type {Record<string, LegacyFixture>} */
export const LEGACY_FIXTURES = {
  "legacy-plain.doc": {
    build: () => container(wordItems()),
    expect: expects({ family: "doc" }),
    declares: "Word FIB flags 0x0200, fEncrypted clear; no Macros storage",
  },
  "legacy-plain.xls": {
    build: () => container(excelItems()),
    expect: expects({ family: "xls" }),
    declares: "BIFF8 workbook globals without FILEPASS, one worksheet BOUNDSHEET",
  },
  "legacy-plain.ppt": {
    build: () => container(pptItems()),
    expect: expects({ family: "ppt" }),
    declares: "UserEditAtom recLen 0x1C, VbaInfo absent",
  },
  "legacy-encrypted.doc": {
    build: () => container(wordItems({ encrypted: true })),
    expect: expects({ family: "doc", encrypted: true }),
    declares: "Word FIB fEncrypted (flag bit 0x0100) set",
  },
  "legacy-filepass.xls": {
    build: () => container(excelItems({ filepass: true })),
    expect: expects({ family: "xls", encrypted: true }),
    declares: "FILEPASS (0x002F) record in the workbook globals",
  },
  "legacy-encrypted.ppt": {
    build: () => container(pptItems({ userEditLength: 0x20 })),
    expect: expects({ family: "ppt", encrypted: true }),
    declares: "UserEditAtom recLen 0x20 (encryptSessionPersistIdRef present)",
  },
  "legacy-macro.doc": {
    build: () => container(wordItems({ macros: true })),
    expect: expects({ family: "doc", macro: true }),
    declares: "storage Macros with a VBA storage and _VBA_PROJECT stream",
  },
  "legacy-vba.xls": {
    build: () => container(excelItems({ vbaStorage: true })),
    expect: expects({ family: "xls", macro: true }),
    declares: "storage _VBA_PROJECT_CUR with a VBA storage",
  },
  "legacy-xlm.xls": {
    build: () => container(excelItems({ sheets: [SHEET_TYPE.worksheet, SHEET_TYPE.macro] })),
    expect: expects({ family: "xls", macro: true }),
    declares: "BOUNDSHEET8 with dt 1 (XLM macro sheet)",
  },
  "legacy-macro.ppt": {
    build: () => container(pptItems({ vba: "macros" })),
    expect: expects({ family: "ppt", macro: true }),
    declares:
      "DocumentContainer → DocInfoListContainer (RT_List 0x07D0) → VbaInfoAtom (0x0400), fHasMacros = 1",
  },
  "legacy-truncated.ppt": {
    build: () => {
      const whole = container(pptItems({ size: 16384 }));
      return whole.subarray(0, whole.length - 6144);
    },
    expect: expects({ ok: false }),
    declares: "a 16 KiB PowerPoint Document stream whose last sectors are missing",
  },
  "legacy.wps": {
    build: () => container(wordItems({ wpsMarker: true })),
    expect: expects({ family: "doc", vendor: "wps" }),
    declares: "Word streams plus the WPS private stream WpsCustomData",
  },
  "legacy.et": {
    build: () => container(excelItems({ wpsMarker: true })),
    expect: expects({ family: "xls", vendor: "wps" }),
    declares: "Workbook plus the WPS private stream ETExtData",
  },
  "legacy.dps": {
    build: () => container(pptItems()),
    expect: expects({ family: "ppt", vendor: "wps" }),
    declares: "PowerPoint streams with no private stream: WPS by the .dps extension only",
  },
  "wps-secure.doc": {
    build: () => container(wordItems({ wpsMarker: true, decoy: "simplified" })),
    expect: expects({ family: "doc", vendor: "wps", encrypted: true, wpsSecure: true }),
    declares: "WpsCustomData plus the WPS secure-document placeholder text; FIB fEncrypted clear",
  },
  "wps-secure.xls": {
    build: () => container(excelItems({ wpsMarker: true, filepass: true })),
    expect: expects({ family: "xls", vendor: "wps", encrypted: true, wpsSecure: true }),
    declares: "ETExtData plus a FILEPASS record",
  },
  "wps-secure.dps": {
    build: () => container(pptItems({ userEditLength: 0x20, scramble: true, size: 4608 })),
    expect: expects({ family: "ppt", vendor: "wps", encrypted: true, wpsSecure: true }),
    declares:
      "UserEditAtom recLen 0x20 after a scrambled PowerPoint Document stream; .dps extension",
  },
};

/** The file extension decides the family of a name; WPS uses its own three. */
const NAME_FAMILY = { doc: "doc", wps: "doc", xls: "xls", et: "xls", ppt: "ppt", dps: "ppt" };
const FORMAT_LABEL = {
  doc: { ms: "Word", wps: "WPS Writer" },
  xls: { ms: "Excel", wps: "WPS Spreadsheets" },
  ppt: { ms: "PowerPoint", wps: "WPS Presentation" },
};

/**
 * The fixtures the sample generator writes to disk, with the manifest properties
 * each carries. The three plain files already exist there as legacy.doc/.xls/.ppt,
 * so they are left out. `format` keeps the "OLE2 legacy" wording that marks a
 * sample as intentionally not decodable.
 * @returns {{name: string, buffer: Buffer, properties: {format: string, legacy: {declares: string, expect: LegacyExpectation}}}[]}
 */
export function legacyDiskSamples() {
  return Object.entries(LEGACY_FIXTURES)
    .filter(([name]) => !name.startsWith("legacy-plain."))
    .map(([name, fixture]) => {
      const family = /** @type {"doc"|"xls"|"ppt"} */ (
        /** @type {Record<string, string>} */ (NAME_FAMILY)[name.split(".").pop() ?? ""]
      );
      const label = FORMAT_LABEL[family][fixture.expect.vendor];
      return {
        name,
        buffer: fixture.build(),
        properties: {
          format: `OLE2 legacy ${label}`,
          legacy: { declares: fixture.declares, expect: fixture.expect },
        },
      };
    });
}
