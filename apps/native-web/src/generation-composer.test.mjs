import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGenerationTurnRequest,
  currentModelFromState,
  generationComposerMode,
  modelOptionValue,
  parseProviderRoster,
  selectedModelFromRoster,
} from "../public/generation-composer.js";

const rosterData = {
  connection: { providerId: "pi-xai", model: "grok-4.6", ready: true },
  providers: [
    { id: "pi-xai", name: "xAI", ready: true, models: ["grok-4.6"] },
    { id: "minimax-cn", name: "MiniMax", ready: true, models: ["MiniMax-M3"] },
    null,
    { id: "empty", models: [] },
  ],
};

test("roster keeps exact ready models and rejects an empty catalog", () => {
  const roster = parseProviderRoster(rosterData);
  assert.deepEqual(
    roster.providers.map((row) => row.id),
    ["pi-xai", "minimax-cn"],
  );
  assert.deepEqual(selectedModelFromRoster(roster, modelOptionValue("minimax-cn", "MiniMax-M3")), {
    provider: "minimax-cn",
    model: "MiniMax-M3",
  });
  assert.throws(() => selectedModelFromRoster(roster, "missing/model"));
  assert.throws(() => parseProviderRoster({ providers: [null, { id: "x", models: [] }] }));
});

test("a generation turn includes attempt and model only when they actually change the session", () => {
  const current = { provider: "pi-xai", model: "grok-4.6" };
  const same = buildGenerationTurnRequest({
    instruction: "继续完成当前文稿",
    resumeGeneration: true,
    modelSelection: current,
    expectedAttemptId: "attempt-1",
    currentModel: current,
  });
  assert.deepEqual(same, {
    text: "继续完成当前文稿",
    resumeGeneration: true,
    expectedAttemptId: "attempt-1",
  });
  const switched = buildGenerationTurnRequest({
    instruction: "改用文本模型继续",
    resumeGeneration: true,
    modelSelection: { provider: "minimax-cn", model: "MiniMax-M3" },
    expectedAttemptId: "attempt-1",
    currentModel: current,
  });
  assert.equal(switched.modelSelection.provider, "minimax-cn");
  assert.equal(Object.hasOwn(switched, "editorEdit"), false);
  assert.throws(() => buildGenerationTurnRequest({ instruction: " ", resumeGeneration: true }));
});

test("composer stays closed while busy and opens only for continue recovery", () => {
  assert.equal(generationComposerMode({ agentStatus: "busy", recoveryKind: "continue" }), "wait-or-stop");
  assert.equal(
    generationComposerMode({
      agentStatus: "idle",
      execution: { recovery: { kind: "wait-or-stop" } },
    }),
    "wait-or-stop",
  );
  assert.equal(
    generationComposerMode({
      agentStatus: "idle",
      execution: { recovery: { kind: "continue" } },
    }),
    "continue",
  );
  assert.equal(
    generationComposerMode({
      agentStatus: "idle",
      execution: { recovery: { kind: "continue" }, status: { kind: "ready-to-export" } },
    }),
    "hidden",
    "a composed deck only needs the editor's own export, not another agent turn",
  );
  assert.equal(
    generationComposerMode({
      agentStatus: "idle",
      execution: {
        recovery: { kind: "continue" },
        status: { kind: "ready-to-export" },
        fault: { code: "operator-stop" },
      },
    }),
    "continue",
    "a fault that stopped the run still needs the resume composer",
  );
  assert.equal(
    generationComposerMode({
      agentStatus: "idle",
      execution: { recovery: { kind: "continue" }, status: { kind: "ready-to-export" } },
      hasError: true,
    }),
    "continue",
    "an explicit error still opens continue even on ready-to-export",
  );
  assert.equal(
    generationComposerMode({
      agentStatus: "idle",
      execution: { recovery: { kind: "continue" }, status: { kind: "ready-to-export" } },
      phase: "paused",
    }),
    "continue",
    "a paused phase still opens continue even on ready-to-export",
  );
  assert.equal(generationComposerMode({ agentStatus: "idle" }), "hidden");
});

test("current model is read from execution, not guessed from a missing provider", () => {
  assert.deepEqual(
    currentModelFromState({
      execution: { model: { provider: "pi-xai", model: "grok-4.6" } },
      binding: { provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" } },
    }),
    { provider: "pi-xai", model: "grok-4.6" },
  );
  assert.equal(currentModelFromState({ execution: { model: { provider: "unknown", model: "unknown" } } }), null);
});
