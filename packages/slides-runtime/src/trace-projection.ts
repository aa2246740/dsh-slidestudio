/**
 * Redacted public trace projection at `<projectRoot>/_agent/agent-trace.jsonl`.
 * Rows follow the DSH host's `AgentTraceRow` contract (same ids, kinds,
 * statuses and detail modes) so the editor generation-history view reads both
 * hosts. Only final snapshots are projected; streaming deltas are not.
 * Completed assistant prose passes the ledger truth guard first.
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { applyTraceTruthGuard } from "@open-slidestudio/slides-tools";
import { redactText, redactValue } from "./redact.js";
import type { TurnEndReason } from "./session-store.js";

export const AGENT_TRACE_REL = path.join("_agent", "agent-trace.jsonl");
export const AGENT_TRACE_DETAIL_MAX = 8_192;

export type AgentTraceStatus = "running" | "complete" | "failed" | "cancelled" | "needs-attention";

export type AgentTraceRow = {
  readonly id: string;
  readonly at: string;
  readonly seq?: number;
  readonly turn?: number;
  readonly step?: number;
  readonly kind: "message" | "reasoning" | "tool" | "result" | "turn";
  readonly status: AgentTraceStatus;
  readonly name?: string;
  readonly callId?: string;
  readonly detail?: string;
  readonly truncated?: true;
  readonly detailMode?: "append" | "replace";
  readonly pageId?: string;
};

type Detail = { detail?: string; truncated?: true };

function bound(text: string, preserveWhitespace = false): Detail {
  const safe = redactText(text).replace(/\r\n?/g, "\n");
  const detail = preserveWhitespace ? safe : safe.trim();
  if (!detail.trim()) return {};
  if (detail.length <= AGENT_TRACE_DETAIL_MAX) return { detail };
  return { detail: `${detail.slice(0, AGENT_TRACE_DETAIL_MAX - 1)}…`, truncated: true };
}

function jsonDetail(value: unknown): Detail {
  try {
    return bound(JSON.stringify(redactValue(value), null, 2));
  } catch {
    return {};
  }
}

function pageIdOf(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as { id?: unknown; pageId?: unknown };
  const id = record.id ?? record.pageId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function resultDetail(content: unknown): Detail {
  const parts: string[] = [];
  for (const block of Array.isArray(content) ? content : []) {
    const row = block as { type?: unknown; text?: unknown };
    if (row.type === "text" && typeof row.text === "string" && row.text.trim()) {
      try {
        parts.push(JSON.stringify(redactValue(JSON.parse(row.text)), null, 2));
      } catch {
        parts.push(redactText(row.text.trim()));
      }
    } else if (typeof row.type === "string" && row.type !== "text") {
      parts.push(`[${row.type} content omitted]`);
    }
  }
  return bound(parts.join("\n"));
}

function reportsFailure(content: unknown): boolean {
  return (Array.isArray(content) ? content : []).some((block) => {
    const row = block as { type?: unknown; text?: unknown };
    if (row.type !== "text" || typeof row.text !== "string") return false;
    try {
      return (JSON.parse(row.text) as { ok?: unknown })?.ok === false;
    } catch {
      return false;
    }
  });
}

const REASON_STATUS: Record<TurnEndReason["kind"], AgentTraceStatus> = {
  completed: "complete",
  aborted: "cancelled",
  interrupted: "cancelled",
  error: "failed",
  "max-tokens": "needs-attention",
};

function reasonDetail(reason: TurnEndReason): Detail {
  switch (reason.kind) {
    case "completed":
      return { detail: "Turn completed" };
    case "aborted":
      return bound(
        `Turn cancelled (${reason.reason?.kind ?? "cancelled"}${reason.reason?.reason ? `: ${reason.reason.reason}` : ""})`,
      );
    case "error":
      return bound(`${reason.error.code}: ${reason.error.message}`);
    case "max-tokens":
      return { detail: "Turn reached the output limit" };
    default:
      return { detail: "Turn interrupted during restart or recovery" };
  }
}

export type TraceStamp = { readonly turn: number; readonly step?: number };

export function turnRow(stamp: TraceStamp, reason?: TurnEndReason): AgentTraceRow {
  return {
    id: `turn:${stamp.turn}`,
    at: new Date().toISOString(),
    turn: stamp.turn,
    kind: "turn",
    status: reason ? REASON_STATUS[reason.kind] : "running",
    name: "turn",
    ...(reason ? reasonDetail(reason) : { detail: "Turn started" }),
    detailMode: "replace",
  };
}

/** Rows for a committed assistant message (prose, reasoning). */
export function assistantRows(stamp: TraceStamp, message: AgentMessage): AgentTraceRow[] {
  const record = message as unknown as { content?: unknown; stopReason?: unknown };
  const status: AgentTraceStatus = record.stopReason === "aborted" ? "cancelled" : "complete";
  const rows: AgentTraceRow[] = [];
  (Array.isArray(record.content) ? record.content : []).forEach((value, index) => {
    const block = value as { type?: unknown; text?: unknown; thinking?: unknown };
    const text = block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : undefined;
    if (typeof text !== "string") return;
    const detail = bound(text, true);
    if (!detail.detail?.trim()) return;
    const kind = block.type === "thinking" ? "reasoning" : "message";
    rows.push({
      id: `assistant:${stamp.turn}:${stamp.step ?? "?"}:${index}:${kind}`,
      at: new Date().toISOString(),
      turn: stamp.turn,
      ...(stamp.step !== undefined ? { step: stamp.step } : {}),
      kind,
      status,
      ...detail,
      detailMode: "replace",
    });
  });
  return rows;
}

export function toolRow(stamp: TraceStamp, callId: string, name: string, args: unknown): AgentTraceRow {
  const pageId = pageIdOf(args);
  return {
    id: `tool:${callId}`,
    at: new Date().toISOString(),
    turn: stamp.turn,
    ...(stamp.step !== undefined ? { step: stamp.step } : {}),
    kind: "tool",
    status: "running",
    name,
    callId,
    ...jsonDetail(args),
    detailMode: "replace",
    ...(pageId ? { pageId } : {}),
  };
}

export function resultRow(stamp: TraceStamp, callId: string, content: unknown, isError: boolean): AgentTraceRow {
  return {
    id: `result:${callId}`,
    at: new Date().toISOString(),
    turn: stamp.turn,
    ...(stamp.step !== undefined ? { step: stamp.step } : {}),
    kind: "result",
    status: isError || reportsFailure(content) ? "failed" : "complete",
    callId,
    ...resultDetail(content),
    detailMode: "replace",
  };
}

function readExistingTraceState(file: string): { maxSeq: number; needsNewline: boolean } {
  if (!fs.existsSync(file)) return { maxSeq: 0, needsNewline: false };
  const text = fs.readFileSync(file, "utf8");
  if (!text) return { maxSeq: 0, needsNewline: false };
  let maxSeq = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const seq = (JSON.parse(line) as { seq?: unknown }).seq;
      if (typeof seq === "number" && Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    } catch {
      // Ignore a crash-truncated or malformed trailing line.
    }
  }
  return { maxSeq, needsNewline: !text.endsWith("\n") };
}

export type TraceWriteGate = (projectRoot: string, write: () => void) => boolean;

/** Buffered appender; rows wait in memory until a project root is known. */
export class TraceWriter {
  private root?: string;
  private seq = 0;
  private readonly pending: AgentTraceRow[] = [];

  constructor(private readonly writeGate?: TraceWriteGate) {}

  private runGated(projectRoot: string, write: () => void): boolean {
    if (!this.writeGate) {
      write();
      return true;
    }
    return this.writeGate(projectRoot, write);
  }

  attach(projectRoot: string): boolean {
    const file = path.join(projectRoot, AGENT_TRACE_REL);
    return this.runGated(projectRoot, () => {
      const { maxSeq, needsNewline } = readExistingTraceState(file);
      this.root = projectRoot;
      this.seq = Math.max(this.seq, maxSeq);
      const buffered = this.pending.splice(0);
      if (needsNewline) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, "\n", "utf8");
      }
      if (buffered.length) this.writeRaw(projectRoot, buffered);
    });
  }

  write(rows: readonly AgentTraceRow[]): void {
    if (!rows.length) return;
    if (!this.root) {
      this.pending.push(...rows);
      return;
    }
    const root = this.root;
    this.runGated(root, () => this.writeRaw(root, rows));
  }

  private writeRaw(root: string, rows: readonly AgentTraceRow[]): void {
    if (!rows.length) return;
    const guarded = applyTraceTruthGuard(root, rows, AGENT_TRACE_DETAIL_MAX).map((row) => ({
      ...row,
      seq: ++this.seq,
    }));
    const file = path.join(root, AGENT_TRACE_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, guarded.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
  }
}
