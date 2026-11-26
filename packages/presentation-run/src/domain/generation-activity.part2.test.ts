import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generationActivityEventsFromTraceRows } from "../generation-activity.js";

describe("generation activity", () => {
  it("does not guess between multiple streamed blocks when terminal indexes drift", () => {
    const events = generationActivityEventsFromTraceRows([
      {
        id: "assistant:2:1:4:message",
        at: "2026-09-06T11:00:00.000Z",
        turn: 2,
        step: 1,
        kind: "message",
        status: "running",
        detail: "A",
        detailMode: "append",
      },
      {
        id: "assistant:2:1:5:message",
        at: "2026-09-06T11:00:00.001Z",
        turn: 2,
        step: 1,
        kind: "message",
        status: "running",
        detail: "B",
        detailMode: "append",
      },
      {
        id: "assistant:2:1:0:message",
        at: "2026-09-06T11:00:00.002Z",
        turn: 2,
        step: 1,
        kind: "message",
        status: "complete",
        detail: "final",
        detailMode: "replace",
      },
      {
        id: "step:2:1",
        at: "2026-09-06T11:00:00.003Z",
        turn: 2,
        step: 1,
        kind: "turn",
        name: "step",
        status: "complete",
        detail: "Step completed",
        detailMode: "replace",
      },
    ]);
    assert.equal(events.filter((event) => event.kind === "message").length, 3);
    assert.deepEqual(
      events.filter((event) => event.kind === "message").map((event) => event.status),
      ["complete", "complete", "complete"],
    );
  });
});
