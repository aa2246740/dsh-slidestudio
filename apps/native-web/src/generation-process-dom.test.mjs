import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const { resolvePlaywrightRuntimeFile } = await import("../../../scripts/lib/playwright-runtime-path.mjs");
const playwrightRuntime = resolvePlaywrightRuntimeFile(process.env, { repoRoot: ROOT, homeDir: os.homedir() });
const hasPlaywright = playwrightRuntime.ready;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openslides-process-dom-"));
const project = path.join(scratch, "project");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

function snapshot(events, phase = "generating") {
  return {
    ok: true,
    sessionId: "test-session",
    brief: "独立测试：持续显示生成过程",
    phase,
    project: { path: project, title: "Process DOM", pageCount: 1, pagePaths: ["pages/01_cover.page"] },
    inspection: { pages: [{ pageId: "01_cover", visualReview: "pending" }] },
    stages: [
      { id: "plan", status: "complete", detail: "1 页" },
      { id: "pages", status: phase === "complete" ? "complete" : "active", detail: "1 页" },
      { id: "review", status: phase === "complete" ? "complete" : "pending", detail: "" },
      { id: "compose", status: phase === "complete" ? "complete" : "pending", detail: "" },
    ],
    events,
  };
}

describe("generation process DOM", { skip: !hasPlaywright }, () => {
  let browser;
  let server;
  let page;
  let current;
  let base;
  let serverLog = "";

  after(async () => {
    await page?.close();
    await browser?.close();
    if (server) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("preserves cards and reading position while appending, then follows and folds on completion", async () => {
    fs.cpSync(path.join(ROOT, "fixtures", "okp-yu7-ppt"), project, { recursive: true });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["apps/native-web/src/server.mjs"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), OPEN_SLIDESTUDIO_PROJECT: project },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => { serverLog += chunk; });
    server.stderr.on("data", (chunk) => { serverLog += chunk; });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        if (attempt === 79) throw new Error(`native editor did not start\n${serverLog}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const { launchPinnedChromium } = await import("../../../scripts/lib/pinned-playwright.mjs");
    browser = await launchPinnedChromium({ headless: true });
    page = await browser.newPage({locale:'zh-CN', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const hostile = "<img src=x onerror=alert(1)>";
    const history = Array.from({ length: 36 }, (_, index) => ({
      id: `ledger-${index}`,
      kind: "ledger",
      label: `历史步骤 ${index + 1}`,
      detail: `已记录 ${index + 1}`,
      status: "complete",
    }));
    const initialEvents = [
      { id: "message", kind: "message", label: "助手消息", detail: "我先检查已有资料，再开始排版。", status: "complete" },
      { id: "reasoning", kind: "reasoning", label: "思考", detail: hostile, status: "running" },
      { id: "tool:bad", kind: "tool", callId: "bad", name: "view_design_reference", detail: "{\"designSystemId\":\"x\"}", status: "running" },
      { id: "result:bad", kind: "result", callId: "bad", name: "view_design_reference", detail: "{\"ok\":false,\"detail\":\"taste execution gate is not enabled\"}", status: "complete" },
      // Kept away from the running reasoning row: the process list folds
      // consecutive thought/reasoning rows into one card (DSH parity), which
      // would otherwise merge the completed and running cards this case checks.
      { id: "past-reasoning", kind: "reasoning", label: "思考", detail: "已经完成的历史思考", status: "complete" },
      ...history,
    ];
    current = snapshot(initialEvents);
    await page.route("**/api/generation-activity**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(current),
    }));
    await page.route("**/slides/state/test-session", route => route.fulfill({json:{binding:{dshSessionId:"test-session"},agentStatus:current.phase === "generating" ? "busy" : "idle",phase:{kind:current.phase},questions:[]}}));
    // A live session keeps a stream connection open, so "networkidle" never
    // settles; wait for the boot DOM instead and let the assertions below wait
    // for the rendered rows.
    await page.goto(`${base}/index.html?project=${encodeURIComponent(project)}&workspace=1&live=1&session=test-session`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(() => document.querySelectorAll("#editor-generation-event-list > li").length >= 40);

    // The document must be focused before a programmatic range is set, otherwise
    // a headless page may silently drop the selection on the next layout pass.
    await page.bringToFront();
    const initial = await page.evaluate((unsafe) => {
      const list = document.getElementById("editor-generation-event-list");
      const tool = list.querySelector('[data-process-key="tool:bad"]');
      const details = tool.querySelector(".generation-technical-details");
      const technicalDefaultClosed = !details.open;
      const rawDefaultHidden = !details.querySelector("pre").checkVisibility();
      details.open = true;
      tool.dataset.testSeat = "preserved";
      const reasoning = list.querySelector('[data-process-key="reasoning"] [data-process-detail]');
      const range = document.createRange();
      range.selectNodeContents(reasoning);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return {
        overflow: list.scrollHeight > list.clientHeight,
        horizontalOverflow: list.scrollWidth > list.clientWidth + 1,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
        sidebarWidth: document.querySelector(".work-chat").getBoundingClientRect().width,
        panelHeight: document.getElementById("editor-generation").getBoundingClientRect().height,
        toolCardTag: tool.firstElementChild?.tagName,
        technicalDefaultClosed,
        rawDefaultHidden,
        readableTitle: tool.querySelector(".tool-verb").textContent,
        readableTarget: tool.querySelector("[data-tool-target]").textContent,
        readableSummary: tool.querySelector("[data-process-summary]").textContent,
        readableFacts: tool.querySelector("[data-process-facts]").textContent,
        readableHasJson: [...tool.querySelector(".generation-tool-card").children]
          .filter((node) => !node.matches(".generation-technical-details"))
          .some((node) => node.textContent.includes("{")),
        messageIsArticle: Boolean(list.querySelector('[data-process-key="message"] > .generation-message-card')),
        currentReasoningOpen: list.querySelector('[data-process-key="reasoning"] > .generation-reasoning-card')?.open,
        pastReasoningOpen: list.querySelector('[data-process-key="past-reasoning"] > .generation-reasoning-card')?.open,
        failed: tool.dataset.processStatus,
        status: tool.querySelector("[data-process-status]").textContent,
        titleFontSize: getComputedStyle(tool.querySelector(".tool-verb")).fontSize,
        detailFontSize: getComputedStyle(tool.querySelector("pre")).fontSize,
        injected: Boolean(list.querySelector("img")),
        hostileText: list.textContent.includes(unsafe),
      };
    }, hostile);
    assert.ok(initial.overflow, `process list did not own scrolling: ${JSON.stringify(initial)}`);
    assert.equal(initial.sidebarWidth, 420);
    assert.equal(initial.horizontalOverflow, false, `process cards overflowed horizontally: ${JSON.stringify(initial)}`);
    assert.equal(initial.titleFontSize, "13px");
    // The technical-details block (and the inline <pre> inside it) is hidden by
    // design now, so only the visible tool title keeps a typography assertion.
    assert.equal(initial.toolCardTag, "ARTICLE");
    assert.equal(initial.technicalDefaultClosed, true);
    assert.equal(initial.rawDefaultHidden, true);
    assert.equal(initial.readableTitle, "查看设计参考");
    assert.equal(initial.readableTarget, "x");
    assert.match(initial.readableSummary, /未启用设计参考预览/);
    assert.match(initial.readableFacts, /设计参考.*x/);
    assert.equal(initial.readableHasJson, false);
    assert.equal(initial.messageIsArticle, true);
    // While the turn is live every reasoning card is expanded (a manual collapse
    // is remembered per card); the completed-turn fold is asserted below.
    assert.equal(initial.currentReasoningOpen, true);
    assert.equal(initial.pastReasoningOpen, true);
    assert.equal(initial.failed, "failed");
    assert.equal(initial.status, "失败");
    assert.equal(initial.injected, false);
    assert.equal(initial.hostileText, true);

    current = snapshot([
      initialEvents[0],
      { ...initialEvents[0], type: "assistant/chunk", detail: "\n继续分析当前页" },
      ...initialEvents.slice(1),
      { id: "ledger-delta", kind: "ledger", label: "新增步骤", status: "complete" },
    ]);
    await page.waitForFunction(() => document.querySelector('[data-process-key="ledger-delta"]'));
    const stable = await page.evaluate(() => {
      const tool = document.querySelector('[data-process-key="tool:bad"]');
      const reasoning = document.querySelectorAll('[data-process-key="reasoning"]');
      const reasoningDetail = reasoning[0]?.querySelector("[data-process-detail]");
      const selection = getSelection();
      return {
        sameSeat: tool?.dataset.testSeat,
        stillOpen: tool?.querySelector(".generation-technical-details")?.open,
        reasoningCount: reasoning.length,
        selectionKept: Boolean(selection && !selection.isCollapsed && reasoningDetail?.contains(selection.anchorNode)),
        selectedTextHeld: reasoningDetail?.textContent,
      };
    });
    assert.equal(stable.sameSeat, "preserved");
    assert.equal(stable.stillOpen, true);
    assert.equal(stable.reasoningCount, 1);
    assert.equal(stable.selectionKept, true);
    assert.equal(stable.selectedTextHeld, hostile, "streaming text pauses while the user selects it");

    current = snapshot(current.events.map((event) => event.id === "reasoning" ? { ...event, status: "complete" } : event));
    await page.waitForFunction(() => !document.querySelector('[data-process-key="reasoning"] > .generation-reasoning-card')?.open);
    // Earlier steps of a live turn sit behind the counted fold row; open it first.
    const fold = page.locator('.reader-process-toggle').last();
    if (await fold.getAttribute('aria-expanded') !== 'true') await fold.click();
    const card = '[data-process-key="reasoning"] > .generation-reasoning-card';
    // Revealing the fold may already show the card expanded; end on a manual open.
    if (await page.$eval(card, (node) => node.open)) await page.click(`${card} > summary`);
    await page.click(`${card} > summary`);
    assert.equal(await page.$eval('[data-process-key="reasoning"] > .generation-reasoning-card', (node) => node.open), true);

    const scrolled = await page.evaluate(() => {
      const list = document.getElementById("editor-generation-event-list");
      getSelection()?.removeAllRanges();
      list.scrollTop = 0;
      list.dispatchEvent(new Event("scroll"));
      return { top: list.scrollTop, height: list.scrollHeight, client: list.clientHeight };
    });
    assert.equal(scrolled.top, 0);
    assert.ok(scrolled.height > scrolled.client);
    current = snapshot([...current.events, { id: "after-scroll", kind: "ledger", label: "滚动后新增", status: "complete" }]);
    await page.waitForFunction(() => document.querySelector('[data-process-key="after-scroll"]'));
    const held = await page.evaluate(() => ({
      top: document.getElementById("editor-generation-event-list").scrollTop,
      latestHidden: document.getElementById("editor-generation-latest").hidden,
      userReasoningOpen: document.querySelector('[data-process-key="reasoning"] > .generation-reasoning-card')?.open,
    }));
    assert.ok(held.top <= 2, `user reading position moved to ${held.top}`);
    assert.equal(held.latestHidden, false);
    assert.equal(held.userReasoningOpen, true, "a reasoning card opened by the user stays open across polling");

    await page.click("#editor-generation-latest");
    await page.waitForFunction(() => {
      const list = document.getElementById("editor-generation-event-list");
      return list.scrollHeight - list.scrollTop - list.clientHeight <= 24;
    });

    current = snapshot(current.events, "complete");
    await page.waitForFunction(() => document.getElementById("editor-generation-status")?.textContent === "已完成");
    const completed = await page.evaluate(() => ({
      expanded: document.getElementById("editor-generation").classList.contains("is-expanded"),
      historyOpen: document.getElementById("editor-generation-events").open,
      cards: document.querySelectorAll("#editor-generation-event-list > li").length,
    }));
    assert.equal(completed.historyOpen, true);
    assert.ok(completed.cards > 0, "completed process history remains mounted");
  });

  it("shows reviewed partial output, recovered attempts, parent cancellation, and the remaining blocker", async () => {
    const pages = Array.from({ length: 10 }, (_, index) => ({
      pageId: String(index + 1).padStart(2, "0"),
      visualReview: "pass",
    }));
    current = {
      ...snapshot([
        { id: "turn-cancel", kind: "turn", turn: 1, status: "cancelled", detail: "Turn cancelled (hook: production-no-progress-budget)" },
        { id: "write-1", kind: "tool", turn: 1, callId: "write-1", name: "write_page", detail: '{"id":"01_cover"}' },
        { id: "write-1-result", kind: "result", turn: 1, callId: "write-1", status: "complete", detail: '{"outcome":"rejected","detail":"overlap"}' },
        { id: "write-2", kind: "tool", turn: 1, callId: "write-2", name: "write_page", detail: '{"id":"01_cover"}' },
        { id: "write-2-result", kind: "result", turn: 1, callId: "write-2", status: "complete", detail: '{"outcome":"written","pageId":"01_cover"}' },
        { id: "aborted", kind: "tool", turn: 1, callId: "aborted", name: "read_reference", detail: '{"sourceId":"openkimi:reference/pptd.md","chunkIndex":1}' },
        { id: "aborted-result", kind: "result", turn: 1, callId: "aborted", status: "failed", detail: "Error: tool call aborted before dispatch" },
        { id: "compose", kind: "tool", turn: 1, callId: "compose", name: "compose_deck", detail: "{}" },
        { id: "compose-result", kind: "result", turn: 1, callId: "compose", status: "failed", detail: '{"ok":false,"detail":"compose gate failed: 8 required source chunks unread"}' },
      ], "paused"),
      project: { path: project, title: "Process DOM", pageCount: 10, pagePaths: pages.map((page) => `pages/${page.pageId}.page`) },
      inspection: {
        pages,
        composed: false,
        missingReferenceChunks: Array.from({ length: 8 }, (_, index) => ({ chunkIndex: index })),
      },
      stages: [
        { id: "plan", status: "complete", detail: "已规划 10 页" },
        { id: "pages", status: "complete", detail: "已持久化 10 页" },
        { id: "review", status: "complete", detail: "页面检查已通过" },
        { id: "compose", status: "needs-attention", detail: "最终合稿未完成" },
      ],
      error: {
        code: "production-no-progress-budget",
        detail: "生产阶段连续 32 个工具结果未产生持久页面修订，已达到有界预算。",
      },
    };

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("editor-generation-status")?.textContent === "已生成 10 页，收尾未完成");
    const terminal = await page.evaluate(() => ({
      status: document.getElementById("editor-generation-status")?.textContent,
      action: document.getElementById("editor-generation-action")?.textContent,
      output: document.getElementById("editor-generation-output")?.textContent,
      detail: document.getElementById("editor-generation-detail")?.textContent,
      recovered: document.querySelector('[data-process-key="tool:write-1"] [data-process-status]')?.textContent,
      canceled: document.querySelector('[data-process-key="tool:aborted"] [data-process-status]')?.textContent,
      canceledSummary: document.querySelector('[data-process-key="tool:aborted"] [data-process-summary]')?.textContent,
      failed: document.querySelector('[data-process-key="tool:compose"] [data-process-status]')?.textContent,
      failedSummary: document.querySelector('[data-process-key="tool:compose"] [data-process-summary]')?.textContent,
    }));
    assert.equal(terminal.status, "已生成 10 页，收尾未完成");
    assert.match(terminal.action, /最终合稿未完成.*8 个参考资料分段/);
    assert.equal(terminal.output, "已写入并检查 10 页");
    assert.match(terminal.detail, /连续 32 个工具结果/);
    assert.equal(terminal.recovered, "已恢复");
    assert.equal(terminal.canceled, "已取消");
    assert.equal(terminal.canceledSummary, "这次调用尚未执行，所在任务已中止。");
    assert.equal(terminal.failed, "失败");
    assert.match(terminal.failedSummary, /8 个参考资料分段未读取/);
    const visibleReason = page.locator('[data-process-key="turn-end"] .generation-turn-end-detail');
    assert.equal(await visibleReason.isVisible(), true, "the user must see the reason without opening hidden diagnostics");
    assert.match(await visibleReason.innerText(), /连续 32 个工具结果/);
    assert.match(await visibleReason.innerText(), /继续完成生成/);
  });

  it("shows a five-page unfinished run's actual blockers with no error object", async () => {
    current = {
      ...snapshot([{ id: "reply", kind: "message", status: "complete", detail: "已写入页面。" }], "paused"),
      project: { path: project, title: "收尾原因验收", pageCount: 5 },
      inspection: { composed: false, pages: Array.from({ length: 5 }, (_, i) => ({ pageId: `p${i + 1}` })) },
      execution: {
        status: { kind: "reviewing" }, recovery: { kind: "continue" },
        blockers: [{ code: "page_render_needed", pageIds: ["p1", "p2"] }, { code: "structural_review_needed", pageIds: ["p1", "p2"] }],
      },
    };
    await page.reload({ waitUntil: "networkidle" });
    const reason = page.locator('[data-process-key="turn-end"] .generation-turn-end-detail');
    await reason.waitFor({ state: "visible" });
    assert.match(await reason.innerText(), /有 2 页尚未完成截图与排版检查/);
    assert.match(await reason.innerText(), /整稿结构检查尚未通过/);
    if (process.env.SLIDESTUDIO_TEST_EVIDENCE) {
      fs.mkdirSync(process.env.SLIDESTUDIO_TEST_EVIDENCE, { recursive: true });
      await reason.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.SLIDESTUDIO_TEST_EVIDENCE, "unfinished-five-pages.png") });
    }
  });

  it("continues an idle partial generation once without creating an editor edit scope", async () => {
    const pages = [
      { pageId: "01_cover", visualReview: "pass", revision: 1, pageSha256: "a".repeat(64) },
      { pageId: "02_close", visualReview: "pass", revision: 1, pageSha256: "b".repeat(64) },
    ];
    const missingReferenceChunks = [
      { sourceId: "openkimi:reference/pptd.md", chunkIndex: 1 },
      { sourceId: "openkimi:reference/pptd.md", chunkIndex: 2 },
    ];
    const pausedActivity = {
      ...snapshot([], "paused"),
      project: { path: project, title: "Process DOM", pageCount: 2, pagePaths: pages.map((entry) => `pages/${entry.pageId}.page`) },
      inspection: { pages, composed: false, missingReferenceChunks },
      stages: [
        { id: "plan", status: "complete", detail: "已规划 2 页" },
        { id: "pages", status: "complete", detail: "已持久化 2 页" },
        { id: "review", status: "complete", detail: "页面检查已通过" },
        { id: "compose", status: "needs-attention", detail: "最终合稿未完成" },
      ],
      error: { detail: "生成收尾暂停" },
    };
    current = pausedActivity;
    let turnAccepted = false;
    let stateReadsAfterTurn = 0;
    const turnBodies = [];
    await page.route("**/slides/state/test-session", (route) => {
      let state;
      if (!turnAccepted) {
        state = {
          binding: { sessionId: "test-session" },
          agentStatus: "idle",
          phase: { kind: "paused", detail: "生成收尾暂停" },
          inspection: {
            sessionId: "test-session",
            ledger: { pages, composed: false, missingReferenceChunks },
          },
        };
      } else if (stateReadsAfterTurn++ === 0) {
        current = {
          ...pausedActivity,
          phase: "reviewing",
          events: [{ id: "resume-started", kind: "turn", turn: 2, status: "running", detail: "继续完成生成" }],
        };
        state = {
          binding: { sessionId: "test-session" },
          agentStatus: "busy",
          phase: { kind: "reviewing" },
          inspection: { sessionId: "test-session", ledger: { pages, composed: false, missingReferenceChunks } },
        };
      } else {
        current = {
          ...pausedActivity,
          phase: "complete",
          error: null,
          inspection: { pages, composed: true, missingReferenceChunks: [] },
          stages: pausedActivity.stages.map((stage) => ({ ...stage, status: "complete" })),
          events: [
            { id: "resume-started", kind: "turn", turn: 2, status: "complete", detail: "继续完成生成" },
            { id: "compose-complete", kind: "ledger", turn: 2, status: "complete", detail: "整稿已合成" },
          ],
        };
        state = {
          binding: { sessionId: "test-session" },
          agentStatus: "idle",
          phase: { kind: "complete" },
          inspection: { sessionId: "test-session", ledger: { pages, composed: true, missingReferenceChunks: [] } },
        };
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) });
    });
    await page.route("**/slides/sessions/test-session/turn", async (route) => {
      turnBodies.push(route.request().postDataJSON());
      turnAccepted = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });

    await page.goto(`${base}/index.html?project=${encodeURIComponent(project)}&workspace=1&session=test-session`, {
      waitUntil: "networkidle",
    });
    await page.waitForFunction(() => {
      const row = document.getElementById("generation-resume-row");
      const button = document.getElementById("editor-generation-resume");
      return row && !row.hidden && button && !button.disabled;
    });
    const clicked = await page.evaluate(() => {
      const button = document.getElementById("editor-generation-resume");
      button.click();
      button.click();
      return { disabled: button.disabled, label: button.textContent };
    });
    assert.equal(clicked.disabled, true);
    assert.equal(clicked.label, "正在继续…");
    await page.waitForFunction(() => document.getElementById("editor-generation-status")?.textContent === "已完成");
    await page.waitForFunction(() => document.getElementById("generation-resume-row")?.hidden === true);

    assert.equal(turnBodies.length, 1, "a double click must dispatch only one continuation turn");
    assert.deepEqual(Object.keys(turnBodies[0]), ["text", "resumeGeneration"]);
    assert.equal(turnBodies[0].resumeGeneration, true);
    assert.equal("editorEdit" in turnBodies[0], false);
    assert.match(turnBodies[0].text, /保留已经持久化的 2 页/);
    assert.match(turnBodies[0].text, /openkimi:reference\/pptd\.md#1/);
    assert.match(turnBodies[0].text, /compose_deck 和 export_deck/);
    assert.equal(new URL(page.url()).searchParams.has("live"), false, "history/open routes can continue without live=1");
  });
  it("sends and restores two discussion turns without creating an edit lock or losing the model choice", async () => {
    const turns = [];
    const mutations = [];
    current = {...snapshot([], "complete"), provider:{providerId:"test",modelId:"model-a"},conversation:{version:1,mode:"generate",messages:[]}};
    await page.route("**/slides/assistant-intent", route => route.fulfill({json:{ok:true,intent:"discuss",scope:"current",pages:[]}}));
    await page.route("**/slides/providers", route => route.fulfill({json:{providers:[{id:"test",name:"Local models",ready:true,models:["model-a","model-b"]}]}}));
    await page.route("**/slides/state/test-session", route => route.fulfill({json:{binding:{dshSessionId:"test-session"},agentStatus:"idle",phase:{kind:"complete"}}}));
    await page.route("**/api/reviews/ai-lock**", route => {mutations.push(route.request().url()); return route.fulfill({status:500,json:{error:"discussion must not acquire an edit lock"}});});
    await page.route("**/slides/sessions/test-session/turn", route => {
      const body = route.request().postDataJSON(); turns.push(body);
      const n = turns.length;
      current.conversation.mode = "discuss";
      current.conversation.messages.push({id:`u${n}`,at:`2026-09-20T00:00:0${n*2}Z`,text:body.text,mode:"discuss"});
      current.events.push({id:`a${n}`,kind:"message",at:`2026-09-20T00:00:0${n*2+1}Z`,detail:`讨论回复 ${n}`,status:"complete"});
      if(body.modelSelection) current.provider = {providerId:body.modelSelection.provider,modelId:body.modelSelection.model};
      return route.fulfill({json:{ok:true}});
    });
    await page.reload({waitUntil:"domcontentloaded"});
    await page.waitForFunction(() => document.querySelector('#assistant-model')?.options.length === 2);
    await page.getByLabel("助手模型",{exact:true}).selectOption("test/model-b");
    for(const [index,text] of ["先讨论一下结构，不要修改文稿。","把刚才的建议再缩短，只回复标题，暂时不修改文稿。"].entries()) {
      await page.getByLabel("与 AI 协作",{exact:true}).fill(text);
      await page.getByRole("button",{name:"发送消息",exact:true}).click();
      await page.waitForFunction(n => document.querySelector('#editor-generation-event-list')?.textContent.includes(`讨论回复 ${n}`), index + 1);
      await page.waitForFunction(() => document.querySelector('#editor-generation-status')?.textContent === "继续聊聊");
    }
    assert.equal(turns.length,2);
    assert.ok(turns.every(body=>body.conversationMode === "discuss" && !body.editorEdit));
    assert.deepEqual(turns[0].modelSelection,{provider:"test",model:"model-b"});
    assert.equal(mutations.length,0);
    await page.reload({waitUntil:"domcontentloaded"});
    await page.waitForFunction(() => document.querySelector('#editor-generation-event-list')?.textContent.includes('讨论回复 2'));
    const text = await page.locator('#editor-generation-event-list').innerText();
    assert.match(text,/先讨论一下结构/); assert.match(text,/讨论回复 1/); assert.match(text,/讨论回复 2/);
    assert.equal(await page.locator('#work-empty').isVisible(),false);
    assert.equal(await page.locator('#generation-resume-row').isVisible(),false);
    assert.equal(await page.locator('#assistant-model').inputValue(),"test/model-b");
  });

  it("unlocks an idle completed edit and keeps background raster loads finite", async () => {
    current = {...current, phase:"reviewing", conversation:{...current.conversation,mode:"edit"}};
    await page.reload({waitUntil:"domcontentloaded"});
    await page.waitForFunction(() => document.getElementById('editor-generation-status')?.textContent === '已修改');
    assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isEnabled(),true);
    assert.equal(await page.getByRole('button',{name:'导出',exact:true}).isVisible(),true);
    let activityReads = 0;
    const raster = await browser.newPage({locale:'zh-CN'});
    try {
      await raster.route('**/api/generation-activity**', route => {activityReads++;return route.fulfill({json:snapshot([],'generating')});});
      await raster.goto(`${base}/index.html?project=${encodeURIComponent(project)}&page=0&workspace=0&render=1`,{waitUntil:'networkidle',timeout:10000});
      assert.ok(activityReads <= 1,'background rendering may read history once, but must not poll continuously');
      assert.equal(await raster.locator('#work-chat').isVisible(),false);
      assert.ok(await raster.locator('#slide .el').count()>0);
    } finally { await raster.close(); }
  });

});
