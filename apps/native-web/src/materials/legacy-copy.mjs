/**
 * The rejection copy for legacy files that carry the WPS name. Microsoft
 * formats keep the sentence detect.mjs has always given; a WPS file is named as
 * one, so the save-as hint sends the user to WPS rather than to Office.
 */
import { legacyVendorOf } from "./cfb.mjs";

/** @type {Record<"doc"|"xls"|"ppt", {label: string, ext: string, target: string}>} */
const WPS_PARTS = {
  doc: { label: "文字", ext: ".wps", target: ".docx" },
  xls: { label: "表格", ext: ".et", target: ".xlsx" },
  ppt: { label: "演示", ext: ".dps", target: ".pptx" },
};

/** @type {Record<string, "doc"|"xls"|"ppt">} */
const EXTENSION_FAMILY = {
  ".doc": "doc",
  ".wps": "doc",
  ".xls": "xls",
  ".et": "xls",
  ".ppt": "ppt",
  ".dps": "ppt",
};

/**
 * The refusal for an OLE file WPS wrote: it has a WPS private stream, or its
 * extension is .wps/.et/.dps. Null for anything else.
 * @param {Uint8Array} bytes @param {string} extension lower-case with the dot
 * @returns {{ok: false, code: "legacy-office-format", message: string} | null}
 */
export function wpsLegacyRefusal(bytes, extension) {
  const { vendor, family } = legacyVendorOf(bytes, extension);
  if (vendor !== "wps" || !family) return null;
  const part = WPS_PARTS[family];
  // The file's own extension is shown when it belongs to this family, else the WPS one.
  const shown = EXTENSION_FAMILY[extension] === family ? extension : part.ext;
  return {
    ok: false,
    code: "legacy-office-format",
    message: `这是 WPS ${part.label}文件（${shown}），暂不支持；请在 WPS 中“另存为” ${part.target} 后再上传`,
  };
}
