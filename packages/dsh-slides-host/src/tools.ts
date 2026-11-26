/**
 * DSH bridge for the canonical slide tools. Every product tool is defined once
 * in `@open-slidestudio/slides-tools`; this module only maps a DSH execution
 * (`exec.agent.id`) onto a host-neutral `SlideToolContext`, routes neutral
 * image blocks through the DSH attachments service, and keeps the rc.2/rc.5
 * registration and step-visibility compatibility.
 */
import fs from "node:fs";
import path from "node:path";
import {
  defineTool,
  ToolArgsError,
  validateJsonSchemaValue,
  type JsonSchemaNode,
  type ToolDefinition,
  type ToolRuntime,
} from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
  inspectCapabilities,
  inspectProjectCapabilities,
  persistPresentationRunProvider,
} from "@open-slidestudio/presentation-run";
import type { CapabilitySnapshot, ModelInputModality, PresentationRun } from "@open-slidestudio/presentation-run";
import {
  addCapabilityTools,
  applyProjectEditScopes,
  createSlideTools,
  isSlideToolArgsError,
  readProjectLease,
  renderPageToolContent,
  withProjectLeaseLock,
  type SlideToolContext,
  type SlideToolDefinition,
  type SlideToolResult,
  type SlideToolRuntimeDeps,
} from "@open-slidestudio/slides-tools";
import { discussionOnly, DISCUSSION_TOOLS } from "./assistant-conversation.js";
import type { AgentFaults } from "./agent-fault.js";
import { CAPABILITY_FILTERED_PRODUCE_TOOL_NAMES } from "./produce-request-header.js";
import { SLICE_TOOL_NAMES } from "./protocol.js";
import { SliceSessionStore } from "./slice-session.js";
import { isSliceToolStepVisible, registerToolWithWhen, sliceToolGuard } from "./tool-visibility.js";

export { isSliceToolStepVisible, sliceToolGuard };
export {
  aiReviewPageVersionConflict,
  autoRenderWriteOutcome,
  formatWritePageOutcome,
  readPageFromProject,
} from "@open-slidestudio/slides-tools";

export type SliceAttachments = {
  saveImage(input: { data: Uint8Array; mediaType: "image/png" | "image/jpeg"; name?: string }): Promise<{
    attachmentId: string;
    mediaType: string;
    bytes: number;
    width: number;
    height: number;
    name?: string;
  }>;
};

export type SliceToolDeps = {
  store: SliceSessionStore;
  presentation: PresentationRun;
  workspaceRoot: string;
  editorBaseUrl: string;
  faults: AgentFaults;
  provider: {
    providerId: string;
    modelId: string;
    ready?: boolean;
    modelInputModalities?: readonly ModelInputModality[];
  };
  reasoningEffort?: string;
  attachments?: SliceAttachments;
  /** Re-bind the live xAI oauth token before hosted generate/search. */
  ensureGrokImageEnv?: () => void;
};

/** The Hub embeds the native editor, so the editor-link tool is not offered to Hub runs. */
const DSH_HIDDEN_CANONICAL_TOOLS: ReadonlySet<string> = new Set(["open_in_editor"]);

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Normalize a provider wire `function.arguments` envelope on a product tool
 * that did not declare `arguments` as one of its own business fields.
 *
 * A chain of envelopes is unwrapped while each level is unambiguous: `arguments`
 * is the sole top-level key and its value is a plain object. Once the inner
 * record is reached, every key must be a declared field or the call is rejected,
 * so a genuinely malformed call cannot be normalized into a successful call or
 * acquire a success receipt. Depth is capped to bound pathological nesting.
 */
const MAX_ARGUMENT_ENVELOPE_DEPTH = 4;

function unwrapEnvelope(top: Record<string, unknown>): Record<string, unknown> {
  let record = top;
  let depth = 0;
  while (
    Object.hasOwn(record, "arguments") &&
    Object.keys(record).length === 1 &&
    depth < MAX_ARGUMENT_ENVELOPE_DEPTH
  ) {
    const inner = plainRecord(record.arguments);
    if (inner === undefined) break;
    record = inner;
    depth += 1;
  }
  return record;
}

export function withProductToolArgumentContract(definition: ToolDefinition): ToolDefinition {
  const properties = plainRecord(definition.parameters.properties);
  if (properties && Object.hasOwn(properties, "arguments")) return definition;

  const declaredKeys = properties ? new Set(Object.keys(properties)) : new Set<string>();
  const expected = declaredKeys.size ? [...declaredKeys].join(", ") : "(no declared fields)";
  const execute = definition.execute;
  return {
    ...definition,
    async execute(rawArgs, exec) {
      const top = plainRecord(rawArgs);
      if (top === undefined || !Object.hasOwn(top, "arguments")) {
        return execute(rawArgs, exec);
      }
      const record = unwrapEnvelope(top);
      if (Object.hasOwn(record, "arguments") || !Object.keys(record).every((key) => declaredKeys.has(key))) {
        throw new ToolArgsError([
          `$args.arguments is a provider wire envelope, not a declared field of ${definition.name}; pass the declared fields directly at the top level: ${expected}`,
        ]);
      }
      return execute({ ...record }, exec);
    },
  };
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

const CAPABILITY_FILTERED_PRODUCE_TOOLS = new Set<string>(CAPABILITY_FILTERED_PRODUCE_TOOL_NAMES);

export function produceToolAllowlist(caps: CapabilitySnapshot): ReadonlySet<string> {
  const allowed = new Set<string>(SLICE_TOOL_NAMES.filter((name) => !CAPABILITY_FILTERED_PRODUCE_TOOLS.has(name)));
  allowed.add("ask_user_question");
  addCapabilityTools(allowed, caps);
  return allowed;
}

function resolveBindingRoot(deps: Pick<SliceToolDeps, "store">, sessionId?: string): string | undefined {
  const binding = sessionId ? deps.store.bindingFor(sessionId) : undefined;
  if (!binding) return undefined;
  const root = typeof deps.store.resolveRoot === "function" ? deps.store.resolveRoot(binding) : binding.projectRoot;
  return typeof root === "string" && root.trim() ? root : undefined;
}

function hasForeignActiveLease(projectRoot: string, ownerId: string): boolean {
  const activeLease = readProjectLease(projectRoot);
  return Boolean(activeLease.active && activeLease.holder && activeLease.holder.ownerId !== ownerId);
}

function persistHubProvider(deps: Pick<SliceToolDeps, "store" | "provider">, sessionId?: string): string | undefined {
  const binding = sessionId ? deps.store.bindingFor(sessionId) : undefined;
  const root = resolveBindingRoot(deps, sessionId);
  if (!binding || !root) return undefined;
  const sameRoute =
    binding.provider.providerId === deps.provider.providerId && binding.provider.modelId === deps.provider.modelId;
  // Host-global tools reflect the boot route. They may inspect a session that
  // has since switched, but must not downgrade that session's accepted binding.
  if (!sameRoute) return root;
  const ownerId = `hub-run:${sessionId}`;
  if (!fs.existsSync(path.join(root, "_agent", "presentation-run.v1.json")) || hasForeignActiveLease(root, ownerId)) {
    return root;
  }
  // An empty modality list is never a real declaration: it means the snapshot
  // predates the live model catalog, so it must not erase the persisted list.
  const modalities = deps.provider.modelInputModalities;
  const nextProvider = {
    ...binding.provider,
    ready: deps.provider.ready === true,
    ...(modalities !== undefined && modalities.length > 0 ? { modelInputModalities: modalities } : {}),
  };
  // Serialize the lease check and atomic provider write under the dedicated
  // lease lock (`_agent/.pptd-write.lock`) shared with `acquireProjectLease`.
  withProjectLeaseLock(root, () => {
    if (hasForeignActiveLease(root, ownerId)) return;
    persistPresentationRunProvider(root, nextProvider);
  });
  return root;
}

export function sessionProduceCapabilities(
  deps: Pick<SliceToolDeps, "store" | "provider">,
  sessionId?: string,
): CapabilitySnapshot {
  const projectRoot = persistHubProvider(deps, sessionId);
  if (projectRoot) return inspectProjectCapabilities(projectRoot, process.env);
  return inspectCapabilities({
    env: process.env,
    providerId: deps.provider.providerId,
    modelId: deps.provider.modelId,
    ready: deps.provider.ready === true,
    modelInputModalities: deps.provider.modelInputModalities,
  });
}

export function sessionProduceToolAllowlist(
  deps: Pick<SliceToolDeps, "store" | "provider">,
  sessionId?: string,
): ReadonlySet<string> {
  const caps = sessionProduceCapabilities(deps, sessionId);
  const projectRoot = resolveBindingRoot(deps, sessionId);
  if (projectRoot && discussionOnly(projectRoot)) return DISCUSSION_TOOLS;
  const allowed = new Set(produceToolAllowlist(caps));
  return projectRoot ? applyProjectEditScopes(allowed, projectRoot) : allowed;
}

type SliceToolExec = { agent?: { id: string }; callId?: string; signal?: AbortSignal };

function sessionIdOf(exec: SliceToolExec): string {
  const id = exec.agent?.id;
  if (!id) throw new Error("tool call has no agent session");
  return id;
}

/** Map one DSH execution onto the host-neutral slide tool context. */
export function slideContextFor(deps: SliceToolDeps, exec: SliceToolExec, requiresProject = true): SlideToolContext {
  const sessionId = sessionIdOf(exec);
  const base = {
    callId: exec.callId ?? "missing-call",
    ...(exec.signal ? { signal: exec.signal } : {}),
    caller: { kind: "hub-run" as const, id: `hub-run:${sessionId}` },
    sessionId,
    acceptsImageContent: Boolean(deps.attachments),
  };
  if (!requiresProject) return { ...base, projectId: "", projectRoot: "" };
  const binding = deps.store.bindingFor(sessionId);
  if (!binding) throw new Error("open_project first");
  return { ...base, projectId: binding.projectRoot, projectRoot: deps.store.resolveRoot(binding) };
}

function slideRuntimeDeps(deps: SliceToolDeps): SlideToolRuntimeDeps {
  return {
    presentation: deps.presentation,
    editorBaseUrl: deps.editorBaseUrl,
    validateSchema: (schema, value) => validateJsonSchemaValue(schema as JsonSchemaNode, value, ""),
    capabilities: (ctx) => sessionProduceCapabilities(deps, ctx.sessionId),
    ...(deps.ensureGrokImageEnv ? { ensureMediaEnv: deps.ensureGrokImageEnv } : {}),
    projects: {
      peekExisting(ctx) {
        const binding = deps.store.bindingFor(ctx.sessionId ?? ctx.caller.id);
        return binding ? deps.store.resolveRoot(binding) : undefined;
      },
      open({ ctx, title }) {
        const opened = deps.store.openProject({
          dshSessionId: ctx.sessionId ?? ctx.caller.id,
          title,
          design: { kind: "self-directed" },
          provider: deps.provider,
        });
        return {
          created: opened.created,
          projectId: opened.binding.projectRoot,
          projectRoot: deps.store.resolveRoot(opened.binding),
          displayRoot: opened.binding.projectRoot,
          design: opened.binding.design,
        };
      },
      rollbackCreated(projectRoot, ctx) {
        deps.store.evictCreatedProject(ctx.sessionId ?? ctx.caller.id, projectRoot);
      },
    },
  };
}

/** Save neutral image blocks as DSH attachments; the rendered value carries the refs. */
async function deliverContent(deps: SliceToolDeps, result: SlideToolResult): Promise<Record<string, unknown>> {
  const images = (result.content ?? []).filter((block) => block.type === "image");
  if (!images.length) return result.data;
  if (!deps.attachments)
    throw new Error("the DSH attachments service is not mounted; cannot send the image to the selected model");
  const refs = [];
  for (const image of images) {
    refs.push({
      ...(await deps.attachments.saveImage({
        data: image.data,
        mediaType: image.mediaType,
        ...(image.name ? { name: image.name } : {}),
      })),
    });
  }
  await result.onContentDelivered?.();
  return { ...result.data, image: refs[0], ...(refs.length > 1 ? { images: refs } : {}) };
}

function renderFor(def: SlideToolDefinition): (args: unknown, value: unknown) => ContentBlock[] {
  if (def.render === "vision") return (_args, value) => renderPageToolContent(value) as ContentBlock[];
  const format = def.render;
  const text = typeof format === "function" ? format : (value: Record<string, unknown>) => JSON.stringify(value);
  return (_args, value) => [{ type: "text", text: text(value as Record<string, unknown>) }];
}

/** One canonical slide tool as a DSH ToolDefinition. */
export function dshSlideTool(deps: SliceToolDeps, def: SlideToolDefinition): ToolDefinition {
  const render = renderFor(def);
  const shell = defineTool({
    name: def.name,
    description: def.description,
    parameters: {},
    output: { schema: { type: "json" }, render: (args, value) => render(args, value) },
    async execute() {
      return null;
    },
  });
  return {
    ...shell,
    parameters: def.inputSchema as ToolDefinition["parameters"],
    ...(def.concurrencySafe ? { isConcurrencySafe: () => true } : {}),
    async execute(args, exec) {
      const input = args as Record<string, unknown>;
      let result: SlideToolResult;
      try {
        // Arguments are rejected before any project binding is resolved.
        def.validate?.(input);
        result = await def.execute(input, slideContextFor(deps, exec, def.requiresProject !== false));
      } catch (error) {
        if (isSlideToolArgsError(error)) throw new ToolArgsError([...error.violations]);
        throw error;
      }
      return jsonValue(await deliverContent(deps, result));
    },
  };
}

/** Canonical definitions bridged for DSH (no registration). */
export function sliceToolDefinitions(
  deps: SliceToolDeps,
  options?: { readonly exclude?: ReadonlySet<string> },
): ToolDefinition[] {
  const exclude = new Set([...DSH_HIDDEN_CANONICAL_TOOLS, ...(options?.exclude ?? [])]);
  return createSlideTools(slideRuntimeDeps(deps), { exclude }).map((def) => dshSlideTool(deps, def));
}

function sliceToolByName(deps: SliceToolDeps, name: string): ToolDefinition {
  const def = createSlideTools(slideRuntimeDeps(deps)).find((tool) => tool.name === name);
  if (!def) throw new Error(`canonical slide tool ${name} is not defined`);
  return dshSlideTool(deps, def);
}

export function registerSliceTools(
  tools: ToolRuntime,
  deps: SliceToolDeps,
  options?: { readonly exclude?: ReadonlySet<string> },
): () => void {
  const disposers = sliceToolDefinitions(deps, options).map((def) =>
    registerToolWithWhen(tools, withProductToolArgumentContract(def), ({ agent }) =>
      isSliceToolStepVisible(def.name, sessionProduceToolAllowlist(deps, agent?.id)),
    ),
  );
  disposers.push(
    tools.guard((exec) => {
      const allowed = sessionProduceToolAllowlist(deps, exec.agent?.id);
      // Discussion is an explicit read-only capability, including hidden tools.
      if (allowed === DISCUSSION_TOOLS && !allowed.has(exec.name))
        return `Discussion is read-only: ${exec.name} is unavailable`;
      return sliceToolGuard(allowed)(exec);
    }),
  );
  return () => {
    for (const dispose of disposers) dispose();
  };
}

export function searchImageTool(deps: SliceToolDeps): ToolDefinition {
  return sliceToolByName(deps, "search_image");
}

export function generateImageTool(deps: SliceToolDeps): ToolDefinition {
  return sliceToolByName(deps, "generate_image");
}

export function webSearchTool(deps: SliceToolDeps): ToolDefinition {
  return sliceToolByName(deps, "web_search");
}
