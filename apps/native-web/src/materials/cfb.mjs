/**
 * Precheck that classifies legacy Office (.doc/.xls/.ppt) and WPS
 * (.wps/.et/.dps) Compound File Binary containers before any converter sees
 * them. The bounds-checked container reader lives in `cfb-reader.mjs`; any
 * damage ends in a CfbError, which `classifyLegacyOffice` turns into
 * `ok: false`. Nothing here throws on bad input or runs unbounded.
 */
import { CfbError, openCfb } from "./cfb-reader.mjs";

export { openCfb };

/** Bytes of the Excel globals substream read, and of a Word stream scanned for the WPS notice. */
const BIFF_WINDOW = 1 << 20;
const WORD_SCAN_LIMIT = 4 << 20;
const MAX_PPT_RECORDS = 4096;
const MAX_PPT_EDITS = 64;

/** @typedef {import("./cfb-reader.mjs").Cfb} Cfb */
/** @typedef {import("./cfb-reader.mjs").CfbStream} CfbStream */

/** @param {string} code @param {string} [detail] @returns {never} */
function fail(code, detail) {
  throw new CfbError(code, detail);
}

/**
 * @typedef {{
 *   ok: boolean, family: "doc"|"xls"|"ppt"|null, vendor: "ms"|"wps",
 *   encrypted: boolean, macro: boolean, wpsSecure: boolean, reason: string | null,
 * }} LegacyClassification
 */

/** WPS Writer, Spreadsheets and Presentation write these extensions; .doc/.xls/.ppt are the Microsoft ones. */
const WPS_EXTENSIONS = new Set([".wps", ".et", ".dps"]);
/** @type {Record<string, "doc"|"xls"|"ppt">} */
const WPS_FAMILY_BY_EXTENSION = { ".wps": "doc", ".et": "xls", ".dps": "ppt" };
const MACRO_NAMES = new Set(["macros", "_vba_project_cur", "vba", "_vba_project"]);
/** The sentences WPS writes into a secure document in place of its text, in both scripts. */
export const WPS_SECURE_NOTICES = ["此文件仅WPS能打开", "此文件为私密文档", "此檔案僅WPS可開啟", "此檔案為私密檔案"];
const WPS_NOTICES = WPS_SECURE_NOTICES.map((text) => Buffer.from(text, "utf16le"));

/** @param {Cfb} cfb @returns {"doc"|"xls"|"ppt"|null} same precedence as the legacy rejection in detect.mjs */
function familyOf(cfb) {
  if (cfb.has("WordDocument")) return "doc";
  if (cfb.has("Workbook") || cfb.has("Book")) return "xls";
  return cfb.has("PowerPoint Document") ? "ppt" : null;
}

/** @param {Cfb} cfb */
const hasWpsMarker = (cfb) => cfb.has("WpsCustomData") || cfb.has("ETExtData");

/**
 * Which vendor wrote an OLE file and which Office family it belongs to, from
 * the directory alone (no stream is read), for the rejection copy.
 * @param {Uint8Array} bytes @param {string} [extension] lower-case with the dot
 * @returns {{vendor: "ms"|"wps", family: "doc"|"xls"|"ppt"|null}}
 */
export function legacyVendorOf(bytes, extension = "") {
  /** @type {"doc"|"xls"|"ppt"|null} */
  let family = null;
  let marked = false;
  try {
    const cfb = openCfb(bytes);
    family = familyOf(cfb);
    marked = hasWpsMarker(cfb);
    if (!family && marked) family = cfb.has("WpsCustomData") ? "doc" : "xls";
  } catch {
    // An unreadable container still has a name that may say WPS.
  }
  const byExtension = WPS_EXTENSIONS.has(extension);
  return {
    vendor: marked || byExtension ? "wps" : "ms",
    family: family ?? (byExtension ? (WPS_FAMILY_BY_EXTENSION[extension] ?? null) : null),
  };
}

/** @param {Cfb} cfb @param {boolean} wpsMarked @returns {{encrypted: boolean, macro: boolean}} */
function inspectWord(cfb, wpsMarked) {
  const stream = cfb.stream("WordDocument");
  if (!stream || stream.size < 0x20) fail("bad-office");
  const fib = stream.read(0, 0x20);
  const ident = fib.readUInt16LE(0);
  if (ident !== 0xa5ec && ident !== 0xa5dc) fail("bad-office");
  // FIB base flag word at 0x0A: bit 8 is fEncrypted (the body is cipher text).
  let encrypted = (fib.readUInt16LE(10) & 0x0100) !== 0;
  if (!encrypted && wpsMarked) {
    const text = stream.read(0, Math.min(stream.size, WORD_SCAN_LIMIT));
    encrypted = WPS_NOTICES.some((notice) => text.includes(notice));
  }
  return { encrypted, macro: false };
}

/** @param {Cfb} cfb @returns {{encrypted: boolean, macro: boolean}} */
function inspectWorkbook(cfb) {
  const stream = cfb.stream(cfb.has("Workbook") ? "Workbook" : "Book");
  if (!stream) fail("bad-office");
  const head = stream.read(0, Math.min(stream.size, BIFF_WINDOW));
  const version = head.length >= 6 ? head.readUInt16LE(4) : 0;
  if (head.length < 12 || head.readUInt16LE(0) !== 0x0809 || (version !== 0x0500 && version !== 0x0600)) {
    fail("bad-office");
  }
  let encrypted = false;
  let macro = false;
  for (let at = 0; at + 4 <= head.length;) {
    const id = head.readUInt16LE(at);
    const next = at + 4 + head.readUInt16LE(at + 2);
    if (next > head.length) {
      if (head.length === stream.size) fail("bad-office");
      break;
    }
    if (id === 0x000a) break;
    if (id === 0x002f) {
      encrypted = true;
      break;
    }
    // BOUNDSHEET8 sheet type: 1 is an Excel 4.0 (XLM) macro sheet, 6 a VBA module.
    if (id === 0x0085 && next - at >= 10) macro ||= [1, 6].includes(head[at + 9] ?? 0);
    at = next;
  }
  return { encrypted, macro };
}

/** @param {CfbStream} stream @param {number} offset @param {number} length */
function slice(stream, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > stream.size) fail("bad-office");
  return stream.read(offset, length);
}

/** @param {CfbStream} stream @param {number} offset @returns {{version: number, type: number, length: number}} */
function recordAt(stream, offset) {
  const header = slice(stream, offset, 8);
  const length = header.readUInt32LE(4);
  if (offset + 8 + length > stream.size) fail("bad-office");
  return { version: header.readUInt16LE(0), type: header.readUInt16LE(2), length };
}

/** @param {CfbStream} stream @param {number} offset the UserEditAtom */
function userEditAt(stream, offset) {
  const { version, type, length } = recordAt(stream, offset);
  if (version !== 0 || type !== 0x0ff5 || (length !== 0x1c && length !== 0x20)) fail("bad-office");
  const data = slice(stream, offset + 8, length);
  return {
    length,
    lastEdit: data.readUInt32LE(8),
    persistOffset: data.readUInt32LE(12),
    documentId: data.readUInt32LE(16),
  };
}

/** @param {CfbStream} stream @param {number} offset @returns {Map<number, number>} persist id → stream offset */
function persistDirectoryAt(stream, offset) {
  const { type, length } = recordAt(stream, offset);
  if (type !== 0x1772) fail("bad-office");
  const data = slice(stream, offset + 8, length);
  /** @type {Map<number, number>} */
  const offsets = new Map();
  for (let at = 0; at + 4 <= data.length;) {
    const head = data.readUInt32LE(at);
    const first = head & 0xfffff;
    const count = head >>> 20;
    at += 4;
    if (at + count * 4 > data.length) fail("bad-office");
    for (let i = 0; i < count; i += 1, at += 4) offsets.set(first + i, data.readUInt32LE(at));
  }
  return offsets;
}

/** @param {CfbStream} stream @param {ReturnType<typeof userEditAt>} newest */
function presentationHasMacros(stream, newest) {
  let edit = newest;
  let documentOffset = persistDirectoryAt(stream, edit.persistOffset).get(newest.documentId);
  for (let hops = 0; documentOffset === undefined; hops += 1) {
    if (edit.lastEdit === 0 || hops >= MAX_PPT_EDITS) fail("bad-office");
    edit = userEditAt(stream, edit.lastEdit);
    documentOffset = persistDirectoryAt(stream, edit.persistOffset).get(newest.documentId);
  }
  const document = recordAt(stream, documentOffset);
  if (document.type !== 0x03e8) fail("bad-office");
  const end = documentOffset + 8 + document.length;
  // MS-PPT §2.4.4: the VbaInfo container lives inside the document's
  // DocInfoListContainer (RT_List 0x07D0), which is a child of the
  // DocumentContainer. A VbaInfo written directly under the document is still
  // checked, so detection never depends on a correct writer.
  for (let at = documentOffset + 8, seen = 0; at + 8 <= end; seen += 1) {
    if (seen >= MAX_PPT_RECORDS) fail("bad-office");
    const child = recordAt(stream, at);
    if (child.type === 0x07d0 && docInfoListHasMacros(stream, at + 8, at + 8 + child.length)) return true;
    if (child.type === 0x03ff && vbaInfoHasMacros(stream, at + 8, at + 8 + child.length)) return true;
    at += 8 + child.length;
  }
  return false;
}

/** The document's DocInfoListContainer children (MS-PPT §2.4.4) hold the VbaInfo.
 * @param {CfbStream} stream @param {number} from @param {number} end */
function docInfoListHasMacros(stream, from, end) {
  for (let at = from, seen = 0; at + 8 <= end; seen += 1) {
    if (seen >= MAX_PPT_RECORDS) fail("bad-office");
    const child = recordAt(stream, at);
    if (child.type === 0x03ff && vbaInfoHasMacros(stream, at + 8, at + 8 + child.length)) return true;
    at += 8 + child.length;
  }
  return false;
}

/** @param {CfbStream} stream @param {number} from @param {number} end inside the VbaInfoContainer */
function vbaInfoHasMacros(stream, from, end) {
  for (let at = from, seen = 0; at + 8 <= end; seen += 1) {
    if (seen >= MAX_PPT_RECORDS) fail("bad-office");
    const atom = recordAt(stream, at);
    // VbaInfoAtom: persistIdRef, fHasMacros, version (4 bytes each).
    if (atom.type === 0x0400 && atom.length >= 8) return slice(stream, at + 8, 8).readUInt32LE(4) !== 0;
    at += 8 + atom.length;
  }
  return false;
}

/** @param {Cfb} cfb @returns {{encrypted: boolean, macro: boolean}} */
function inspectPresentation(cfb) {
  const current = cfb.stream("Current User");
  const document = cfb.stream("PowerPoint Document");
  if (!current || !document || current.size < 20) fail("bad-office");
  const head = current.read(0, 20);
  const token = head.readUInt32LE(12);
  // 0xE391C05F marks an ordinary deck, 0xF3D1C4DF one encrypted with the document password.
  if (head.readUInt16LE(2) !== 0x0ff6 || (token !== 0xe391c05f && token !== 0xf3d1c4df)) fail("bad-office");
  const edit = userEditAt(document, head.readUInt32LE(16));
  // recLen 0x20 means encryptSessionPersistIdRef is present: the deck is encrypted.
  if (token === 0xf3d1c4df || edit.length === 0x20) return { encrypted: true, macro: false };
  return { encrypted: false, macro: presentationHasMacros(document, edit) };
}

/** @param {Cfb} cfb @param {boolean} byExtension @returns {LegacyClassification} */
function inspect(cfb, byExtension) {
  const family = familyOf(cfb);
  const wpsMarked = hasWpsMarker(cfb);
  const encryptedPackage = cfb.has("EncryptedPackage") || cfb.has("EncryptionInfo");
  if (!family && !encryptedPackage) fail("not-office");
  const found =
    family === "doc"
      ? inspectWord(cfb, wpsMarked)
      : family === "xls"
        ? inspectWorkbook(cfb)
        : family === "ppt"
          ? inspectPresentation(cfb)
          : { encrypted: false, macro: false };
  const vendor = wpsMarked || byExtension ? "wps" : "ms";
  const encrypted = encryptedPackage || found.encrypted;
  return {
    ok: true,
    family,
    vendor,
    encrypted,
    macro: found.macro || cfb.entries.some((entry) => MACRO_NAMES.has(entry.name.toLowerCase())),
    wpsSecure: vendor === "wps" && encrypted,
    reason: null,
  };
}

/**
 * Classifies an OLE container without converting or executing anything: Office
 * family, vendor, encryption, macros and WPS secure documents. Never throws; a
 * container that cannot be read safely comes back `ok: false` with a reason.
 * @param {Uint8Array} bytes
 * @param {string} [extension] lower-case with the dot; WPS extensions make the vendor WPS
 * @returns {LegacyClassification}
 */
export function classifyLegacyOffice(bytes, extension = "") {
  const byExtension = WPS_EXTENSIONS.has(extension);
  try {
    return inspect(openCfb(bytes), byExtension);
  } catch (error) {
    return {
      ok: false,
      family: null,
      vendor: byExtension ? "wps" : "ms",
      encrypted: false,
      macro: false,
      wpsSecure: false,
      reason: error instanceof CfbError ? error.code : "unreadable",
    };
  }
}
