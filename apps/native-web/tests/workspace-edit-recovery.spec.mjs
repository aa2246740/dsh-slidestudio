import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test } from "vitest";
import { launchPinnedChromium } from "../../../scripts/lib/pinned-playwright.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

/** @typedef {{continue: () => Promise<void>, abort: () => Promise<void>, fulfill: (options?: Record<string, unknown>) => Promise<void>, request: () => {method: () => string, url: () => string}}} RecoveryRoute */
/** @typedef {Window & {__recoveryPrompts: string[]; __archiveBeforeDelete?: boolean}} RecoveryTestWindow */
/** @typedef {{project: string, text: string, target: {targetPageIds: string[], label: string}, snapshotId: string, snapshotLabel: string, sessionId: string, aiLockToken: string, clientRequestId: string, before: {inspection: {pages: unknown[]}}}} PendingEdit */
/** @typedef {{pendingKey: string, pending: PendingEdit, otherPendingKey: string, otherPending: PendingEdit, archiveKey: string, differentArchiveKey: string, confirm: boolean, failArchive: boolean}} RecoveryInitState */
/** @typedef {{pendingKey: string, otherPendingKey: string, archiveKey: string, differentArchiveKey: string}} RecoveryResultKeys */

/** @returns {Promise<number>} */
async function unusedPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("could not select an unused port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

/** @param {string} project @param {string} token @param {string} [text] @returns {PendingEdit} */
function pendingEdit(project, token, text = "Finish the interrupted edit") {
  return {
    project,
    text,
    target: { targetPageIds: ["01_cover"], label: "cover" },
    snapshotId: "snapshot-before-edit",
    snapshotLabel: "V1",
    sessionId: "recovery-session",
    aiLockToken: token,
    clientRequestId: `request-${token}`,
    before: { inspection: { pages: [] } },
  };
}

/** @type {string} */
let scratch;
/** @type {string} */
let project;
/** @type {string} */
let otherProject;
/** @type {string} */
let base;
/** @type {ReturnType<typeof spawn>} */
let server;
/** @type {Awaited<ReturnType<typeof launchPinnedChromium>> | undefined} */
let browser;
/** @type {Awaited<ReturnType<typeof launchPinnedChromium>>} */
let browserInstance;

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "slides-edit-recovery-"));
  project = path.join(scratch, "project");
  otherProject = path.join(scratch, "other-project");
  fs.cpSync(path.join(ROOT, "fixtures/okp-yu7-ppt"), project, { recursive: true });
  fs.cpSync(path.join(ROOT, "fixtures/okp-yu7-ppt"), otherProject, { recursive: true });
  const port = await unusedPort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["apps/native-web/src/server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      OPEN_SLIDESTUDIO_PROJECT: project,
      SLIDESTUDIO_RETENTION_DAYS: "0",
    },
    stdio: "ignore",
  });
  /** @type {boolean} */
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        ready = true;
        break;
      }
    } catch {
      if (attempt === 79) throw new Error("server did not start");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "server did not become ready");
  browser = await launchPinnedChromium({ headless: true });
  browserInstance = browser;
});

afterAll(async () => {
  await browser?.close();
  if (server?.exitCode === null) {
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await stopped;
  }
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

/**
 * @param {Awaited<ReturnType<Awaited<ReturnType<typeof launchPinnedChromium>>["newPage"]>>} page
 */
async function settleRecoveryFrame(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => resolve(undefined))),
      ),
  );
}

/**
 * @param {{token: string, guard: object, agentStatus?: string, confirm?: boolean, expectedPrompt?: boolean | string, failStatus?: boolean, missingProject?: boolean, failArchive?: boolean}} options
 */
async function scenario({
  token,
  guard,
  agentStatus = "idle",
  confirm = true,
  expectedPrompt,
  failStatus = false,
  missingProject = false,
  failArchive = false,
}) {
  const page = await browserInstance.newPage({ locale: "zh-CN" });
  const pending = pendingEdit(project, token);
  const otherPending = pendingEdit(otherProject, token, "Other project's instruction");
  const pendingKey = `slides.pending-edit:${project}`;
  const otherPendingKey = `slides.pending-edit:${otherProject}`;
  const archiveKey = `slides.interrupted-edit:${encodeURIComponent(project)}:${encodeURIComponent(token)}`;
  const differentArchiveKey = `slides.interrupted-edit:${encodeURIComponent(project)}:different-token`;
  /** @type {() => void} */
  let resolveStatusSeen = () => {};
  /** @type {Promise<void>} */
  const statusSeen = new Promise((resolve) => {
    resolveStatusSeen = () => resolve();
  });
  /** @type {() => void} */
  let resolveTwoStateCalls = () => {};
  /** @type {Promise<void>} */
  const twoStateCalls = new Promise((resolve) => {
    resolveTwoStateCalls = () => resolve();
  });
  let statusCalls = 0;
  let stateCalls = 0;
  let turnCalls = 0;
  /** @type {() => void} */
  let releaseActivity = () => {};
  /** @type {Promise<void>} */
  const activityGate = new Promise((resolve) => {
    releaseActivity = () => resolve();
  });
  const activity = {
    ok: true,
    sessionId: "recovery-session",
    brief: "",
    phase: "idle",
    agentStatus: "idle",
    project: {
      path: project,
      title: "Recovery test",
      pageCount: 2,
      pagePaths: ["pages/01_cover.page", "pages/02_overview.page"],
    },
    stages: [],
    inspection: { pages: [] },
    events: [],
    conversation: { version: 1, mode: "generate", messages: [] },
  };

  await page.route(
    "**/api/generation-activity**",
    /** @param {RecoveryRoute} route */ async (route) => {
      await activityGate;
      await route.fulfill({ json: activity });
    },
  );
  await page.route(
    "**/api/reviews/ai-lock/status**",
    /** @param {RecoveryRoute} route */ async (route) => {
      statusCalls += 1;
      const url = new URL(route.request().url());
      assert.equal(url.searchParams.get("project"), project);
      assert.equal(url.searchParams.get("token"), token);
      if (missingProject) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ code: "REVIEW_PROJECT_NOT_FOUND" }),
        });
      } else if (failStatus) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "unavailable" }),
        });
      } else {
        await route.fulfill({ json: guard });
      }
      if (statusCalls === 1) resolveStatusSeen();
    },
  );
  await page.route(
    "**/slides/state/recovery-session",
    /** @param {RecoveryRoute} route */ async (route) => {
      stateCalls += 1;
      if (agentStatus === "missing") {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "missing" }),
        });
      } else {
        await route.fulfill({ json: { agentStatus } });
      }
      if (stateCalls === 2) resolveTwoStateCalls();
    },
  );
  await page.route("**/slides/sessions/**/events", /** @param {RecoveryRoute} route */ (route) => route.abort());
  await page.route(
    "**/slides/sessions/**/turn",
    /** @param {RecoveryRoute} route */ async (route) => {
      turnCalls += 1;
      await route.fulfill({ status: 503, json: { error: "provider calls are not part of this test" } });
    },
  );
  await page.route(
    "**/slides/providers",
    /** @param {RecoveryRoute} route */ (route) => route.fulfill({ json: { providers: [] } }),
  );
  await page.addInitScript(
    /** @param {RecoveryInitState} init */
    ({ pendingKey, pending, otherPendingKey, otherPending, archiveKey, differentArchiveKey, confirm, failArchive }) => {
      const testWindow = /** @type {RecoveryTestWindow} */ (/** @type {unknown} */ (globalThis.window));
      localStorage.setItem(pendingKey, JSON.stringify(pending));
      localStorage.setItem(otherPendingKey, JSON.stringify(otherPending));
      localStorage.setItem(differentArchiveKey, "preserve");
      testWindow.__recoveryPrompts = [];
      testWindow.confirm = (message) => {
        testWindow.__recoveryPrompts.push(String(message));
        return confirm;
      };
      const removeItem = Storage.prototype.removeItem;
      Storage.prototype.removeItem = /** @param {string} key */ function (key) {
        if (key === pendingKey) {
          testWindow.__archiveBeforeDelete = localStorage.getItem(archiveKey) !== null;
        }
        return removeItem.call(this, key);
      };
      if (failArchive) {
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = /** @param {string} key @param {string} value */ function (key, value) {
          if (key === archiveKey) throw new Error("archive storage unavailable");
          return setItem.call(this, key, value);
        };
      }
    },
    { pendingKey, pending, otherPendingKey, otherPending, archiveKey, differentArchiveKey, confirm, failArchive },
  );

  try {
    await page.goto(`${base}/index.html?project=${encodeURIComponent(project)}&workspace=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("#work-brief").waitFor({ state: "attached" });
    await page.evaluate(() => {
      const brief = globalThis.document.getElementById("work-brief");
      if (!(brief instanceof globalThis.HTMLTextAreaElement)) throw new Error("work brief is not a textarea");
      brief.value = "Existing draft";
      brief.dispatchEvent(new Event("input", { bubbles: true }));
    });
    releaseActivity();
    await statusSeen;
    if (agentStatus === "busy") await twoStateCalls;
    if (expectedPrompt) {
      await page.waitForFunction(() => {
        const testWindow = /** @type {RecoveryTestWindow} */ (/** @type {unknown} */ (globalThis.window));
        return testWindow.__recoveryPrompts.length === 1;
      });
      if (expectedPrompt === true) {
        await page.waitForFunction(/** @param {string} key */ (key) => localStorage.getItem(key) === null, pendingKey);
      } else {
        await settleRecoveryFrame(page);
      }
    } else {
      await settleRecoveryFrame(page);
    }
    const result = await page.evaluate(
      /** @param {RecoveryResultKeys} keys */
      ({ pendingKey, otherPendingKey, archiveKey, differentArchiveKey }) => ({
        pending: localStorage.getItem(pendingKey),
        otherPending: localStorage.getItem(otherPendingKey),
        archive: localStorage.getItem(archiveKey),
        differentArchive: localStorage.getItem(differentArchiveKey),
        archiveBeforeDelete: /** @type {RecoveryTestWindow} */ (/** @type {unknown} */ (globalThis.window))
          .__archiveBeforeDelete,
        prompt: /** @type {RecoveryTestWindow} */ (/** @type {unknown} */ (globalThis.window)).__recoveryPrompts,
        brief:
          /** @type {HTMLTextAreaElement | null} */ (globalThis.document.getElementById("work-brief"))?.value ?? "",
      }),
      { pendingKey, otherPendingKey, archiveKey, differentArchiveKey },
    );
    return { page, result, statusCalls, stateCalls, turnCalls, pending, otherPending, expectedPrompt };
  } catch (error) {
    await page.close();
    throw error;
  }
}

test("recovers stale edits, isolates tokens and projects, preserves instructions, and never resubmits", async () => {
  const token = "token-confirmed-idle";
  const recovered = await scenario({
    token,
    guard: { active: false, recoverable: false },
    agentStatus: "idle",
    expectedPrompt: true,
  });
  assert.equal(recovered.result.pending, null);
  assert.deepEqual(JSON.parse(recovered.result.archive), recovered.pending);
  assert.equal(recovered.result.archiveBeforeDelete, true);
  assert.equal(recovered.result.otherPending, JSON.stringify(recovered.otherPending));
  assert.equal(recovered.result.differentArchive, "preserve");
  assert.match(recovered.result.brief, /Existing draft\n\nFinish the interrupted edit/);
  assert.match(recovered.result.prompt[0], /不会回滚/);
  assert.match(recovered.result.prompt[0], /版本历史/);
  assert.match(recovered.result.prompt[0], /待处理指令/);
  assert.equal(recovered.turnCalls, 0, "a missing conversation message must never be resubmitted");
  await recovered.page.close();
});

test("preserves a live guard", async () => {
  const active = await scenario({
    token: "token-live",
    guard: { active: true, recoverable: false, expiresAt: Date.now() + 60_000 },
    expectedPrompt: false,
  });
  assert.equal(active.result.pending, JSON.stringify(active.pending));
  assert.equal(active.result.archive, null);
  assert.deepEqual(active.result.prompt, []);
  await active.page.close();
});

test("preserves pending instructions when lock status is unavailable", async () => {
  const network = await scenario({
    token: "token-network",
    guard: { active: false, recoverable: false },
    failStatus: true,
    expectedPrompt: false,
  });
  assert.equal(network.result.pending, JSON.stringify(network.pending));
  assert.deepEqual(network.result.prompt, []);
  await network.page.close();
});

test("preserves pending instructions for a busy session", async () => {
  const busy = await scenario({
    token: "token-busy",
    guard: { active: false, recoverable: false },
    agentStatus: "busy",
    expectedPrompt: false,
  });
  assert.equal(busy.result.pending, JSON.stringify(busy.pending));
  assert.deepEqual(busy.result.prompt, []);
  assert.ok(busy.stateCalls >= 2, "idle recovery requires a separate explicit session-state check");
  await busy.page.close();
});

test("archives edits for a missing project", async () => {
  const missingProject = await scenario({
    token: "token-missing-project",
    guard: { active: false, recoverable: false },
    missingProject: true,
    expectedPrompt: true,
  });
  assert.equal(missingProject.result.pending, null);
  assert.deepEqual(JSON.parse(missingProject.result.archive), missingProject.pending);
  await missingProject.page.close();
});

test("archives edits for a missing session", async () => {
  const missingSession = await scenario({
    token: "token-missing-session",
    guard: { active: false, recoverable: false },
    agentStatus: "missing",
    expectedPrompt: true,
  });
  assert.equal(missingSession.result.pending, null);
  assert.deepEqual(JSON.parse(missingSession.result.archive), missingSession.pending);
  await missingSession.page.close();
});

test("keeps the pending edit when archiving fails", async () => {
  const archiveFailure = await scenario({
    token: "token-archive-failure",
    guard: { active: false, recoverable: false },
    failArchive: true,
    expectedPrompt: "archive-failure",
  });
  assert.equal(archiveFailure.result.pending, JSON.stringify(archiveFailure.pending));
  assert.equal(archiveFailure.result.archive, null);
  assert.equal(archiveFailure.result.archiveBeforeDelete, undefined);
  assert.equal(archiveFailure.result.prompt.length, 1);
  await archiveFailure.page.close();
});
