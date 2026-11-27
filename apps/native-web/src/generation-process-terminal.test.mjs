import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generationActivityProgressSignature,
  generationEventsForTask,
  generationResumeCandidate,
  generationResumeInstruction,
  generationStateCanResume,
  generationTerminalCardModel,
  generationTerminalPresentation,
  humanizeGenerationFault,
  unfinishedGenerationReason,
} from "../public/generation-process.js";

describe("current Agent task event window", () => {
  it("shows only turns created after the editor action while retaining all new correction turns", () => {
    const history = [
      { id: "turn-1", kind: "turn", turn: 1 },
      { id: "old-tool", kind: "tool", turn: 1 },
      { id: "turn-2", kind: "turn", turn: 2 },
      { id: "new-tool", kind: "tool", turn: 2 },
      { id: "local-ledger", kind: "ledger" },
      { id: "turn-3", kind: "turn", turn: 3 },
      { id: "correction", kind: "tool", turn: 3 },
    ];

    assert.deepEqual(
      generationEventsForTask(history, 1).map((event) => event.id),
      ["turn-2", "new-tool", "local-ledger", "turn-3", "correction"],
    );
    assert.deepEqual(generationEventsForTask(history, 3), []);
    assert.equal(history.length, 7, "filtering must not remove persisted history");
  });
});

describe("generation activity progress signature", () => {
  it("changes for a new journal event or an actual reasoning delta", () => {
    const first = { events: [{ id: "reason-1", kind: "reasoning", status: "running", detail: "正在检查" }] };
    const delta = { events: [{ id: "reason-1", kind: "reasoning", status: "running", detail: "正在检查页面" }] };
    const tool = {
      events: [...delta.events, { id: "call-1", callId: "c1", kind: "tool", status: "running", detail: "{}" }],
    };

    assert.notEqual(generationActivityProgressSignature(first), generationActivityProgressSignature(delta));
    assert.notEqual(generationActivityProgressSignature(delta), generationActivityProgressSignature(tool));
  });

  it("does not count a changing poll timestamp or a constant busy state as progress", () => {
    const event = { id: "call-1", callId: "c1", kind: "tool", status: "running", detail: "{}" };
    const first = { phase: "generating", updatedAt: "2026-09-06T10:00:00Z", events: [event] };
    const later = { phase: "generating", updatedAt: "2026-09-06T10:01:00Z", events: [{ ...event }] };

    assert.equal(generationActivityProgressSignature(first), generationActivityProgressSignature(later));
    assert.equal(generationActivityProgressSignature({ phase: "generating", events: [] }), "");
  });
});

describe("generation terminal presentation", () => {
  it("explains unfinished output from authoritative blockers even without a provider error", () => {
    const result = generationTerminalPresentation({
      phase: "paused",
      project: { pageCount: 5 },
      inspection: { composed: false, pages: Array.from({ length: 5 }, () => ({})) },
      execution: {
        blockers: [
          { code: "page_render_needed", pageIds: ["p1"] },
          { code: "page_render_needed", pageIds: ["p2"] },
          { code: "structural_review_needed", pageIds: ["p1", "p2"] },
        ],
      },
    });
    assert.ok(result);
    assert.match(result.status, /已生成 5 页/);
    assert.match(result.detail, /有 2 页尚未完成截图与排版检查/);
    assert.match(result.detail, /整稿结构检查尚未通过/);
    assert.match(result.action, /继续完成生成/);
  });

  it("states that the model stopped before wrap-up when no error or blocker was recorded", () => {
    const result = generationTerminalPresentation({
      phase: "paused",
      project: { pageCount: 5 },
      inspection: { composed: false },
    });
    assert.ok(result);
    assert.match(result.detail, /模型已结束本轮回复/);
    assert.doesNotMatch(result.detail, /全部完成/);
  });

  it("reports preserved reviewed pages separately from an unfinished final compose", () => {
    const pages = Array.from({ length: 10 }, (_, index) => ({
      pageId: String(index + 1).padStart(2, "0"),
      visualReview: "pass",
    }));
    const presentation = generationTerminalPresentation({
      phase: "paused",
      project: { pageCount: 10 },
      inspection: {
        pages,
        composed: false,
        missingReferenceChunks: Array.from({ length: 8 }, (_, index) => ({ chunkIndex: index })),
      },
      error: {
        code: "production-no-progress-budget",
        detail: "生产阶段连续 32 个工具结果未产生持久页面修订，已达到有界预算。",
      },
    });

    assert.ok(presentation);
    assert.equal(presentation.status, "已生成 10 页，收尾未完成");
    assert.equal(presentation.output, "已写入并检查 10 页");
    assert.match(presentation.action, /最终合稿未完成.*8 个参考资料分段/);
    assert.match(presentation.detail, /10 页已写入并通过页面检查/);
    assert.match(presentation.detail, /连续 32 个工具结果/);
  });

  it("names token-plan exhaustion instead of a bare 已暂停 chip", () => {
    const presentation = generationTerminalPresentation({
      phase: "paused",
      project: { pageCount: 14 },
      inspection: { pages: [{ pageId: "1_cover" }], composed: true },
      error: {
        code: "provider-token-plan",
        detail:
          'provider-token-plan: 429 {"error":{"message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"}}',
      },
    });
    assert.ok(presentation);
    assert.match(presentation.status, /已暂停/);
    assert.match(presentation.status, /额度已用尽/);
    assert.match(presentation.action, /换模型或充值/);
    assert.equal(
      humanizeGenerationFault({ error: { code: "provider-token-plan", detail: "2056" } }),
      "当前模型的套餐额度已用尽。请换模型或充值后再点继续；自动重试无法恢复额度。",
    );
  });

  it("keeps a zero-page hard failure distinct from a canceled partial result", () => {
    assert.deepEqual(
      generationTerminalPresentation({
        phase: "failed",
        project: { pageCount: 0 },
        error: { detail: "项目文件不存在" },
      }),
      {
        status: "未完成 · 项目文件不存在",
        action: "项目文件不存在",
        output: "尚未写入页面",
        detail: "尚未写入页面；项目文件不存在。",
        reason: "项目文件不存在",
        pageCount: 0,
        reviewedPageCount: 0,
        missingReferenceCount: 0,
        composed: false,
      },
    );
    const canceled = generationTerminalPresentation({
      phase: "cancelled",
      project: { pageCount: 3 },
      inspection: { pages: [{}, {}, {}], composed: false },
    });
    assert.ok(canceled);
    assert.equal(canceled.status, "已取消，保留 3 页");
  });
});

describe("generation resume contract", () => {
  const sessionId = "resume-session";
  const ledger = {
    pages: [
      { pageId: "01_cover", visualReview: "pass" },
      { pageId: "02_close", visualReview: "pass" },
    ],
    composed: false,
    missingReferenceChunks: [
      { sourceId: "openkimi:reference/pptd.md", chunkIndex: 1 },
      { sourceId: "openkimi:reference/pptd.md", chunkIndex: 2 },
    ],
  };

  it("requires the same idle terminal session with saved pages and unfinished compose", () => {
    const activity = {
      sessionId,
      phase: "paused",
      project: { pageCount: 2 },
      inspection: { composed: false, pages: ledger.pages },
    };
    assert.equal(generationResumeCandidate(activity), true);
    assert.equal(generationResumeCandidate({ ...activity, phase: "generating" }), false);
    assert.equal(
      generationResumeCandidate({ ...activity, project: { pageCount: 0 }, inspection: { pages: [], composed: false } }),
      false,
    );
    assert.equal(
      generationResumeCandidate({
        sessionId,
        phase: "paused",
        project: { pageCount: 0 },
        execution: { recovery: { kind: "continue" }, status: { kind: "paused" } },
      }),
      true,
    );
    assert.equal(
      generationResumeCandidate({ ...activity, inspection: { pages: ledger.pages, composed: true } }),
      false,
    );

    const state = {
      binding: { sessionId },
      agentStatus: "idle",
      phase: { kind: "paused" },
      inspection: { sessionId, ledger },
    };
    assert.equal(generationStateCanResume(state, sessionId), true);
    assert.equal(generationStateCanResume({ ...state, agentStatus: "busy" }, sessionId), false);
    assert.equal(
      generationStateCanResume(
        {
          ...state,
          binding: { dshSessionId: sessionId },
          execution: { recovery: { kind: "continue" }, status: { kind: "paused" } },
        },
        sessionId,
      ),
      true,
    );
    assert.equal(generationStateCanResume(state, "other-session"), false);
    assert.equal(generationStateCanResume({ ...state, phase: { kind: "complete" } }, sessionId), false);
  });

  it("hides the resume entry once the deck is composed and only a fresh export remains", () => {
    const deliveredThenEdited = {
      sessionId,
      phase: "complete",
      project: { pageCount: 8 },
      execution: {
        recovery: { kind: "continue", reason: "Export the current composed document" },
        status: { kind: "ready-to-export" },
        blockers: [{ code: "export_needed", detail: "Export the current composed document", next: "export_deck" }],
      },
    };
    assert.equal(generationResumeCandidate(deliveredThenEdited), false);
    assert.equal(
      generationStateCanResume(
        {
          binding: { dshSessionId: sessionId },
          agentStatus: "idle",
          phase: { kind: "complete" },
          execution: deliveredThenEdited.execution,
        },
        sessionId,
      ),
      false,
    );
  });

  it("still offers resume when a fault stopped the run even though export was next", () => {
    const stalled = {
      sessionId,
      phase: "paused",
      execution: {
        recovery: { kind: "continue" },
        status: { kind: "ready-to-export" },
        fault: { code: "operator-stop" },
      },
    };
    assert.equal(generationResumeCandidate(stalled), true);
    assert.equal(
      generationStateCanResume(
        {
          binding: { dshSessionId: sessionId },
          agentStatus: "idle",
          execution: stalled.execution,
        },
        sessionId,
      ),
      true,
    );
  });

  it("builds a ledger-driven continuation without an editor edit scope", () => {
    const instruction = generationResumeInstruction({ inspection: { ledger } });
    assert.match(instruction, /保留已经持久化的 2 页/);
    assert.match(instruction, /openkimi:reference\/pptd\.md#1/);
    assert.match(instruction, /compose_deck 和 export_deck/);
    assert.match(instruction, /仅允许针对当前权威检查明确点名为失败或需要修订的页面进行必要修复/);
    assert.match(instruction, /其他页面保持不变/);
    assert.doesNotMatch(instruction, /editorEdit|authorizationId|workspaceEdit/);
  });
});

describe("expanded fault humanization, terminal card model, and recovery guards", () => {
  it("prioritizes explicit auth and 429 before generic quota and humanizes network/context/5xx/4xx", () => {
    assert.equal(
      humanizeGenerationFault({ error: { detail: "401 invalid api key quota check" } }),
      "模型登录失效，请重新登录或更换密钥。",
    );
    assert.equal(
      humanizeGenerationFault({ error: { detail: "429 Too Many Requests: quota limit" } }),
      "模型暂时限流，稍后再继续即可。",
    );
    assert.equal(
      humanizeGenerationFault({ error: { code: "provider-quota", detail: "429 RESOURCE_EXHAUSTED" } }),
      "模型额度已用尽。请换模型或充值后再继续。",
    );
    assert.equal(
      humanizeGenerationFault({ error: { detail: "fetch failed: ECONNREFUSED" } }),
      "模型服务连接超时或网络不可达，请稍后重试或切换模型。",
    );
    assert.equal(
      humanizeGenerationFault({ error: { detail: "maximum context length exceeded" } }),
      "上下文内容超出当前模型长度限制，请切换更大上下文的模型或精简指令后继续。",
    );
    assert.equal(
      humanizeGenerationFault({ error: { detail: "503 Service Unavailable" } }),
      "模型服务暂时不可用，请稍后重试或切换模型。",
    );
    assert.equal(
      humanizeGenerationFault({ error: { detail: "404 model not found" } }),
      "当前模型拒绝了本次请求，请检查模型配置或切换其他模型后重试。",
    );
  });

  it("builds pill models, wait cards, and deduplicated fault cards", () => {
    const now = 10000;
    const mustCard = (/** @type {any} */ a, /** @type {any} */ o = undefined) => {
      const m = generationTerminalCardModel(a, o);
      assert.ok(m);
      return m;
    };
    assert.equal(generationTerminalCardModel({ phase: "generating" }, { now }), null);
    assert.deepEqual(generationTerminalCardModel({ phase: "complete" }, { pageCount: 6, duration: " · 用时 10 秒" }), {
      variant: "pill",
      tone: "success",
      badge: "",
      title: "已完成 · 6 页 · 用时 10 秒",
      summary: "",
      hint: "",
      rawDetail: "",
      recoveryKind: "none",
      rateLimitWait: null,
      statusText: "已完成",
    });
    assert.equal(mustCard({ phase: "edited" }).statusText, "已修改");
    assert.equal(mustCard({ phase: "discussion" }).statusText, "继续聊聊");

    const waitCard = mustCard(
      {
        phase: "generating",
        rateLimitWait: { attempt: 1, waitMs: 30000, nextRetryAt: now + 15000, code: "provider-rate-limit" },
      },
      { now },
    );
    assert.equal(waitCard.variant, "card");
    assert.equal(waitCard.tone, "wait");
    assert.equal(waitCard.badge, "自动重试中");
    assert.equal(waitCard.recoveryKind, "wait-or-stop");
    assert.equal(waitCard.statusText, "模型暂时限流，等待自动重试");
    assert.equal(
      generationTerminalCardModel({ phase: "generating", rateLimitWait: { nextRetryAt: now - 1 } }, { now }),
      null,
    );

    const blocked = mustCard({
      phase: "paused",
      project: { pageCount: 10 },
      inspection: { composed: false, pages: Array.from({ length: 10 }, () => ({})), missingReferenceChunks: [{}, {}] },
      error: { code: "production-no-progress-budget", detail: "连续 32 个工具结果未产生持久页面修订。" },
    });
    assert.equal(blocked.tone, "warning");
    assert.equal(blocked.title, "已生成 10 页，收尾未完成");
    assert.equal(blocked.statusText, "已生成 10 页，收尾未完成");
    assert.match(blocked.summary, /仍缺 2 个参考资料分段未读取/);
    assert.equal(blocked.rawDetail, "");

    const plan = mustCard({
      phase: "paused",
      project: { pageCount: 2 },
      execution: { recovery: { kind: "resolve" } },
      error: { code: "provider-token-plan", detail: "provider-token-plan: 429 (2056)" },
    });
    assert.equal(plan.tone, "error");
    assert.equal(plan.badge, "需要处理");
    assert.equal(plan.title, "模型额度已用尽");
    assert.equal(plan.rawDetail, "provider-token-plan: 429 (2056)");

    const stopped = mustCard({ phase: "cancelled", project: { pageCount: 3 } });
    assert.equal(stopped.tone, "info");
    assert.equal(stopped.badge, "已停止");
    assert.equal(stopped.title, "已停止，保留 3 页");
    assert.equal(stopped.summary, "");
  });

  it("suppresses spurious activity_unknown and honors explicit execution recovery kinds", () => {
    assert.equal(
      unfinishedGenerationReason(
        { phase: "paused", execution: { blockers: [{ code: "activity_unknown" }, { code: "compose_needed" }] } },
        {},
      ),
      "页面检查已通过，尚未完成合稿",
    );
    assert.equal(
      unfinishedGenerationReason({ phase: "paused", execution: { blockers: [{ code: "activity_unknown" }] } }, {}),
      "模型已结束本轮回复，但尚未完成整稿检查与合稿",
    );
    assert.equal(
      unfinishedGenerationReason(
        { phase: "paused", connectionState: "disconnected", execution: { blockers: [{ code: "activity_unknown" }] } },
        {},
      ),
      "暂时无法确认生成会话状态，请等待连接恢复",
    );
    const sid = "s1";
    for (const kind of ["wait-or-stop", "resolve", "none"]) {
      const execution = { status: { kind: "paused" }, recovery: { kind } };
      assert.equal(generationResumeCandidate({ sessionId: sid, phase: "paused", execution }), false);
      assert.equal(
        generationStateCanResume({ binding: { sessionId: sid }, agentStatus: "idle", execution }, sid),
        false,
      );
    }
    const readyWithErr = {
      sessionId: sid,
      phase: "paused",
      error: { detail: "boom" },
      execution: { status: { kind: "ready-to-export" }, recovery: { kind: "continue" } },
    };
    assert.equal(generationResumeCandidate(readyWithErr), true);
    assert.equal(
      generationStateCanResume(
        {
          binding: { sessionId: sid },
          agentStatus: "idle",
          phase: "paused",
          error: { detail: "boom" },
          execution: readyWithErr.execution,
        },
        sid,
      ),
      true,
    );
    assert.equal(
      generationResumeCandidate({ sessionId: sid, phase: "paused", execution: { status: { kind: "paused" } } }),
      true,
    );
  });

  it("humanizes internal Host fault codes while keeping Chinese production budget detail intact", () => {
    const h = (/** @type {any} */ error) => humanizeGenerationFault({ error });
    assert.equal(h({ code: "operator-stop" }), "你已手动停止本轮任务。");
    assert.equal(h({ detail: "operator stopped turn" }), "你已手动停止本轮任务。");
    assert.equal(h({ code: "host-interrupted" }), "后台服务意外中断，任务已自动暂停。");
    assert.equal(h({ detail: "host_interrupted during stream" }), "后台服务意外中断，任务已自动暂停。");
    assert.equal(h({ code: "repeated-invalid-args" }), "模型连续返回无效的工具参数，任务已自动暂停。");
    assert.equal(h({ code: "tool-invalid-args-loop" }), "模型连续返回无效的工具参数，任务已自动暂停。");
    assert.equal(h({ code: "repeated-business-rejection" }), "连续多次写入未通过校验，任务已自动暂停。");
    assert.equal(h({ code: "planning-no-progress-budget" }), "规划阶段长时间未推进，任务已自动暂停。");
    assert.equal(
      h({ code: "production-no-progress-budget", detail: "no progress" }),
      "制作阶段长时间未产生新页面修订，任务已自动暂停。",
    );
    const zh = "生产阶段连续 32 个工具结果未产生持久页面修订。";
    assert.equal(h({ code: "production-no-progress-budget", detail: zh }), zh);
  });

  it("builds mode-aware discuss/edit cards and non-repeating wait/auth/quota/token-plan copy", () => {
    const card = (/** @type {any} */ a, /** @type {any} */ o = undefined) => {
      const m = generationTerminalCardModel(a, o);
      assert.ok(m);
      return m;
    };
    const sig = (/** @type {any} */ m) => `${m.title}|${m.statusText}|${m.badge}|${m.tone}|${m.recoveryKind}`;
    const dHint = "可以重新发送消息，或在下方切换模型后再试。";
    const eHint = "文稿未受影响；可以重新发送修改要求，或在下方切换模型后再试。";
    const qHint = "请在下方切换到其他已连接的模型，或充值补充额度后再继续。";
    const dFail = card({ phase: "failed", conversation: { mode: "discuss" }, error: { detail: "503" } });
    assert.equal(sig(dFail), "回复未完成|回复未完成|未完成|error|none");
    assert.equal(dFail.hint, dHint);
    const dStop = card({ phase: "cancelled", conversation: { mode: "discuss" } });
    assert.equal(sig(dStop), "已停止回复|已停止|已停止|info|none");
    const ePause = card({
      phase: "paused",
      conversation: { mode: "edit" },
      execution: { recovery: { kind: "continue" } },
    });
    assert.equal(sig(ePause), "修改未完成|修改未完成|已暂停|warning|none");
    assert.equal(ePause.hint, eHint);
    const eStop = card({ phase: "canceled", conversation: { mode: "edit" } });
    assert.equal(sig(eStop), "已停止修改|已停止|已停止|info|none");
    for (const m of [dFail, dStop, ePause, eStop]) assert.doesNotMatch(m.hint, /留空按当前计划继续/);

    const wait = card(
      { phase: "generating", error: { code: "provider-rate-limit" }, rateLimitWait: { nextRetryAt: 20000 } },
      { now: 10000 },
    );
    assert.equal(wait.title, "模型暂时限流");
    assert.equal(wait.summary, "请求触发了上游频率限制，系统正在按退避间隔等待自动续跑。");
    assert.equal(wait.hint, "倒计时结束后会自动继续，也可以先在下方切换模型立即继续，或点击停止等待。");
    const auth = card({ phase: "failed", error: { code: "provider-auth", detail: "401" } });
    assert.equal(auth.title, "模型登录或密钥失效");
    assert.equal(auth.summary, "当前供应商拒绝了身份认证，需要重新认证或更换模型后才能继续。");
    assert.equal(auth.hint, "可在下方切换到其他可用模型，或在设置中更新密钥或重新登录。");
    const quota = card({ phase: "failed", error: { code: "provider-quota", detail: "quota" } });
    assert.equal(quota.title, "模型额度已用尽");
    assert.equal(quota.summary, "当前模型账户额度已用尽，自动重试无法恢复。");
    assert.equal(quota.hint, qHint);
    const plan = card({
      phase: "paused",
      execution: { recovery: { kind: "resolve" } },
      error: { code: "provider-token-plan", detail: "2056" },
    });
    assert.equal(plan.summary, "当前模型的套餐额度已用尽，自动重试无法恢复。");
    assert.equal(plan.hint, qHint);
    assert.doesNotMatch(qHint, /重新登录|密钥/);
  });
});
