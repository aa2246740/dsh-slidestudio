/**
 * Deterministic CSV text rendering of a parsed table, for the host's inline
 * path. Kept apart from the attachment store so that module stays inside its
 * size budget.
 */

/** @param {string} char */
function regexEscape(char) {
  return char.replace(/[\\\]\-^]/g, "\\$&");
}

/**
 * Rendering of a parsed table, for the host's inline path. Only `csv-v1` derivatives render: xlsx sheets stay multi-part until
 * materials paging lands. When the preview capped the rows the rendering
 * would silently drop rows, so it is marked `truncated` instead.
 * @param {import("../attachments.mjs").StoredDerivative} derivative
 * @returns {{text: string, chars: number, truncated: boolean}|undefined}
 */
export function tableTextRendering(derivative) {
  const table = derivative.table;
  if (!table || derivative.parser?.id !== "csv-v1") return undefined;
  const delimiter = table.delimiter || ",";
  // RFC 4180 quoting for the ACTIVE delimiter: a field containing the
  // delimiter, a quote or a line break is quoted, otherwise the rendering
  // would split the cell when the host reads it back.
  const needsQuotes = new RegExp(`["${regexEscape(delimiter)}\r\n]`);
  /** @param {unknown} value */
  const escape = (value) => {
    const field = String(value ?? "");
    return needsQuotes.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
  };
  const rows = table.fullRows ?? table.rows ?? [];
  const lines = [];
  if (Array.isArray(table.headerRow) && table.headerRow.length) {
    lines.push(table.headerRow.map(escape).join(delimiter));
  }
  for (const row of rows) lines.push(row.map(escape).join(delimiter));
  const text = lines.join("\n");
  const truncated = Number.isSafeInteger(table.rowCount) && rows.length < table.rowCount;
  return { text, chars: Array.from(text).length, truncated };
}
