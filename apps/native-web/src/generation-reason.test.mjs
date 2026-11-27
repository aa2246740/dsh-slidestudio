import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTerminalCardModel, humanizeGenerationFault } from "../public/generation-reason.js";
import { GENERATION_STATUS_I18N } from "../public/generation-status-i18n.js";

const SMALL_WINDOW_TITLE = "当前模型上下文窗口过小";
const SMALL_WINDOW_SUMMARY =
  "当前模型的上下文窗口不足以容纳完整演示文稿生成，请切换到至少 64k 上下文窗口的模型后再继续。";
const SMALL_WINDOW_HINT = "请在下方切换到上下文窗口不小于 64k 的模型（推荐 128k 及以上）后再继续。";

describe("generation-reason context-window-too-small handling", () => {
  it("humanizes context-window-too-small by fault code or CONTEXT_WINDOW_TOO_SMALL raw detail", () => {
    assert.equal(
      humanizeGenerationFault({
        error: {
          code: "context-window-too-small",
          detail: "模型上下文窗口过小：受保护的上下文约 28000 tokens，可用输入预算仅 20000 tokens（窗口 32768）。",
        },
      }),
      SMALL_WINDOW_SUMMARY,
    );
    assert.equal(
      humanizeGenerationFault({
        error: {
          code: "provider-bad-request",
          detail: "CONTEXT_WINDOW_TOO_SMALL: maximum context length cannot hold protected context",
        },
      }),
      SMALL_WINDOW_SUMMARY,
    );
    assert.equal(
      humanizeGenerationFault({
        phaseDetail: "CONTEXT_WINDOW_TOO_SMALL (window 32768)",
      }),
      SMALL_WINDOW_SUMMARY,
    );
  });

  it("builds an error-tone resolve card with model-switch guidance and preserved technical detail", () => {
    const technicalDetail =
      "模型上下文窗口过小：受保护的上下文约 28000 tokens，可用输入预算仅 20000 tokens（窗口 32768）。";
    const card = buildTerminalCardModel({
      phase: "paused",
      error: { code: "context-window-too-small", detail: technicalDetail },
      execution: { recovery: { kind: "resolve" } },
    });
    assert.ok(card);
    assert.equal(card.variant, "card");
    assert.equal(card.tone, "error");
    assert.equal(card.badge, "需要处理");
    assert.equal(card.title, SMALL_WINDOW_TITLE);
    assert.equal(card.summary, SMALL_WINDOW_SUMMARY);
    assert.equal(card.hint, SMALL_WINDOW_HINT);
    assert.equal(card.recoveryKind, "resolve");
    assert.equal(card.rawDetail, technicalDetail);
    assert.equal(card.statusText, SMALL_WINDOW_TITLE);
  });

  it("deduplicates rawDetail when error.detail repeats the summary and works via execution.fault", () => {
    const repeated = buildTerminalCardModel({
      phase: "paused",
      error: { code: "context-window-too-small", detail: SMALL_WINDOW_SUMMARY },
      execution: { recovery: { kind: "resolve" } },
    });
    assert.ok(repeated);
    assert.equal(repeated.tone, "error");
    assert.equal(repeated.rawDetail, "");

    const fromExecutionFault = buildTerminalCardModel({
      phase: "paused",
      project: { pageCount: 2 },
      inspection: { composed: false, pages: [{ pageId: "1_cover" }, { pageId: "2_body" }] },
      execution: { fault: { code: "context-window-too-small", detail: "CONTEXT_WINDOW_TOO_SMALL" } },
    });
    assert.ok(fromExecutionFault);
    assert.equal(fromExecutionFault.tone, "error");
    assert.equal(fromExecutionFault.title, SMALL_WINDOW_TITLE);
    assert.equal(fromExecutionFault.summary, SMALL_WINDOW_SUMMARY);
    assert.equal(fromExecutionFault.hint, SMALL_WINDOW_HINT);
    assert.equal(fromExecutionFault.badge, "需要处理");
    assert.equal(fromExecutionFault.recoveryKind, "resolve");
    assert.equal(fromExecutionFault.rawDetail, "");
  });

  it("provides English i18n entries in GENERATION_STATUS_I18N for every new Chinese copy key", () => {
    for (const key of [SMALL_WINDOW_TITLE, SMALL_WINDOW_SUMMARY, SMALL_WINDOW_HINT]) {
      const english = GENERATION_STATUS_I18N[key];
      assert.equal(typeof english, "string", `missing English translation for ${key}`);
      assert.ok(english.trim().length > 0, `empty English translation for ${key}`);
      assert.equal(/[\u4e00-\u9fff]/.test(english), false, `translation for ${key} should be English`);
    }
  });
});
