/**
 * Compact disk summary builder for fresh context seeding on comment/review
 * turns and model-switch / failover recovery. Reads only durable disk state
 * and keeps the summary strictly bounded (< 2,500 chars) so re-entering a deck
 * never replays raw intermediate reasoning from prior generation runs.
 */
import fs from "node:fs";
import path from "node:path";
import { inspectRunLedger, listSourceReceipts, readCommittedPagePlan } from "@open-slidestudio/presentation-run";
import { designContractCard } from "@open-slidestudio/slides-tools";
import { readConversation } from "./assistant-conversation.js";

export type DiskSummaryReason = "comment-edit" | "model-switch" | "failover";

export type DiskContextSummaryOptions = {
  readonly targetPageIds?: readonly string[];
  readonly reason?: DiskSummaryReason;
};

const MAX_SUMMARY_CHARS = 2_400;
const MAX_BRIEF_CHARS = 400;
const MAX_HISTORY_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 180;
const MAX_PLAN_ITEMS = 24;

function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function readJsonRecord(file: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readOriginalBrief(projectRoot: string): string {
  const input = readJsonRecord(path.join(projectRoot, "_agent", "generation-input.v1.json"));
  if (typeof input?.brief === "string" && input.brief.trim()) return clip(input.brief, MAX_BRIEF_CHARS);
  const runtime = readJsonRecord(path.join(projectRoot, "_agent", "runtime.json"));
  if (typeof runtime?.brief === "string" && runtime.brief.trim()) return clip(runtime.brief, MAX_BRIEF_CHARS);
  return "";
}

function formatConversationLines(projectRoot: string): string[] {
  try {
    const conv = readConversation(projectRoot);
    return conv.messages
      .slice(-MAX_HISTORY_MESSAGES)
      .map((msg) => clip(msg.text, MAX_MESSAGE_CHARS))
      .filter(Boolean)
      .map((line, index) => `${index + 1}. ${line}`);
  } catch {
    return [];
  }
}

function formatDesignSummary(projectRoot: string): string {
  try {
    const adoptedSourceIds = [
      ...new Set(
        listSourceReceipts(projectRoot)
          .filter((row) => row.state === "adopted" || row.state === "executed")
          .map((row) => row.sourceId),
      ),
    ];
    const card = designContractCard(projectRoot, { adoptedSourceIds });
    const palette = Object.entries(card.palette)
      .slice(0, 6)
      .map(([role, hex]) => `${role}=${hex}`)
      .join(", ");
    const parts: string[] = [];
    if (card.designSystemId) parts.push(`pack=${card.designSystemId}`);
    if (card.adoptedSourceIds.length) parts.push(`adopted=${card.adoptedSourceIds.join(",")}`);
    if (palette) parts.push(`palette(${palette})`);
    if (card.fonts?.major || card.fonts?.minor) {
      parts.push(`fonts=${JSON.stringify(card.fonts)}`);
    }
    return parts.join("; ");
  } catch {
    return "";
  }
}

function formatPlanLines(projectRoot: string): string[] {
  try {
    return readCommittedPagePlan(projectRoot)
      .slice(0, MAX_PLAN_ITEMS)
      .map((item) => `- ${item.pageId}: ${clip(item.title || "", 60)} (${item.layoutFamily || "general"})`);
  } catch {
    return [];
  }
}

function formatDeckStatus(projectRoot: string): string {
  try {
    const status = inspectRunLedger(projectRoot);
    const total = status.pages.length;
    const failedLayout = status.pages.filter((page) => page.layout === "fail").map((page) => page.pageId);
    const revisePages = status.pages.filter((page) => page.visualReview === "revise").map((page) => page.pageId);
    const parts = [
      `已写页面 ${total} 页`,
      status.composed ? "已合稿" : "未合稿",
      `结构检查=${status.structuralReview}`,
    ];
    if (failedLayout.length) parts.push(`排版未通过: ${failedLayout.join(",")}`);
    if (revisePages.length) parts.push(`待视觉修订: ${revisePages.join(",")}`);
    return parts.join("；");
  } catch {
    return "";
  }
}

function sessionLogHasProgress(sessionLogPath: string): boolean {
  if (!fs.existsSync(sessionLogPath)) return false;
  try {
    const raw = fs.readFileSync(sessionLogPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as {
        type?: unknown;
        message?: { role?: unknown; stopReason?: unknown; content?: unknown };
      };
      if (row.type !== "message" || !row.message) continue;
      if (row.message.role === "toolResult") return true;
      const hasToolCall =
        Array.isArray(row.message.content) &&
        row.message.content.some((block) => (block as { type?: unknown })?.type === "toolCall");
      if (
        row.message.role === "assistant" &&
        row.message.stopReason !== "error" &&
        row.message.stopReason !== "aborted" &&
        (row.message.stopReason !== "length" || hasToolCall)
      ) {
        return true;
      }
    }
  } catch {
    /* ignore unreadable log */
  }
  return false;
}

/**
 * True only when the project has durable progress worth summarizing (at least
 * one written page, committed plan, or completed assistant/tool step). A brand-new
 * 0-page deck whose very first turn failed must NOT be summarized so switching
 * models preserves the full directorBrief, canvas format and attachments.
 */
export function hasPersistedDeckHistory(projectRoot: string): boolean {
  try {
    if (inspectRunLedger(projectRoot).pages.length > 0) return true;
    if (readCommittedPagePlan(projectRoot).length > 0) return true;
  } catch {
    /* ignore */
  }
  return sessionLogHasProgress(path.join(projectRoot, "_agent", "runtime-session.v1.jsonl"));
}

function reasonHeading(reason: DiskSummaryReason | undefined): string {
  if (reason === "comment-edit") return "场景：编辑器批注/局部修改轮（仅基于当前磁盘状态继续）";
  if (reason === "model-switch") return "场景：已切换模型恢复任务（仅基于当前磁盘状态继续）";
  if (reason === "failover") return "场景：自动故障切换后恢复任务（仅基于当前磁盘状态继续）";
  return "场景：基于当前磁盘状态恢复上下文";
}

/** Build a compact, bounded disk summary for seeding a fresh model context. */
export function buildDiskContextSummary(projectRoot: string, options: DiskContextSummaryOptions = {}): string {
  const sections: string[] = [reasonHeading(options.reason)];
  const brief = readOriginalBrief(projectRoot);
  if (brief) sections.push(`原始需求：${brief}`);
  const design = formatDesignSummary(projectRoot);
  if (design) sections.push(`设计契约：${design}`);
  const status = formatDeckStatus(projectRoot);
  if (status) sections.push(`文稿状态：${status}`);
  const plan = formatPlanLines(projectRoot);
  if (plan.length) sections.push(`页面计划：\n${plan.join("\n")}`);
  const conversation = formatConversationLines(projectRoot);
  if (conversation.length) sections.push(`近期用户指令：\n${conversation.join("\n")}`);
  const targets = (options.targetPageIds ?? []).map((id) => id.trim()).filter(Boolean);
  if (targets.length) {
    sections.push(`本轮目标页：${targets.join("、")}。修改前请先调用 read_page 获取最新 pageSha256。`);
  }
  const text = sections.join("\n\n");
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  return `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

/** Resolve optional followup options carrying a disk-summary seed for an editor-authorized edit/comment turn. */
export function resolveEditorEditFollowupOptions(
  projectRoot: string | undefined,
  editorEditAuthorized: boolean,
  editorEdit: unknown,
  reviewScopes?: readonly { readonly pageId: string }[],
): { readonly seedFromSummary: string } | undefined {
  if (!editorEditAuthorized || !projectRoot || !hasPersistedDeckHistory(projectRoot)) return undefined;
  const fallbackPageId =
    editorEdit && typeof editorEdit === "object" && !Array.isArray(editorEdit)
      ? (editorEdit as Record<string, unknown>).pageId
      : undefined;
  const targetPageIds = reviewScopes?.length
    ? [...new Set(reviewScopes.map((scope) => scope.pageId))]
    : typeof fallbackPageId === "string" && fallbackPageId.trim()
      ? [fallbackPageId]
      : [];
  return { seedFromSummary: buildDiskContextSummary(projectRoot, { targetPageIds, reason: "comment-edit" }) };
}

const TURN_ATTACHMENTS_REL = path.join("_agent", "turn-attachments.v1.json");

/** Persist accepted follow-up turn attachments so subsequent tool allowlists keep material tools enabled. */
export function recordAcceptedTurnAttachments(
  projectRoot: string | undefined,
  attachments: readonly { readonly id: string; readonly name: string }[],
): void {
  if (!projectRoot || attachments.length === 0) return;
  const file = path.join(projectRoot, TURN_ATTACHMENTS_REL);
  const existing = readJsonRecord(file);
  const prior = Array.isArray(existing?.attachments)
    ? (existing.attachments as { id?: unknown; name?: unknown }[]).filter(
        (item): item is { id: string; name: string } => typeof item?.id === "string" && typeof item?.name === "string",
      )
    : [];
  const seen = new Set(prior.map((item) => item.id));
  const merged = [...prior];
  for (const item of attachments) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push({ id: item.id, name: item.name });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, attachments: merged }, null, 2)}\n`);
  fs.renameSync(temp, file);
}
