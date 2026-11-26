import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QuestionBroker } from "@open-slidestudio/slides-runtime";
import { AssistantQuestions, validateAnswer } from "./assistant-questions.js";

const questions = [{ id: "theme", question: "选个背景", options: [{ label: "深蓝" }, { label: "深紫" }] }];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slides-question-"));
  const broker = new QuestionBroker(() => root);
  let live = true;
  const bridge = new AssistantQuestions(
    (id) => (id === "test" ? root : undefined),
    () => (live ? broker : undefined),
  );
  return {
    root,
    broker,
    bridge,
    goIdle: () => (live = false),
    cleanup: () => {
      broker.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

it("answers the runtime broker and persists exactly one answer across duplicate HTTP acknowledgements", async () => {
  const { root, broker, bridge, cleanup } = fixture();
  try {
    const completion = broker.ask(questions);
    const pending = bridge.list("test")[0]!;
    assert.equal(pending.status, "pending");
    const answer = { answers: [{ id: "theme", selected: ["深蓝"] }] };
    bridge.settle("test", pending.id, { action: "answer", answer });
    assert.deepEqual(await completion, answer);
    bridge.settle("test", pending.id, { action: "answer", answer });
    assert.equal(bridge.list("test").length, 1);
    assert.equal(new AssistantQuestions(() => root).list("test")[0]!.status, "answered");
    assert.throws(() =>
      bridge.settle("test", pending.id, {
        action: "answer",
        answer: { answers: [{ id: "theme", selected: ["深紫"] }] },
      }),
    );
  } finally {
    cleanup();
  }
});

it("keeps an invalid answer pending and accepts custom or multi-select answers", async () => {
  const { broker, bridge, cleanup } = fixture();
  try {
    const completion = broker.ask(questions);
    const pending = bridge.list("test")[0]!;
    for (const answer of [
      { answers: [] },
      { answers: [{ id: "theme", selected: ["unknown"] }] },
      { answers: [{ id: "theme", selected: ["深蓝", "深紫"] }] },
      { answers: [{ id: "theme", selected: ["深蓝"], custom: "conflicting" }] },
    ]) {
      assert.throws(() => bridge.settle("test", pending.id, { action: "answer", answer }));
    }
    assert.equal(bridge.list("test")[0]!.status, "pending");
    const answer = { answers: [{ id: "theme", selected: [], custom: "墨绿" }] };
    bridge.settle("test", pending.id, { action: "answer", answer });
    assert.deepEqual(await completion, answer);
    assert.deepEqual(
      validateAnswer([{ ...questions[0]!, multiSelect: true }], {
        answers: [{ id: "theme", selected: ["深蓝", "深紫"], custom: "补充" }],
      }).answers[0]!.selected,
      ["深蓝", "深紫"],
    );
  } finally {
    cleanup();
  }
});

it("cancels through the broker and treats a repeated cancel as a no-op", async () => {
  const { broker, bridge, cleanup } = fixture();
  try {
    const completion = broker.ask(questions);
    const pending = bridge.list("test")[0]!;
    bridge.settle("test", pending.id, { action: "cancel" });
    await assert.rejects(completion, /cancelled/);
    bridge.settle("test", pending.id, { action: "cancel" });
    assert.equal(bridge.list("test")[0]!.status, "cancelled");
    assert.throws(() => bridge.settle("test", pending.id, { action: "bogus" }), /无效的回答操作/);
  } finally {
    cleanup();
  }
});

it("reads an idle session's pending rows as interrupted and refuses to settle them", () => {
  const { root, broker, bridge, goIdle, cleanup } = fixture();
  try {
    void broker.ask(questions).catch(() => undefined);
    const pending = bridge.list("test")[0]!;
    goIdle();
    const idle = bridge.list("test")[0]!;
    assert.equal(idle.status, "interrupted");
    assert.throws(
      () =>
        bridge.settle("test", pending.id, {
          action: "answer",
          answer: { answers: [{ id: "theme", selected: ["深蓝"] }] },
        }),
      /这个问题已结束/,
    );
    assert.throws(() => bridge.settle("test", "missing", { action: "cancel" }), /这个问题已不存在/);
    assert.throws(() => bridge.list("other"), /Unknown slide session/);
    assert.equal(fs.existsSync(path.join(root, "_agent", "assistant-questions.v1.json")), true);
  } finally {
    cleanup();
  }
});
