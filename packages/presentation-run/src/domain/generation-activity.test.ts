import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generationActivityEventsFromTraceRows,
  generationActivityFromLedger,
  inspectGenerationActivitySnapshot,
  readProduceTraceEvents,
} from "../generation-activity.js";
import type { RunLedgerInspection, RunLedgerV1 } from "./run-ledger.js";

function inspection(overrides: Partial<RunLedgerInspection> = {}): RunLedgerInspection {
  return {
    initialized: true,
    referencesComplete: true,
    missingReferenceChunks: [],
    todoCount: 2,
    pages: [
      {
        pageId: "cover",
        revision: 1,
        pageSha256: "page-sha",
        raster: true,
        imageEmitted: true,
        visualReview: "pass",
        layout: "pass",
        chromeStale: false,
      },
    ],
    structuralReview: "pass",
    composeReady: true,
    composeBlockers: [],
    composed: true,
    ...overrides,
  };
}

function ledger(): RunLedgerV1 {
  return {
    schemaVersion: 1,
    runId: "run-1",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:03.000Z",
    sourcePack: { manifestSha256: "m", requirementsId: "r", requirements: [] },
    facts: [
      {
        type: "todo.committed",
        factId: "todo",
        at: "2026-08-31T00:00:00.000Z",
        contextEpochId: "epoch",
        todoSha256: "todo-sha",
        itemCount: 2,
      },
      {
        type: "page.revision-committed",
        factId: "page",
        at: "2026-08-31T00:00:01.000Z",
        contextEpochId: "epoch",
        pageId: "cover",
        revision: 1,
        pageSha256: "page-sha",
      },
      {
        type: "deck.structural-review-recorded",
        factId: "structural",
        at: "2026-08-31T00:00:02.000Z",
        pageRevisions: { cover: "page-sha" },
        ok: true,
        issues: [],
      },
      {
        type: "deck.composed",
        factId: "composed",
        at: "2026-08-31T00:00:03.000Z",
        contextEpochId: "epoch",
        title: "回放测试简报",
        deckSha256: "deck-sha",
        pageRevisions: { cover: "page-sha" },
      },
    ],
  };
}

describe("generation activity", () => {
  it("maps durable facts into a completed replay timeline", () => {
    const activity = generationActivityFromLedger(ledger(), inspection());
    assert.equal(activity.phase, "complete");
    assert.deepEqual(
      activity.stages.map((stage) => stage.status),
      ["complete", "complete", "complete", "complete"],
    );
    assert.deepEqual(
      activity.events.map((event) => event.label),
      ["已建立页面计划", "已写入页面", "已完成结构检查", "已完成整稿"],
    );
    assert.equal(activity.events[1]?.pageId, "cover");
  });

  it("keeps an uninitialized project honest without inventing events", () => {
    const activity = generationActivityFromLedger(
      undefined,
      inspection({
        initialized: false,
        todoCount: 0,
        pages: [],
        composeReady: false,
        composed: false,
      }),
    );
    assert.equal(activity.phase, "awaiting-project");
    assert.equal(activity.events.length, 0);
    assert.equal(activity.stages[0]?.status, "active");
  });

  it("finishes a scoped editor-Agent turn after the authorized revision has a passing raster", () => {
    const base = ledger();
    const edited: RunLedgerV1 = {
      ...base,
      updatedAt: "2026-08-31T00:00:05.000Z",
      facts: [
        ...base.facts,
        {
          type: "page.edit-authorized",
          factId: "edit-auth",
          at: "2026-08-31T00:00:04.000Z",
          authorizationId: "editor-turn-1",
          source: "editor-agent",
          pageId: "cover",
          revision: 1,
          pageSha256: "page-sha",
          expiresAt: "2026-08-31T00:10:00.000Z",
        },
        {
          type: "page.revision-committed",
          factId: "page-edit",
          at: "2026-08-31T00:00:05.000Z",
          contextEpochId: "epoch",
          pageId: "cover",
          revision: 2,
          pageSha256: "edited-page-sha",
        },
      ],
    };
    const activity = generationActivityFromLedger(
      edited,
      inspection({
        pages: [
          {
            pageId: "cover",
            revision: 2,
            pageSha256: "edited-page-sha",
            raster: true,
            imageEmitted: false,
            visualReview: "missing",
            layout: "pass",
            chromeStale: false,
          },
        ],
        structuralReview: "missing",
        composeReady: false,
        composed: false,
      }),
    );
    assert.equal(activity.phase, "complete");
    assert.deepEqual(
      activity.stages.map((stage) => stage.status),
      ["complete", "complete", "complete", "complete"],
    );
    assert.equal(activity.stages[2]?.detail, "本次 Agent 修改已完成渲染与布局检查");
    assert.equal(activity.stages[3]?.detail, "可回放本次 Agent 修改与修改前版本");
  });

  it("prefers hands-log tool calls over ledger preview labels", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trace-activity-"));
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "_agent", "hands-log.jsonl"),
      `${JSON.stringify({
        at: "2026-09-03T09:00:00.000Z",
        name: "generate_image",
        ok: true,
        summary: "media/cover.png · generated",
      })}\n${JSON.stringify({
        at: "2026-09-03T09:00:01.000Z",
        name: "write_page",
        ok: false,
        summary: "execution gate rejected",
        detail: "solution already has a passing deterministic raster",
      })}\n${JSON.stringify({
        at: "2026-09-03T09:00:02.000Z",
        name: "render_page",
        ok: true,
        summary: "cover · native",
      })}\n`,
      "utf8",
    );
    const snapshot = inspectGenerationActivitySnapshot(root);
    const labels = snapshot.activity.events.map((event) => event.label);
    assert.deepEqual(labels, ["调用 generate_image", "write_page 失败"]);
    assert.equal(snapshot.activity.events[1]?.status, "needs-attention");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("folds real deltas and terminal rows by stable id without flattening multiline detail", () => {
    const events = generationActivityEventsFromTraceRows([
      {
        id: "turn:1",
        at: "2026-09-06T10:00:00.000Z",
        kind: "turn",
        status: "running",
        name: "turn",
        detail: "Turn started",
      },
      {
        id: "assistant:1:1:0:reasoning",
        at: "2026-09-06T10:00:01.000Z",
        kind: "reasoning",
        status: "running",
        detail: "先看",
        detailMode: "append",
      },
      {
        id: "assistant:1:1:0:reasoning",
        at: "2026-09-06T10:00:01.010Z",
        kind: "reasoning",
        status: "running",
        detail: "\n  页面",
        detailMode: "append",
      },
      {
        id: "assistant:1:1:0:reasoning",
        at: "2026-09-06T10:00:02.000Z",
        kind: "reasoning",
        status: "complete",
        detail: "先看\n  页面",
        detailMode: "replace",
      },
      {
        id: "tool:call-a",
        at: "2026-09-06T10:00:03.000Z",
        kind: "tool",
        status: "running",
        callId: "call-a",
        name: "write_page",
        detail: '{\n  "pageId": "cover"\n}',
      },
      {
        id: "result:call-a",
        at: "2026-09-06T10:00:04.000Z",
        kind: "result",
        status: "complete",
        callId: "call-a",
        detail: '{\n  "ok": true,\n  "outcome": "written"\n}',
      },
      {
        id: "turn:1",
        at: "2026-09-06T10:00:05.000Z",
        kind: "turn",
        status: "complete",
        name: "turn",
        detail: "Turn completed",
      },
    ]);
    assert.equal(events.length, 4);
    assert.equal(events[0]?.id, "turn:1");
    assert.equal(events[0]?.status, "complete");
    assert.equal(events[0]?.at, "2026-09-06T10:00:00.000Z");
    assert.equal(events[1]?.detail, "先看\n  页面");
    assert.equal(events[1]?.kind, "reasoning");
    assert.equal(events[2]?.callId, "call-a");
    assert.equal(events[3]?.callId, events[2]?.callId);
    assert.match(events[3]?.detail ?? "", /"outcome": "written"/);
  });

  it("reads legacy v1 trace rows while keeping new tool calls non-terminal", () => {
    const events = generationActivityEventsFromTraceRows([
      { at: "2026-09-03T09:00:00.000Z", kind: "think", text: "旧思考" },
      { at: "2026-09-03T09:00:01.000Z", kind: "tool", name: "write_page", text: "cover" },
      {
        at: "2026-09-03T09:00:02.000Z",
        kind: "result",
        name: "write_page",
        ok: false,
        text: "rejected",
      },
    ]);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["message", "tool", "result"],
    );
    assert.deepEqual(
      events.map((event) => event.status),
      ["complete", "running", "failed"],
    );
    assert.equal(events[0]?.detail, "旧思考");
  });

  it("preserves only boolean business verdicts in the activity DTO", () => {
    const events = generationActivityEventsFromTraceRows([
      {
        id: "result:success",
        at: "2026-09-03T09:00:00.000Z",
        kind: "result",
        callId: "success",
        status: "complete",
        ok: true,
        detail: '{"detail":"synthetic clipped result"}',
      },
      {
        id: "result:failure",
        at: "2026-09-03T09:00:01.000Z",
        kind: "result",
        callId: "failure",
        status: "failed",
        ok: false,
        detail: '{"outcome":"rejected"}',
      },
      {
        id: "result:invalid",
        at: "2026-09-03T09:00:02.000Z",
        kind: "result",
        callId: "invalid",
        status: "complete",
        ok: "true",
        detail: '{"detail":"synthetic clipped result"}',
      },
    ]);

    assert.deepEqual(
      events.map((event) => event.ok),
      [true, false, undefined],
    );
  });

  it("keeps a hands-log business verdict when no trace is available", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "generation-hands-verdict-"));
    try {
      const agent = path.join(root, "_agent");
      fs.mkdirSync(agent);
      fs.writeFileSync(
        path.join(agent, "hands-log.jsonl"),
        `${JSON.stringify({
          name: "read_material",
          ok: true,
          summary: "synthetic result",
          detail: "synthetic clipped result ".repeat(500),
          at: "2026-09-03T09:00:00.000Z",
        })}\n`,
      );
      const [event] = readProduceTraceEvents(root);
      assert.equal(event?.ok, true);
      assert.equal(event?.status, "complete");
      assert.equal(event?.truncated, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("redacts credentials that span adjacent delta rows after folding", () => {
    const events = generationActivityEventsFromTraceRows([
      {
        id: "assistant:1:1:0:message",
        at: "2026-09-06T10:00:00.000Z",
        kind: "message",
        status: "running",
        detail: "Bearer secret-",
        detailMode: "append",
      },
      {
        id: "assistant:1:1:0:message",
        at: "2026-09-06T10:00:00.010Z",
        kind: "message",
        status: "running",
        detail: "value-123",
        detailMode: "append",
      },
    ]);
    assert.equal(events[0]?.detail, "Bearer [redacted]");
    assert.doesNotMatch(events[0]?.detail ?? "", /secret-value-123/);
  });

  it("closes real streamed blocks at step and turn boundaries despite terminal index drift", () => {
    const events = generationActivityEventsFromTraceRows([
      {
        id: "turn:7",
        at: "2026-09-06T11:00:00.000Z",
        turn: 7,
        kind: "turn",
        name: "turn",
        status: "running",
        detail: "Turn started",
        detailMode: "replace",
      },
      {
        id: "step:7:3",
        at: "2026-09-06T11:00:00.010Z",
        turn: 7,
        step: 3,
        kind: "turn",
        name: "step",
        status: "running",
        detail: "Step 3 started",
        detailMode: "replace",
      },
      {
        id: "assistant:7:3:9:message",
        at: "2026-09-06T11:00:00.020Z",
        turn: 7,
        step: 3,
        kind: "message",
        status: "running",
        detail: "正在写页",
        detailMode: "append",
      },
      {
        id: "assistant:7:3:0:message",
        at: "2026-09-06T11:00:00.030Z",
        turn: 7,
        step: 3,
        kind: "message",
        status: "complete",
        detail: "页面已经写入",
        detailMode: "replace",
      },
      {
        id: "tool:call-7",
        at: "2026-09-06T11:00:00.040Z",
        turn: 7,
        step: 3,
        kind: "tool",
        name: "write_page",
        callId: "call-7",
        status: "running",
        detailMode: "replace",
      },
      {
        id: "step:7:3",
        at: "2026-09-06T11:00:00.050Z",
        turn: 7,
        step: 3,
        kind: "turn",
        name: "step",
        status: "complete",
        detail: "Step 3 completed",
        detailMode: "replace",
      },
      {
        id: "assistant:7:4:0:reasoning",
        at: "2026-09-06T11:00:00.060Z",
        turn: 7,
        step: 4,
        kind: "reasoning",
        status: "running",
        detail: "检查结果",
        detailMode: "append",
      },
      {
        id: "turn:7",
        at: "2026-09-06T11:00:00.070Z",
        turn: 7,
        kind: "turn",
        name: "turn",
        status: "failed",
        detail: "PROVIDER: failed",
        detailMode: "replace",
      },
    ]);

    const message = events.find((event) => event.id === "assistant:7:3:9:message");
    assert.equal(events.filter((event) => event.kind === "message").length, 1);
    assert.equal(message?.detail, "页面已经写入");
    assert.equal(message?.status, "complete");
    assert.equal(message?.label, "回复");
    const tool = events.find((event) => event.id === "tool:call-7");
    assert.equal(tool?.status, "complete");
    assert.equal(tool?.label, "调用 write_page");
    const reasoning = events.find((event) => event.id === "assistant:7:4:0:reasoning");
    assert.equal(reasoning?.status, "failed");
    assert.equal(reasoning?.label, "思考");
  });
});
