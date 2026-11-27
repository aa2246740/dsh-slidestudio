/**
 * Offline token estimation for mixed Chinese/English content. CJK ideographs,
 * kana, hangul and full-width punctuation cost roughly one token each; other
 * text costs roughly one token per 3.5 UTF-8 bytes (JSON tool arguments and
 * code tokenize denser than prose). Images use a fixed per-block estimate.
 * Estimates are deliberately conservative (rounded up); `TokenCalibration`
 * corrects them online from provider-reported usage.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export const DEFAULT_IMAGE_TOKEN_ESTIMATE = 1_200;
const MESSAGE_OVERHEAD_TOKENS = 4;
const BYTES_PER_LATIN_TOKEN = 3.5;

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

/** Bounds of the online calibration multiplier. */
export const CALIBRATION_BOUNDS = { min: 0.7, max: 1.8 } as const;

/** Provider-reported input tokens of one request (prompt-cache reads/writes included). */
export function reportedInputTokens(usage: Partial<Usage> | undefined): number {
  if (!usage) return 0;
  const part = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  return part(usage.input) + part(usage.cacheRead) + part(usage.cacheWrite);
}

/**
 * Online estimate calibration: the estimate of the last dispatched request is
 * compared with the provider's real `usage.input` once its reply arrives, and
 * the ratio (bounded to `CALIBRATION_BOUNDS`) scales later estimates so the
 * budget of a 64k/128k window stays accurate for the active tokenizer.
 */
export class TokenCalibration {
  private factor = 1;
  private pendingEstimate?: number;

  constructor(
    private readonly bounds: { readonly min: number; readonly max: number } = CALIBRATION_BOUNDS,
    /** Weight of the newest observation (1 = latest ratio wins). */
    private readonly weight = 1,
  ) {}

  get multiplier(): number {
    return this.factor;
  }

  /** Record the uncalibrated estimate of the request that was just sent. */
  recordRequest(estimatedTokens: number): void {
    this.pendingEstimate = estimatedTokens > 0 ? estimatedTokens : undefined;
  }

  /** Fold the real usage of the pending request in; returns the multiplier now in force. */
  observeUsage(usage: Partial<Usage> | undefined): number {
    const estimate = this.pendingEstimate;
    const actual = reportedInputTokens(usage);
    this.pendingEstimate = undefined;
    if (!estimate || actual <= 0) return this.factor;
    const ratio = Math.min(this.bounds.max, Math.max(this.bounds.min, actual / estimate));
    const next = this.factor + (ratio - this.factor) * Math.min(1, Math.max(0, this.weight));
    this.factor = Math.min(this.bounds.max, Math.max(this.bounds.min, next));
    return this.factor;
  }

  /** Scale an uncalibrated estimate. */
  apply(tokens: number): number {
    return Math.ceil(tokens * this.factor);
  }

  reset(): void {
    this.factor = 1;
    this.pendingEstimate = undefined;
  }
}
