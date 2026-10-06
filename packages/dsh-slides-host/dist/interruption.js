import fs from "node:fs";
import path from "node:path";
import { AGENT_TRACE_REL, appendAgentTrace } from "./agent-trace.js";
import { readAgentError, readRateLimitWait, recordAgentError } from "./agent-fault.js";
import { readAttempt } from "./session-transition.js";
/** Long generations append megabytes of deltas; the marker only needs the tail. */
const TAIL_BYTES = 128 * 1024;
export const HOST_INTERRUPTED_CODE = "host-interrupted";
const INTERRUPTED_DETAIL = "Turn interrupted during restart or recovery";
function asRow(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const row = value;
    return typeof row.id === "string" && row.id ? row : undefined;
}
/** Fold the append-only trace tail: a later row replaces the status of its id. */
function scanOpenTurns(projectRoot) {
    const file = path.join(projectRoot, AGENT_TRACE_REL);
    if (!fs.existsSync(file))
        return { openSteps: [], openTurns: [] };
    const size = fs.statSync(file).size;
    const offset = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
    const fd = fs.openSync(file, "r");
    try {
        fs.readSync(fd, buffer, 0, buffer.length, offset);
    }
    finally {
        fs.closeSync(fd);
    }
    // Drop the first partial line when the window starts mid-record.
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    if (offset > 0)
        lines.shift();
    const latest = new Map();
    let lastTurnTerminal;
    for (const line of lines) {
        if (!line.trim())
            continue;
        let row;
        try {
            row = asRow(JSON.parse(line));
        }
        catch {
            continue;
        }
        if (!row || row.kind !== "turn" || typeof row.name !== "string")
            continue;
        if (row.status === "running") {
            latest.set(row.id, row);
        }
        else {
            latest.delete(row.id);
            if (row.name === "turn")
                lastTurnTerminal = row.status;
        }
    }
    const open = [...latest.values()];
    return {
        openSteps: open.filter((row) => row.name === "step"),
        openTurns: open.filter((row) => row.name === "turn"),
        lastTurnTerminal,
    };
}
/**
 * A turn the process never closed is dead work: the Host was killed (SIGKILL,
 * crash, OS AutomaticTermination) before turn/end could land. Persist the
 * interruption so the durable projections read paused-with-continue instead of
 * a permanently active "thinking" phase.
 *
 * Safe while idle only — callers must check agent activity first. Skips when a
 * fault or an armed rate-limit retry already owns the verdict, and when the
 * latest turn ended normally.
 */
export function markInterruptedTurn(projectRoot, now = new Date()) {
    if (readAgentError(projectRoot))
        return false;
    const wait = readRateLimitWait(projectRoot);
    if (wait && wait.nextRetryAt > Date.now())
        return false;
    const scan = scanOpenTurns(projectRoot);
    if (!scan.openTurns.length && !scan.openSteps.length && scan.lastTurnTerminal !== "cancelled")
        return false;
    const at = now.toISOString();
    const rows = [];
    // Close steps before their turn so readers fold terminal states in order.
    for (const row of scan.openSteps) {
        rows.push({ ...row, at, status: "cancelled", detail: INTERRUPTED_DETAIL, detailMode: "replace" });
    }
    // A step can outlive its turn's start row in the tail window; any turn with
    // an open step is by definition unclosed, so close it by number either way.
    const openTurnsByNumber = new Map();
    for (const row of scan.openTurns) {
        if (typeof row.turn === "number")
            openTurnsByNumber.set(row.turn, row);
    }
    for (const row of scan.openSteps) {
        if (typeof row.turn === "number" && !openTurnsByNumber.has(row.turn)) {
            openTurnsByNumber.set(row.turn, {
                id: `turn:${row.turn}`,
                at: row.at,
                turn: row.turn,
                kind: "turn",
                name: "turn",
                status: "running",
                detailMode: "replace",
            });
        }
    }
    for (const row of openTurnsByNumber.values()) {
        rows.push({ ...row, at, status: "cancelled", detail: INTERRUPTED_DETAIL, detailMode: "replace" });
    }
    appendAgentTrace(projectRoot, rows);
    const attemptId = readAttempt(projectRoot)?.attemptId;
    recordAgentError(projectRoot, {
        code: HOST_INTERRUPTED_CODE,
        detail: "应用或主机已重启，生成中断；已完成的内容保留，可在编辑器中继续。",
        ...(attemptId ? { attemptId } : {}),
    });
    return true;
}
//# sourceMappingURL=interruption.js.map