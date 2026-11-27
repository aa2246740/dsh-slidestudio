/**
 * Bounded rejection details.
 *
 * An off-pack palette refusal used to repeat the whole allowed palette (every
 * printed colour plus its tints and shades) once per offending colour, which
 * reached several KB per write_page. Refusals are now capped at
 * {@link REJECTION_DETAIL_MAX_CHARS}: every offending field name is kept
 * verbatim (as many as fit), and the allowed tokens are listed palette-first
 * (the order the adopted sources declare them) until the budget is spent.
 */

import { hexVariants } from "./palette-variants.js";

export const REJECTION_DETAIL_MAX_CHARS = 1024;
/** write_page budget: leaves room for the `<code>: ` prefix hosts put in front of the detail. */
export const WRITE_PAGE_DETAIL_MAX_CHARS = REJECTION_DETAIL_MAX_CHARS - 32;

/**
 * Parses the single-issue pack_color message built in layout-qa.ts
 * (`color "<v>" → #HEX at <field> is not allowed by <source>. Allowed pack
 * colors: … <tool> refused. …`). A format change there is caught by the
 * rejection-detail tests, which build real refusals.
 */
const PACK_COLOR_MESSAGE =
  /^color (.+?) → (#[0-9A-Fa-f]{6}) at (\S+) is not allowed by (.+?)\. Allowed pack colors: (.*?)\. After adoption[\s\S]*? (\S+) refused\./;

type ParsedPackColor = { value: string; hex: string; trail: string; source: string; allowed: string[]; tool: string };

function parsePackColorMessage(message: string): ParsedPackColor | undefined {
  const match = PACK_COLOR_MESSAGE.exec(message);
  if (!match) return undefined;
  return {
    value: match[1]!,
    hex: match[2]!,
    trail: match[3]!,
    source: match[4]!,
    allowed: match[5]!.split(", ").filter(Boolean),
    tool: match[6]!,
  };
}

/** Truncate a detail to `max` chars on a line boundary, naming how many lines were dropped. */
export function capRejectionDetail(detail: string, max = REJECTION_DETAIL_MAX_CHARS): string {
  if (detail.length <= max) return detail;
  const lines = detail.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    const suffix = `\n…(+${lines.length - index - 1} more)`;
    if (used + line.length + 1 + suffix.length > max) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  const tail = `…(+${dropped} more)`;
  if (!kept.length) return `${detail.slice(0, max - tail.length - 1)}${tail}`;
  return `${kept.join("\n")}\n${tail}`;
}

/**
 * Base colours first (printed palettes, user-declared colours), in declaration
 * order; documented tints/shades of another allowed colour after them.
 */
export function rankAllowedColors(allowed: readonly string[]): string[] {
  const set = new Set(allowed);
  const derived = new Set<string>();
  for (const hex of allowed) {
    const { tints, shades } = hexVariants(hex);
    for (const variant of [...tints, ...shades]) if (variant !== hex && set.has(variant)) derived.add(variant);
  }
  const base = allowed.filter((hex) => !derived.has(hex));
  return [...base, ...allowed.filter((hex) => derived.has(hex))];
}

function packColorBlock(
  parsed: readonly ParsedPackColor[],
  allowed: readonly string[],
  fields: number,
  tokens: number,
) {
  const first = parsed[0]!;
  const shownFields = parsed.slice(0, fields).map((issue) => `${issue.trail} ${issue.value}→${issue.hex}`);
  const moreFields = parsed.length - shownFields.length;
  const shownTokens = allowed.slice(0, tokens);
  const moreTokens = allowed.length - shownTokens.length;
  return [
    `${parsed.length} off-pack color${parsed.length === 1 ? "" : "s"}; ${first.tool} refused. Host did not snap colors.`,
    `Offending fields: ${shownFields.join("; ")}${moreFields > 0 ? `; (+${moreFields} more)` : ""}`,
    `Allowed pack colors: ${shownTokens.join(", ")}${moreTokens > 0 ? ` (+${moreTokens} more tints/shades; ${allowed.length} total)` : ""}.`,
    `Not allowed by ${first.source}. Use an allowed hex or a Theme.colors $token that resolves to one.`,
  ].join("\n");
}

/**
 * One compact block for all pack_color issues, ≤ `max` chars. `allowedOrder`
 * is the adopted palette in declaration order; without it the sorted list
 * from the messages is used. Undefined when no message is a pack_color one.
 */
export function compactPackColorDetail(
  messages: readonly string[],
  allowedOrder?: Iterable<string>,
  max = REJECTION_DETAIL_MAX_CHARS,
): string | undefined {
  const parsed = messages.map(parsePackColorMessage).filter((issue): issue is ParsedPackColor => Boolean(issue));
  if (!parsed.length) return undefined;
  const allowed = rankAllowedColors([
    ...new Set(allowedOrder ? [...allowedOrder].map((hex) => hex.toUpperCase()) : parsed[0]!.allowed),
  ]);
  let fields = parsed.length;
  let tokens = allowed.length;
  let block = packColorBlock(parsed, allowed, fields, tokens);
  // Shrink the allowed list first (down to a usable core), then the field list, then truncate.
  while (block.length > max && tokens > 12) block = packColorBlock(parsed, allowed, fields, --tokens);
  while (block.length > max && fields > 3) block = packColorBlock(parsed, allowed, --fields, tokens);
  while (block.length > max && tokens > 3) block = packColorBlock(parsed, allowed, fields, --tokens);
  return capRejectionDetail(block, max);
}

/**
 * The capped detail for a list of issue messages: pack_color issues collapse
 * into one compact block, the other messages follow, and the whole is ≤ `max`.
 */
export function cappedIssueDetail(
  messages: readonly string[],
  allowedOrder?: Iterable<string>,
  max = REJECTION_DETAIL_MAX_CHARS,
): string {
  const joined = messages.join("\n");
  if (joined.length <= max) return joined;
  const others = messages.filter((message) => !parsePackColorMessage(message));
  const otherText = others.join("\n");
  const budget = others.length ? Math.max(max - Math.min(otherText.length, max / 2) - 1, max / 2) : max;
  const compact = compactPackColorDetail(messages, allowedOrder, Math.floor(budget));
  return capRejectionDetail(compact ? [compact, ...others].join("\n") : joined, max);
}
