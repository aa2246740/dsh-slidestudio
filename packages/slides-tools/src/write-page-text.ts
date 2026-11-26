/** Normalize only numeric values in canonical display-text slots. Numbers in
 * chart data, geometry, ids and all other fields keep their types. A matching
 * read_page hash lets us preserve an existing representation such as "02";
 * without that provenance, use only the supplied number's literal text.
 */
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function normalizeNumericPageText(args: Record<string, unknown>, baseline?: Record<string, unknown>): void {
  const trusted =
    typeof args.expectedPageSha256 === "string" && args.expectedPageSha256.toLowerCase() === baseline?.pageSha256;
  const previous = trusted && Array.isArray(baseline?.elements) ? baseline.elements : [];
  const oldById = new Map(previous.map((value) => [record(value)?.elementId, record(value)]));
  const normalize = (slot: Record<string, unknown> | undefined, old: Record<string, unknown> | undefined) => {
    const value = slot?.text;
    if (!slot || typeof value !== "number" || !Number.isFinite(value)) return;
    const before = old?.text;
    // Decimal text only. Avoid Number coercing blank, hex or other notation.
    slot.text =
      typeof before === "string" && /^[-+]?\d+(?:\.\d+)?$/.test(before) && Number(before) === value
        ? before
        : String(value);
  };
  if (!Array.isArray(args.elements)) return;
  for (const item of args.elements) {
    const element = record(item);
    if (!element) continue;
    const old = oldById.get(element.elementId);
    if (element.elementType === "text" || element.elementType === "shape") {
      normalize(record(element.content), record(old?.content));
    } else if (element.elementType === "table" && Array.isArray(element.rows)) {
      const oldRows = Array.isArray(old?.rows) ? old.rows : [];
      element.rows.forEach((row, i) => {
        if (!Array.isArray(row)) return;
        const oldRow = Array.isArray(oldRows[i]) ? oldRows[i] : [];
        row.forEach((cell, j) => normalize(record(cell), record(oldRow[j])));
      });
    }
  }
}
