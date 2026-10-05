import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const PUBLIC = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../public");
const appJs = fs.readFileSync(path.join(PUBLIC, "app.js"), "utf8");
const hubJs = fs.readFileSync(path.join(PUBLIC, "hub.js"), "utf8");
const styles = fs.readFileSync(path.join(PUBLIC, "styles.css"), "utf8");
const hubCss = fs.readFileSync(path.join(PUBLIC, "hub.css"), "utf8");
const { resolvePlaywrightRuntimeFile } = await import("../../../scripts/lib/playwright-runtime-path.mjs");
const playwrightRuntime = resolvePlaywrightRuntimeFile(process.env, { repoRoot: ROOT, homeDir: os.homedir() });
const hasPlaywright = playwrightRuntime.ready;

const LONG = Array.from({ length: 80 }, (_, i) =>
  `## 核心医疗场景 ${i + 1}\n\n南通市医疗物流精调调研，模拟数据。**重点**：仓储、冷链、院内配送。\n| 指标 | 数值 |\n| --- | --- |\n| 时效 | 2h |\n| 覆盖 | 98% |\n`,
).join("\n");

describe("generate/editor chrome overflow", () => {
  it("does not dump the full generate brief into a growing bubble", () => {
    assert.ok(appJs.includes('from "./brief-chip.js"'), "editor imports brief-chip");
    assert.ok(appJs.includes("appendBriefChip("), "editor mounts a brief chip");
    const generatePaint = appJs.slice(
      appJs.indexOf("async function runGenerateFlow"),
      appJs.indexOf("function paintPersistedReason"),
    );
    assert.ok(
      !generatePaint.includes("bubble.textContent = brief"),
      "runGenerateFlow must not paint the full brief as a bubble",
    );
    // The hub no longer paints the run itself: it navigates to the editor at
    // once, and the editor's launch flow creates the session and binds to it.
    const launchJs = fs.readFileSync(path.join(PUBLIC, "launch-flow.js"), "utf8");
    assert.ok(hubJs.includes("location.replace(launchHref("), "hub navigates to the editor on Send");
    assert.ok(launchJs.includes("function handoffToLiveEditor("), "launch flow hands the run to the live editor");
    assert.ok(appJs.includes("handoffToLiveEditor(bound)"), "the editor binds itself to the created session");
    assert.ok(
      !hubJs.includes('innerHTML = `<div class="user-message">${escapeHtml(text)}</div>'),
      "hub must not dump the full brief into .user-message",
    );
  });

  it("caps long chrome text and keeps the editor shell inside the viewport", () => {
    assert.ok(/html,\s*body\s*\{[^}]*overflow:\s*hidden/.test(styles), "html/body overflow hidden");
    assert.ok(/\.shell\s*\{[^}]*overflow:\s*hidden/.test(styles), "shell overflow hidden");
    assert.ok(/\.work-chat\s*\{[^}]*min-height:\s*0/.test(styles), "work-chat min-height 0");
    assert.ok(/\.work-thread\s*\{[^}]*min-height:\s*0/.test(styles), "work-thread min-height 0");
    assert.ok(
      /\.brief-chip-body\s*\{[^}]*max-height:[^}]*overflow:\s*auto/.test(styles),
      "editor chip body scrolls",
    );
    assert.ok(
      /\.work-thread \.bubble\s*\{[^}]*max-height:[^}]*overflow:\s*auto/.test(styles),
      "bubbles have max-height",
    );
    assert.ok(
      /\.editor-generation-now strong\s*\{[^}]*-webkit-line-clamp:\s*2/.test(styles),
      "generation intent clamps",
    );
    assert.ok(/\.agent-thread\s*\{[^}]*min-height:\s*0/.test(hubCss), "agent-thread min-height 0");
    assert.ok(
      /\.brief-chip-body\s*\{[^}]*max-height:[^}]*overflow:\s*auto/.test(hubCss),
      "hub chip body scrolls",
    );
    assert.ok(
      /\.prompt-main textarea\s*\{[^}]*max-height:[^}]*overflow:\s*auto/.test(hubCss),
      "hub brief textarea caps",
    );
  });

  it("labels a long brief without repeating the whole source", async () => {
    const { briefChipLabel } = await import("../public/brief-chip.js");
    const label = briefChipLabel(LONG);
    assert.ok(label.length <= 40);
    assert.ok(label.includes("核心医疗场景"));
    assert.notEqual(label, LONG);
  });
});

describe("generate/editor chrome overflow on the real page", { skip: !hasPlaywright }, () => {
  let server;
  let serverLog = "";
  let browser;
  let base;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "oss-chrome-test-"));
  const project = path.join(scratch, "project");
  const port = Number(process.env.QA_PORT || 55441);

  after(async () => {
    await browser?.close();
    if (server) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  async function boot() {
    if (browser) return;
    fs.cpSync(path.join(ROOT, "fixtures/okp-yu7-ppt"), project, { recursive: true });
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
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const { launchPinnedChromium } = await import("../../../scripts/lib/pinned-playwright.mjs");
    browser = await launchPinnedChromium({ headless: true });
  }

  it("keeps a super-long generate source inside the editor viewport", async () => {
    await boot();
    const page = await browser.newPage({locale:'zh-CN', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(`${base}/index.html?project=${encodeURIComponent(project)}&page=0`, {
      waitUntil: "networkidle",
    });
    await page.waitForFunction(() => document.getElementById("doc-title")?.textContent !== "未加载");
    const facts = await page.evaluate(async (brief) => {
      const chat = document.getElementById("work-chat");
      chat.hidden = false;
      const thread = document.getElementById("work-thread");
      thread.replaceChildren();
      const gen = document.getElementById("editor-generation");
      if (gen) gen.hidden = false;
      const intent = document.getElementById("editor-generation-intent");
      if (intent) {
        intent.textContent = brief;
        intent.title = brief;
      }
      const mod = await import("./brief-chip.js").catch(() => null);
      if (mod?.appendBriefChip) mod.appendBriefChip(thread, brief);
      else {
        const bubble = document.createElement("div");
        bubble.className = "bubble";
        bubble.textContent = brief;
        thread.append(bubble);
      }
      const chip = thread.querySelector(".brief-chip");
      const rail = document.getElementById("rail")?.getBoundingClientRect();
      const insertToolbar = document.getElementById("insert-toolbar")?.getBoundingClientRect();
      const inView = (box) =>
        Boolean(box) && box.top >= -1 && box.left >= -1 && box.bottom <= window.innerHeight + 1 && box.right <= window.innerWidth + 1;
      return {
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
        hasChip: Boolean(chip),
        chipOpen: Boolean(chip?.open),
        chipHeight: chip?.getBoundingClientRect().height ?? 0,
        railInView: inView(rail),
        insertToolbarInView: inView(insertToolbar),
      };
    }, LONG);
    await page.close();
    assert.equal(facts.hasChip, true, "generate source must be a chip, not a full-page bubble");
    assert.equal(facts.chipOpen, false);
    assert.ok(facts.chipHeight < 120, `collapsed chip was ${facts.chipHeight}px`);
    assert.ok(
      facts.scrollHeight <= facts.innerHeight + 2,
      `document grew to ${facts.scrollHeight}px vs viewport ${facts.innerHeight}px`,
    );
    assert.equal(facts.railInView, true);
    assert.equal(facts.insertToolbarInView, true);
  });

  it("keeps Agent, properties, comments, and menus reachable at desktop and narrow widths", async () => {
    await boot();
    for (const width of [1280, 1000, 600]) {
      const page = await browser.newPage({locale:'zh-CN', viewport: { width, height: 800 }, deviceScaleFactor: 1 });
      // workspace=0 keeps the Agent panel closed on load so this test still owns
      // the open/close toggle path it asserts.
      await page.goto(`${base}/index.html?project=${encodeURIComponent(project)}&page=0&workspace=0`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.getElementById("doc-title")?.textContent !== "未加载");
      const inView = async (locator) => locator.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
      });

      const text = page.locator("#slide .el.text").first();
      await text.dispatchEvent("click");
      await page.locator("#property-panel").waitFor({ state: "visible" });
      assert.equal(await inView(page.locator("#property-panel")), true, `property panel overflowed at ${width}px`);

      assert.equal(await page.locator([
        '#btn-formula',
        '#btn-theme',
        '[data-insert="formula"]',
        '[data-insert="smartart"]',
        '[data-control="insert.smartart"]',
        '[data-insert="icon"]',
        '[data-lib="icon"]',
        '[data-control="insert.icon"]',
        '[data-insert="chart"]',
        '[data-control="insert.chart"]',
        '#property-panel[data-inspector-type="theme"]',
      ].join(",")).count(), 0, "removed manual icon, SmartArt, formula, chart, and page-background entries must stay absent");

      await page.locator("#btn-sparkles").click();
      await page.locator("#work-chat").waitFor({ state: "visible" });
      assert.equal(await inView(page.locator("#work-chat")), true, `Agent panel overflowed at ${width}px`);
      await page.keyboard.press("Escape");
      await page.locator("#work-chat").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#btn-sparkles").evaluate((node) => node === document.activeElement), true);

      await page.locator("#btn-comments").click();
      await page.locator("#comment-panel").waitFor({ state: "visible" });
      assert.equal(await inView(page.locator("#comment-panel")), true, `comment panel overflowed at ${width}px`);
      await page.keyboard.press("Escape");
      await page.locator("#comment-panel").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#btn-comments").evaluate((node) => node === document.activeElement), true);

      const slide = page.locator("#slide");
      await slide.focus();
      // 进出批注模式会清空编辑器选中；空画布菜单只有"粘贴"一项，单项菜单的
      // ArrowDown 只会回绕到自身。先重新选中元素，让菜单回到多项目标态。
      await page.locator("#slide .el.text").first().dispatchEvent("click");
      await page.waitForFunction(() => Boolean(document.querySelector("#slide .el.selected")));
      await slide.dispatchEvent("contextmenu", { button: 2, clientX: width - 2, clientY: 798 });
      await page.locator("#ctx-menu").waitFor({ state: "visible" });
      assert.equal(await inView(page.locator("#ctx-menu")), true, `context menu overflowed at ${width}px`);
      assert.equal(await page.locator('#ctx-menu [data-control="theme.background.set"]').count(), 0,
        "the context menu must not restore the removed manual page-background action");
      assert.equal(await page.getByRole("button", { name: /设置背景色/ }).count(), 0,
        "the removed right-click background action must stay absent");
      const first = page.locator("#ctx-menu button:not(:disabled)").first();
      assert.equal(await first.evaluate((node) => node === document.activeElement), true);
      await page.keyboard.press("ArrowDown");
      assert.equal(await first.evaluate((node) => node === document.activeElement), false, "ArrowDown must move through the context menu");
      await page.keyboard.press("Escape");
      await page.locator("#ctx-menu").waitFor({ state: "hidden" });
      assert.equal(await slide.evaluate((node) => node === document.activeElement), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
      await page.close();
    }
  });

  it("gives the canvas priority when Agent and object properties compete for width", async () => {
    await boot();
    for (const [width, shouldAutoCollapse] of [[1100, true], [1280, true], [1440, true], [1920, false]]) {
      const page = await browser.newPage({locale:'zh-CN', viewport: { width, height: 720 }, deviceScaleFactor: 1 });
      // The Agent workspace opens by default now; workspace=0 restores the closed
      // baseline this auto-collapse scenario measures from.
      await page.goto(`${base}/index.html?project=${encodeURIComponent(project)}&page=0&workspace=0`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.getElementById("doc-title")?.textContent !== "未加载");
      await page.evaluate(() => {
        localStorage.setItem("oss.propertyPanelCollapsed", "0");
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForFunction(() => document.getElementById("doc-title")?.textContent !== "未加载");
      const panel = page.locator("#property-panel");
      await panel.waitFor({ state: "visible" });
      if (width !== 1440) {
        await page.locator("#slide .el.text").first().dispatchEvent("click");
        assert.equal(await panel.evaluate((node) => node.classList.contains("is-collapsed")), false);
      }
      await page.locator("#btn-sparkles").click();
      await page.locator("#work-chat").waitFor({ state: "visible" });
      if (width === 1440) {
        assert.equal(await panel.evaluate((node) => node.classList.contains("is-empty")), true,
          "opening Agent before selecting an object should keep the compact empty property affordance");
        await page.locator("#slide .el.text").first().dispatchEvent("click");
      }
      await page.waitForFunction((expected) => {
        const panel = document.getElementById("property-panel");
        const width = panel?.getBoundingClientRect().width || 0;
        return panel?.hasAttribute("data-agent-auto-collapsed") === expected
          && (expected ? width > 0 && width <= 52 : width >= 290);
      }, shouldAutoCollapse);
      const facts = await page.evaluate(() => ({
        autoCollapsed: document.getElementById("property-panel")?.hasAttribute("data-agent-auto-collapsed"),
        panelWidth: document.getElementById("property-panel")?.getBoundingClientRect().width || 0,
        stageWidth: document.querySelector(".stage-wrap")?.getBoundingClientRect().width || 0,
        workWidth: document.getElementById("work-chat")?.getBoundingClientRect().width || 0,
        railWidth: document.getElementById("rail")?.getBoundingClientRect().width || 0,
        targetReadable: Boolean(document.getElementById("work-target")?.textContent?.startsWith("目标：")),
        targetFits: (document.getElementById("work-target")?.scrollWidth || 0) <= (document.getElementById("work-target")?.clientWidth || 0),
        noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 2,
        toggleLabel: document.getElementById("property-toggle")?.getAttribute("aria-label"),
        stored: localStorage.getItem("oss.propertyPanelCollapsed"),
      }));
      assert.equal(facts.autoCollapsed, shouldAutoCollapse,
        `unexpected Agent layout priority at ${width}px: ${JSON.stringify(facts)}`);
      assert.equal(facts.stored, "0", "automatic layout must not overwrite the user's saved preference");
      assert.equal(facts.noPageOverflow, true, `editor chrome overflowed at ${width}px`);
      assert.equal(facts.targetReadable, true, `Agent target was not readable at ${width}px`);
      assert.equal(facts.targetFits, true, `Agent target overflowed its panel at ${width}px`);
      if (shouldAutoCollapse) {
        assert.ok(facts.panelWidth <= 52, `collapsed properties used ${facts.panelWidth}px at ${width}px`);
        assert.ok(facts.stageWidth >= (width === 1100 ? 520 : 600), `Agent left only ${facts.stageWidth}px for the canvas at ${width}px`);
        assert.equal(facts.toggleLabel, "展开属性面板");
      } else {
        assert.ok(facts.panelWidth >= 290, `wide layout unexpectedly collapsed properties to ${facts.panelWidth}px`);
      }

      if (width === 1100) {
        assert.ok(Math.abs(facts.workWidth - 310) <= 1, `Agent panel used ${facts.workWidth}px at 1100px`);
        assert.ok(Math.abs(facts.railWidth - 136) <= 1, `page rail used ${facts.railWidth}px at 1100px`);
      }

      if (width === 1280) {
        await page.locator("#property-toggle").click();
        await page.waitForTimeout(220);
        assert.equal(await panel.evaluate((node) => node.classList.contains("is-collapsed")), false,
          "the user must be able to reopen properties while Agent stays open");
        assert.equal(await page.evaluate(() => localStorage.getItem("oss.propertyPanelCollapsed")), "0");
      }
      await page.locator("#chat-close").click();
      await page.locator("#work-chat").waitFor({ state: "hidden" });
      await page.waitForTimeout(220);
      assert.equal(await panel.evaluate((node) => node.classList.contains("is-collapsed")), false,
        "closing Agent must restore the user's open property preference");
      await page.close();
    }
  });

  it("caps hub generate source so the agent screen does not paint the whole brief", async () => {
    await boot();
    const page = await browser.newPage({locale:'zh-CN', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    // The hub polls its health endpoint continuously, so "networkidle" never
    // settles; wait for the agent screen element instead.
    // The brief chip renders in the editor thread now (the hub hands off), so the
    // layout guarantee is checked on the page that actually owns it.
    await page.goto(`${base}/index.html?project=${encodeURIComponent(project)}&workspace=0`, { waitUntil: "domcontentloaded" });
    // The thread only lays out inside the open Agent workspace.
    await page.click("#btn-sparkles");
    await page.waitForSelector("#work-thread", { state: "visible", timeout: 15000 });
    const facts = await page.evaluate(async (brief) => {
      const thread = document.getElementById("work-thread");
      thread.replaceChildren();
      const mod = await import("./brief-chip.js").catch(() => null);
      if (mod?.appendBriefChip) mod.appendBriefChip(thread, brief);
      else {
        const msg = document.createElement("div");
        msg.className = "user-message";
        msg.textContent = brief;
        thread.append(msg);
      }
      const chip = thread.querySelector(".brief-chip");
      const body = chip?.querySelector(".brief-chip-body");
      if (chip) chip.open = true;
      return {
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
        hasChip: Boolean(chip),
        bodyHeight: body?.getBoundingClientRect().height ?? 0,
        bodyScroll: body?.scrollHeight ?? 0,
      };
    }, LONG);
    await page.close();
    assert.equal(facts.hasChip, true);
    assert.ok(facts.scrollHeight <= facts.innerHeight + 2);
    assert.ok(facts.bodyHeight <= 240, `expanded chip body was ${facts.bodyHeight}px`);
    assert.ok(facts.bodyScroll > facts.bodyHeight, "full source stays inside the chip scroller");
  });

  it("uses the real browser fullscreen capability and exits cleanly", async () => {
    await boot();
    const page = await browser.newPage({locale:'zh-CN', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.goto(`${base}/index.html?project=${encodeURIComponent(project)}&page=0`, {
      waitUntil: "networkidle",
    });
    const button = page.locator("#btn-fs");
    const supported = await page.evaluate(() => Boolean(
      (document.documentElement.requestFullscreen && document.exitFullscreen && document.fullscreenEnabled !== false) ||
      (document.documentElement.webkitRequestFullscreen && document.webkitExitFullscreen)
    ));
    assert.equal(await button.isEnabled(), supported);
    if (supported) {
      await button.click();
      await page.waitForFunction(() => Boolean(document.fullscreenElement || document.webkitFullscreenElement));
      assert.equal(await button.getAttribute("aria-pressed"), "true");
      assert.equal(await button.getAttribute("data-tip"), "退出全屏");
      await button.click();
      await page.waitForFunction(() => !document.fullscreenElement && !document.webkitFullscreenElement);
      assert.equal(await button.getAttribute("aria-pressed"), "false");
    } else {
      assert.equal(await button.getAttribute("data-tip"), "当前浏览器不支持全屏");
    }
    await page.close();
  });

  it("disables fullscreen with an explicit reason when the browser has no API", async () => {
    await boot();
    const page = await browser.newPage({locale:'zh-CN', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.goto(`${base}/index.html?project=${encodeURIComponent(project)}&page=0`, {
      waitUntil: "networkidle",
    });
    await page.evaluate(() => {
      Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: false });
      Object.defineProperty(document, "webkitFullscreenEnabled", { configurable: true, value: false });
      Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: undefined });
      Object.defineProperty(document, "exitFullscreen", { configurable: true, value: undefined });
      Object.defineProperty(document.documentElement, "webkitRequestFullscreen", { configurable: true, value: undefined });
      Object.defineProperty(document, "webkitExitFullscreen", { configurable: true, value: undefined });
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    const button = page.locator("#btn-fs");
    assert.equal(await button.isDisabled(), true);
    assert.equal(await button.getAttribute("data-tip"), "当前浏览器不支持全屏");
    assert.equal(await button.getAttribute("aria-label"), "当前浏览器不支持全屏");
    await page.close();
  });

  it("anchors an element comment beside its target and reselects that immutable scope", async () => {
    await boot();
    const page = await browser.newPage({locale:'zh-CN', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.goto(`${base}/index.html?project=${encodeURIComponent(project)}&page=0`, {
      waitUntil: "networkidle",
    });
    const target = page.locator("#slide .el.text").first();
    const targetId = await target.getAttribute("data-id");
    await target.dispatchEvent("pointerdown", { button: 0, bubbles: true });
    await page.locator("#btn-comments").click();
    await page.locator("#comment-draft").fill("元素批注定位回归");
    await page.locator("#comment-add").click();
    // Adding finishes the annotation: the mode exits and leaves no outline behind.
    await page.waitForFunction(() => !document.querySelector(".app")?.classList.contains("is-comment"));
    assert.equal(await page.locator("#comment-panel").isHidden(), true);
    assert.equal(await page.locator(".comment-hover-target, .comment-draft-target").count(), 0);
    assert.equal(await page.locator("#btn-comments").getAttribute("aria-label"), "添加批注");
    // The pointer resting on the element it just annotated draws no outline.
    await target.hover();
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".comment-hover-target").count(), 0);
    // Edit mode again: a blank click clears the editor selection.
    await page.evaluate(() => document.querySelector("#slide")?.click());
    await page.waitForFunction(() => !document.querySelector("#slide .el.selected"));

    // Re-entering annotation shows the saved pin beside its target.
    await page.locator("#btn-comments").click();
    await page.locator("#comment-layer .pin").waitFor();
    // Read target, pin and viewport together once the overlay has held still.
    const [targetBox, pinBox, viewportBox] = await page.evaluate(async (id) => {
      const read = () => [`#slide .el[data-id="${CSS.escape(id)}"]`, "#comment-layer .pin", "#viewport"].map((selector) => {
        const r = document.querySelector(selector)?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
      });
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      let last = "", steady = 0, boxes = read();
      for (let i = 0; i < 60 && steady < 2; i += 1) {
        await frame(); boxes = read();
        const key = JSON.stringify(boxes);
        steady = key === last && boxes.every(Boolean) ? steady + 1 : 0; last = key;
      }
      return boxes;
    }, targetId);
    assert.ok(targetBox && pinBox && viewportBox);
    const pinCenter = { x: pinBox.x + pinBox.width / 2, y: pinBox.y + pinBox.height / 2 };
    assert.ok(Math.abs(pinCenter.x - (targetBox.x + targetBox.width + 8)) <= 1.5);
    assert.ok(Math.abs(pinCenter.y - targetBox.y) <= 1.5);
    assert.ok(pinBox.x >= viewportBox.x && pinBox.x + pinBox.width <= viewportBox.x + viewportBox.width);
    assert.ok(pinBox.y >= viewportBox.y && pinBox.y + pinBox.height <= viewportBox.y + viewportBox.height);
    await page.locator("#comment-layer .pin").click();
    await page.waitForFunction(() => document.querySelector("#comment-panel")?.hidden === false);
    const targetIds = JSON.parse(await page.locator("#comment-panel").getAttribute("data-target-ids") || "[]");
    assert.deepEqual(targetIds, [targetId]);
    await page.close();
  });
});
