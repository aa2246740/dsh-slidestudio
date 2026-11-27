import fs from "node:fs";
import path from "node:path";
import { AGENT_TRACE_REL, type AgentTraceRow } from "./agent-trace.js";

/** Long generations append megabytes of deltas; the marker only needs the tail. */
const TAIL_BYTES = 128 * 1024;

export type OpenTurnScan = {
  /** Step rows (kind "turn", name "step") whose last write is still running. */
  readonly openSteps: AgentTraceRow[];
  /** Turn rows (kind "turn", name "turn") whose last write is still running. */
  readonly openTurns: AgentTraceRow[];
  /** Terminal status of the most recently written closed turn, if any. */
  readonly lastTurnTerminal?: AgentTraceRow["status"];
};

function asRow(value: unknown): AgentTraceRow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as AgentTraceRow;
  return typeof row.id === "string" && row.id ? row : undefined;
}

function appendSynthesizedTailTurns(
  openTurns: AgentTraceRow[],
  activityByTurn: Map<number, string>,
  closedTurns: Set<number>,
): AgentTraceRow[] {
  const known = new Set(openTurns.map((row) => row.turn).filter((n): n is number => typeof n === "number"));
  const extra: AgentTraceRow[] = [];
  for (const [turn, at] of activityByTurn) {
    if (!closedTurns.has(turn) && !known.has(turn)) {
      extra.push({
        id: `turn:${turn}`,
        at,
        turn,
        kind: "turn",
        name: "turn",
        status: "running",
        detailMode: "replace",
      });
    }
  }
  return extra.length ? [...openTurns, ...extra] : openTurns;
}

/** Fold the append-only trace tail: a later row replaces the status of its id. */
export function scanOpenTurns(projectRoot: string): OpenTurnScan {
  const file = path.join(projectRoot, AGENT_TRACE_REL);
  if (!fs.existsSync(file)) return { openSteps: [], openTurns: [] };
  const size = fs.statSync(file).size;
  const offset = Math.max(0, size - TAIL_BYTES);
  const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buffer.toString("utf8").split("\n");
  if (offset > 0) lines.shift();
  const latest = new Map<string, AgentTraceRow>();
  const closedTurns = new Set<number>();
  const activityByTurn = new Map<number, string>();
  let lastTurnTerminal: AgentTraceRow["status"] | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: AgentTraceRow | undefined;
    try {
      row = asRow(JSON.parse(line));
    } catch {
      continue;
    }
    if (!row) continue;
    if (row.kind !== "turn") {
      if (typeof row.turn === "number") activityByTurn.set(row.turn, row.at);
      continue;
    }
    if (typeof row.name !== "string") continue;
    if (row.status === "running") {
      latest.set(row.id, row);
    } else {
      latest.delete(row.id);
      if (row.name === "turn") {
        lastTurnTerminal = row.status;
        if (typeof row.turn === "number") closedTurns.add(row.turn);
      }
    }
  }
  const open = [...latest.values()];
  return {
    openSteps: open.filter((row) => row.name === "step"),
    openTurns: appendSynthesizedTailTurns(
      open.filter((row) => row.name === "turn"),
      activityByTurn,
      closedTurns,
    ),
    lastTurnTerminal,
  };
}
