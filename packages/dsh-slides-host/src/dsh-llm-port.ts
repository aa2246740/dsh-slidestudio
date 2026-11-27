/**
 * `DshLlmPort`: the `@open-slidestudio/slides-runtime` `LlmPort` served by
 * DSH's `ctx.llm.stream(GenerateOptions)`. A pi-ai transcript becomes DSH
 * request messages (inline images are promoted to attachments through
 * `ctx.attachments.saveImage`, failing closed when the service is absent) and
 * DSH `StreamChunk`s become a pi-ai `AssistantMessageEventStream` with
 * stopReason, usage and structured failures (code, status, Retry-After).
 * Types are structural so DSH 0.2.0-rc.2 and 0.2.2-rc.5 both satisfy them.
 */
import crypto from "node:crypto";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  failedStream,
  failureFromThrown,
  modelForRoute,
  type LlmPort,
  type LlmRoute,
  type StreamFn,
} from "@open-slidestudio/slides-runtime";
import { DshChunkAssembler, readDshReplayState } from "./dsh-llm-stream.js";

export type DshImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type DshImageAttachmentRef = {
  readonly attachmentId: string;
  readonly mediaType: DshImageMediaType;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly name?: string;
};

export type DshContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "image"; readonly attachment: DshImageAttachmentRef }
  | { readonly type: "tool-call"; readonly id: string; readonly name: string; readonly arguments: string };

export type DshRequestMessage =
  | { readonly role: "user"; readonly content: readonly DshContentBlock[] }
  | {
      readonly role: "assistant";
      readonly id: string;
      readonly source: {
        readonly kind: "model";
        readonly provider: string;
        readonly model: string;
        readonly replayState?: unknown;
      };
      readonly content: readonly DshContentBlock[];
    }
  | {
      readonly role: "tool";
      readonly id: string;
      readonly source: { readonly kind: "tool"; readonly callId: string };
      readonly toolCallId: string;
      readonly isError?: boolean;
      readonly content: readonly DshContentBlock[];
    };

/** Structural supertype satisfied by DSH rc.2/rc.5 `RequestMessage` and `DshRequestMessage`. */
export type DshRequestMessageLike = {
  readonly role: string;
  readonly content: readonly { readonly type: string }[];
};

export type DshToolSchema = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
};

export type DshGenerateOptions = {
  provider: string;
  model: string;
  reasoningEffort?: string;
  messages: DshRequestMessage[];
  system?: string;
  tools?: DshToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

/**
 * Structural supertype satisfied by DSH 0.2.0-rc.2 and 0.2.2-rc.5 `GenerateOptions`
 * (including branded `ReasoningEffortId`, `MessageId`, `ToolCallId`, `AttachmentId`)
 * as well as plain `DshGenerateOptions`. Method bivariance on `DshLlmService.stream`
 * accepts both real `LlmRuntime` instances and plain test doubles without casts.
 */
export type DshGenerateOptionsLike = {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly messages: readonly DshRequestMessageLike[];
  readonly system?: string;
  readonly tools?: readonly DshToolSchema[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
};

export type DshLlmFailure = {
  readonly message: string;
  readonly code: string;
  readonly status?: number;
  readonly providerRetryAfterMs?: number;
  readonly requestId?: string;
};

export type DshBlockEndPayload = {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
};

export type DshStreamChunk =
  | { readonly type: "block-start"; readonly index: number; readonly blockType: string }
  | { readonly type: "text-delta"; readonly index: number; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly index: number; readonly text: string }
  | {
      readonly type: "tool-call-delta";
      readonly index: number;
      readonly id: string;
      readonly name?: string;
      readonly argumentsDelta: string;
    }
  | {
      readonly type: "block-end";
      readonly index: number;
      readonly block: DshBlockEndPayload;
    }
  | {
      readonly type: "usage";
      readonly usage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly totalTokens?: number;
        readonly cacheReadTokens?: number;
        readonly cacheWriteTokens?: number;
        readonly reasoningTokens?: number;
      };
    }
  | {
      readonly type: "finish";
      readonly reason:
        | { readonly kind: "stop" | "tool-calls" | "max-tokens" }
        | { readonly kind: "aborted" | "error"; readonly failure: DshLlmFailure };
      readonly replayState?: unknown;
    };

/** The slice of `ctx.llm` the port needs (compatible with rc.2 and rc.5 `LlmRuntime`). */
export type DshLlmService = { stream(options: DshGenerateOptionsLike): AsyncIterable<DshStreamChunk> };

/** The slice of `ctx.attachments` the port needs. */
export type DshAttachmentService = {
  saveImage(input: { data: Uint8Array; mediaType: DshImageMediaType; name?: string }): Promise<DshImageAttachmentRef>;
};

export type DshLlmPortOptions = {
  readonly llm: DshLlmService;
  readonly attachments?: DshAttachmentService;
  readonly route: LlmRoute;
  readonly temperature?: number;
};

export const DSH_ATTACHMENTS_UNAVAILABLE = "ATTACHMENTS_UNAVAILABLE";
const MEDIA_TYPES: readonly DshImageMediaType[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

type PiBlock = { type: string; [key: string]: unknown };

function textBlocks(content: unknown): PiBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : ((content as PiBlock[] | undefined) ?? []);
}

class MissingAttachments extends Error {
  readonly code = DSH_ATTACHMENTS_UNAVAILABLE;
  constructor() {
    super("the DSH attachments service is not mounted; cannot send the image to the selected model");
  }
}

/** Converts a pi-ai transcript into DSH request messages, caching promoted images by content hash. */
class RequestBuilder {
  private readonly saved = new Map<string, Promise<DshImageAttachmentRef>>();

  constructor(private readonly attachments?: DshAttachmentService) {}

  private image(block: PiBlock): Promise<DshImageAttachmentRef> {
    if (!this.attachments) return Promise.reject(new MissingAttachments());
    const data = String(block.data ?? "");
    const key = crypto.createHash("sha256").update(data).digest("hex");
    let ref = this.saved.get(key);
    if (!ref) {
      const declared = String(block.mimeType ?? "image/png") as DshImageMediaType;
      const mediaType = MEDIA_TYPES.includes(declared) ? declared : "image/png";
      ref = this.attachments.saveImage({ data: Buffer.from(data, "base64"), mediaType });
      ref.catch(() => this.saved.delete(key));
      this.saved.set(key, ref);
    }
    return ref;
  }

  private async content(blocks: readonly PiBlock[]): Promise<DshContentBlock[]> {
    const out: DshContentBlock[] = [];
    for (const block of blocks) {
      if (block.type === "text") out.push({ type: "text", text: String(block.text ?? "") });
      else if (block.type === "thinking") out.push({ type: "reasoning", text: String(block.thinking ?? "") });
      else if (block.type === "image") out.push({ type: "image", attachment: await this.image(block) });
      else if (block.type === "toolCall") {
        out.push({
          type: "tool-call",
          id: String(block.id),
          name: String(block.name),
          arguments: JSON.stringify(block.arguments ?? {}),
        });
      }
    }
    return out;
  }

  async message(message: Message): Promise<DshRequestMessage | undefined> {
    const id = `msg-${crypto.randomUUID()}`;
    if (message.role === "user") return { role: "user", content: await this.content(textBlocks(message.content)) };
    if (message.role === "assistant") {
      const replayState = readDshReplayState(message);
      return {
        role: "assistant",
        id,
        source: {
          kind: "model",
          provider: message.provider,
          model: message.model,
          ...(replayState !== undefined ? { replayState } : {}),
        },
        content: await this.content(message.content as unknown as PiBlock[]),
      };
    }
    if (message.role === "toolResult") {
      return {
        role: "tool",
        id,
        source: { kind: "tool", callId: message.toolCallId },
        toolCallId: message.toolCallId,
        ...(message.isError ? { isError: true } : {}),
        content: await this.content(message.content as unknown as PiBlock[]),
      };
    }
    return undefined;
  }
}

/** pi-ai transcript + stream options -> DSH `GenerateOptions`. */
export async function toDshGenerateOptions(
  route: LlmRoute,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  builder: { message(message: Message): Promise<DshRequestMessage | undefined> },
  temperature?: number,
): Promise<DshGenerateOptions> {
  const messages: DshRequestMessage[] = [];
  for (const message of context.messages) {
    const converted = await builder.message(message);
    if (converted) messages.push(converted);
  }
  const system = getCurrentSystemPrompt(context.messages);
  const tools = getCurrentTools(context.messages).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Record<string, unknown>,
  }));
  const hasExplicitReasoning = options !== undefined && Object.prototype.hasOwnProperty.call(options, "reasoning");
  const effort = hasExplicitReasoning ? options.reasoning : route.reasoningEffort;
  const temp = options?.temperature ?? temperature;
  return {
    provider: route.providerId,
    model: route.modelId,
    ...(effort && effort !== "off" ? { reasoningEffort: effort } : {}),
    messages,
    ...(system ? { system } : {}),
    ...(tools.length ? { tools } : {}),
    ...(temp !== undefined ? { temperature: temp } : {}),
    ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  };
}

export class DshLlmPort implements LlmPort {
  readonly route: LlmRoute;
  readonly model: Model<Api>;
  private readonly builder: RequestBuilder;

  constructor(private readonly options: DshLlmPortOptions) {
    this.route = options.route;
    this.model = modelForRoute(options.route, { api: "dsh-llm" });
    this.builder = new RequestBuilder(options.attachments);
  }

  readonly stream: StreamFn = async (model, context, streamOptions) => {
    let request: DshGenerateOptions;
    try {
      request = await toDshGenerateOptions(this.route, context, streamOptions, this.builder, this.options.temperature);
    } catch (error) {
      return failedStream(
        model,
        failureFromThrown(error, "REQUEST_CONVERSION"),
        streamOptions?.signal?.aborted === true,
      );
    }
    const assembler = new DshChunkAssembler(model);
    void assembler.consume(() => this.options.llm.stream(request), streamOptions?.signal);
    return assembler.stream;
  };
}
