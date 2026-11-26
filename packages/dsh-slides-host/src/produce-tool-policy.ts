/**
 * Host-neutral produce tool policy for Hub runs: which canonical slide tools a
 * session turn may see, given its capability snapshot, conversation mode and
 * editor edit scopes. `SlidesAgentRuntime` receives the complement as
 * `excludeTools`, so a hidden tool is never offered to the model.
 */
import fs from "node:fs";
import path from "node:path";
import {
  inspectCapabilities,
  inspectProjectCapabilities,
  persistPresentationRunProvider,
  type CapabilitySnapshot,
  type ModelInputModality,
} from "@open-slidestudio/presentation-run";
import {
  addCapabilityTools,
  applyProjectEditScopes,
  CANONICAL_SLIDE_TOOL_NAMES,
  readProjectLease,
  toolRefusalMessage,
  withProjectLeaseLock,
} from "@open-slidestudio/slides-tools";
import { discussionOnly, DISCUSSION_TOOLS } from "./assistant-conversation.js";
import { SLICE_TOOL_NAMES } from "./protocol.js";
import type { SliceSessionStore } from "./slice-session.js";

export const NATIVE_WEB_FORBID_SENTENCE =
  "Do not call web_search or web_fetch — those DSH tools are not available on this route.";

export const PRODUCE_WEB_SEARCH_NAME = "web_search";

export const CAPABILITY_FILTERED_PRODUCE_TOOL_NAMES = [
  "edit_elements",
  "edit_page_background",
  "delete_pages",
  "reorder_pages",
  "update_deck",
  "review_page",
  "view_material",
  "record_material_notes",
  "search_image",
  "generate_image",
] as const;

const CAPABILITY_FILTERED_PRODUCE_TOOLS = new Set<string>(CAPABILITY_FILTERED_PRODUCE_TOOL_NAMES);

/** Page, layout and plan writes that a turn's allowlist can withhold (review, element, editor and layout locks). */
const ALLOWLIST_GATED_PRODUCE_TOOLS = new Set<string>([
  "write_page",
  "write_layout",
  "write_todo",
  "batch_remove_footers",
]);

/**
 * Hub runs never see the editor-link tool (the Hub embeds the editor) or the
 * function-calling `web_search` (search is provider-native on hosted routes).
 */
export const HUB_HIDDEN_CANONICAL_TOOLS: ReadonlySet<string> = new Set(["open_in_editor", PRODUCE_WEB_SEARCH_NAME]);

export const CONVERSATION_INTERACTION_TEXT =
  "与用户交互集中在对话中。用户已明确要求的修改直接执行，不重复确认。只有缺少影响结果的关键信息，或用户明确要求先选择时，调用 ask_user_question；不要用正文中的‘回复 A/B’或‘说开始改’代替问题卡。用户已授权‘选完就改’时，工具返回回答后在同一轮继续完成修改，不再要求用户发一条消息。取消或未回答不等于同意，不执行依赖该回答的修改。只讨论的轮次仍然只读。";

export type SessionToolProvider = {
  readonly providerId: string;
  readonly modelId: string;
  readonly ready?: boolean;
  readonly modelInputModalities?: readonly ModelInputModality[];
};

export type SessionPolicyDeps = {
  readonly store: Pick<SliceSessionStore, "bindingFor" | "resolveRoot">;
  readonly provider: SessionToolProvider;
};

/** Whether a tool may appear this step. Function `web_search` never does. */
export function isProduceToolAllowed(toolName: string, allowed?: ReadonlySet<string>): boolean {
  if (toolName === PRODUCE_WEB_SEARCH_NAME) return false;
  if (!allowed) return true;
  return (
    (!ALLOWLIST_GATED_PRODUCE_TOOLS.has(toolName) || allowed.has(toolName)) &&
    (!CAPABILITY_FILTERED_PRODUCE_TOOLS.has(toolName) || allowed.has(toolName))
  );
}

/** Refusal wording is shared with every host through the canonical allowlist module. */
export function sliceToolGuard(allowed: ReadonlySet<string>) {
  return (exec: { name: string }): string | undefined => toolRefusalMessage(exec.name, allowed);
}

/** Discussion only shows DISCUSSION_TOOLS; produce turns drop web_search and capability gaps. */
export function isSliceToolStepVisible(name: string, allowed: ReadonlySet<string>): boolean {
  if (allowed === DISCUSSION_TOOLS) return allowed.has(name);
  if (!isProduceToolAllowed(name, allowed)) return false;
  return sliceToolGuard(allowed)({ name }) === undefined;
}

export function produceToolAllowlist(caps: CapabilitySnapshot): ReadonlySet<string> {
  const allowed = new Set<string>(SLICE_TOOL_NAMES.filter((name) => !CAPABILITY_FILTERED_PRODUCE_TOOLS.has(name)));
  allowed.add("ask_user_question");
  addCapabilityTools(allowed, caps);
  return allowed;
}

function resolveBindingRoot(deps: Pick<SessionPolicyDeps, "store">, sessionId?: string): string | undefined {
  const binding = sessionId ? deps.store.bindingFor(sessionId) : undefined;
  if (!binding) return undefined;
  const root = deps.store.resolveRoot(binding);
  return typeof root === "string" && root.trim() ? root : undefined;
}

function hasForeignActiveLease(projectRoot: string, ownerId: string): boolean {
  const activeLease = readProjectLease(projectRoot);
  return Boolean(activeLease.active && activeLease.holder && activeLease.holder.ownerId !== ownerId);
}

function persistHubProvider(deps: SessionPolicyDeps, sessionId?: string): string | undefined {
  const binding = sessionId ? deps.store.bindingFor(sessionId) : undefined;
  const root = resolveBindingRoot(deps, sessionId);
  if (!binding || !root) return undefined;
  const sameRoute =
    binding.provider.providerId === deps.provider.providerId && binding.provider.modelId === deps.provider.modelId;
  // Never downgrade a session whose accepted binding has since switched route.
  if (!sameRoute) return root;
  const ownerId = `hub-run:${sessionId}`;
  if (!fs.existsSync(path.join(root, "_agent", "presentation-run.v1.json")) || hasForeignActiveLease(root, ownerId)) {
    return root;
  }
  // An empty modality list is never a real declaration: it must not erase the persisted list.
  const modalities = deps.provider.modelInputModalities;
  const nextProvider = {
    ...binding.provider,
    ready: deps.provider.ready === true,
    ...(modalities !== undefined && modalities.length > 0 ? { modelInputModalities: modalities } : {}),
  };
  // Serialize the lease check and atomic provider write under the shared lease lock.
  withProjectLeaseLock(root, () => {
    if (hasForeignActiveLease(root, ownerId)) return;
    persistPresentationRunProvider(root, nextProvider);
  });
  return root;
}

export function sessionProduceCapabilities(deps: SessionPolicyDeps, sessionId?: string): CapabilitySnapshot {
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

export function sessionProduceToolAllowlist(deps: SessionPolicyDeps, sessionId?: string): ReadonlySet<string> {
  const caps = sessionProduceCapabilities(deps, sessionId);
  const projectRoot = resolveBindingRoot(deps, sessionId);
  if (projectRoot && discussionOnly(projectRoot)) return DISCUSSION_TOOLS;
  const allowed = new Set(produceToolAllowlist(caps));
  return projectRoot ? applyProjectEditScopes(allowed, projectRoot) : allowed;
}

/** Canonical tools a turn must not offer: Hub-hidden tools plus everything outside the turn allowlist. */
export function excludedToolsFor(allowed: ReadonlySet<string>): ReadonlySet<string> {
  const excluded = new Set(HUB_HIDDEN_CANONICAL_TOOLS);
  for (const name of CANONICAL_SLIDE_TOOL_NAMES) {
    if (!isSliceToolStepVisible(name, allowed)) excluded.add(name);
  }
  return excluded;
}

/** Stable cache key for an exclusion set. */
export function toolSetKey(excluded: ReadonlySet<string>): string {
  return [...excluded].sort().join(",");
}
