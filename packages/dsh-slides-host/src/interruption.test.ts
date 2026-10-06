import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendAgentTrace, type AgentTraceRow } from "./agent-trace.js";
import { readAgentError, recordAgentError, writeRateLimitWait } from "./agent-fault.js";
import { markInterruptedTurn, HOST_INTERRUPTED_CODE } from "./interruption.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slides-interruption-"));
}

function readTrace(root: string): AgentTraceRow[] {
  const file = path.join(root, "_agent", "agent-trace.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentTraceRow);
}

function turnRow(over: Partial<AgentTraceRow>): AgentTraceRow {
  return {
    id: `turn:${over.turn ?? 1}`,
    at: "2026-10-05T17:25:00.000Z",
    kind: "turn",
    name: "turn",
    status: "running",
    detailMode: "replace",
    ...over,
  };
}

function stepRow(over: Partial<AgentTraceRow>): AgentTraceRow {
  return {
    id: `step:${over.turn ?? 1}:${over.step ?? 1}`,
    at: "2026-10-05T17:25:00.000Z",
    kind: "turn",
    name: "step",
    status: "running",
    detailMode: "replace",
    ...over,
  };
}

describe("markInterruptedTurn", () => {
  it("closes open steps and the open turn, then records a paused fault", () => {
    const root = tempRoot();
    appendAgentTrace(root, [
      turnRow({ turn: 1 }),
      stepRow({ turn: 1, step: 1 }),
      stepRow({ id: "step:1:1", turn: 1, step: 1, status: "complete" }),
      stepRow({ turn: 1, step: 2 }),
    ]);
    assert.equal(markInterruptedTurn(root, new Date("2026-10-06T04:00:00.000Z")), true);

    const trace = readTrace(root);
    const closedStep = trace.find((row) => row.id === "step:1:2" && row.status === "cancelled");
    const closedTurn = trace.find((row) => row.id === "turn:1" && row.status === "cancelled");
    assert.ok(closedStep, "open step must get a closing row");
    assert.ok(closedTurn, "open turn must get a closing row");
    assert.equal(closedTurn?.detail, "Turn interrupted during restart or recovery");
    // The already-complete step is left alone.
    assert.equal(trace.filter((row) => row.id === "step:1:1").length, 2);

    const fault = readAgentError(root);
    assert.equal(fault?.code, HOST_INTERRUPTED_CODE);
    assert.match(fault?.detail ?? "", /重启|中断/);
  });

  it("does nothing when every turn already closed", () => {
    const root = tempRoot();
    appendAgentTrace(root, [
      turnRow({ turn: 1 }),
      stepRow({ turn: 1, step: 1 }),
      stepRow({ id: "step:1:1", turn: 1, step: 1, status: "complete" }),
      turnRow({ id: "turn:1", turn: 1, status: "complete" }),
    ]);
    assert.equal(markInterruptedTurn(root), false);
    assert.equal(readAgentError(root), undefined);
    assert.equal(readTrace(root).length, 4);
  });

  it("does nothing when a fault already owns the verdict", () => {
    const root = tempRoot();
    appendAgentTrace(root, [turnRow({ turn: 1 })]);
    recordAgentError(root, { code: "operator-stop", detail: "user stopped" });
    assert.equal(markInterruptedTurn(root), false);
    assert.equal(readAgentError(root)?.code, "operator-stop");
    assert.equal(readTrace(root).length, 1);
  });

  it("does nothing while a rate-limit retry is still armed", () => {
    const root = tempRoot();
    appendAgentTrace(root, [turnRow({ turn: 1 })]);
    writeRateLimitWait(root, {
      attempt: 1,
      waitMs: 30_000,
      nextRetryAt: Date.now() + 60_000,
      code: "provider-rate-limit",
    });
    assert.equal(markInterruptedTurn(root), false);
    assert.equal(readAgentError(root), undefined);
  });

  it("marks a gracefully closed cancelled turn that carries no fault", () => {
    const root = tempRoot();
    appendAgentTrace(root, [
      turnRow({ turn: 1 }),
      turnRow({ id: "turn:1", turn: 1, status: "cancelled", detail: "Turn interrupted during restart or recovery" }),
    ]);
    assert.equal(markInterruptedTurn(root), true);
    const fault = readAgentError(root);
    assert.equal(fault?.code, HOST_INTERRUPTED_CODE);
    // No extra rows needed: the turn already has a terminal record.
    assert.equal(readTrace(root).length, 2);
  });

  it("is idempotent once marked", () => {
    const root = tempRoot();
    appendAgentTrace(root, [turnRow({ turn: 1 })]);
    assert.equal(markInterruptedTurn(root), true);
    assert.equal(markInterruptedTurn(root), false);
    assert.equal(readTrace(root).length, 2);
  });

  it("marks an open turn even when an earlier turn completed", () => {
    const root = tempRoot();
    appendAgentTrace(root, [
      turnRow({ turn: 1 }),
      turnRow({ id: "turn:1", turn: 1, status: "complete" }),
      turnRow({ turn: 2 }),
      stepRow({ turn: 2, step: 1 }),
    ]);
    assert.equal(markInterruptedTurn(root), true);
    const trace = readTrace(root);
    assert.ok(trace.find((row) => row.id === "step:2:1" && row.status === "cancelled"));
    assert.ok(trace.find((row) => row.id === "turn:2" && row.status === "cancelled"));
    assert.equal(readAgentError(root)?.code, HOST_INTERRUPTED_CODE);
  });

  it("marks a turn whose start row aged out of the tail window", () => {
    // Real interruption signature: turn:1 running scrolled out of the 128KB
    // tail; only the final running step remains inside the window.
    const root = tempRoot();
    appendAgentTrace(root, [stepRow({ turn: 1, step: 44 })]);
    assert.equal(markInterruptedTurn(root), true);
    const trace = readTrace(root);
    assert.ok(trace.find((row) => row.id === "step:1:44" && row.status === "cancelled"));
    const synthesized = trace.find((row) => row.id === "turn:1" && row.status === "cancelled");
    assert.ok(synthesized, "missing turn row must be closed by number");
    assert.equal(readAgentError(root)?.code, HOST_INTERRUPTED_CODE);
  });

  it("does nothing without a trace file", () => {
    const root = tempRoot();
    assert.equal(markInterruptedTurn(root), false);
    assert.equal(readAgentError(root), undefined);
  });
});
