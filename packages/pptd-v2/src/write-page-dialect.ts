import { normalizeMisplacedStyles } from "./write-page-style-catalog.js";

const LINE_ARROW_NONE = new Set(["", "null", "none", "false"]);
const LINE_ARROW_HEADS = new Set(["arrow", "stealth", "diamond", "oval"]);

/** Models often send the string "null" instead of JSON null for a missing line head. */
export function coerceLineArrowHead(value: unknown): "arrow" | "stealth" | "diamond" | "oval" | null | unknown {
  if (value === undefined) return undefined;
  if (value === null || value === false) return null;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) return null;
  if (typeof value === "string") {
    const token = value.trim().toLowerCase();
    if (LINE_ARROW_NONE.has(token)) return null;
    if (LINE_ARROW_HEADS.has(token)) return token;
  }
  return value;
}

export function normalizeWritePageLineArrows(args: Record<string, unknown>): void {
  const elements = args.elements;
  if (!Array.isArray(elements)) return;
  for (const element of elements) {
    if (!element || typeof element !== "object" || Array.isArray(element)) continue;
    const rec = element as Record<string, unknown>;
    if (rec.elementType !== "line" || !Array.isArray(rec.arrow) || rec.arrow.length !== 2) continue;
    rec.arrow = [coerceLineArrowHead(rec.arrow[0]), coerceLineArrowHead(rec.arrow[1])];
  }
}

function unwrapXmlTextNode(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length === 1 && keys[0] === "$text" && typeof rec.$text === "string") {
    return rec.$text;
  }
  return value;
}

/** Normalize adapter wrappers and unambiguous style placements, reporting every move. */
export function normalizeWritePageDialect(args: Record<string, unknown>): string[] {
  const notes: string[] = [];
  const walk = (node: unknown, path: string): unknown => {
    const unwrapped = unwrapXmlTextNode(node);
    if (unwrapped !== node) {
      notes.push(`${path}.$text -> ${path}`);
      return unwrapped;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) node[index] = walk(node[index], `${path}[${index}]`);
      return node;
    }
    if (!node || typeof node !== "object") return node;
    const rec = node as Record<string, unknown>;
    for (const key of Object.keys(rec)) rec[key] = walk(rec[key], `${path}.${key}`);
    return rec;
  };
  walk(args, "$");
  return [...notes, ...normalizeMisplacedStyles(args)];
}
