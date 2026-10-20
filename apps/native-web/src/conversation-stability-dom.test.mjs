import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchPinnedChromium } from "../../../scripts/lib/pinned-playwright.mjs";
const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

test("live, settled and reloaded conversation preserves turn ownership and the reader anchor", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "slides-stable-chat-"));
  const project = path.join(scratch, "project");
  fs.cpSync(path.join(ROOT, "fixtures/okp-yu7-ppt"), project, { recursive: true });
  const port = await new Promise((resolve) => {
    const p = net.createServer();
    p.listen(0, "127.0.0.1", () => {
      const n = p.address().port;
      p.close(() => resolve(n));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["apps/native-web/src/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), OPEN_SLIDESTUDIO_PROJECT: project, SLIDESTUDIO_RETENTION_DAYS: "0" },
    stdio: "ignore",
  });
  let browser;
  const out =
    process.env.SLIDESTUDIO_QA_OUTPUT_DIR || path.join(ROOT, "output/conversation-stability-acceptance-2026-09-20");
  fs.mkdirSync(out, { recursive: true });
  try {
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    browser = await launchPinnedChromium({ headless: true });
    const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(90000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let busy = true;
    const events = [];
    const messages = [];
    for (let turn = 1; turn <= 3; turn++) {
      const at = (n) => `2026-09-20T0${turn}:00:${String(n).padStart(2, "0")}Z`;
      messages.push({ id: `u${turn}`, at: at(0), text: `第 ${turn} 轮：讨论页面配色`, mode: "discuss" });
      for (let i = 1; i <= 6; i++) {
        events.push({
          id: `a${turn}-${i}`,
          turn,
          at: at(i * 2 - 1),
          kind: "message",
          detail: `正在检查第 ${i} 项页面内容。`,
          status: "complete",
        });
        events.push({
          id: `t${turn}-${i}`,
          turn,
          at: at(i * 2),
          kind: "tool",
          callId: `t${turn}-${i}`,
          name: "read_page",
          detail: '{"pageId":"1_cover"}',
          status: "complete",
          ok: true,
        });
      }
      events.push({
        id: `final${turn}`,
        turn,
        at: at(30),
        kind: "message",
        detail: Array.from(
          { length: 12 },
          (_, i) => `第 ${turn} 轮回复，第 ${i + 1} 段。这里是需要稳定阅读的正文，包含页面内容与配色建议。`,
        ).join("\n\n"),
        status: turn === 3 ? "running" : "complete",
      });
    }
    const state = () => ({ agentStatus: busy ? "busy" : "idle", phase: { kind: "page-ready" }, questions: [] });
    const activity = () => ({
      ok: true,
      sessionId: "stability-test",
      brief: "保持原生对话的阅读体验",
      phase: busy ? "discussing" : "discussion",
      provider: { providerId: "test", modelId: "test" },
      project: { path: project, title: "Conversation stability", pageCount: 1, pagePaths: ["pages/01_cover.page"] },
      stages: [],
      events: [...events],
      conversation: { version: 1, mode: "discuss", messages: [...messages] },
    });
    await page.route("**/api/generation-activity**", (r) => r.fulfill({ json: activity() }));
    await page.route("**/slides/state/stability-test", (r) => r.fulfill({ json: state() }));
    await page.route("**/slides/providers", (r) => r.fulfill({ json: { providers: [] } }));
    await page.route("**/slides/sessions/stability-test/events", (r) => r.abort());
    await page.goto(`${base}/index.html?project=${encodeURIComponent(project)}&workspace=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator('[data-process-key="final3"]').waitFor();
    const heads = page.locator(".reader-process-toggle");
    assert.equal(await heads.count(), 3);
    assert.deepEqual(await heads.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-expanded"))), [
      "false",
      "false",
      "true",
    ]);
    // Read an older paragraph. Streaming and completion must keep its exact screen position.
    const anchor = await page.evaluate(() => {
      const list = document.querySelector("#editor-generation-event-list"),
        node = document.querySelector('[data-process-key="final2"]');
      list.scrollTop += node.getBoundingClientRect().top - list.getBoundingClientRect().top + 130;
      list.dispatchEvent(new Event("scroll"));
      node.dataset.seatProof = "same-node";
      return { top: node.getBoundingClientRect().top, scrollTop: list.scrollTop };
    });
    events.at(-1).detail += "\n\n新输出不会打断你阅读前文。";
    await page.waitForFunction(() =>
      document.querySelector('[data-process-key="final3"]').textContent.includes("新输出"),
    );
    const streamTop = await page.locator('[data-process-key="final2"]').evaluate((n) => n.getBoundingClientRect().top);
    assert.ok(Math.abs(streamTop - anchor.top) <= 1, `stream shifted reader ${streamTop - anchor.top}px`);
    busy = false;
    events.at(-1).status = "complete";
    events.push({
      id: "turn3-end",
      turn: 3,
      at: "2026-09-20T03:00:40Z",
      kind: "turn",
      name: "turn",
      status: "complete",
    });
    await page.waitForFunction(
      () => document.querySelectorAll(".reader-process-toggle")[2]?.getAttribute("aria-expanded") === "false",
    );
    const finishTop = await page.locator('[data-process-key="final2"]').evaluate((n) => n.getBoundingClientRect().top);
    assert.ok(Math.abs(finishTop - anchor.top) <= 1, `completion shifted reader ${finishTop - anchor.top}px`);
    assert.equal(await page.locator('[data-process-key="final2"]').getAttribute("data-seat-proof"), "same-node");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-process-key="final2"]').waitFor();
    await page.waitForFunction(
      (top) => Math.abs(document.querySelector('[data-process-key="final2"]').getBoundingClientRect().top - top) <= 1,
      anchor.top,
    );
    await page.screenshot({ path: path.join(out, "reading-position-restored.png") });
    // Every disclosure controls exactly its own turn and survives polling/reload.
    await heads.nth(1).click();
    assert.deepEqual(await heads.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-expanded"))), [
      "false",
      "true",
      "false",
    ]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-process-key="final3"]').waitFor();
    assert.deepEqual(await heads.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-expanded"))), [
      "false",
      "true",
      "false",
    ]);
    // At the tail, a new turn never expands all old tools. Finishing retains the visible answer.
    const nextUser = { id: "u4", at: "2026-09-20T04:00:00Z", text: "继续讨论", mode: "discuss" };
    await page.route("**/slides/assistant-intent", (r) =>
      r.fulfill({ json: { ok: true, intent: "discuss", scope: "page", pages: [1] } }),
    );
    await page.route("**/slides/sessions/stability-test/turn", (r) => {
      nextUser.clientRequestId = r.request().postDataJSON().clientRequestId;
      messages.push(nextUser);
      busy = true;
      return r.fulfill({ json: { ok: true, userMessage: nextUser } });
    });
    events.push({
      id: "tool4",
      turn: 4,
      at: "2026-09-20T04:00:01Z",
      kind: "tool",
      callId: "tool4",
      name: "read_page",
      detail: '{"pageId":"1_cover"}',
      status: "complete",
      ok: true,
    });
    events.push({
      id: "final4",
      turn: 4,
      at: "2026-09-20T04:00:02Z",
      kind: "message",
      detail:
        "这次修改已经处理。\n\n" +
        Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 段最终答复。保持清楚、稳定的阅读顺序。`).join("\n\n"),
      status: "running",
    });
    await page.getByLabel("与 AI 协作", { exact: true }).fill("继续讨论");
    await page.getByLabel("与 AI 协作", { exact: true }).press("Enter");
    await page.locator('[data-process-key="final4"]').waitFor();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".reader-process-toggle")[3]?.getAttribute("aria-expanded") === "true" &&
        !document.querySelector("#generation-think-status").hidden,
    );
    await page.evaluate(() => {
      const l = document.querySelector("#editor-generation-event-list");
      l.scrollTop -= 100;
      l.dispatchEvent(new Event("scroll"));
    });
    await page.locator("#editor-generation-latest").click();
    const liveTop = await page
      .locator('[data-process-key="final4"] .md-body p')
      .last()
      .evaluate((n) => n.getBoundingClientRect().top);
    busy = false;
    events.at(-1).status = "complete";
    events.push({
      id: "turn4-end",
      turn: 4,
      at: "2026-09-20T04:00:05Z",
      kind: "turn",
      name: "turn",
      status: "complete",
    });
    await page.waitForFunction(
      () => document.querySelectorAll(".reader-process-toggle")[3]?.getAttribute("aria-expanded") === "false",
    );
    const doneTop = await page
      .locator('[data-process-key="final4"] .md-body p')
      .last()
      .evaluate((n) => n.getBoundingClientRect().top);
    assert.ok(Math.abs(doneTop - liveTop) <= 1, `followed completion jumped ${doneTop - liveTop}px`);
    const metrics = [];
    for (const width of [1440, 877, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const metric = await page.evaluate(() => {
        const list = document.querySelector("#editor-generation-event-list");
        return {
          width: innerWidth,
          overflow: document.documentElement.scrollWidth - innerWidth,
          chatOverflow: list.scrollWidth - list.clientWidth,
          tail: Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop),
        };
      });
      assert.ok(metric.overflow <= 1);
      assert.ok(metric.chatOverflow <= 1);
      metrics.push(metric);
      await page.screenshot({ path: path.join(out, `stable-chat-${width}.png`) });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(out, "scroll-dom-proof.json"),
      JSON.stringify(
        {
          streamShift: streamTop - anchor.top,
          completionReadingShift: finishTop - anchor.top,
          followedCompletionShift: doneTop - liveTop,
          refreshAnchorPreserved: true,
          perTurnDisclosure: true,
          stableDOMSeat: true,
          metrics,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      const done = new Promise((r) => server.once("exit", r));
      server.kill("SIGTERM");
      await done;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
