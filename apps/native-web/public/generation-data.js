/** Shared intake reply wording: one bad-payload sentence for every attachment parser. */
export const INVALID_REPLY = "资料上传回复无效，请重试或移除该资料";

/** @param {unknown} value */
export function text(value) {
  return typeof value === "string" ? value : "";
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {Record<string, unknown>} */
export function record(value) {
  return isRecord(value) ? value : {};
}

/** Preserve valid journal records without modifying their persisted payload.
 * @param {unknown} value @returns {Record<string, unknown>[]} */
export function records(value) {
  if (!Array.isArray(value)) return [];
  /** @type {unknown[]} */
  const entries = value;
  return entries.filter(isRecord);
}

/** Parse a tool input/output journal string (or object) into a record; never
 * fabricates data for malformed JSON.
 * @param {unknown} value @returns {Record<string, unknown>} */
export function objectFrom(value) {
  const raw = typeof value === "string" ? value.trim() : value;
  const candidates = typeof raw === "string" ? [raw, raw.replace(/\s*\[image content omitted\]\s*$/i, "")] : [raw];
  for (const candidate of candidates) {
    try {
      /** @type {unknown} */
      const parsed = typeof candidate === "string" ? JSON.parse(candidate) : candidate;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return record(parsed);
    } catch {
      // Try the next journal representation when a tool emitted plain text.
    }
  }
  return {};
}

/** @param {unknown} value @param {number} [limit] */
export function brief(value, limit = 160) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").slice(0, limit) : "";
}
