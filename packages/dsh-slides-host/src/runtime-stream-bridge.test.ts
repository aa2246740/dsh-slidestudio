import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuntimeEvent } from "@open-slidestudio/slides-runtime";
import type { AgentTraceRow } from "./agent-trace.js";
import { RuntimeStreamBridge } from "./runtime-stream-bridge.js";

function agent(event: Record<string, unknown>): RuntimeEvent {
  return { type: "agent", event } as unknown as RuntimeEvent;
}

function delta(type: string, contentIndex: number, value: string): RuntimeEvent {
  return agent({ type: "message_update", message: {}, assistantMessageEvent: { type, contentIndex, delta: value } });
}

describe("runtime stream bridge", () => {
  it("publishes real deltas as cumulative snapshots, then the committed row replaces them", () => {
    const published: AgentTraceRow[][] = [];
    const bridge = new RuntimeStreamBridge((_id, rows) => published.push([...rows]), undefined, 1_000);
    bridge.observe("s", { type: "turn/start", turn: 3 });
    bridge.observe("s", agent({ type: "turn_start" }));
    bridge.observe("s", delta("thinking_delta", 0, "想"));
    bridge.observe("s", delta("text_delta", 1, "你"));
    bridge.observe("s", delta("text_delta", 1, "好"));
    bridge.flush();
    const live = published.flat().filter((row) => row.stream);
    const message = live.filter((row) => row.id === "assistant:3:1:1:message").at(-1)!;
    assert.equal(message.detail, "你好");
    assert.equal(message.status, "running");
    assert.equal(live.find((row) => row.kind === "reasoning")?.detail, "想");

    bridge.observe(
      "s",
      agent({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [
            { type: "thinking", thinking: "想" },
            { type: "text", text: "你好" },
          ],
        },
      }),
    );
    const settled = published.at(-1)!;
    const committed = settled.find((row) => row.id === "assistant:3:1:1:message")!;
    assert.equal(committed.status, "complete");
    assert.ok(committed.stream, "the committed row keeps the live stream cursor for idempotent replacement");

    bridge.observe(
      "s",
      agent({ type: "tool_execution_start", toolCallId: "c1", toolName: "read_page", args: { id: "p1" } }),
    );
    assert.deepEqual(
      published.at(-1)!.map((row) => [row.id, row.status, row.pageId]),
      [["tool:c1", "running", "p1"]],
    );
    bridge.observe("s", {
      type: "turn/end",
      result: { turn: 3, status: "completed", toolNames: ["read_page"] },
    });
    assert.deepEqual(
      published.at(-1)!.map((row) => [row.id, row.status]),
      [["turn:3", "complete"]],
    );
  });

  it("cancels unfinished streaming rows when the turn ends without committing them", () => {
    const published: AgentTraceRow[][] = [];
    const bridge = new RuntimeStreamBridge((_id, rows) => published.push([...rows]), undefined, 1_000);
    bridge.observe("s", { type: "turn/start", turn: 1 });
    bridge.observe("s", agent({ type: "turn_start" }));
    bridge.observe("s", delta("text_delta", 0, "部分"));
    bridge.observe("s", {
      type: "turn/end",
      result: { turn: 1, status: "aborted", fault: { code: "operator-stop", detail: "stop" }, toolNames: [] },
    });
    const rows = published.flat();
    assert.equal(rows.filter((row) => row.id === "assistant:1:1:0:message").at(-1)?.status, "cancelled");
    assert.equal(rows.at(-1)?.status, "cancelled");
    bridge.dispose();
  });
});
