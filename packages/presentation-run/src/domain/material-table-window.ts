/**
 * Table renderings for `read_material`: a header plus a bounded window of data rows with
 * absolute 1-based indices, so any row of a large sheet is exactly reachable.
 */
import { MATERIAL_CHUNK_BYTES, MATERIAL_TABLE_MAX_ROWS, MaterialPackError } from "./material-pack.js";
import type { TableWindow, VerifiedMaterial } from "./material-pack.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sheetByName(material: VerifiedMaterial, name: string): Record<string, unknown> {
  const table = isRecord(material.derivative.table) ? material.derivative.table : {};
  const sheets = Array.isArray(table.sheets) ? table.sheets.filter(isRecord) : [];
  const sheet = sheets.find((item) => String(item.name ?? "") === name);
  if (!sheet) {
    const available = sheets.map((item) => `sheet:${String(item.name ?? "")}`).join("、");
    throw new MaterialPackError(`资料「${material.name}」没有名为「${name}」的工作表；可用 part：${available || "无"}`);
  }
  return sheet;
}

function sheetRows(sheet: Record<string, unknown>): readonly unknown[][] {
  const full = Array.isArray(sheet.fullRows) ? sheet.fullRows : undefined;
  const preview = Array.isArray(sheet.rows) ? sheet.rows : [];
  const rows = full ?? preview;
  return rows.filter(Array.isArray) as readonly unknown[][];
}

function headerOf(record: Record<string, unknown>): readonly string[] {
  const header = Array.isArray(record.headerRow) ? record.headerRow : [];
  return header.map((cell) => String(cell ?? ""));
}

/**
 * RFC 4180 field parser identical to the intake csv-v1 reader: quoted fields,
 * `""` escapes, `\r\n` and `\n` row ends. Needed because a csv-v1 derivative
 * keeps only a ≤200-row preview while the full table is exactly re-readable
 * from the verified original bytes.
 */
export function parseDelimitedText(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
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

/** csv-v1 original bytes → all rows. Derivative previews are never trusted for paging. */
export function csvAllRows(material: Pick<VerifiedMaterial, "derivative" | "originalBytes" | "name">): string[][] {
  const table = isRecord(material.derivative.table) ? material.derivative.table : {};
  const encoding = String(table.encoding ?? "");
  let bytes: Uint8Array = material.originalBytes;
  if (encoding === "UTF-8 BOM") bytes = bytes.subarray(3);
  const label = encoding === "GB18030" ? "gb18030" : "utf-8";
  let text: string;
  try {
    text = new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    throw new MaterialPackError(`资料「${material.name}」编码无法识别，请重新上传后再发送`);
  }
  const delimiter = String(table.delimiter ?? ",") || ",";
  const rows = parseDelimitedText(text, delimiter);
  while (rows.length && rows[rows.length - 1]?.every((cell) => cell === "")) rows.pop();
  return rows;
}

/** Table part id for a csv/tsv material ("rows") or the first xlsx sheet. */
export function defaultTablePart(material: VerifiedMaterial): string {
  const table = isRecord(material.derivative.table) ? material.derivative.table : {};
  const sheets = Array.isArray(table.sheets) ? table.sheets.filter(isRecord) : [];
  if (sheets.length) return `sheet:${String(sheets[0]?.name ?? "")}`;
  return "rows";
}

function tableRowsForPart(
  material: VerifiedMaterial,
  part: string,
): { header: readonly string[]; rows: readonly unknown[][]; rowCount: number } {
  const table = isRecord(material.derivative.table) ? material.derivative.table : {};
  if (material.parser === "csv-v1" || !Array.isArray(table.sheets)) {
    const all = csvAllRows(material);
    const header = all[0]?.map((cell) => cell.trim() || `列${all[0]!.indexOf(cell) + 1}`) ?? [];
    const dataRows = all.slice(1);
    const declared = Number(table.rowCount);
    const rowCount = Number.isSafeInteger(declared) ? Math.max(declared, dataRows.length) : dataRows.length;
    return { header, rows: dataRows, rowCount };
  }
  const name = part.startsWith("sheet:") ? part.slice("sheet:".length) : part;
  const sheet = sheetByName(material, name);
  const rows = sheetRows(sheet);
  const declared = Number(sheet.rowCount);
  return {
    header: headerOf(sheet),
    rows,
    rowCount: Number.isSafeInteger(declared) ? Math.max(declared, rows.length) : rows.length,
  };
}

/**
 * Data rows a window can actually return. A derivative may declare more rows than
 * it kept, and those rows are unreachable, so they can never be required.
 */
export function readableTableRows(material: VerifiedMaterial, part: string): number {
  const { rows, rowCount } = tableRowsForPart(material, part);
  return Math.min(rows.length, rowCount);
}

const COLUMN_PREFIX = "列：";
const HEADER_CUT_MARKER = "…（表头过长，已截断）";

function truncateUtf8(text: string, maxBytes: number, marker: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes - Buffer.byteLength(marker, "utf8");
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return bytes.subarray(0, end).toString("utf8") + marker;
}

/** Share the available bytes between long cells while preserving short cells. */
function fitRowCells(cells: readonly string[], maxBytes: number): readonly string[] {
  const marker = "…（本行过长，已截断）";
  const render = (cap: number) => cells.map((cell) => truncateUtf8(cell, cap, marker));
  let low = Buffer.byteLength(marker, "utf8");
  let high = maxBytes;
  if (Buffer.byteLength(render(low).join("\t"), "utf8") > maxBytes) {
    // Extremely many columns: even separators/markers cannot all fit.
    return [truncateUtf8(cells.join("\t"), maxBytes, marker)];
  }
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(render(mid).join("\t"), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return render(low);
}

/**
 * Header plus a UTF-8-byte-bounded window. `offset` is a zero-based index into the
 * data rows; returned `rows[i].index` is the absolute 1-based data-row index
 * so row 12345 of a 20k CSV is exactly reachable.
 */
export function tableWindow(material: VerifiedMaterial, part: string, offset: number, limit: number): TableWindow {
  const boundedOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const boundedLimit = Math.min(
    Math.max(Number.isSafeInteger(limit) && limit > 0 ? limit : MATERIAL_TABLE_MAX_ROWS, 1),
    MATERIAL_TABLE_MAX_ROWS,
  );
  const { header, rows, rowCount } = tableRowsForPart(material, part);
  if (boundedOffset >= rowCount && rowCount > 0) {
    throw new MaterialPackError(`资料「${material.name}」行偏移超出范围：offset=${boundedOffset}，共 ${rowCount} 行`);
  }
  const windowRows = rows.slice(boundedOffset, boundedOffset + boundedLimit);
  const indexed: TableWindow["rows"][number][] = [];
  // Reserve space for at least one data row even with an oversized column header.
  const title = truncateUtf8(`# 表「${material.name}」${part}`, 1024, "…（已截断）");
  const columnLine = header.length ? `列：${header.join(" | ")}` : "";
  const columns = truncateUtf8(columnLine, MATERIAL_CHUNK_BYTES / 2, HEADER_CUT_MARKER);
  let truncated = title !== `# 表「${material.name}」${part}` || columns !== columnLine;
  const cellText = (cell: unknown) => {
    if (cell === null || cell === undefined) return "";
    if (typeof cell === "object") {
      const rec = cell as Record<string, unknown>;
      return String(rec.text ?? rec.value ?? "");
    }
    return String(cell);
  };
  const render = () =>
    [
      title,
      `共 ${rowCount} 行数据 · 本段第 ${indexed.length ? indexed[0]!.index : 0}–${indexed.length ? indexed[indexed.length - 1]!.index : 0} 行`,
      columns,
      ...indexed.map((entry) => `${entry.index}\t${entry.cells.map((cell) => cellText(cell)).join("\t")}`),
    ]
      .filter((line) => line !== "")
      .join("\n");
  let text = render();
  for (const cells of windowRows) {
    indexed.push({ index: boundedOffset + indexed.length + 1, cells });
    let candidate = render();
    if (Buffer.byteLength(candidate, "utf8") > MATERIAL_CHUNK_BYTES) {
      if (indexed.length > 1) {
        indexed.pop();
        break;
      }
      const entry = indexed[0]!;
      const cellBytes = Buffer.byteLength(entry.cells.map(cellText).join("\t"), "utf8");
      const available = MATERIAL_CHUNK_BYTES - Buffer.byteLength(candidate, "utf8") + cellBytes;
      indexed[0] = { index: entry.index, cells: fitRowCells(cells.map(cellText), available) };
      truncated = true;
      candidate = render();
    }
    text = candidate;
  }
  // Facts are limited to the bytes the receipt hash covers: the header exactly as far as the
  // rendering above kept it, never the part `truncateUtf8` cut away.
  const visibleHeader =
    columns === columnLine
      ? header.join(" | ")
      : columns.slice(COLUMN_PREFIX.length, columns.length - HEADER_CUT_MARKER.length);
  const factText = [visibleHeader, ...indexed.map((entry) => entry.cells.map((cell) => cellText(cell)).join("\t"))]
    .filter((line) => line !== "")
    .join("\n");
  return {
    part,
    header,
    rowCount,
    rows: indexed,
    truncated,
    text,
    factText,
  };
}
