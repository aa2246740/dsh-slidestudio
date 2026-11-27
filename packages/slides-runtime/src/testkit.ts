/** Offline fixtures for slides-runtime tests: temp roots and a deterministic scripted LLM port. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type SimpleStreamOptions,
  type ToolCall,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import { createPresentationRun, resolveRepoRoot, type PresentationRun } from "@open-slidestudio/presentation-run";
import {
  assistantShell,
  attachLlmFailure,
  modelForRoute,
  type LlmFailure,
  type LlmPort,
  type LlmRoute,
} from "./llm-port.js";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `slides-runtime-${prefix}-`)));
}

export function testPresentation(): PresentationRun {
  return createPresentationRun({ repoRoot: resolveRepoRoot(PACKAGE_ROOT) });
}

export const TEST_ROUTE: LlmRoute = {
  providerId: "scripted",
  modelId: "scripted-1",
  contextWindow: 200_000,
  maxTokens: 8_192,
  inputModalities: ["text", "image"],
};

export type ScriptReply = (
  | { readonly text: string }
  | { readonly calls: readonly { readonly name: string; readonly args: Record<string, unknown> }[] }
  | { readonly failure: LlmFailure }
  | { readonly hang: true }
  /** Reply cut off by the output limit (`stopReason: "length"`) without tool calls. */
  | { readonly truncated: { readonly thinking?: string; readonly text?: string } }
) & {
  /** Provider-reported usage for the reply (input tokens drive online calibration). */
  readonly usage?: Partial<Usage>;
};

export type ScriptStep = (context: TranscriptContext, call: number) => ScriptReply | Promise<ScriptReply>;

let callCounter = 0;

function toolCalls(reply: Extract<ScriptReply, { calls: unknown }>): ToolCall[] {
  return reply.calls.map((call) => ({
    type: "toolCall",
    id: `call-${++callCounter}`,
    name: call.name,
    arguments: call.args as ToolCall["arguments"],
  }));
}

/** Deterministic port: the n-th request answers with `steps[n](context)`; extra requests stop with "done". */
export class ScriptedLlm implements LlmPort {
  readonly route: LlmRoute;
  readonly model;
  readonly requests: { context: TranscriptContext; options?: SimpleStreamOptions }[] = [];

  constructor(
    private readonly steps: readonly ScriptStep[],
    route: Partial<LlmRoute> = {},
  ) {
    this.route = { ...TEST_ROUTE, ...route };
    this.model = modelForRoute(this.route, { api: "scripted" });
  }

  readonly stream: StreamFn = (model, context, options) => {
    const index = this.requests.length;
    this.requests.push({ context, ...(options ? { options } : {}) });
    const out = createAssistantMessageEventStream();
    const shell = assistantShell(model);
    out.push({ type: "start", partial: shell });
    void (async () => {
      const step = this.steps[index];
      const reply: ScriptReply = step ? await step(context, index) : { text: "done" };
      this.finish(out, shell, reply, options?.signal);
    })();
    return out;
  };

  private finish(
    out: ReturnType<typeof createAssistantMessageEventStream>,
    shell: AssistantMessage,
    reply: ScriptReply,
    signal?: AbortSignal,
  ): void {
    if (reply.usage) shell = { ...shell, usage: { ...shell.usage, ...reply.usage } };
    if ("hang" in reply) {
      const onAbort = () => {
        const aborted = attachLlmFailure({ ...shell, stopReason: "aborted" }, { code: "ABORTED", message: "aborted" });
        out.push({ type: "error", reason: "aborted", error: aborted });
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      return;
    }
    if ("failure" in reply) {
      const failed = attachLlmFailure({ ...shell, stopReason: "error" }, reply.failure);
      out.push({ type: "error", reason: "error", error: failed });
      return;
    }
    if ("truncated" in reply) {
      const content: AssistantMessage["content"] = [
        ...(reply.truncated.thinking ? [{ type: "thinking" as const, thinking: reply.truncated.thinking }] : []),
        ...(reply.truncated.text ? [{ type: "text" as const, text: reply.truncated.text }] : []),
      ];
      out.push({ type: "done", reason: "length", message: { ...shell, content, stopReason: "length" } });
      return;
    }
    if ("text" in reply) {
      const message: AssistantMessage = { ...shell, content: [{ type: "text", text: reply.text }], stopReason: "stop" };
      out.push({ type: "done", reason: "stop", message });
      return;
    }
    const message: AssistantMessage = { ...shell, content: toolCalls(reply), stopReason: "toolUse" };
    out.push({ type: "done", reason: "toolUse", message });
  }
}

/** JSON of the most recent tool result for `toolName` in a request context. */
export function lastResultData(context: TranscriptContext, toolName: string): Record<string, unknown> {
  const messages = context.messages as Message[];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "toolResult" || message.toolName !== toolName) continue;
    const first = message.content.find((block) => block.type === "text");
    return first && first.type === "text" ? (JSON.parse(first.text) as Record<string, unknown>) : {};
  }
  throw new Error(`no ${toolName} result in context`);
}

export function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("condition not reached in time"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const INK = "#1F2937";

export function pageArgs(id: string): Record<string, unknown> {
  return {
    id,
    pageType: "content",
    elements: [
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 120, 800, 70],
        content: { text: `第 ${id} 页标题`, fontSize: 32, color: INK },
      },
      {
        elementId: "body",
        elementType: "text",
        bounds: [80, 220, 800, 160],
        content: { text: "明确负责人，核对输入信息，再记录交付结果。", fontSize: 24, color: INK },
      },
    ],
  };
}
