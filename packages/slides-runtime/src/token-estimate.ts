/**
 * Offline token estimation for mixed Chinese/English content. CJK ideographs,
 * kana, hangul and full-width punctuation cost roughly one token each; other
 * text costs roughly one token per four UTF-8 bytes. Images use a fixed
 * per-block estimate. Estimates are deliberately conservative (rounded up).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const DEFAULT_IMAGE_TOKEN_ESTIMATE = 1_200;
const MESSAGE_OVERHEAD_TOKENS = 4;
const BYTES_PER_LATIN_TOKEN = 4;

const CJK =
  /[\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u;

/** Estimate tokens of one text string. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let otherBytes = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk += 1;
    else otherBytes += Buffer.byteLength(char, "utf8");
  }
  return cjk + Math.ceil(otherBytes / BYTES_PER_LATIN_TOKEN);
}

type Block = { readonly type?: unknown; readonly [key: string]: unknown };

function blockTokens(block: Block, imageTokens: number): number {
  switch (block.type) {
    case "text":
      return estimateTextTokens(String(block.text ?? ""));
    case "thinking":
      return estimateTextTokens(String(block.thinking ?? ""));
    case "image":
      return imageTokens;
    case "toolCall":
      return estimateTextTokens(String(block.name ?? "")) + estimateTextTokens(JSON.stringify(block.arguments ?? {}));
    default:
      return estimateTextTokens(JSON.stringify(block));
  }
}

function contentTokens(content: unknown, imageTokens: number): number {
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  return content.reduce<number>((total, block) => total + blockTokens(block as Block, imageTokens), 0);
}

/** Estimate tokens of one transcript message (system tool declarations included). */
export function estimateMessageTokens(message: AgentMessage, imageTokens = DEFAULT_IMAGE_TOKEN_ESTIMATE): number {
  const record = message as unknown as { content?: unknown; toolsAdded?: unknown; toolName?: unknown };
  const tools = record.toolsAdded ? estimateTextTokens(JSON.stringify(record.toolsAdded)) : 0;
  const name = typeof record.toolName === "string" ? estimateTextTokens(record.toolName) : 0;
  return MESSAGE_OVERHEAD_TOKENS + tools + name + contentTokens(record.content, imageTokens);
}

/** Estimate tokens of a whole transcript. */
export function estimateMessagesTokens(
  messages: readonly AgentMessage[],
  imageTokens = DEFAULT_IMAGE_TOKEN_ESTIMATE,
): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message, imageTokens), 0);
}

/** Count inline image blocks and their base64 payload bytes. */
export function imageLoad(messages: readonly AgentMessage[]): { readonly count: number; readonly bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const message of messages) {
    const content = (message as unknown as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Block[]) {
      if (block.type !== "image") continue;
      count += 1;
      bytes += typeof block.data === "string" ? block.data.length : 0;
    }
  }
  return { count, bytes };
}
