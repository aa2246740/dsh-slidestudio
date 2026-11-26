/**
 * DSH `StreamChunk` -> pi-ai `AssistantMessageEventStream`. Blocks are keyed
 * by the DSH block index; text, reasoning and tool-call blocks map to
 * `text_*`, `thinking_*` and `toolcall_*` events. `finish` sets the stop
 * reason (`tool-calls` -> `toolUse`, `max-tokens` -> `length`) or ends with a
 * structured failure. Never throws: iteration errors become an error event.
 */
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type JsonValue,
  type Model,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  assistantShell,
  attachLlmFailure,
  failureFromThrown,
  scrubRegisteredSecrets,
  type LlmFailure,
} from "@open-slidestudio/slides-runtime";
import type { DshBlockEndPayload, DshLlmFailure, DshStreamChunk } from "./dsh-llm-port.js";

export const DSH_REPLAY_STATE_DIAGNOSTIC = "slides-runtime/dsh-replay-state";

function scrubReplayNode(
  value: unknown,
  ancestors: Set<object>,
  cache: WeakMap<object, unknown>,
): { value: unknown; cyclic: boolean } {
  if (typeof value === "string") return { value: scrubRegisteredSecrets(value), cyclic: false };
  if (value === null || typeof value !== "object") return { value, cyclic: false };
  if (ancestors.has(value)) return { value: "[circular]", cyclic: true };
  if (cache.has(value)) return { value: cache.get(value), cyclic: false };
  ancestors.add(value);
  let cyclic = false;
  try {
    if (Array.isArray(value)) {
      const out = value.map((item) => {
        const child = scrubReplayNode(item, ancestors, cache);
        if (child.cyclic) cyclic = true;
        return child.value;
      });
      if (!cyclic) cache.set(value, out);
      return { value: out, cyclic };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = scrubReplayNode(v, ancestors, cache);
      if (child.cyclic) cyclic = true;
      out[k] = child.value;
    }
    if (!cyclic) cache.set(value, out);
    return { value: out, cyclic };
  } finally {
    ancestors.delete(value);
  }
}

function scrubReplaySecrets(value: unknown): unknown {
  return scrubReplayNode(value, new Set<object>(), new WeakMap<object, unknown>()).value;
}

export function readDshReplayState(message: AssistantMessage): unknown {
  const row = message.diagnostics?.find((item) => item.type === DSH_REPLAY_STATE_DIAGNOSTIC);
  return row?.details && "replayState" in row.details ? scrubReplaySecrets(row.details.replayState) : undefined;
}

function attachDshReplayState(message: AssistantMessage, replayState: unknown): void {
  const sanitized = scrubReplaySecrets(replayState);
  const others = (message.diagnostics ?? []).filter((row) => row.type !== DSH_REPLAY_STATE_DIAGNOSTIC);
  message.diagnostics = [
    ...others,
    {
      type: DSH_REPLAY_STATE_DIAGNOSTIC,
      timestamp: Date.now(),
      details: { replayState: sanitized as JsonValue },
    },
  ];
}

type Open = { readonly kind: "text" | "thinking" | "toolCall"; readonly at: number; raw: string; ended: boolean };
type Usage = Extract<DshStreamChunk, { type: "usage" }>["usage"];
type Finish = Extract<DshStreamChunk, { type: "finish" }>;

function failureOf(failure: DshLlmFailure): LlmFailure {
  return {
    code: failure.code,
    message: failure.message,
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.providerRetryAfterMs !== undefined ? { retryAfterMs: failure.providerRetryAfterMs } : {}),
    ...(failure.requestId ? { requestId: failure.requestId } : {}),
  };
}

function parseArguments(raw: string): { arguments: JsonObject; argumentsError?: string } {
  if (!raw.trim()) return { arguments: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { arguments: parsed as JsonObject };
    return { arguments: {}, argumentsError: "tool-call arguments are not a JSON object" };
  } catch (error) {
    return { arguments: {}, argumentsError: `tool-call arguments are not valid JSON: ${(error as Error).message}` };
  }
}

const BLOCK_KINDS: Record<string, Open["kind"] | undefined> = {
  text: "text",
  reasoning: "thinking",
  "tool-call": "toolCall",
};

export class DshChunkAssembler {
  readonly stream: AssistantMessageEventStream = createAssistantMessageEventStream();
  private readonly message: AssistantMessage;
  private readonly blocks = new Map<number, Open>();
  private settled = false;

  constructor(model: Model<Api>) {
    this.message = assistantShell(model);
    this.stream.push({ type: "start", partial: this.message });
  }

  private open(index: number, kind: Open["kind"]): Open {
    const existing = this.blocks.get(index);
    if (existing) return existing;
    const at = this.message.content.length;
    const block: TextContent | ThinkingContent | ToolCall =
      kind === "text"
        ? { type: "text", text: "" }
        : kind === "thinking"
          ? { type: "thinking", thinking: "" }
          : { type: "toolCall", id: "", name: "", arguments: {} };
    this.message.content.push(block);
    const open: Open = { kind, at, raw: "", ended: false };
    this.blocks.set(index, open);
    const type = kind === "text" ? "text_start" : kind === "thinking" ? "thinking_start" : "toolcall_start";
    this.stream.push({ type, contentIndex: at, partial: this.message });
    return open;
  }

  private delta(index: number, kind: Open["kind"], text: string): void {
    const open = this.open(index, kind);
    const block = this.message.content[open.at]!;
    if (block.type === "text") block.text += text;
    else if (block.type === "thinking") block.thinking += text;
    const type = kind === "text" ? "text_delta" : "thinking_delta";
    this.stream.push({ type, contentIndex: open.at, delta: text, partial: this.message });
  }

  private toolDelta(chunk: Extract<DshStreamChunk, { type: "tool-call-delta" }>): void {
    const open = this.open(chunk.index, "toolCall");
    const block = this.message.content[open.at] as ToolCall;
    if (chunk.id) block.id = chunk.id;
    if (chunk.name) block.name = chunk.name;
    open.raw += chunk.argumentsDelta;
    this.stream.push({
      type: "toolcall_delta",
      contentIndex: open.at,
      delta: chunk.argumentsDelta,
      partial: this.message,
    });
  }

  private end(index: number, final?: DshBlockEndPayload): void {
    const open = this.blocks.get(index);
    if (!open || open.ended) return;
    open.ended = true;
    const block = this.message.content[open.at]!;
    if (block.type === "text") {
      if (typeof final?.text === "string") block.text = final.text;
      this.stream.push({ type: "text_end", contentIndex: open.at, content: block.text, partial: this.message });
    } else if (block.type === "thinking") {
      if (typeof final?.text === "string") block.thinking = final.text;
      this.stream.push({ type: "thinking_end", contentIndex: open.at, content: block.thinking, partial: this.message });
    } else {
      if (typeof final?.id === "string" && final.id) block.id = final.id;
      if (typeof final?.name === "string" && final.name) block.name = final.name;
      const parsed = parseArguments(typeof final?.arguments === "string" ? final.arguments : open.raw);
      block.arguments = parsed.arguments;
      if (parsed.argumentsError) block.argumentsError = parsed.argumentsError;
      this.stream.push({ type: "toolcall_end", contentIndex: open.at, toolCall: block, partial: this.message });
    }
  }

  private usage(usage: Usage): void {
    const input = usage.inputTokens;
    const output = usage.outputTokens;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    this.message.usage = {
      ...this.message.usage,
      input,
      output,
      cacheRead,
      cacheWrite,
      ...(usage.reasoningTokens !== undefined ? { reasoning: usage.reasoningTokens } : {}),
      totalTokens: usage.totalTokens ?? input + output + cacheRead + cacheWrite,
    };
  }

  private fail(failure: LlmFailure, aborted: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.message.stopReason = aborted ? "aborted" : "error";
    attachLlmFailure(this.message, failure);
    this.stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: this.message });
  }

  private finish(chunk: Finish): void {
    for (const index of this.blocks.keys()) this.end(index);
    const reason = chunk.reason;
    if (reason.kind === "aborted" || reason.kind === "error") {
      this.fail(failureOf(reason.failure), reason.kind === "aborted");
      return;
    }
    this.settled = true;
    if (chunk.replayState !== undefined) attachDshReplayState(this.message, chunk.replayState);
    const stop = reason.kind === "tool-calls" ? "toolUse" : reason.kind === "max-tokens" ? "length" : "stop";
    this.message.stopReason = stop;
    this.stream.push({ type: "done", reason: stop, message: this.message });
  }

  /** Apply one DSH chunk. */
  push(chunk: DshStreamChunk): void {
    if (this.settled) return;
    switch (chunk.type) {
      case "block-start": {
        const kind = BLOCK_KINDS[chunk.blockType];
        if (kind) this.open(chunk.index, kind);
        return;
      }
      case "text-delta":
        return this.delta(chunk.index, "text", chunk.text);
      case "reasoning-delta":
        return this.delta(chunk.index, "thinking", chunk.text);
      case "tool-call-delta":
        return this.toolDelta(chunk);
      case "block-end": {
        const kind = BLOCK_KINDS[chunk.block.type];
        if (kind) this.open(chunk.index, kind);
        return this.end(chunk.index, chunk.block);
      }
      case "usage":
        return this.usage(chunk.usage);
      case "finish":
        return this.finish(chunk);
    }
  }

  /** Drive the DSH stream to completion; transport errors and early ends become failures. */
  async consume(source: () => AsyncIterable<DshStreamChunk>, signal?: AbortSignal): Promise<void> {
    try {
      for await (const chunk of source()) {
        this.push(chunk);
        if (this.settled) break;
      }
      if (!this.settled) {
        this.fail(
          signal?.aborted
            ? { code: "ABORTED", message: "the request was aborted" }
            : { code: "STREAM_INCOMPLETE", message: "the DSH stream ended without a finish chunk" },
          signal?.aborted === true,
        );
      }
    } catch (error) {
      this.fail(failureFromThrown(error, "DSH_LLM_ERROR"), signal?.aborted === true);
    }
  }
}
