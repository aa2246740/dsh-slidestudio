import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@deepseek-ai/cordis";
import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { runModelSwitchTransaction } from "./model-switch.js";
import {
  applyLiveModelSelection,
  installModelSelectionCompat,
  readLiveModelSelection,
  rollbackLiveModelSelection,
  runGuardedLiveModelSwitch,
  type LiveAgentModelLike,
  type ModelSelectionCompatRef,
  type ModelSelectionInstaller,
} from "./model-selection-compat.js";

const agentCtx = { tag: "agent" } as unknown as Context;

function selection(model: string, effort?: string): ModelSelection {
  return {
    provider: "amd",
    model,
    ...(effort ? { reasoningEffort: ReasoningEffortId(effort) } : {}),
  };
}

function refOf(model: string): ModelSelectionCompatRef {
  return { current: selection(model), assembled: undefined };
}

describe("model selection compat", () => {
  it("calls a rc.5 installer with only the agent context", () => {
    const seen: unknown[] = [];
    const installer: ModelSelectionInstaller = (ctx) => {
      seen.push(ctx);
      return () => undefined;
    };
    assert.equal(installer.length, 1);
    installModelSelectionCompat(agentCtx, refOf("old"), installer);
    assert.deepEqual(seen, [agentCtx]);
  });

  it("calls a rc.2 installer with the agent context and the selection ref", () => {
    const seen: unknown[] = [];
    function installer(ctx: Context, ref?: ModelSelectionCompatRef) {
      seen.push(ctx, ref?.current?.model);
      return () => undefined;
    }
    assert.equal(installer.length, 2);
    installModelSelectionCompat(agentCtx, refOf("flash"), installer);
    assert.deepEqual(seen, [agentCtx, "flash"]);
  });

  it("switches and rolls back through agent.model on rc.5", async () => {
    const ref = refOf("old");
    let live: ModelSelection | undefined = selection("old", "low");
    const selects: string[] = [];
    let failRollback = false;
    const agent = {
      model: {
        current: () => live,
        select: async (next: ModelSelection) => {
          if (failRollback && next.model === "old") throw new Error("select rollback failed");
          live = next;
          selects.push(next.model);
        },
      } satisfies LiveAgentModelLike,
    };
    assert.equal(readLiveModelSelection(agent, ref)?.model, "old");
    assert.equal(readLiveModelSelection(agent, ref)?.reasoningEffort, ReasoningEffortId("low"));

    const next = selection("next", "high");
    await applyLiveModelSelection(agent, next, ref);
    assert.equal(live?.model, "next");
    assert.equal(ref.current?.model, "next");
    assert.deepEqual(selects, ["next"]);

    const prior = selection("old", "low");
    failRollback = true;
    await assert.rejects(
      runModelSwitchTransaction({
        apply: () => undefined,
        activate: async () => {
          await applyLiveModelSelection(agent, selection("broken"), ref);
          throw new Error("activate failed");
        },
        rollback: () => rollbackLiveModelSelection(agent, prior, ref),
      }),
      /activate failed/,
    );
    assert.equal(ref.current?.model, "old");
    assert.equal(ref.current?.reasoningEffort, ReasoningEffortId("low"));
    assert.equal(live?.model, "broken");
  });

  it("keeps the rc.2 selection ref when the agent has no model api", async () => {
    const ref = refOf("old");
    const agent = {};
    assert.equal(readLiveModelSelection(agent, ref)?.model, "old");
    assert.equal(readLiveModelSelection({ model: { current: () => undefined } }, ref)?.model, "old");

    const next = selection("vision");
    await runModelSwitchTransaction({
      apply: () => undefined,
      activate: () => applyLiveModelSelection(agent, next, ref),
      rollback: () => {
        throw new Error("rollback should not run");
      },
    });
    assert.equal(ref.current?.model, "vision");

    await assert.rejects(
      runModelSwitchTransaction({
        apply: () => undefined,
        activate: async () => {
          await applyLiveModelSelection(agent, selection("broken"), ref);
          throw new Error("rc2 activate failed");
        },
        rollback: () => rollbackLiveModelSelection(agent, selection("old"), ref),
      }),
      /rc2 activate failed/,
    );
    assert.equal(ref.current?.model, "old");
    assert.equal(ref.current?.reasoningEffort, undefined);
  });

  it("does not write a live selection when apply fails before activation", async () => {
    const selects: string[] = [];
    const agent = {
      model: {
        current: () => selection("old", "low"),
        select: async (next: ModelSelection) => {
          selects.push(next.model);
        },
      } satisfies LiveAgentModelLike,
    };
    const ref = refOf("old");
    let liveSelectionApplied = false;
    await assert.rejects(
      runGuardedLiveModelSwitch({
        agent,
        sessionId: "sess",
        selection: ref,
        next: selection("next", "high"),
        prior: selection("old", "low"),
        markLiveApplied: () => {
          liveSelectionApplied = true;
        },
        liveSelectionApplied: () => liveSelectionApplied,
        apply: () => {
          throw new Error("apply failed");
        },
        resume: () => {
          throw new Error("resume should not run");
        },
        rollbackStore: () => undefined,
      }),
      /apply failed/,
    );
    assert.equal(liveSelectionApplied, false);
    assert.deepEqual(selects, []);
    assert.equal(ref.current?.model, "old");
  });
});
