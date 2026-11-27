/**
 * Page-aware projection passes for the context budget. All functions mutate a
 * detached projection copy in place (never the durable session log), never
 * remove a message and never touch protected messages.
 *
 * - Superseded write pruning: an older `write_page` for a page that has a newer
 *   `write_page` (succeeded or failed) keeps only `{ id, superseded: true }`.
 * - Working set (small windows): the active page keeps its latest write and the
 *   feedback that followed it verbatim, the design contract stays anchored, and
 *   other pages' page-tool results collapse to one-line receipts.
 * - Delivered references: which reference reads reached the model untruncated.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  blocksOf,
  hasCompactionMarker,
  identityArguments,
  isFailedToolResult,
  roleOf,
  summarizeToolResult,
} from "./context-compaction.js";

export const DEFAULT_SUPERSEDABLE_TOOLS = ["write_page"] as const;
export const DEFAULT_PAGE_TOOLS = [
  "write_page",
  "patch_page_elements",
  "render_page",
  "review_page",
  "read_page",
  "edit_elements",
  "edit_page_background",
] as const;
export const DEFAULT_DESIGN_TOOLS = ["commit_design", "write_layout"] as const;
export const DEFAULT_REFERENCE_TOOLS = ["read_reference"] as const;
/** Windows at or below this size switch to the working set once compaction reaches tier 2. */
export const WORKING_SET_MAX_WINDOW = 96_000;
export const PAGE_RECEIPT_LABEL = "[页面回执]";

type Block = Record<string, unknown> & { type?: unknown };

export type ToolCallRef = {
  /** Index of the assistant message that issued the call. */
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly block: Block;
  readonly pageId?: string;
};

/** Page id of page-scoped tool arguments (`id`, then `pageId`). */
export function pageIdOf(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const value = typeof record.id === "string" ? record.id : record.pageId;
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
}

/** Every tool call of every assistant message, in transcript order. */
export function collectToolCalls(messages: readonly AgentMessage[]): ToolCallRef[] {
  const calls: ToolCallRef[] = [];
  messages.forEach((message, index) => {
    if (roleOf(message) !== "assistant") return;
    for (const block of blocksOf(message)) {
      if (block.type !== "toolCall") continue;
      const pageId = pageIdOf(block.arguments);
      calls.push({
        index,
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        block,
        ...(pageId ? { pageId } : {}),
      });
    }
  });
  return calls;
}

/** Map tool-call id to the index of its tool result message. */
export function resultIndexById(messages: readonly AgentMessage[]): Map<string, number> {
  const results = new Map<string, number>();
  messages.forEach((message, index) => {
    if (roleOf(message) !== "toolResult") return;
    results.set(String((message as unknown as { toolCallId?: unknown }).toolCallId ?? ""), index);
  });
  return results;
}

/**
 * Collapse older calls of `tools` whose page has a newer call of the same tool
 * to `{ id, superseded: true }`. Returns how many calls were collapsed.
 */
export function pruneSupersededCalls(
  messages: readonly AgentMessage[],
  protectedIndices: ReadonlySet<number>,
  tools: ReadonlySet<string>,
): number {
  const calls = collectToolCalls(messages).filter((call) => tools.has(call.name) && call.pageId);
  const newest = new Set<string>();
  let pruned = 0;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]!;
    const key = `${call.name}\u0000${call.pageId}`;
    if (!newest.has(key)) {
      newest.add(key);
      continue;
    }
    const args = call.block.arguments as Record<string, unknown> | undefined;
    if (protectedIndices.has(call.index) || args?.superseded === true) continue;
    call.block.arguments = { id: call.pageId, superseded: true };
    pruned += 1;
  }
  return pruned;
}

export type WorkingSetPlan = {
  readonly activePage?: string;
  /** Messages the working set keeps verbatim (in addition to the budget's anchors). */
  readonly protect: ReadonlySet<number>;
  /** Tool-result indices of other pages that collapse to one-line receipts. */
  readonly receipts: ReadonlySet<number>;
  /** Tool-call ids of other pages whose arguments shrink to identity fields. */
  readonly identityCalls: ReadonlySet<string>;
};

export type WorkingSetTools = {
  readonly pageTools: ReadonlySet<string>;
  readonly designTools: ReadonlySet<string>;
};

function protectDesignAnchors(
  messages: readonly AgentMessage[],
  calls: readonly ToolCallRef[],
  results: ReadonlyMap<string, number>,
  tools: ReadonlySet<string>,
  protect: Set<number>,
): void {
  const anchored = new Set<string>();
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]!;
    const resultIndex = results.get(call.id);
    if (!tools.has(call.name) || anchored.has(call.name) || resultIndex === undefined) continue;
    if (isFailedToolResult(messages[resultIndex]!)) continue;
    anchored.add(call.name);
    protect.add(resultIndex);
  }
}

function protectActivePage(
  pageCalls: readonly ToolCallRef[],
  results: ReadonlyMap<string, number>,
  activePage: string,
  protect: Set<number>,
): void {
  const active = pageCalls.filter((call) => call.pageId === activePage);
  const lastWrite = active.filter((call) => call.name === "write_page").at(-1);
  const from = lastWrite?.index ?? active.at(-1)?.index ?? Number.POSITIVE_INFINITY;
  for (const call of active) {
    if (call.index < from) continue;
    if (call === lastWrite) protect.add(call.index);
    const resultIndex = results.get(call.id);
    if (resultIndex !== undefined) protect.add(resultIndex);
  }
}

/** Decide what the small-window working set keeps, receipts and shrinks. */
export function planWorkingSet(messages: readonly AgentMessage[], tools: WorkingSetTools): WorkingSetPlan {
  const calls = collectToolCalls(messages);
  const results = resultIndexById(messages);
  const pageCalls = calls.filter((call) => tools.pageTools.has(call.name) && call.pageId);
  const activePage = pageCalls.at(-1)?.pageId;
  const protect = new Set<number>();
  protectDesignAnchors(messages, calls, results, tools.designTools, protect);
  if (activePage) protectActivePage(pageCalls, results, activePage, protect);
  const receipts = new Set<number>();
  const identityCalls = new Set<string>();
  for (const call of pageCalls) {
    if (call.pageId === activePage) continue;
    identityCalls.add(call.id);
    const resultIndex = results.get(call.id);
    if (resultIndex !== undefined && !protect.has(resultIndex)) receipts.add(resultIndex);
  }
  return { ...(activePage ? { activePage } : {}), protect, receipts, identityCalls };
}

/** One-line receipt of a completed page's tool result. */
export function pageReceipt(message: AgentMessage, pageId: string | undefined): string {
  const summary = summarizeToolResult(message, 60, PAGE_RECEIPT_LABEL);
  return pageId ? summary.replace(PAGE_RECEIPT_LABEL, `${PAGE_RECEIPT_LABEL} ${pageId}`) : summary;
}

/** Apply a working-set plan to unprotected messages; returns how many results became receipts. */
export function applyWorkingSet(
  messages: readonly AgentMessage[],
  plan: WorkingSetPlan,
  protectedIndices: ReadonlySet<number>,
): number {
  const calls = collectToolCalls(messages);
  const pageById = new Map(calls.map((call) => [call.id, call.pageId]));
  for (const call of calls) {
    if (!plan.identityCalls.has(call.id) || protectedIndices.has(call.index)) continue;
    const args = call.block.arguments as Record<string, unknown> | undefined;
    if (args?.superseded !== true) call.block.arguments = identityArguments(call.block.arguments);
  }
  let collapsed = 0;
  for (const index of plan.receipts) {
    if (protectedIndices.has(index)) continue;
    const message = messages[index]!;
    const callId = String((message as unknown as { toolCallId?: unknown }).toolCallId ?? "");
    const text = pageReceipt(message, pageById.get(callId));
    (message as unknown as { content: unknown }).content = [{ type: "text", text }];
    collapsed += 1;
  }
  return collapsed;
}

/** Call ids of successful `tools` results that appear in `messages` without any compaction marker. */
export function untruncatedResultCallIds(messages: readonly AgentMessage[], tools: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (roleOf(message) !== "toolResult") continue;
    const record = message as unknown as { toolName?: unknown; toolCallId?: unknown };
    if (!tools.has(String(record.toolName ?? "")) || record.toolCallId == null) continue;
    if (isFailedToolResult(message) || hasCompactionMarker(message, [PAGE_RECEIPT_LABEL])) continue;
    ids.push(String(record.toolCallId));
  }
  return ids;
}
