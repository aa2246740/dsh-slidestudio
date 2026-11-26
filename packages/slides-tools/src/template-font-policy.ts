import { normalizePageFonts, type FontPair, type FontReplacement } from "@open-slidestudio/pptd-v2";
import type { TemplateFontPolicy } from "@open-slidestudio/presentation-run";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function matchesPair(value: unknown, pair: FontPair): boolean {
  const current = asRecord(value);
  return current?.latin === pair.latin && current.ea === pair.ea;
}

/** Apply a receipt-verified adopted template font pair before the page is persisted. */
export function applyTemplateFontPolicy(
  args: Record<string, unknown>,
  policy: TemplateFontPolicy | undefined,
): FontReplacement[] {
  if (!policy) return [];
  const notes = new Map<string, FontReplacement>();
  const replace = (owner: Record<string, unknown>, key: string): void => {
    const before = owner[key];
    if (matchesPair(before, policy.pair)) return;
    if (Object.prototype.hasOwnProperty.call(owner, key)) {
      const from =
        typeof before === "string" || (before && typeof before === "object" && !Array.isArray(before))
          ? (before as string | FontPair)
          : "未指定";
      notes.set(JSON.stringify(from), { from, to: policy.pair });
    }
    owner[key] = { ...policy.pair };
  };
  const visit = (value: unknown, seen: WeakSet<object>): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, seen);
      return;
    }
    const owner = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(owner, "fontFamily")) {
      replace(owner, "fontFamily");
    }
    for (const [key, entry] of Object.entries(owner)) {
      if (key !== "fontFamily") visit(entry, seen);
    }
  };

  const elements = Array.isArray(args.elements) ? args.elements : [];
  for (const element of elements) {
    const record = asRecord(element);
    if (!record) continue;
    const content = asRecord(record.content);
    if (content && typeof content.text === "string") {
      if (!Object.prototype.hasOwnProperty.call(content, "fontFamily")) {
        notes.set("未指定", { from: "未指定", to: policy.pair });
      }
      replace(content, "fontFamily");
    }
    visit(record, new WeakSet());
  }
  const theme = asRecord(args.theme);
  if (theme) visit(theme, new WeakSet());
  return [...notes.values()];
}

export function normalizeTemplatePageFonts(
  args: Record<string, unknown>,
  policy: TemplateFontPolicy | undefined,
): FontReplacement[] {
  return [...applyTemplateFontPolicy(args, policy), ...normalizePageFonts(args)];
}
