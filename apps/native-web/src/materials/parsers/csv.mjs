/**
 * `csv-v1` — delimited data material (csv/tsv). Encoding is detected strictly
 * (UTF-8 BOM → UTF-8 → GB18030, fatal decoding) and the delimiter is chosen
 * from `, \t ; |` by counting candidates outside quoted fields. Row/column
 * counts, the header row and simple column type inference feed both the
 * derivative payload and the Chinese summary.
 */
import { MaterialRejection } from "../zip-guard.mjs";
import { buildSummaryZh } from "../summary.mjs";

export const CSV_PREVIEW_ROWS = 200;
export const CSV_MAX_ROWS = 100_000;

export const csvParser = {
  id: "csv-v1",
  engine: "TextDecoder + RFC 4180",
  /** @type {"table"} */
  kind: "table",

  /**
   * @param {{name: string, extension: string, bytes: Uint8Array}} input
   * @returns {import("../derivative.mjs").ParserResult<object>}
   */
  parse({ name, bytes }) {
    const { text, encoding } = decodeStrict(bytes);
    const delimiter = detectDelimiter(text);
    const rows = parseDelimited(text, delimiter);
    // Trailing blank lines are file noise, not data rows.
    while (rows.length && rows[rows.length - 1]?.every((cell) => cell === "")) rows.pop();
    if (!rows.length) throw new MaterialRejection("empty", "文件为空或没有数据行");
    if (rows.length > CSV_MAX_ROWS) {
      throw new MaterialRejection("too-large", `表格行数超过 ${CSV_MAX_ROWS} 行上限，请拆分后再上传`);
    }
    const headerRow = (rows[0] ?? []).map((cell, index) => cell.trim() || `列${index + 1}`);
    const dataRows = rows.slice(1);
    const columns = headerRow.map((header, columnIndex) => ({
      header,
      inferredType: inferType(dataRows, columnIndex),
    }));
    const truncatedRowWindow = dataRows.length > CSV_PREVIEW_ROWS;
    const payload = {
      encoding,
      delimiter,
      rowCount: dataRows.length,
      colCount: headerRow.length,
      chars: Array.from(text).length,
      headerRow,
      columns,
      rows: dataRows.slice(0, CSV_PREVIEW_ROWS),
    };
    const warnings = [];
    if (truncatedRowWindow) {
      warnings.push({
        code: "preview-truncated",
        message: `仅预览前 ${CSV_PREVIEW_ROWS} 行，完整 ${dataRows.length.toLocaleString("en-US")} 行可分页读取`,
      });
    }
    return {
      payload,
      summary: buildSummaryZh({
        parserId: this.id,
        encoding,
        delimiter,
        rowCount: dataRows.length,
        headers: headerRow,
        extension: extensionOfName(name),
      }),
      warnings,
      truncated: {
        applied: truncatedRowWindow,
        reason: truncatedRowWindow ? "preview-rows" : undefined,
      },
    };
  },
};

/** @param {string} name */
function extensionOfName(name) {
  const dot = name.toLowerCase().lastIndexOf(".");
  return dot > 0 ? name.toLowerCase().slice(dot) : "";
}

/**
 * Strict decoding: UTF-8 BOM, plain UTF-8, then GB18030. Anything else is a
 * rejection — decoded garbage is never shown to the user as data.
 * @param {Uint8Array} bytes @returns {{text: string, encoding: string}}
 */
export function decodeStrict(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decodeFatal(bytes.subarray(3), "utf-8"), encoding: "UTF-8 BOM" };
  }
  try {
    return { text: decodeFatal(bytes, "utf-8"), encoding: "UTF-8" };
  } catch {
    try {
      return { text: decodeFatal(bytes, "gb18030"), encoding: "GB18030" };
    } catch {
      throw new MaterialRejection("unsupported-encoding", "无法识别文件编码，请另存为 UTF-8 后再上传");
    }
  }
}

/** @param {Uint8Array} bytes @param {string} label */
function decodeFatal(bytes, label) {
  return new TextDecoder(label, { fatal: true }).decode(bytes);
}

/**
 * Pick the delimiter that separates the most fields outside quotes. A candidate
 * only counts when it appears in the file, so tab-delimited data named .csv
 * still detects 制表符.
 * @param {string} text
 */
export function detectDelimiter(text) {
  const candidates = [",", "\t", ";", "|"];
  const sample = text.slice(0, 65536);
  /** @type {Map<string, number>} */
  const counts = new Map(candidates.map((d) => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < sample.length; i += 1) {
    const ch = sample[i] ?? "";
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best = ",";
  let bestCount = 0;
  for (const [delimiter, count] of counts) {
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

/**
 * RFC 4180 field parser: quoted fields, `""` escapes, `\r\n` and `\n` rows.
 * @param {string} text @param {string} delimiter
 * @returns {string[][]}
 */
export function parseDelimited(text, delimiter) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      if (field.endsWith("\r")) field = field.slice(0, -1);
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Column type inference over the data rows: `number` when every non-empty
 * cell parses as a finite number, `boolean` for true/false, else `text`.
 * @param {string[][]} rows @param {number} columnIndex
 */
export function inferType(rows, columnIndex) {
  let sawValue = false;
  let onlyNumber = true;
  let onlyBoolean = true;
  for (const row of rows.slice(0, 1000)) {
    const cell = (row[columnIndex] ?? "").trim();
    if (!cell) continue;
    sawValue = true;
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)(e[+-]?\d+)?$/i.test(cell)) onlyNumber = false;
    if (!/^(true|false|是|否)$/i.test(cell)) onlyBoolean = false;
    if (!onlyNumber && !onlyBoolean) break;
  }
  if (!sawValue) return "text";
  if (onlyNumber) return "number";
  if (onlyBoolean) return "boolean";
  return "text";
}
