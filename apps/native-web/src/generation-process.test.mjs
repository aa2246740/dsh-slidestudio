import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROCESS_STATUS_LABEL, projectGenerationProcess } from "../public/generation-process.js";

describe("generation process projection", () => {
  it("pairs a tool call and result by callId with one stable card", () => {
    const rows = projectGenerationProcess(
      [
        { id: "call", kind: "tool", callId: "c1", name: "write_page", detail: '{"id":"p1"}', status: "running" },
        { id: "result", kind: "result", callId: "c1", name: "write_page", detail: '{"ok":true}', status: "complete" },
      ],
      { active: true, phase: "generating" },
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, "tool:c1");
    assert.equal(rows[0].input, '{"id":"p1"}');
    assert.equal(rows[0].output, '{"ok":true}');
    assert.equal(rows[0].status, "success");
  });

  it("pairs a nameless legacy result only when it is strictly adjacent", () => {
    const adjacent = projectGenerationProcess(
      [
        { id: "call", kind: "tool", type: "agent.tool", name: "read_page", detail: "{}" },
        { id: "result", kind: "result", detail: "plain result", status: "complete" },
      ],
      { active: true },
    );
    assert.equal(adjacent.length, 1);
    assert.equal(adjacent[0].status, "returned");

    const parallel = projectGenerationProcess(
      [
        { id: "a", kind: "tool", type: "agent.tool", name: "read_page", detail: '{"id":"a"}' },
        { id: "b", kind: "tool", type: "agent.tool", name: "read_page", detail: '{"id":"b"}' },
        { id: "r", kind: "result", detail: "plain result", status: "complete" },
      ],
      { active: true },
    );
    assert.equal(parallel.length, 3, "ambiguous parallel calls keep an unpaired result card");
  });

  it("never falls back when a result has a different callId", () => {
    const rows = projectGenerationProcess(
      [
        { id: "a", kind: "tool", callId: "call-a", name: "read_page", detail: '{"id":"a"}', status: "running" },
        {
          id: "result-b",
          kind: "result",
          callId: "call-b",
          name: "read_page",
          detail: '{"ok":true}',
          status: "complete",
        },
      ],
      { active: true },
    );

    assert.equal(rows.length, 2, "mismatched callIds remain separate cards");
    assert.equal(rows[0].key, "tool:call-a");
    assert.equal(rows[0].output, "");
    assert.equal(rows[0].status, "running");
    assert.equal(rows[1].key, "result-b");
    assert.equal(rows[1].output, '{"ok":true}');
    assert.equal(rows[1].status, "success");
  });

  it("does not call explicit rejection or truncated JSON a success", () => {
    const rejected = projectGenerationProcess(
      [
        { id: "call", kind: "tool", callId: "bad", name: "write_page", status: "running" },
        {
          id: "result",
          kind: "result",
          callId: "bad",
          detail: '{"ok":false,"outcome":"rejected"}',
          status: "complete",
        },
      ],
      { active: true },
    );
    assert.equal(rejected[0].status, "failed");

    const clipped = projectGenerationProcess(
      [
        { id: "call", kind: "tool", callId: "clip", name: "read_page", status: "running" },
        {
          id: "result",
          kind: "result",
          callId: "clip",
          detail: '{"ok":true,"payload":',
          status: "complete",
          truncated: true,
        },
      ],
      { active: true },
    );
    assert.equal(clipped[0].status, "returned");

    const clippedFailure = projectGenerationProcess(
      [
        { id: "call", kind: "tool", type: "agent.tool", name: "view_design_reference" },
        {
          id: "result",
          kind: "result",
          detail: '{"ok":false,"name":"view_design_reference","detail":',
          status: "complete",
          truncated: true,
        },
      ],
      { active: true },
    );
    assert.equal(clippedFailure[0].status, "failed");
  });

  it("distinguishes recovered attempts, parent cancellation, and a real tool failure", () => {
    const rows = projectGenerationProcess(
      [
        {
          id: "turn-cancelled",
          kind: "turn",
          turn: 1,
          status: "cancelled",
          detail: "Turn cancelled (hook: production-no-progress-budget)",
        },
        { id: "write-1", kind: "tool", turn: 1, callId: "write-1", name: "write_page", detail: '{"id":"01_cover"}' },
        {
          id: "write-1-result",
          kind: "result",
          turn: 1,
          callId: "write-1",
          status: "complete",
          detail: '{"outcome":"rejected","detail":"overlap"}',
        },
        { id: "write-2", kind: "tool", turn: 1, callId: "write-2", name: "write_page", detail: '{"id":"01_cover"}' },
        {
          id: "write-2-result",
          kind: "result",
          turn: 1,
          callId: "write-2",
          status: "complete",
          detail: '{"outcome":"written","pageId":"01_cover"}',
        },
        {
          id: "aborted",
          kind: "tool",
          turn: 1,
          callId: "aborted",
          name: "read_reference",
          detail: '{"sourceId":"openkimi:reference/pptd.md","chunkIndex":1}',
        },
        {
          id: "aborted-result",
          kind: "result",
          turn: 1,
          callId: "aborted",
          status: "failed",
          detail: "Error: tool call aborted before dispatch",
        },
        {
          id: "missing",
          kind: "tool",
          turn: 1,
          callId: "missing",
          name: "read_reference",
          detail: '{"sourceId":"openkimi:reference/missing.md","chunkIndex":0}',
        },
        {
          id: "missing-result",
          kind: "result",
          turn: 1,
          callId: "missing",
          status: "failed",
          detail: "Error: unknown OpenKimi source id: missing",
        },
      ],
      {
        active: false,
        phase: "paused",
        error: {
          code: "production-no-progress-budget",
          detail: "生产阶段连续 32 个工具结果未产生持久页面修订，已达到有界预算。",
        },
      },
    );

    assert.deepEqual(
      rows.map((row) => row.status),
      ["recovered", "success", "canceled", "failed"],
    );
    assert.equal(PROCESS_STATUS_LABEL.recovered, "已恢复");
    assert.match(rows[0].summary, /后续重试已成功/);
    assert.equal(rows[2].summary, "这次调用尚未执行，所在任务已中止。");
    const afterRecovery = projectGenerationProcess(
      [
        { id: "call", kind: "tool", callId: "aborted", name: "read_reference", detail: "{}" },
        {
          id: "result",
          kind: "result",
          callId: "aborted",
          status: "failed",
          detail: "Error: tool call aborted before dispatch",
        },
      ],
      { active: false, phase: "complete" },
    );
    assert.equal(
      afterRecovery[0].status,
      "canceled",
      "historical cancellation must stay canceled after the session later completes",
    );
    assert.match(rows[3].summary, /没有找到指定的参考资料/);
  });

  it("shows active thought and terminal tool states without losing raw text", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const thought = projectGenerationProcess([{ id: "think", kind: "reasoning", detail: hostile }], { active: true });
    assert.equal(thought[0].status, "running");
    assert.equal(thought[0].detail, hostile);

    const canceled = projectGenerationProcess([{ id: "call", kind: "tool", callId: "c", name: "render_page" }], {
      active: false,
      phase: "paused",
      error: { code: "operator-stop" },
    });
    assert.equal(canceled[0].status, "canceled");
    assert.equal(PROCESS_STATUS_LABEL.canceled, "已取消");
  });

  it("keeps an unsettled direct-edit tool running while the persisted session phase is complete", () => {
    const pending = projectGenerationProcess(
      [
        {
          id: "partial-call",
          kind: "tool",
          callId: "write-page-1",
          name: "write_page",
          detail: '{"id":"p1","elements":[',
          status: "running",
        },
      ],
      { active: false, turnActive: true, phase: "complete" },
    );

    assert.equal(pending[0].status, "running");
    assert.equal(pending[0].summary, "正在执行，结果返回后会更新。");

    const failed = projectGenerationProcess(
      [
        { id: "call", kind: "tool", callId: "write-page-1", name: "write_page", status: "running" },
        {
          id: "result",
          kind: "result",
          callId: "write-page-1",
          name: "write_page",
          detail: '{"ok":false,"detail":"pack_color"}',
          status: "failed",
        },
      ],
      { active: false, turnActive: true, phase: "complete" },
    );

    assert.equal(failed[0].status, "failed", "an explicit result still settles the card as failed");
  });

  it("labels legacy think events as a neutral process note", () => {
    const rows = projectGenerationProcess(
      [{ id: "legacy-think", kind: "think", label: "模型思考", detail: "旧数据" }],
      { active: true },
    );

    assert.equal(rows[0].title, "过程说明");
  });

  it("coalesces repeated stable assistant chunk ids into one projected row", () => {
    const rows = projectGenerationProcess(
      [
        { id: "assistant:1:2:0:reasoning", type: "assistant/chunk", kind: "reasoning", detail: "正在分析" },
        { id: "assistant:1:2:0:reasoning", type: "assistant/chunk", kind: "reasoning", detail: "页面结构" },
      ],
      { active: true },
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, "正在分析页面结构");
    assert.equal(rows[0].status, "running");
  });

  it("preserves truncation metadata for reasoning and message cards", () => {
    const rows = projectGenerationProcess(
      [
        { id: "long-reasoning", kind: "reasoning", detail: "x".repeat(8192), truncated: true },
        { id: "long-message", kind: "message", detail: "y".repeat(8192), truncated: true },
      ],
      { active: false, phase: "complete" },
    );

    assert.equal(rows[0].truncated, true);
    assert.equal(rows[1].truncated, true);
  });
});

describe("human-readable generation activity", () => {
  function call(name, input, output, status = "complete") {
    return projectGenerationProcess(
      [
        { id: "c", kind: "tool", callId: "1", name, detail: JSON.stringify(input) },
        {
          id: "r",
          kind: "result",
          callId: "1",
          detail: typeof output === "string" ? output : JSON.stringify(output),
          status,
        },
      ],
      { active: true },
    )[0];
  }
  it("explains invalid arguments without showing a JSON envelope", () => {
    const row = call(
      "write_todo",
      { arguments: { items: [{ pageId: "x" }] } },
      'Error: invalid arguments: missing required property "items"',
      "failed",
    );
    assert.equal(row.displayTitle, "安排页面制作任务");
    assert.equal(row.summary, "这次调用未执行：缺少任务列表。");
    assert.deepEqual(row.facts, [{ label: "制作任务", value: "1 项" }]);
    assert.ok(row.input.includes("arguments"), "original remains available only for technical details");
  });
  it("distinguishes a disabled preview from a missing reference", () => {
    const preview = call(
      "view_design_reference",
      {},
      { ok: false, detail: "taste execution gate is not enabled for this run" },
    );
    assert.match(preview.summary, /未启用设计参考预览/);
    const missing = call("read_reference", {}, { ok: false, detail: "unknown OpenKimi source id: x" });
    assert.match(missing.summary, /没有找到/);
  });
  it("gives readable reference counts and keeps lifecycle plumbing out of the feed", () => {
    const row = call("list_references", {}, { ok: true, payload: { sourceFiles: 76, visualFiles: 44 } });
    assert.equal(row.displayTitle, "查找参考资料");
    assert.deepEqual(row.facts, [{ label: "找到资料", value: "76 份资料，44 份视觉参考" }]);
    assert.deepEqual(projectGenerationProcess([{ id: "step", kind: "turn", label: "Step 1 started" }]), []);
  });
  it("describes a scoped edit_elements result with its authorized object count", () => {
    const row = call(
      "edit_elements",
      {
        pageId: "p1",
        expectedPageSha256: "sha",
        elements: [
          { id: "title", type: "text" },
          { id: "accent", type: "shape" },
        ],
      },
      { ok: true, payload: { updatedElementIds: ["title", "accent"] } },
    );
    assert.equal(row.displayTitle, "修改所选对象");
    assert.equal(row.summary, "2 个所选对象已更新，等待后续检查。");
    assert.deepEqual(row.facts, [
      { label: "页面", value: "p1" },
      { label: "所选对象", value: "2 个" },
    ]);
  });
  it("does not invent success or a review verdict for unknown results", () => {
    const row = call("review_page", {}, { ok: true });
    assert.equal(row.summary, "已收到页面检查结果。");
    const unknown = call("other_tool", {}, '{"ok":true,');
    assert.equal(unknown.summary, "已收到结果，尚未确认是否完成。");
  });
});
