/**
 * Dialect primitives and element-list helpers for the skill produce path. Split out of
 * skill-pages.ts to keep that module under its budget; the functions are moved verbatim.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function coerceElementList(rec: Record<string, unknown>): unknown[] {
  let raw: unknown = rec.elements ?? rec.items ?? rec.shapes;
  raw = parseJsonMaybe(raw);
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return [raw];
  return [];
}

export function liftBareCopy(item: unknown): unknown {
  const rec = asRecord(item);
  if (!rec) return item;
  const type = asString(rec.type) ?? asString(rec.elementType);
  if (type) return item;
  if (asString(rec.title) && !asString(rec.text)) {
    return { ...rec, type: "text", text: rec.title, fontWeight: rec.fontWeight ?? "bold" };
  }
  if (asString(rec.body) && !asString(rec.text)) {
    return { ...rec, type: "text", text: rec.body };
  }
  return item;
}
