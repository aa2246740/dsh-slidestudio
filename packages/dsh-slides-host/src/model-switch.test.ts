import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideWritePage } from "./write-page.js";
import { DSH_THIN_SHELL_SERVICES, inject, runModelSwitchTransaction } from "./plugin.js";

describe("model switch transaction", () => {
  it("restores the previous route when activation fails", async () => {
    let route = "amd/DeepSeek-V4-Flash";
    const events: string[] = [];

    await assert.rejects(
      runModelSwitchTransaction({
        apply: () => {
          route = "amd/DeepSeek-Vision-Exp";
          events.push("apply");
        },
        activate: async () => {
          events.push("activate");
          throw new Error("cannot prepare session while it is live");
        },
        rollback: () => {
          route = "amd/DeepSeek-V4-Flash";
          events.push("rollback");
        },
      }),
      /cannot prepare session while it is live/,
    );

    assert.equal(route, "amd/DeepSeek-V4-Flash");
    assert.deepEqual(events, ["apply", "activate", "rollback"]);
  });
});

describe("host DSH surface", () => {
  it("requires only the thin services: webServer, llm and attachments (connection optional)", () => {
    assert.deepEqual([...inject].sort(), ["attachments", "llm", "webServer"]);
    for (const service of inject) assert.ok((DSH_THIN_SHELL_SERVICES as readonly string[]).includes(service));
    for (const removed of ["tools", "agents", "agentPresets", "profileContext", "workspaceRegistry", "sessionQuery"]) {
      assert.equal(inject.includes(removed), false, removed);
    }
  });

  it("decideWritePage stays lazy: no todo source, no plan membership verdict", () => {
    const decision = decideWritePage(
      {
        id: "c",
        pageType: "cover",
        elements: [
          {
            elementId: "title",
            elementType: "text",
            bounds: [80, 200, 800, 80],
            content: { text: "光合作用", fontSize: 36 },
          },
        ],
      },
      undefined,
    );
    assert.equal(decision.action, "write");
  });
});
