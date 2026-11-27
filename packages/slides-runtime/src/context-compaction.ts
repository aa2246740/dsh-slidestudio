/**
 * Per-message compaction primitives for the context budget. Every function
 * mutates a detached copy in place and never removes a message, a role, a
 * tool-call id or a tool-result pairing.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const ELISION = "[历史内容已为模型上下文缩短；请用工具重新读取当前文件。]";
export const DEEP_ELISION = "[已省略；请用工具重读]";
export const REASONING_ELISION = "[earlier reasoning omitted]";
export const IMAGE_OFFLOADED = "[图片已从上下文移出以控制预算；需要时请重新渲染或读取。]";
export const SUMMARY_LABEL = "[历史工具结果已摘要]";

const IDENTITY_KEYS = new Set([
  "pageId",
  "pageIds",
  "id",
  "revision",
  "verdict",
  "family",
  "kind",
  "tag",
  "deliveryToken",
  "elementId",
  "title",
]);
const SUMMARY_KEYS = ["ok", "outcome", "error", "code", "pageId", "revision", "verdict", "status"] as const;

type Block = Record<string, unknown> & { type?: unknown };
type Mutable = { role?: unknown; content?: unknown; toolName?: unknown; toolCallId?: unknown; isError?: unknown };

export function blocksOf(message: AgentMessage): Block[] {
  const content = (message as unknown as Mutable).content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

export function roleOf(message: AgentMessage): string {
  return String((message as unknown as Mutable).role ?? "");
}

/** Cut `text` to at most `limit` characters, appending `marker`; surrogate pairs stay intact. */
export function shorten(text: string, limit: number, marker = ELISION): string {
  if (text.length <= limit) return text;
  let end = Math.max(0, limit - marker.length - 1);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end -= 1;
  return `${text.slice(0, end)}\n${marker}`;
}

function scalarIdentity(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= 200) ||
    (Array.isArray(value) && value.length <= 50 && value.every((item) => typeof item === "string" && item.length <= 64))
  );
}

/** Keep only small identity fields (page ids, revisions, verdicts) of tool-call arguments. */
export function identityArguments(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).filter(
      ([key, value]) => IDENTITY_KEYS.has(key) && scalarIdentity(value),
    ),
  );
}

function textsOf(message: AgentMessage): string[] {
  const content = (message as unknown as Mutable).content;
  if (typeof content === "string") return [content];
  return blocksOf(message)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text));
}

/** Whether a tool result reports failure (error flag, `ok:false`, rejection, or validation text). */
export function isFailedToolResult(message: AgentMessage): boolean {
  if ((message as unknown as Mutable).isError === true) return true;
  return textsOf(message).some((text) => {
    try {
      const value = JSON.parse(text) as { ok?: unknown; outcome?: unknown };
      return value?.ok === false || value?.outcome === "rejected";
    } catch {
      return /invalid[ _-]+(?:tool[ _-]+)?(?:args|arguments|input)|ToolArgsError|validation (?:error|failed)/i.test(
        text,
      );
    }
  });
}

/** Short structured summary of a tool result's JSON envelope, or a bounded text excerpt. */
export function summarizeToolResult(message: AgentMessage, excerptChars = 160, label = SUMMARY_LABEL): string {
  const [first] = textsOf(message);
  const name = String((message as unknown as Mutable).toolName ?? "tool");
  if (first === undefined) return `${label} ${name}`;
  try {
    const parsed = JSON.parse(first) as Record<string, unknown>;
    const picked = Object.fromEntries(
      SUMMARY_KEYS.filter((key) => key in parsed && scalarIdentity(parsed[key])).map((key) => [key, parsed[key]]),
    );
    const detail = typeof parsed.detail === "string" ? { detail: shorten(parsed.detail, excerptChars, "…") } : {};
    return `${label} ${name} ${JSON.stringify({ ...picked, ...detail })}`;
  } catch {
    return `${label} ${name}: ${shorten(first, excerptChars, "…")}`;
  }
}

/** Whether any text of `message` carries a compaction marker (shortened, summarized or elided). */
export function hasCompactionMarker(message: AgentMessage, extraMarkers: readonly string[] = []): boolean {
  const markers = [ELISION, DEEP_ELISION, SUMMARY_LABEL, ...extraMarkers];
  return textsOf(message).some((text) => markers.some((marker) => text.includes(marker)));
}

/** Replace inline images with a text placeholder; returns how many were offloaded. */
export function offloadImages(message: AgentMessage, keep: (index: number) => boolean = () => false): number {
  let offloaded = 0;
  const content = (message as unknown as Mutable).content;
  if (!Array.isArray(content)) return 0;
  (message as unknown as Mutable).content = (content as Block[]).map((block, index) => {
    if (block.type !== "image" || keep(index)) return block;
    offloaded += 1;
    return { type: "text", text: IMAGE_OFFLOADED };
  });
  return offloaded;
}

function trimToolCalls(message: AgentMessage, limit: number, identityOnly: (id: string) => boolean): void {
  for (const block of blocksOf(message)) {
    if (block.type !== "toolCall") continue;
    const id = String(block.id ?? "");
    const serialized = JSON.stringify(block.arguments ?? {});
    if (identityOnly(id)) block.arguments = identityArguments(block.arguments);
    else if (serialized.length > limit)
      block.arguments = { ...identityArguments(block.arguments), _contextElision: ELISION };
  }
}

export type TrimPlan = {
  /** 1: long items; 2: + reasoning and failed-call args; 3: old results summarized; 4: old prose dropped. */
  readonly tier: 1 | 2 | 3 | 4;
  readonly limit: number;
  readonly failedCalls: ReadonlySet<string>;
};

function trimText(message: AgentMessage, plan: TrimPlan): void {
  const record = message as unknown as Mutable;
  if (typeof record.content === "string") {
    record.content = plan.tier >= 4 ? DEEP_ELISION : shorten(record.content, plan.limit);
    return;
  }
  for (const block of blocksOf(message)) {
    if (block.type === "text" && typeof block.text === "string") {
      block.text = plan.tier >= 4 ? DEEP_ELISION : shorten(block.text, plan.limit);
    }
    if (block.type === "thinking" && typeof block.thinking === "string" && !block.thinkingSignature) {
      block.thinking = plan.tier >= 2 ? REASONING_ELISION : shorten(block.thinking, plan.limit);
    }
  }
}

/** Compact one non-protected message according to `plan`. */
export function trimMessage(message: AgentMessage, plan: TrimPlan): void {
  const role = roleOf(message);
  if (role === "assistant") {
    trimToolCalls(message, plan.tier >= 3 ? 256 : plan.limit, (id) => plan.tier >= 2 && plan.failedCalls.has(id));
  }
  if (role === "toolResult" && plan.tier >= 3) {
    const summary = summarizeToolResult(message, plan.tier >= 4 ? 80 : 160);
    (message as unknown as Mutable).content = [{ type: "text", text: summary }];
    return;
  }
  trimText(message, plan);
}
