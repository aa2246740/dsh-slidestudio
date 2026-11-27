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
const ONE_PAGE = [{ pageId: "01_cover", visualReview: "pass" }];

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      probe.close(() => resolve(addr && typeof addr === "object" ? addr.port : 0));
    });
  });
}

/** @param {string} dir @param {string} [title] */
function createEmptyProjectDir(dir, title = "空画布测试") {
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  const theme = {
    colors: { primary: "#2563EB", text: "#111111", background: "#FFFFFF" },
    textStyles: { title: { fontSize: 36, bold: true, color: "$text" }, body: { fontSize: 18, color: "$text" } },
  };
  const body = JSON.stringify({ version: "v2", title, size: [960, 540], theme, pages: [] });
  fs.writeFileSync(path.join(dir, "deck.pptd"), `${body}\n`, "utf8");
}

/** @param {Record<string, any>} baseAct @param {boolean} [composed] */
function doneActivity(baseAct, composed = false) {
  return {
    ...baseAct,
    phase: "complete",
    error: null,
    ...(composed ? { inspection: { pages: ONE_PAGE, composed: true } } : {}),
    events: [{ id: "done-1", kind: "ledger", turn: 2, status: "complete", detail: "已完成" }],
  };
}

/** @param {any} page @param {number} count */
function waitModels(page, count) {
  return page.waitForFunction(
    (/** @type {number} */ n) =>
      /** @type {HTMLSelectElement | null} */ (document.getElementById("assistant-model"))?.options.length === n,
    count,
  );
}

/** @param {any} page @param {string} text */
function waitStatus(page, text) {
  return page.waitForFunction(
    (/** @type {string} */ expected) => document.getElementById("editor-generation-status")?.textContent === expected,
    text,
  );
}

/** @param {string} sessionId @param {string} projectPath @param {Record<string, any>} [extra] */
function makeActivity(sessionId, projectPath, extra = {}) {
  return {
    ok: true,
    sessionId,
    brief: "测试",
    phase: "failed",
    provider: { providerId: "p1", modelId: "m1" },
    project: { path: projectPath, title: "Test", pageCount: 1, pagePaths: ["pages/01_cover.page"] },
    inspection: { pages: ONE_PAGE, composed: false },
    stages: [],
    events: [],
    ...extra,
  };
}

/** @param {string} sessionId @param {string} phase @param {string} [recovery] @param {Record<string, any>} [extra] */
function makeState(sessionId, phase, recovery = "none", extra = {}) {
  const statusKind = phase === "complete" ? "delivered" : phase;
  const { model, ...rest } = extra;
  const execution = {
    sessionId,
    status: { kind: statusKind },
    recovery: { kind: recovery },
    ...(model ? { model } : {}),
  };
  return {
    binding: { dshSessionId: sessionId, provider: { providerId: "p1", modelId: "m1" } },
    agentStatus: phase === "generating" ? "busy" : "idle",
    phase: { kind: phase },
    execution,
    questions: [],
    ...rest,
  };
}

/**
 * @param {any} page @param {string} sid
 * @param {{ activity: () => any, state: (r: any) => any, onTurn?: (body: any) => void, onStop?: () => void, models?: () => string[] }} cfg
 */
async function mockSession(page, sid, cfg) {
  await page.route("**/api/generation-activity**", (/** @type {any} */ r) => r.fulfill({ json: cfg.activity() }));
  await page.route(`**/slides/state/${sid}`, (/** @type {any} */ r) => cfg.state(r));
  await page.route("**/slides/providers", (/** @type {any} */ r) =>
    r.fulfill({
      json: { providers: [{ id: "p1", name: "Local", ready: true, models: (cfg.models || (() => ["m1", "m2"]))() }] },
    }),
  );
  await page.route(`**/slides/sessions/${sid}/events`, (/** @type {any} */ r) => r.abort());
  if (cfg.onTurn) {
    await page.route(`**/slides/sessions/${sid}/turn`, async (/** @type {any} */ r) => {
      cfg.onTurn?.(r.request().postDataJSON());
      await r.fulfill({ json: { ok: true } });
    });
  }
  if (cfg.onStop) {
    await page.route(`**/slides/sessions/${sid}/stop`, async (/** @type {any} */ r) => {
      cfg.onStop?.();
      await r.fulfill({ json: { ok: true, stopped: true } });
    });
  }
}

/** @param {any} page @param {string} base @param {string} proj @param {string} [extra] */
async function openEditor(page, base, proj, extra = "") {
  const url = `${base}/index.html?project=${encodeURIComponent(proj)}&workspace=1${extra}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

/** @param {any} browser @param {(page: any, errors: string[]) => Promise<void>} fn */
async function withPage(browser, fn) {
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1440, height: 900 } });
  /** @type {string[]} */
  const errors = [];
  page.on("pageerror", (/** @type {Error} */ error) => errors.push(error.message));
  try {
    await fn(page, errors);
  } finally {
    await page.close();
  }
}

describe("left panel unified status/recovery card and stability", { skip: !hasPlaywright }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openslides-left-recovery-"));
  const fixtureProject = path.join(scratch, "fixture-project");
  const emptyProject = path.join(scratch, "empty-project");
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let server;
  /** @type {any} */
  let browser;
  let base = "";
  let serverLog = "";

  before(async () => {
    fs.cpSync(path.join(ROOT, "fixtures", "okp-yu7-ppt"), fixtureProject, { recursive: true });
    createEmptyProjectDir(emptyProject);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["apps/native-web/src/server.mjs"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), OPEN_SLIDESTUDIO_PROJECT: fixtureProject },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (c) => (serverLog += c));
    server.stderr?.on("data", (c) => (serverLog += c));
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        if (attempt === 79) throw new Error(`native editor did not start\n${serverLog}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const { launchPinnedChromium } = await import("../../../scripts/lib/pinned-playwright.mjs");
    browser = await launchPinnedChromium({ headless: true });
  });

  after(async () => {
    await browser?.close();
    if (server) {
      server.kill("SIGTERM");
      await new Promise((r) => server?.once("exit", r));
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("renders unified error card on 0-event LLM failure and resumes on a real 0-page deck", async () => {
    await withPage(browser, async (page, errors) => {
      /** @type {any[]} */
      const turnBodies = [];
      let done = false;
      const failAct = makeActivity("s-early", emptyProject, {
        brief: "",
        allowZeroPage: true,
        project: { path: emptyProject, title: "空画布测试", pageCount: 0, pagePaths: [] },
        inspection: { pages: [], composed: false },
        error: { code: "provider-unavailable", detail: "503 upstream provider overloaded" },
      });
      await mockSession(page, "s-early", {
        activity: () => (done ? doneActivity(failAct) : failAct),
        state: (r) =>
          r.fulfill({
            json: done
              ? makeState("s-early", "complete")
              : makeState("s-early", "failed", "continue", { allowZeroPage: true }),
          }),
        onTurn: (body) => {
          turnBodies.push(body);
          done = true;
        },
      });
      await openEditor(page, base, emptyProject);
      await page.waitForSelector("#editor-generation-event-list .generation-status-card", { state: "visible" });
      await page.waitForFunction(() => Boolean(document.getElementById("workspace-cover")?.hidden));

      const m = await page.evaluate(() => {
        const card = document.querySelector("#editor-generation-event-list .generation-status-card");
        const resume = /** @type {HTMLButtonElement | null} */ (document.getElementById("editor-generation-resume"));
        const statusEl = document.getElementById("editor-generation-status");
        const q = (/** @type {string} */ s) => card?.querySelector(s)?.textContent?.trim() || "";
        return {
          coverHidden: Boolean(document.getElementById("workspace-cover")?.hidden),
          legacy: document.querySelectorAll(
            "#editor-generation > header, #editor-generation-now, #work-generation-lock",
          ).length,
          cardClass: card?.className || "",
          title: q("[data-status-title]"),
          summary: q("[data-process-detail]"),
          hint: q("[data-status-hint]"),
          resumeInCard: Boolean(card?.contains(resume)),
          resumeVisible: Boolean(resume?.checkVisibility()),
          resumeDisabled: Boolean(resume?.disabled),
          statusSrOnly: Boolean(statusEl?.classList.contains("sr-only")),
          statusText: statusEl?.innerText || "",
        };
      });
      assert.equal(m.coverHidden, true, "#workspace-cover must hide on valid 0-page deck.pptd");
      assert.equal(m.legacy, 0);
      assert.match(m.cardClass, /\bis-error\b/);
      assert.deepEqual([m.resumeInCard, m.resumeVisible, m.resumeDisabled, m.statusSrOnly], [true, true, false, true]);
      assert.ok(m.statusText.length > 0);
      if (m.summary) {
        assert.notEqual(m.title, m.summary);
        assert.notEqual(m.summary, m.hint);
      }
      await page.locator("#editor-generation-resume").click();
      await waitStatus(page, "已完成");
      assert.equal(turnBodies.length, 1);
      assert.equal(turnBodies[0].resumeGeneration, true);
      assert.deepEqual(errors, []);
    });
  });

  it("renders 429 rateLimitWait card with live countdown, stop/switch actions, and no thinking conflict", async () => {
    await withPage(browser, async (page, errors) => {
      const nextRetryAt = Date.now() + 12_000;
      await mockSession(page, "s-wait", {
        activity: () => makeActivity("s-wait", fixtureProject, { phase: "generating", inspection: { pages: [] } }),
        state: (r) =>
          r.fulfill({
            json: makeState("s-wait", "generating", "wait-or-stop", {
              rateLimitWait: { attempt: 1, waitMs: 12_000, nextRetryAt, code: "429" },
            }),
          }),
      });
      await openEditor(page, base, fixtureProject, "&live=1&session=s-wait");
      await page.waitForSelector(".generation-status-card.is-wait", { state: "visible" });

      const first = await page.evaluate(() => {
        const card = document.querySelector(".generation-status-card.is-wait");
        const stopBtn = /** @type {HTMLButtonElement | null} */ (card?.querySelector("[data-status-stop]"));
        return {
          countdown: card?.querySelector("[data-status-countdown]")?.textContent || "",
          flags: [
            Boolean(stopBtn?.checkVisibility()),
            Boolean(stopBtn?.disabled),
            Boolean(card?.querySelector("[data-status-switch]")?.checkVisibility()),
            Boolean(document.getElementById("editor-generation-resume")?.hidden),
            document.querySelectorAll('[data-process-key="live-waiting"]').length,
            Boolean(document.getElementById("generation-think-status")?.hidden),
          ],
        };
      });
      assert.match(first.countdown, /\d+\s*秒后自动重试/);
      assert.deepEqual(first.flags, [true, false, true, true, 0, true]);

      const initialSec = Number(first.countdown.match(/(\d+)/)?.[1] || 0);
      await page.waitForFunction(
        (/** @type {number} */ prev) => {
          const text =
            document.querySelector(".generation-status-card.is-wait [data-status-countdown]")?.textContent || "";
          const cur = Number(text.match(/(\d+)/)?.[1] || 0);
          return cur > 0 && cur < prev;
        },
        initialSec,
        { timeout: 5000 },
      );
      await page.locator(".generation-status-card.is-wait [data-status-switch]").click();
      assert.equal(await page.evaluate(() => document.activeElement?.id), "assistant-model");
      assert.deepEqual(errors, []);
    });
  });

  it("guides model switch on auth failure (resolve) and enables resume after selecting another model", async () => {
    await withPage(browser, async (page, errors) => {
      /** @type {any[]} */
      const turnBodies = [];
      let done = false;
      const failAct = makeActivity("s-auth", fixtureProject, {
        error: { code: "provider-auth", detail: "401 Invalid API key" },
      });
      await mockSession(page, "s-auth", {
        activity: () => (done ? doneActivity(failAct, true) : failAct),
        state: (r) =>
          r.fulfill({
            json: done
              ? makeState("s-auth", "complete")
              : makeState("s-auth", "failed", "resolve", { model: { provider: "p1", model: "m1" } }),
          }),
        onTurn: (body) => {
          turnBodies.push(body);
          done = true;
        },
      });
      await openEditor(page, base, fixtureProject, "&session=s-auth");
      await page.waitForSelector(".generation-status-card", { state: "visible" });
      await waitModels(page, 2);

      const before = await page.evaluate(() => [
        Boolean(document.querySelector(".generation-status-card [data-status-switch]")?.checkVisibility()),
        Boolean(
          /** @type {HTMLButtonElement | null} */ (document.getElementById("editor-generation-resume"))?.disabled,
        ),
      ]);
      assert.deepEqual(before, [true, true]);

      await page.locator("#assistant-model").selectOption("p1/m2");
      await page.waitForFunction(
        () =>
          /** @type {HTMLButtonElement | null} */ (document.getElementById("editor-generation-resume"))?.disabled ===
          false,
      );
      await page.locator("#editor-generation-resume").click();
      await waitStatus(page, "已完成");
      assert.equal(turnBodies.length, 1);
      assert.equal(turnBodies[0].resumeGeneration, true);
      assert.deepEqual(turnBodies[0].modelSelection, { provider: "p1", model: "m2" });
      assert.deepEqual(errors, []);
    });
  });

  it("prevents ghost DOM leaks on kind flip, keeps 1 state fetch per poll, and live-refreshes #assistant-model", async () => {
    await withPage(browser, async (page, errors) => {
      let activityFetches = 0;
      let stateFetches = 0;
      let flipped = false;
      let models = ["m1"];
      await mockSession(page, "s-stable", {
        activity: () => {
          activityFetches += 1;
          return makeActivity("s-stable", fixtureProject, {
            phase: flipped ? "complete" : "generating",
            inspection: { pages: ONE_PAGE, composed: flipped },
            events: [
              flipped
                ? { id: "flip-row", kind: "message", detail: "已转为正式回复", status: "complete" }
                : { id: "flip-row", kind: "reasoning", detail: "先思考一下", status: "running" },
            ],
          });
        },
        state: (r) => {
          stateFetches += 1;
          return r.fulfill({ json: makeState("s-stable", flipped ? "complete" : "generating") });
        },
        models: () => models,
      });
      await openEditor(page, base, fixtureProject, "&session=s-stable");
      await page.waitForSelector(
        '#editor-generation-event-list > li[data-process-key="flip-row"][data-process-kind="thought"]',
      );
      await waitModels(page, 1);

      flipped = true;
      await page.waitForSelector(
        '#editor-generation-event-list > li[data-process-key="flip-row"][data-process-kind="message"]',
      );
      const kinds = await page.evaluate(() =>
        [...document.querySelectorAll('#editor-generation-event-list > li[data-process-key="flip-row"]')].map(
          (n) => /** @type {HTMLElement} */ (n).dataset.processKind,
        ),
      );
      assert.deepEqual(kinds, ["message"]);

      models = ["m1", "m2"];
      await page.locator("#assistant-model").focus();
      await waitModels(page, 2);

      activityFetches = 0;
      stateFetches = 0;
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitStatus(page, "已完成");
      await page.waitForTimeout(350);
      assert.ok(activityFetches >= 1);
      assert.equal(stateFetches, activityFetches);
      assert.deepEqual(errors, []);
    });
  });

  it("renders discuss and edit failure cards with mode-specific copy and hidden generation resume", async () => {
    for (const [mode, expectedTitle] of [
      ["discuss", "回复未完成"],
      ["edit", "修改未完成"],
    ]) {
      await withPage(browser, async (page, errors) => {
        const sid = `s-${mode}`;
        await mockSession(page, sid, {
          activity: () =>
            makeActivity(sid, fixtureProject, {
              conversation: { version: 1, mode, messages: [] },
              inspection: { pages: ONE_PAGE, composed: true },
              events: [
                { id: "turn-fail", kind: "turn", name: "turn", status: "failed", detail: "503 upstream overloaded" },
              ],
              error: { code: "provider-unavailable", detail: "503 upstream overloaded" },
            }),
          state: (r) => r.fulfill({ json: makeState(sid, "failed") }),
        });
        await openEditor(page, base, fixtureProject, `&session=${sid}`);
        await page.waitForSelector(".generation-status-card", { state: "visible" });
        const info = await page.evaluate(() => {
          const card = document.querySelector(".generation-status-card");
          return {
            title: card?.querySelector("[data-status-title]")?.textContent?.trim() || "",
            hint: card?.querySelector("[data-status-hint]")?.textContent?.trim() || "",
            status: document.getElementById("editor-generation-status")?.textContent?.trim() || "",
            flags: [
              Boolean(document.getElementById("editor-generation-resume")?.hidden),
              Boolean(card?.querySelector("[data-status-switch]")?.checkVisibility()),
              Boolean(document.getElementById("generation-resume-row")?.checkVisibility()),
            ],
          };
        });
        assert.deepEqual([info.title, info.status], [expectedTitle, expectedTitle]);
        assert.doesNotMatch(info.hint, /留空按当前计划继续/);
        assert.deepEqual(info.flags, [true, true, true]);
        assert.deepEqual(errors, []);
      });
    }
  });

  it("does not spin rapid polling on expired rateLimitWait and shows reconnect indicator on disconnect", async () => {
    await withPage(browser, async (page, errors) => {
      let statePolls = 0;
      let failState = false;
      let phase = "complete";
      await mockSession(page, "s-poll", {
        activity: () =>
          makeActivity("s-poll", fixtureProject, { phase, inspection: { pages: ONE_PAGE, composed: true } }),
        state: (r) => {
          statePolls += 1;
          if (failState) return r.fulfill({ status: 503, json: { error: "unavailable" } });
          return r.fulfill({
            json: makeState("s-poll", phase, "none", {
              rateLimitWait: { attempt: 1, waitMs: 5000, nextRetryAt: Date.now() - 10_000, code: "429" },
            }),
          });
        },
      });
      await openEditor(page, base, fixtureProject, "&session=s-poll");
      await waitStatus(page, "已完成");
      statePolls = 0;
      await page.waitForTimeout(1200);
      assert.ok(statePolls <= 2, `expired rateLimitWait must not spin rapid 260ms polling (saw ${statePolls})`);

      phase = "generating";
      failState = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => {
        const el = document.getElementById("generation-think-status");
        return Boolean(el && !el.hidden && el.textContent?.includes("连接中断，正在重连…"));
      });
      assert.deepEqual(errors, []);
    });
  });

  it("sends stop immediately when Stop is clicked during a resumed generation", async () => {
    await withPage(browser, async (page, errors) => {
      let mode = "paused";
      let stopCalls = 0;
      const phase = () => (mode === "running" ? "generating" : mode === "stopped" ? "cancelled" : "paused");
      await mockSession(page, "s-stop", {
        activity: () =>
          makeActivity("s-stop", fixtureProject, {
            phase: phase(),
            events:
              mode === "running"
                ? [{ id: "r-1", kind: "reasoning", turn: 2, status: "running", detail: "继续生成中" }]
                : [],
          }),
        state: (r) => r.fulfill({ json: makeState("s-stop", phase(), mode === "paused" ? "continue" : "none") }),
        onTurn: () => (mode = "running"),
        onStop: () => {
          stopCalls += 1;
          mode = "stopped";
        },
      });
      await openEditor(page, base, fixtureProject, "&session=s-stop");
      await page.waitForSelector("#editor-generation-resume", { state: "visible" });
      await page.locator("#editor-generation-resume").click();
      await page.waitForSelector("#work-form .composer-send.is-stopping", { state: "visible" });
      await page.locator("#work-form .composer-send.is-stopping").click();
      await page.waitForFunction(() => document.querySelector("#work-form .composer-send.is-stopping") === null);
      assert.equal(stopCalls, 1, "clicking Stop during resumed generation must send POST /stop");
      assert.deepEqual(errors, []);
    });
  });
});
