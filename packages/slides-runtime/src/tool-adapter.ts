/**
 * Adapt canonical `@open-slidestudio/slides-tools` definitions to
 * pi-agent-core `AgentTool`s: domain argument validation becomes a structured
 * INVALID_ARGS failure, neutral image blocks become pi-ai `ImageContent`,
 * `onContentDelivered` is deferred until the runtime commits the tool-result
 * message, every call has an upper time bound, and tools that are not
 * `concurrencySafe` never overlap.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  isSlideToolArgsError,
  type SlideCaller,
  type SlideImageBlock,
  type SlideToolContext,
  type SlideToolDefinition,
  type SlideToolResult,
} from "@open-slidestudio/slides-tools";

export const DEFAULT_TOOL_TIMEOUT_MS = 10 * 60_000;
export const IMAGES_UNSUPPORTED_NOTE =
  "Image content omitted: the selected model does not accept images, so the picture was not sent. Rely on the text fields above.";

export type ProjectBinding = { readonly projectId: string; readonly projectRoot: string };

/** Thrown from `execute` for invalid model arguments; the runtime reports it as INVALID_ARGS. */
export class RuntimeToolArgsError extends Error {
  readonly code = "INVALID_ARGS";
  constructor(
    readonly toolName: string,
    readonly violations: readonly string[],
  ) {
    super(`invalid arguments for tool ${toolName}: ${violations.join("; ")}`);
    this.name = "ToolArgsError";
  }
}

export type BoundedOutcome<T> = { readonly value: T } | { readonly timedOut: true } | { readonly aborted: true };

async function waitForGate(
  previous: Promise<void>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<"ready" | "timedOut" | "aborted"> {
  if (signal?.aborted) return "aborted";
  if (timeoutMs <= 0) return "timedOut";
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<"ready" | "timedOut" | "aborted">((resolve) => {
      timer = setTimeout(() => resolve("timedOut"), timeoutMs);
      if (signal) {
        onAbort = () => resolve("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
      }
      void previous.then(
        () => resolve("ready"),
        () => resolve("ready"),
      );
    });
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** FIFO mutex serializing non-concurrency-safe tools. Timed-out tasks hold the slot until settled. */
export class SerialGate {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Wait for the previous task (bounded by `signal` and `timeoutMs`), then run `task`.
   * If `task` times out while ignoring abort, the serial slot stays occupied until the
   * underlying promise settles so a later tool cannot overlap it on disk.
   */
  async runBounded<T>(
    task: (signal: AbortSignal) => Promise<T>,
    parent: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<BoundedOutcome<T>> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const currentTail = this.tail;
      const status = await waitForGate(currentTail, parent, deadline - Date.now());
      if (status === "aborted") return { aborted: true };
      if (status === "timedOut") return { timedOut: true };
      if (this.tail === currentTail) break;
    }
    if (parent?.aborted) return { aborted: true };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { timedOut: true };
    let releaseTail!: () => void;
    this.tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    return withTimeout(task, parent, remaining, releaseTail);
  }
}

export type ToolAdapterContext = {
  readonly caller: SlideCaller;
  readonly sessionId: string;
  readonly binding: () => ProjectBinding | undefined;
  readonly acceptsImages: () => boolean;
  readonly timeoutMs?: number;
  /** Cap for the rendered model text (ModelPolicyProfile.maxToolResultChars). */
  readonly maxResultChars?: number;
  readonly serial: SerialGate;
  /** Called when argument validation fails for a call id. */
  readonly onInvalidArgs: (callId: string, error: RuntimeToolArgsError) => void;
  /** Register the delivery hook the runtime fires after the result message is committed. */
  readonly deferDelivery: (callId: string, hook: () => Promise<void>) => void;
  /** Active turn abort signal, linked into the tool context signal while deferred delivery runs. */
  readonly turnSignal?: () => AbortSignal | undefined;
};

export function encodeImageContent(block: SlideImageBlock): ImageContent {
  const data = Buffer.from(block.data.buffer, block.data.byteOffset, block.data.byteLength).toString("base64");
  const png = block.data[0] === 0x89 && block.data[1] === 0x50;
  const jpeg = block.data[0] === 0xff && block.data[1] === 0xd8;
  return { type: "image", data, mimeType: png ? "image/png" : jpeg ? "image/jpeg" : block.mediaType };
}

function renderText(def: SlideToolDefinition, data: Record<string, unknown>, maxChars?: number): string {
  const text = typeof def.render === "function" ? def.render(data) : JSON.stringify(data);
  if (!maxChars || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function errorResult(error: string, detail: string, extra: Record<string, unknown> = {}): AgentToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error, detail, ...extra }) }],
    details: undefined,
    isError: true,
  };
}

/** Map a neutral result to model content; returns the delivery hook only when images were sent. */
export function toAgentToolResult(
  def: SlideToolDefinition,
  result: SlideToolResult,
  acceptsImages: boolean,
  maxChars?: number,
): { result: AgentToolResult; deliver?: () => Promise<void> } {
  const content: (TextContent | ImageContent)[] = [{ type: "text", text: renderText(def, result.data, maxChars) }];
  for (const block of result.content ?? []) if (block.type === "text") content.push({ type: "text", text: block.text });
  const images = (result.content ?? []).filter((block): block is SlideImageBlock => block.type === "image");
  if (images.length && acceptsImages) content.push(...images.map(encodeImageContent));
  else if (images.length) content.push({ type: "text", text: IMAGES_UNSUPPORTED_NOTE });
  const mapped: AgentToolResult = { content, details: undefined, ...(result.isError ? { isError: true } : {}) };
  const hook = images.length && acceptsImages ? result.onContentDelivered : undefined;
  return { result: mapped, ...(hook ? { deliver: hook } : {}) };
}

function toolContext(
  def: SlideToolDefinition,
  ctx: ToolAdapterContext,
  callId: string,
  signal: AbortSignal,
): SlideToolContext | undefined {
  const binding = def.requiresProject === false ? undefined : ctx.binding();
  if (def.requiresProject !== false && !binding) return undefined;
  return {
    projectId: binding?.projectId ?? "",
    projectRoot: binding?.projectRoot ?? "",
    callId,
    signal,
    caller: ctx.caller,
    sessionId: ctx.sessionId,
    acceptsImageContent: ctx.acceptsImages(),
  };
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal | undefined,
  timeoutMs: number,
  onSettled?: () => void,
): Promise<BoundedOutcome<T>> {
  if (parent?.aborted) {
    onSettled?.();
    return { aborted: true };
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ readonly timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("tool timeout"));
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  const inflight = Promise.resolve()
    .then(() => run(controller.signal))
    .finally(() => onSettled?.());
  // Absorb late rejections if timeout wins the race before `inflight` settles.
  inflight.catch(() => undefined);
  try {
    return await Promise.race([inflight.then((value) => ({ value })), timeout]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  }
}

async function runDefinition(
  def: SlideToolDefinition,
  ctx: ToolAdapterContext,
  callId: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  safe: boolean,
): Promise<AgentToolResult> {
  if (signal?.aborted) return errorResult("tool_aborted", `${def.name} was cancelled before execution`);
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const toolAbort = new AbortController();
  const invoke = async (child: AbortSignal) => {
    if (child.aborted) return undefined;
    const onChildAbort = () => toolAbort.abort(child.reason);
    child.addEventListener("abort", onChildAbort, { once: true });
    try {
      const toolCtx = toolContext(def, ctx, callId, toolAbort.signal);
      if (!toolCtx) return null;
      return await def.execute(args, toolCtx);
    } finally {
      child.removeEventListener("abort", onChildAbort);
    }
  };
  const outcome = safe
    ? await withTimeout(invoke, signal, timeoutMs)
    : await ctx.serial.runBounded(invoke, signal, timeoutMs);
  if ("aborted" in outcome) return errorResult("tool_aborted", `${def.name} was cancelled before execution`);
  if ("timedOut" in outcome) {
    return errorResult("tool_timeout", `${def.name} exceeded ${timeoutMs} ms and was cancelled`);
  }
  if (outcome.value === undefined) return errorResult("tool_aborted", `${def.name} was cancelled before execution`);
  if (outcome.value === null) {
    return errorResult("project_not_bound", "No project is bound to this run: call open_project first.");
  }
  const mapped = toAgentToolResult(def, outcome.value, ctx.acceptsImages(), ctx.maxResultChars);
  if (mapped.deliver) {
    const deliver = mapped.deliver;
    ctx.deferDelivery(callId, async () => {
      const activeSignals = [ctx.turnSignal?.(), signal].filter((item): item is AbortSignal => Boolean(item));
      const aborted = activeSignals.find((item) => item.aborted);
      if (aborted) {
        toolAbort.abort(aborted.reason);
        return;
      }
      const cleanups = activeSignals.map((item) => {
        const onAbort = () => toolAbort.abort(item.reason);
        item.addEventListener("abort", onAbort, { once: true });
        return () => item.removeEventListener("abort", onAbort);
      });
      try {
        await deliver();
      } finally {
        for (const off of cleanups) off();
      }
    });
  }
  return mapped.result;
}

/** One canonical slide tool as a pi-agent-core tool. */
export function adaptSlideTool(def: SlideToolDefinition, ctx: ToolAdapterContext): AgentTool {
  const safe = def.concurrencySafe === true;
  return {
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: def.inputSchema,
    ...(safe ? {} : { executionMode: "sequential" as const }),
    async execute(callId, params, signal) {
      if (signal?.aborted) return errorResult("tool_aborted", `${def.name} was cancelled before execution`);
      const args = (params ?? {}) as Record<string, unknown>;
      try {
        def.validate?.(args);
      } catch (error) {
        if (!isSlideToolArgsError(error)) throw error;
        const invalid = new RuntimeToolArgsError(def.name, error.violations);
        ctx.onInvalidArgs(callId, invalid);
        throw invalid;
      }
      try {
        return await runDefinition(def, ctx, callId, args, signal, safe);
      } catch (error) {
        if (!isSlideToolArgsError(error)) throw error;
        const invalid = new RuntimeToolArgsError(def.name, error.violations);
        ctx.onInvalidArgs(callId, invalid);
        throw invalid;
      }
    },
  };
}
