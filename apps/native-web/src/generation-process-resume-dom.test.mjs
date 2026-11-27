import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const { resolvePlaywrightRuntimeFile } = await import("../../../scripts/lib/playwright-runtime-path.mjs");
const playwrightRuntime = resolvePlaywrightRuntimeFile(process.env, { repoRoot: ROOT, homeDir: os.homedir() });
const hasPlaywright = playwrightRuntime.ready;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openslides-process-resume-dom-"));
const project = path.join(scratch, "project");

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** @param {Record<string, unknown>[]} events @param {string} [phase] */
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

describe("generation process resume & discussion DOM", { skip: !hasPlaywright }, () => {
  /** @type {any} */
  let browser;
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let server;
  /** @type {any} */
  let page;
  /** @type {any} */
  let current;
  let base = "";
  let serverLog = "";

  before(async () => {
    fs.cpSync(path.join(ROOT, "fixtures", "okp-yu7-ppt"), project, { recursive: true });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["apps/native-web/src/server.mjs"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), OPEN_SLIDESTUDIO_PROJECT: project },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk) => {
      serverLog += chunk;
    });
    server.stderr?.on("data", (chunk) => {
      serverLog += chunk;
    });
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
    page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    current = snapshot([], "complete");
    await page.route("**/api/generation-activity**", (/** @type {any} */ route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(current) }),
    );
  });

  after(async () => {
    await page?.close();
    await browser?.close();
    if (server) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server?.once("exit", resolve));
    }
    fs.rmSync(scratch, { recursive: true, force: true });
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
      project: {
        path: project,
        title: "Process DOM",
        pageCount: 2,
        pagePaths: pages.map((entry) => `pages/${entry.pageId}.page`),
      },
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
    /** @type {Record<string, any>[]} */
    const turnBodies = [];
    await page.route("**/slides/state/test-session", (/** @type {any} */ route) => {
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
    await page.route("**/slides/sessions/test-session/turn", async (/** @type {any} */ route) => {
      turnBodies.push(route.request().postDataJSON());
      turnAccepted = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });

    await page.goto(`${base}/index.html?project=${encodeURIComponent(project)}&workspace=1&session=test-session`, {
      waitUntil: "networkidle",
    });
    await page.waitForFunction(() => {
      const row = document.getElementById("generation-resume-row");
      const button = /** @type {HTMLButtonElement | null} */ (document.getElementById("editor-generation-resume"));
      return Boolean(row && !row.hidden && button && !button.disabled);
    });
    const clicked = await page.evaluate(() => {
      const button = /** @type {HTMLButtonElement | null} */ (document.getElementById("editor-generation-resume"));
      if (!button) return { disabled: false, label: "" };
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
    assert.equal(
      new URL(page.url()).searchParams.has("live"),
      false,
      "history/open routes can continue without live=1",
    );
  });

  it("sends and restores two discussion turns without creating an edit lock or losing the model choice", async () => {
    /** @type {Record<string, any>[]} */
    const turns = [];
    /** @type {string[]} */
    const mutations = [];
    current = {
      ...snapshot([], "complete"),
      provider: { providerId: "test", modelId: "model-a" },
      conversation: { version: 1, mode: "generate", messages: [] },
    };
    await page.route("**/slides/assistant-intent", (/** @type {any} */ route) =>
      route.fulfill({ json: { ok: true, intent: "discuss", scope: "current", pages: [] } }),
    );
    await page.route("**/slides/providers", (/** @type {any} */ route) =>
      route.fulfill({
        json: { providers: [{ id: "test", name: "Local models", ready: true, models: ["model-a", "model-b"] }] },
      }),
    );
    await page.route("**/slides/state/test-session", (/** @type {any} */ route) =>
      route.fulfill({
        json: { binding: { dshSessionId: "test-session" }, agentStatus: "idle", phase: { kind: "complete" } },
      }),
    );
    await page.route("**/api/reviews/ai-lock**", (/** @type {any} */ route) => {
      mutations.push(route.request().url());
      return route.fulfill({ status: 500, json: { error: "discussion must not acquire an edit lock" } });
    });
    await page.route("**/slides/sessions/test-session/turn", (/** @type {any} */ route) => {
      const body = route.request().postDataJSON();
      turns.push(body);
      const n = turns.length;
      current.conversation.mode = "discuss";
      current.conversation.messages.push({
        id: `u${n}`,
        at: `2026-09-20T00:00:0${n * 2}Z`,
        text: body.text,
        mode: "discuss",
      });
      current.events.push({
        id: `a${n}`,
        kind: "message",
        at: `2026-09-20T00:00:0${n * 2 + 1}Z`,
        detail: `讨论回复 ${n}`,
        status: "complete",
      });
      if (body.modelSelection)
        current.provider = { providerId: body.modelSelection.provider, modelId: body.modelSelection.model };
      return route.fulfill({ json: { ok: true } });
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const select = /** @type {HTMLSelectElement | null} */ (document.querySelector("#assistant-model"));
      return select?.options.length === 2;
    });
    await page.getByLabel("助手模型", { exact: true }).selectOption("test/model-b");
    for (const [index, text] of [
      "先讨论一下结构，不要修改文稿。",
      "把刚才的建议再缩短，只回复标题，暂时不修改文稿。",
    ].entries()) {
      await page.getByLabel("与 AI 协作", { exact: true }).fill(text);
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await page.waitForFunction(
        (/** @type {number} */ n) =>
          document.querySelector("#editor-generation-event-list")?.textContent?.includes(`讨论回复 ${n}`),
        index + 1,
      );
      await page.waitForFunction(() => document.querySelector("#editor-generation-status")?.textContent === "继续聊聊");
    }
    assert.equal(turns.length, 2);
    assert.ok(turns.every((body) => body.conversationMode === "discuss" && !body.editorEdit));
    assert.deepEqual(turns[0].modelSelection, { provider: "test", model: "model-b" });
    assert.equal(mutations.length, 0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() =>
      document.querySelector("#editor-generation-event-list")?.textContent?.includes("讨论回复 2"),
    );
    const text = await page.locator("#editor-generation-event-list").innerText();
    assert.match(text, /先讨论一下结构/);
    assert.match(text, /讨论回复 1/);
    assert.match(text, /讨论回复 2/);
    assert.equal(await page.locator("#work-empty").isVisible(), false);
    assert.equal(await page.locator("#generation-resume-row").isVisible(), false);
    assert.equal(await page.locator("#assistant-model").inputValue(), "test/model-b");
  });

  it("unlocks an idle completed edit and keeps background raster loads finite", async () => {
    current = { ...current, phase: "reviewing", conversation: { ...current.conversation, mode: "edit" } };
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("editor-generation-status")?.textContent === "已修改");
    assert.equal(await page.getByRole("button", { name: "发送消息", exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole("button", { name: "导出", exact: true }).isVisible(), true);
    let activityReads = 0;
    const raster = await browser.newPage({ locale: "zh-CN" });
    try {
      await raster.route("**/api/generation-activity**", (/** @type {any} */ route) => {
        activityReads++;
        return route.fulfill({ json: snapshot([], "generating") });
      });
      await raster.goto(`${base}/index.html?project=${encodeURIComponent(project)}&page=0&workspace=0&render=1`, {
        waitUntil: "networkidle",
        timeout: 10000,
      });
      assert.ok(activityReads <= 1, "background rendering may read history once, but must not poll continuously");
      assert.equal(await raster.locator("#work-chat").isVisible(), false);
      assert.ok((await raster.locator("#slide .el").count()) > 0);
    } finally {
      await raster.close();
    }
  });
});
