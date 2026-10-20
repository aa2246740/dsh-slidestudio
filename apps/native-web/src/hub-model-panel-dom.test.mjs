import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { launchPinnedChromium } from "../../../scripts/lib/pinned-playwright.mjs";

/** @typedef {{ json?: unknown; contentType?: string; body?: Uint8Array; status?: number }} MockFulfillOptions */
/** @typedef {{ request: () => { url: () => string }; fulfill: (options: MockFulfillOptions) => Promise<void> }} MockRoute */
/** @typedef {{ url: () => string }} MockResponse */
/** @typedef {{ isVisible: () => Promise<boolean>; isHidden: () => Promise<boolean>; isDisabled: () => Promise<boolean>; getAttribute: (name: string) => Promise<string | null>; innerText: () => Promise<string>; count: () => Promise<number>; evaluate: <T>(fn: (element: HTMLElement) => T) => Promise<T>; first: () => TestLocator; last: () => TestLocator; focus: () => Promise<void> }} TestLocator */
/** @typedef {{ route: (url: string, handler: (route: MockRoute) => unknown) => Promise<void>; on: (event: "pageerror", handler: (error: Error) => void) => void; goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>; waitForFunction: (predicate: () => unknown, argument?: unknown, options?: Record<string, unknown>) => Promise<unknown>; click: (selector: string) => Promise<void>; fill: (selector: string, value: string) => Promise<void>; waitForSelector: (selector: string) => Promise<unknown>; waitForResponse: (predicate: (response: MockResponse) => boolean, options?: { timeout?: number }) => Promise<MockResponse>; waitForURL: (url: RegExp) => Promise<void>; reload: (options?: Record<string, unknown>) => Promise<unknown>; setViewportSize: (viewport: { width: number; height: number }) => Promise<void>; locator: (selector: string) => TestLocator; keyboard: { press: (key: string) => Promise<void> }; evaluate: <T>(fn: () => T) => Promise<T> }} TestPage */
/** @typedef {{ newPage: (options: { locale: string; viewport: { width: number; height: number } }) => Promise<TestPage>; close: () => Promise<void> }} TestBrowser */

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const deferred = () => {
  /** @type {() => void} */
  let resolve = () => {};
  /** @type {Promise<void>} */
  const promise = new Promise((r) => (resolve = () => r()));
  return { promise, resolve };
};
const BRIEF = "给新员工做一份 5 页的信息安全培训，语气轻松";

/** @param {string} project @param {number | undefined} [kernelPort] */
async function startServer(project, kernelPort) {
  /** @type {Promise<number>} */
  const portPromise = new Promise((resolve, reject) => {
    const p = net.createServer();
    p.listen(0, "127.0.0.1", () => {
      const address = p.address();
      if (address && typeof address !== "string") p.close(() => resolve(address.port));
      else p.close(() => reject(new Error("Server did not bind to a TCP port")));
    });
  });
  const port = await portPromise;
  const base = `http://127.0.0.1:${port}`;
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    PORT: String(port),
    OPEN_SLIDESTUDIO_PROJECT: project,
    SLIDESTUDIO_RETENTION_DAYS: "0",
  };
  if (kernelPort) env.SLIDES_DSH_PORT = String(kernelPort);
  const server = spawn(process.execPath, ["apps/native-web/src/server.mjs"], { cwd: ROOT, env, stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return { base, server };
}

const TEST_SHA = "a".repeat(64);
const TEST_CATALOG = {
  version: 1,
  hash: TEST_SHA,
  formats: [
    { kind: "Slides", layout: "16:9" },
    { kind: "Slides", layout: "4:3" },
  ],
  styles: [
    {
      id: "work/plain",
      label: "Plain",
      category: "work",
      designSourceId: "ds-plain",
      designHash: TEST_SHA,
      previews: [
        {
          sourceId: "pv-plain",
          hash: TEST_SHA,
          order: 0,
          url: `/slides/catalog/previews/${encodeURIComponent("pv-plain")}`,
        },
      ],
    },
  ],
};
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** @param {TestPage} page */
async function mockKernelCatchAll(page) {
  await page.route("**/plugins/**", (route) =>
    route.fulfill({ json: { ok: true, status: "signed-out", providers: [] } }),
  );
  await page.route("**/slides/catalog/previews/**", (route) =>
    route.fulfill({ contentType: "image/png", body: PIXEL_PNG }),
  );
  await page.route("**/slides/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/slides/catalog") return route.fulfill({ json: TEST_CATALOG });
    if (path === "/slides/runtime") return route.fulfill({ json: { phase: "ready" } });
    if (path === "/slides/health") {
      return route.fulfill({
        json: {
          ok: true,
          product: "DSH SlideStudio",
          generateReady: true,
          selection: { providerId: "test", model: "cheap", ready: true },
          connection: { ready: true },
          capability: null,
          catalog: {},
          providers: [],
        },
      });
    }
    if (path === "/slides/tool-settings") return route.fulfill({ json: { ok: true, settings: {} } });
    return route.fulfill({ json: { ok: true } });
  });
}

test("Hub keeps an opened model panel, groups usable models and preserves exact selections", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "slides-model-picker-"));
  const project = path.join(scratch, "project");
  fs.cpSync(path.join(ROOT, "fixtures/okp-yu7-ppt"), project, { recursive: true });
  const { base, server } = await startServer(project);
  /** @type {TestBrowser | undefined} */
  let browser;
  const gate = deferred();
  try {
    browser = /** @type {TestBrowser} */ (await launchPinnedChromium({ headless: true }));
    const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1440, height: 900 } });
    const reopen = async () => {
      if (await page.locator("#pi-panel").isVisible()) await page.click("#btn-model");
      await page.click("#btn-model");
      await page.waitForSelector("#pi-panel:not([hidden])");
    };
    /** @type {string[]} */
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await mockKernelCatchAll(page);
    let calls = 0,
      status = 200;
    /** @type {ReturnType<typeof deferred> | null} */
    let refreshGate = null;
    const groups = [
      {
        providerId: "local",
        providerName: "本地模型",
        ready: true,
        models: [{ id: "text", name: "文字模型" }],
        modelEfforts: { text: [] },
      },
      {
        providerId: "test",
        providerName: "Remote",
        ready: true,
        models: [{ id: "vendor/vision", name: "Vision 中文" }],
        modelEfforts: { "vendor/vision": ["low", "high"] },
      },
      { providerId: "broken", providerName: "Broken", ready: false, models: [{ id: "hidden", name: "hidden" }] },
    ];
    let catalog = groups;
    await page.route("**/slides/models", async (route) => {
      calls++;
      await gate.promise;
      await refreshGate?.promise;
      await route.fulfill({ status, json: status === 200 ? catalog : { error: "unavailable" } });
    });
    await page.route("**/slides/health**", (route) => {
      const url = new URL(route.request().url());
      const providerId = url.searchParams.get("provider"),
        model = url.searchParams.get("model");
      return route.fulfill({
        json: {
          ok: true,
          product: "DSH SlideStudio",
          selection: { providerId, model, ready: true },
          capability: {
            research: { configured: false },
            imageSearch: { configured: false },
            imageGenerate: { configured: false },
            vision: { mode: model === "vendor/vision" ? "main-model" : "none" },
          },
        },
      });
    });
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("brief"));
    await page.click("#btn-model");
    gate.resolve();
    await page.waitForFunction(() => document.querySelectorAll('#pi-model [role="group"]').length === 2);
    assert.equal(await page.locator("#pi-panel").isVisible(), true, "initial requests cannot undo the user click");
    assert.equal(await page.locator("#btn-model").getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator("#pi-effort-wrap").isHidden(), true);
    const cardHeight = await page.locator(".prompt-card").evaluate((el) => el.getBoundingClientRect().height);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-model-key")), "local/text");
    await page.keyboard.press("End");
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-model-key")),
      "test/vendor/vision",
    );
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#pi-panel").isHidden(), true, "picking a model closes the popup");
    await page.click("#btn-model");
    await page.waitForFunction(() => document.querySelector("#capability-row li")?.classList.contains("is-on"));
    assert.equal(await page.locator("#pi-effort-wrap").isVisible(), true);
    assert.equal(await page.locator("#pi-panel select, #pi-login-status, #pi-provider").count(), 0);
    assert.equal(
      await page.locator(".prompt-card").evaluate((el) => el.getBoundingClientRect().height),
      cardHeight,
      "popup never expands the prompt card",
    );
    await page.click('#pi-effort [data-effort="low"]');
    assert.equal(await page.locator("#pi-panel").isVisible(), true, "effort selection keeps the popup open");
    assert.equal(await page.locator('#pi-effort [data-effort="low"]').getAttribute("aria-checked"), "true");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator('#pi-effort [data-effort="high"]').getAttribute("aria-checked"), "true");
    assert.deepEqual(
      await page.evaluate(() => [localStorage.getItem("oss.pi.provider"), localStorage.getItem("oss.pi.model")]),
      ["test", "vendor/vision"],
    );
    await page.locator("#capability-row li").first().focus();
    await page.waitForFunction(() => document.querySelector("#capability-row li")?.getAttribute("data-tip"));
    assert.match((await page.locator("#capability-row li").first().getAttribute("aria-label")) ?? "", /看图/);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#pi-panel").isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "btn-model");
    await page.reload({ waitUntil: "networkidle" });
    await page.click("#btn-model");
    assert.equal(
      await page.locator('#pi-model [aria-selected="true"]').getAttribute("data-model-key"),
      "test/vendor/vision",
    );
    await page.waitForFunction(() => document.querySelectorAll("#capability-row li").length === 4);
    refreshGate = deferred();
    await reopen();
    await page.locator("#capability-row li").first().focus();
    refreshGate.resolve();
    refreshGate = null;
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-model-key") === "test/vendor/vision");
    assert.equal(
      await page.locator("#pi-panel").isVisible(),
      true,
      "catalog and capability refresh preserve keyboard focus inside the popup",
    );
    await page.locator('#pi-model [aria-selected="true"]').focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-model-key")),
      "test/vendor/vision",
    );
    for (const [width, height] of [
      [1440, 900],
      [390, 900],
      [320, 900],
      [1440, 420],
      [320, 420],
    ]) {
      await page.setViewportSize({ width, height });
      await page.waitForFunction(
        () => {
          const panel = document.getElementById("pi-panel")?.getBoundingClientRect();
          return (
            panel !== undefined &&
            document.documentElement.scrollWidth <= innerWidth &&
            panel.left >= 0 &&
            panel.right <= innerWidth &&
            panel.top >= 0 &&
            panel.bottom <= innerHeight
          );
        },
        null,
        { timeout: 3000 },
      );
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click(".wordmark");
    assert.equal(await page.locator("#pi-panel").isHidden(), true, "outside click closes");
    await page.click("#btn-model");
    await page.click("#btn-layout");
    assert.equal(await page.locator("#pi-panel").isHidden(), true, "other menu closes the model popup");
    const modelRefresh = page
      .waitForResponse((r) => r.url().includes("/slides/models"), { timeout: 5000 })
      .catch(() => null);
    const healthRefresh = page
      .waitForResponse((r) => r.url().includes("/slides/health"), { timeout: 5000 })
      .catch(() => null);
    await page.click("#btn-model");
    assert.equal(await page.locator("#layout-menu").isHidden(), true);
    // settle the open-time catalog + capability refresh before measuring Tab
    // behavior — the repaint legitimately restores focus to the selected option.
    await modelRefresh;
    await page.waitForFunction(() => document.querySelectorAll('#pi-model [role="group"]').length === 2);
    await healthRefresh;
    await page.locator("#capability-row li").last().focus();
    await page.keyboard.press("Tab");
    // focusout with relatedTarget=null closes the panel on the next frame —
    // wait for the actual hidden state, not a same-tick snapshot.
    await page.waitForFunction(() => document.getElementById("pi-panel")?.hidden === true);
    assert.equal(await page.locator("#pi-panel").isHidden(), true, "Tab leaving closes");
    catalog = [];
    await reopen();
    await page.waitForFunction(() => document.getElementById("pi-model")?.getAttribute("aria-disabled") === "true");
    await page.fill("#brief", BRIEF);
    assert.equal(await page.locator("#btn-send").isDisabled(), true);
    assert.match(await page.locator("#pi-provider-note").innerText(), /右上角/);
    assert.equal(await page.evaluate(() => localStorage.getItem("oss.pi.model")), "vendor/vision");
    status = 503;
    await reopen();
    await page.waitForFunction(() => document.getElementById("pi-provider-note")?.textContent?.includes("无法加载"));
    status = 200;
    catalog = groups;
    await reopen();
    await page.waitForFunction(() => document.getElementById("pi-model")?.getAttribute("aria-disabled") === "false");
    assert.equal(
      await page.locator('#pi-model [aria-selected="true"]').getAttribute("data-model-key"),
      "test/vendor/vision",
    );
    catalog = [
      ...groups,
      {
        providerId: "many",
        providerName: "长列表",
        ready: true,
        models: Array.from({ length: 24 }, (_, i) => ({ id: `model-${i}`, name: `Long model ${i} 中文名称` })),
      },
    ];
    await reopen();
    await page.waitForFunction(() => document.querySelectorAll('#pi-model [role="option"]').length === 26);
    assert.equal(await page.locator("#pi-model").evaluate((el) => el.scrollHeight > el.clientHeight), true);
    await page.locator('#pi-model [aria-selected="true"]').focus();
    await page.keyboard.press("End");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-model-key")), "many/model-23");
    await page.click('#pi-model [data-model-key="test/vendor/vision"]');
    await page.click("#btn-model");
    await page.click('#pi-effort [data-effort="low"]');
    await page.fill("#brief", BRIEF);
    await page.waitForFunction(() => {
      const button = document.getElementById("btn-send");
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    await page.click("#btn-send");
    await page.waitForURL(/index\.html\?launch=/);
    const request = await page.evaluate(() => {
      const id = new URL(location.href).searchParams.get("launch");
      if (!id) throw new Error("Launch request id missing");
      const stored = sessionStorage.getItem(`oss:launch:${id}`);
      if (!stored) throw new Error("Launch request missing");
      return JSON.parse(stored).request;
    });
    assert.deepEqual([request.provider, request.model, request.reasoningEffort], ["test", "vendor/vision", "low"]);
    assert.ok(calls >= 5);
    assert.deepEqual(errors, []);
  } finally {
    gate.resolve();
    await browser?.close();
    server.kill("SIGTERM");
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
