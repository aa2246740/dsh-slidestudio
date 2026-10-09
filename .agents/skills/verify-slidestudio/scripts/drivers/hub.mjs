// hub-create, hub-launch, hub-projects, hub-settings
//
// The Hub is driven through the real /slides proxy against the harness's fake kernel (catalog, health,
// providers). Session creation, the model's intent read and provider/tool settings are stubbed at the
// network boundary: nothing here talks to a real provider, and no key value ever leaves the test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO, deferred, fakeSession, newPage, openEditor, readManifest, sleep, stubKernelRoutes } from "../lib.mjs";

const BRIEF = "给新员工做一份 5 页的信息安全培训，语气轻松";
const FAKE_KEY = "verify-key-not-a-secret";

async function openHub(page, ctx, query = "") {
  await page.goto(`${ctx.base}/${query}`, { waitUntil: "networkidle" });
  await page.waitForSelector("#brief");
}
const sendEnabled = (page) => page.evaluate(() => !document.getElementById("btn-send").disabled);
const visible = (page, sel) => page.locator(sel).isVisible();

/** A Hub page whose Create→editor hand-off is fully stubbed at the network boundary. */
async function launchPage(ctx, rec, { name, intent = { intent: "generate", scope: "deck", pages: [] }, hold = false } = {}) {
  const deck = ctx.deck(name);
  const page = await newPage(ctx, rec);
  const s = await fakeSession(page, { sessionId: "launch-test", project: deck, pagePaths: readManifest(deck).pages, pageCount: 0 });
  s.busy = true;
  s.phase = "planning";
  s.current.brief = BRIEF;
  s.current.conversation.messages.push({ id: "u1", at: new Date().toISOString(), text: BRIEF, mode: "generate" });
  const gate = deferred();
  const calls = { intents: [], creates: [] };
  const state = { intentStatus: 200, intentError: "", createResponses: null, intent };
  await page.route("**/slides/assistant-intent", async (r) => {
    calls.intents.push(r.request().postDataJSON());
    if (hold) await gate.promise;
    if (state.intentStatus !== 200) return r.fulfill({ status: state.intentStatus, json: { error: state.intentError } });
    return r.fulfill({ json: { ok: true, ...state.intent } });
  });
  await page.route("**/slides/sessions", async (r) => {
    if (r.request().method() !== "POST") return r.continue();
    calls.creates.push(r.request().postDataJSON());
    const next = state.createResponses?.shift();
    if (next) return r.fulfill(next);
    return r.fulfill({ json: { ok: true, sessionId: "launch-test", projectPath: deck } });
  });
  return { deck, page, s, gate, calls, state };
}

export const features = [
  {
    id: "hub-create",
    title: "Create Hub: prompt, Send gating, layout menu, style panel, attachments, model panel, recent list, narrow width",
    ignoreErrors: [/status of 415/],
    async run(ctx, rec) {
      const page = await newPage(ctx, rec);
      await openHub(page, ctx);
      rec.check("the wordmark and the one-line purpose are there", (await page.locator(".wordmark").innerText()) === "DSH SlideStudio" && (await page.locator(".home-purpose").count()) === 1);
      rec.check("Send is disabled with an empty prompt", !(await sendEnabled(page)));
      await page.fill("#brief", "   ");
      rec.check("whitespace alone does not enable Send", !(await sendEnabled(page)));
      await page.fill("#brief", BRIEF);
      rec.check("text enables Send once the catalog loaded", await rec.until(() => sendEnabled(page), 5000));
      await rec.shot(page, "01-hub");

      // layout
      await page.click("#btn-layout");
      rec.check("the layout button opens a menu", await visible(page, "#layout-menu"));
      rec.check("自适应 is disabled with a reason", (await page.locator('#layout-menu [data-layout="Adaptive"]').isDisabled()) && /已禁用/.test((await page.locator("#layout-menu .disabled-menu-option").first().getAttribute("data-tip")) ?? ""));
      await page.click('#layout-menu [data-layout="4:3"]');
      rec.check("choosing 4:3 updates the label and closes the menu", (await page.locator("#layout-label").innerText()) === "4:3" && (await page.locator("#layout-menu").isHidden()));
      await page.click("#btn-layout");
      await page.mouse.click(40, 500);
      rec.check("a click elsewhere closes the menu", await page.locator("#layout-menu").isHidden());
      rec.check("the output-type button is hidden (only slides exist)", await page.locator("#btn-kind").isHidden());

      // style
      const chip = page.locator("#style-chip");
      rec.check("the style chip starts as 自由风格", (await page.locator("#style-label").innerText()) === "自由风格");
      await chip.click();
      rec.check("the chip opens the style panel and reports it", (await visible(page, "#style-pop")) && (await chip.getAttribute("aria-expanded")) === "true");
      rec.check("the panel lists 自由风格 plus the catalog style", (await page.locator(".style-reference-card").count()) === 2, await page.locator(".style-reference-card").count());
      rec.check("category tabs are present", (await page.locator("#tabs button").count()) >= 2);
      await rec.shot(page, "02-style-panel");
      await chip.click();
      rec.check("a second click on the chip closes the panel", await page.locator("#style-pop").isHidden());
      await chip.focus();
      await page.keyboard.press("Enter");
      rec.check("Enter on the focused chip opens it", await visible(page, "#style-pop"));
      await page.click("#btn-style-pop-close");
      rec.check("✕ closes it", await page.locator("#style-pop").isHidden());
      await chip.click();
      await page.locator(".style-reference-card", { hasText: "Plain" }).first().click();
      rec.check("picking a style closes the panel and renames the chip", (await page.locator("#style-pop").isHidden()) && /Plain/i.test(await page.locator("#style-label").innerText()), await page.locator("#style-label").innerText());

      // attachments
      const dir = path.join(REPO, "output/attachments");
      const before = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
      try {
        await page.click("#btn-attach");
        rec.check("the plus opens the attachment dialog", await visible(page, "#attach-modal"));
        await page.keyboard.press("Escape");
        rec.check("Esc closes it", await page.locator("#attach-modal").isHidden());
        await page.click("#btn-attach");
        await page.click("#btn-demo-ref");
        await page.waitForSelector("#attach-row .reference-chip", { timeout: 8000 });
        rec.check("the demo reference adds parsed chips and closes the dialog", (await page.locator("#attach-row .reference-chip.is-parsed").count()) >= 1 && (await page.locator("#attach-modal").isHidden()), await page.locator("#attach-row").innerText());
        await rec.shot(page, "03-attachments");
        const chips = await page.locator("#attach-row .reference-chip").count();
        await page.locator("#attach-row .reference-chip button", { hasText: "×" }).first().click();
        rec.check("× removes one chip", await rec.until(async () => (await page.locator("#attach-row .reference-chip").count()) === chips - 1, 3000));
        while ((await page.locator("#attach-row .reference-chip").count()) > 0) {
          await page.locator("#attach-row .reference-chip button", { hasText: "×" }).first().click();
          await sleep(150);
        }
        await page.setInputFiles("#attach-file", { name: "verify-hub.txt", mimeType: "text/plain", buffer: Buffer.from("VERIFY hub attachment") });
        await page.waitForSelector("#attach-row .reference-chip.is-parsed", { timeout: 8000 });
        rec.check("a chosen text file is uploaded and parsed", /verify-hub\.txt/.test(await page.locator("#attach-row").innerText()));
        rec.check("Send stays enabled with a parsed attachment", await sendEnabled(page));
        await page.setInputFiles("#attach-file", { name: "verify-hub.png", mimeType: "image/png", buffer: Buffer.from("not a png") });
        await sleep(1500);
        const states = await page.$$eval("#attach-row .reference-chip", (n) => n.map((x) => `${x.className.match(/is-\w+/)?.[0]}:${x.innerText.replace(/\s+/g, " ")}`));
        rec.note(`chip states after adding a bogus png: ${states.join(" | ")}`);
        const unfinished = states.some((x) => !x.startsWith("is-parsed"));
        rec.check("Send is gated while any attachment is not parsed", unfinished ? !(await sendEnabled(page)) : true, states.join(" | "));
        while ((await page.locator("#attach-row .reference-chip").count()) > 0) {
          await page.locator("#attach-row .reference-chip button", { hasText: "×" }).first().click();
          await sleep(150);
        }
        rec.check("with no attachments Send is enabled again", await rec.until(() => sendEnabled(page), 3000));
      } finally {
        for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (!before.has(f)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      }

      // model panel
      await page.click("#btn-model");
      rec.check("the model chip opens the panel", await visible(page, "#pi-panel"));
      const picked = await page.evaluate(() => {
        const chosen = document.querySelector('#pi-model [aria-selected="true"]');
        return { value: chosen?.dataset.modelKey, group: chosen?.parentElement?.querySelector(".model-group-label")?.textContent ?? "", text: chosen?.querySelector("span")?.textContent ?? "" };
      });
      rec.check("the kernel's model is selected, grouped under its provider", picked.value === "test/cheap" && picked.group === "Local" && picked.text === "cheap", JSON.stringify(picked));
      rec.check("the popup has direct choices and no login entry", (await page.locator('#pi-model [role="option"]').count()) > 0 && (await page.locator("#pi-panel select, #pi-login-status").count()) === 0);
      await page.waitForFunction(() => document.querySelectorAll("#capability-row li").length === 4);
      let chips = await page.$$eval("#capability-row li", (n) => n.map((x) => `${x.className}:${x.textContent}`));
      // the chip row is repainted asynchronously; retry the read if we caught it mid-repaint
      if (chips.length === 0) {
        await rec.until(async () => {
          chips = await page.$$eval("#capability-row li", (n) => n.map((x) => `${x.className}:${x.textContent}`));
          return chips.length === 4;
        }, 3000);
      }
      rec.check("a one-line capability strip lights what this run can use", chips.length === 4 && chips.includes("is-on:看图") && chips.includes("is-on:联网"), chips.join(","));
      rec.check("the choice is remembered for the next visit", await page.evaluate(() => localStorage.getItem("oss.pi.provider") === "test" && localStorage.getItem("oss.pi.model") === "cheap"));
      await rec.shot(page, "04-model-panel");
      await page.click("#btn-settings");
      rec.check("设置 opens Settings → 模型", (await visible(page, "#settings-screen")) && (await visible(page, "#pane-models")) && (await page.locator("#home-screen").isHidden()));
      await page.click("#btn-settings-back");
      rec.check("the recent-work list is on the Hub", (await page.locator("#projects-title").innerText()) === "继续协作");

      // narrow width
      await page.setViewportSize({ width: 375, height: 800 });
      await sleep(250);
      const narrow = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, send: document.getElementById("btn-send").getBoundingClientRect().right <= innerWidth }));
      rec.check("at 375px the page does not scroll sideways and Send stays on screen", narrow.overflow <= 0 && narrow.send, JSON.stringify(narrow));
      await rec.shot(page, "05-narrow");
      await page.__context.close();
    },
  },

  {
    id: "hub-launch",
    title: "Create → editor hand-off: instant cover, live URL without reload, discuss variant, failure recovery, queue",
    ignoreErrors: [/ERR_FAILED/, /status of 5\d\d/],
    async run(ctx, rec) {
      // 1) generate: the intent read is held open, the editor must already show the message
      const a = await launchPage(ctx, rec, { name: "hub-launch-gen", hold: true });
      await openHub(a.page, ctx);
      await a.page.fill("#brief", BRIEF);
      await a.page.click("#btn-layout");
      await a.page.click('#layout-menu [data-layout="4:3"]');
      await a.page.waitForFunction(() => !document.getElementById("btn-send").disabled);
      await a.page.click("#btn-send");
      await a.page.waitForURL(/index\.html\?launch=/, { timeout: 10000 });
      await a.page.waitForSelector("#workspace-cover:not([hidden]) #workspace-cover-brief:not([hidden])", { timeout: 10000 });
      rec.check("the editor opens at once and shows the user's message", (await a.page.locator("#workspace-cover-brief").innerText()) === BRIEF);
      rec.check("progress names the current step truthfully", /理解你的需求/.test(await a.page.locator("#workspace-cover-detail").innerText()) && (await a.page.locator('#workspace-cover-steps li[aria-current="step"]').innerText()) === "理解需求");
      rec.check("no session exists before the intent read returns", a.calls.creates.length === 0 && a.calls.intents.length === 1);
      rec.check("the intent read carries hub:true and the chosen model", a.calls.intents[0]?.hub === true && a.calls.intents[0]?.modelSelection?.provider === "test" && /^model-/.test(a.calls.intents[0]?.modelSelection?.model ?? ""), JSON.stringify(a.calls.intents[0]));
      await rec.shot(a.page, "01-launch-cover");
      await a.page.evaluate(() => (window.__samePage = true));
      a.gate.resolve();
      await a.page.waitForURL(/session=launch-test/, { timeout: 8000 });
      const url = new URL(a.page.url());
      rec.check("the URL becomes the live route: project, session, live, workspace, no launch id", url.searchParams.get("project") === a.deck && url.searchParams.get("live") === "1" && url.searchParams.get("workspace") === "1" && !url.searchParams.has("launch"), a.page.url());
      rec.check("the hand-off does not reload the page", await a.page.evaluate(() => window.__samePage === true));
      rec.check("one session was created, as a generate turn with the brief", a.calls.creates.length === 1 && a.calls.creates[0].conversationMode === "generate" && a.calls.creates[0].brief === BRIEF, JSON.stringify(a.calls.creates[0] ?? {}).slice(0, 300));
      rec.json("create-request", a.calls.creates[0] ?? {});
      rec.check("the request carries the chosen 4:3 layout", JSON.stringify(a.calls.creates[0]).includes("4:3"));
      await a.page.waitForSelector("#workspace-cover", { state: "hidden", timeout: 10000 });
      await rec.shot(a.page, "02-live-editor");
      await a.page.reload({ waitUntil: "domcontentloaded" });
      await sleep(700);
      rec.check("reloading the bound page does not create a second session", a.calls.creates.length === 1);
      await a.page.__context.close();

      // 2) discuss: the model reads the brief as a conversation, opened with Ctrl+Enter
      const d = await launchPage(ctx, rec, { name: "hub-launch-discuss", intent: { intent: "discuss", scope: "current", pages: [] } });
      await openHub(d.page, ctx);
      await d.page.fill("#brief", "先聊聊思路，不要生成");
      await d.page.waitForFunction(() => !document.getElementById("btn-send").disabled);
      await d.page.press("#brief", "Control+Enter");
      await d.page.waitForURL(/session=launch-test/, { timeout: 10000 });
      rec.check("Ctrl+Enter sends", d.calls.creates.length === 1);
      rec.check("a discussion intent creates a discuss session", d.calls.creates[0]?.conversationMode === "discuss", d.calls.creates[0]?.conversationMode);
      await d.page.__context.close();

      // 3) failure: the cause is shown, the message kept, retry re-runs, back restores the draft
      const f = await launchPage(ctx, rec, { name: "hub-launch-fail" });
      f.state.intentStatus = 503;
      f.state.intentError = "模型服务暂时不可达，输入内容已保留。";
      await openHub(f.page, ctx);
      await f.page.fill("#brief", BRIEF);
      await f.page.waitForFunction(() => !document.getElementById("btn-send").disabled);
      await f.page.click("#btn-send");
      await f.page.waitForSelector("#workspace-cover.is-failed");
      rec.check("a failed intent read shows the cause and keeps the message", /暂时不可达/.test(await f.page.locator("#workspace-cover-detail").innerText()) && (await f.page.locator("#workspace-cover-brief").innerText()) === BRIEF);
      rec.check("the failure is announced as an alert and nothing was created", (await f.page.locator("#workspace-cover").getAttribute("role")) === "alert" && f.calls.creates.length === 0);
      await rec.shot(f.page, "03-launch-failed");
      await f.page.click("#workspace-cover .launch-retry");
      await rec.until(() => f.calls.intents.length === 2, 5000);
      rec.check("重试 re-runs the intent read", f.calls.intents.length === 2);
      f.state.intentStatus = 200;
      await f.page.waitForSelector("#workspace-cover.is-failed .launch-retry");
      await f.page.click("#workspace-cover .launch-retry");
      await f.page.waitForURL(/session=launch-test/, { timeout: 8000 });
      rec.check("after the kernel recovers, 重试 completes the launch", f.calls.creates.length === 1);
      await f.page.__context.close();

      // 3b) failure → back to the Hub keeps the draft
      const g = await launchPage(ctx, rec, { name: "hub-launch-back" });
      g.state.intentStatus = 503;
      g.state.intentError = "模型服务暂时不可达。";
      await openHub(g.page, ctx);
      await g.page.fill("#brief", BRIEF);
      await g.page.waitForFunction(() => !document.getElementById("btn-send").disabled);
      await g.page.click("#btn-send");
      await g.page.waitForSelector("#workspace-cover.is-failed");
      await g.page.click("#workspace-cover .launch-back");
      await g.page.waitForURL((u) => u.pathname === "/" && !u.searchParams.has("draft"), { timeout: 5000 });
      rec.check("回首页修改 restores the draft on the Hub", (await g.page.inputValue("#brief")) === BRIEF, await g.page.inputValue("#brief"));
      await g.page.__context.close();

      // 4) session creation fails after a good intent read, then a queued answer
      const c = await launchPage(ctx, rec, { name: "hub-launch-create" });
      c.state.createResponses = [{ status: 500, json: { error: "创建会话失败：磁盘已满" } }];
      await openHub(c.page, ctx);
      await c.page.fill("#brief", BRIEF);
      await c.page.waitForFunction(() => !document.getElementById("btn-send").disabled);
      await c.page.click("#btn-send");
      await c.page.waitForSelector("#workspace-cover.is-failed");
      rec.check("a failed session creation shows the server's reason", /磁盘已满/.test(await c.page.locator("#workspace-cover-detail").innerText()));
      c.state.createResponses = [{ status: 202, json: { queued: true, position: 2, retryAfterMs: 1000 } }];
      await c.page.click("#workspace-cover .launch-retry");
      await c.page.waitForFunction(() => /排队中/.test(document.getElementById("workspace-cover-queue")?.textContent ?? ""), null, { timeout: 5000 });
      rec.check("a 202 queued answer shows the position and keeps waiting", /前面还有 2 个任务/.test(await c.page.locator("#workspace-cover-queue").innerText()));
      await rec.shot(c.page, "04-launch-queued");
      await c.page.waitForURL(/session=launch-test/, { timeout: 10000 });
      rec.check("the same request is re-posted after the wait and succeeds", c.calls.creates.length >= 3 && c.calls.creates.at(-1).clientRequestId === c.calls.creates.at(-2).clientRequestId, c.calls.creates.map((x) => x.clientRequestId).join(","));
      await c.page.__context.close();
    },
  },

  {
    id: "hub-projects",
    title: "Recent work list: rows, unread dot, size, open, delete with confirm, fixtures hidden, unsafe delete refused",
    async run(ctx, rec) {
      const title = `VERIFY 项目列表 ${ctx.runId.slice(-6)}`;
      const dir = ctx.outputProject("hub-projects", title);
      const page = await newPage(ctx, rec);
      await openHub(page, ctx);
      const row = page.locator(".proj-row", { hasText: title });
      await row.waitFor({ timeout: 8000 });
      rec.check("a generated project under output/ is listed by its deck title", (await row.count()) === 1);
      rec.check("the row says pages, when, and disk size", /8 页 · (刚刚|\d+ 分钟前) · [\d.]+ (B|KB|MB|GB)/.test(await row.locator("small").innerText()), await row.locator("small").innerText());
      rec.check("a never-opened generated project has the unread dot", (await row.locator(".proj-dot.unread").count()) === 1);
      const hrefs = await page.$$eval(".proj-row a", (n) => n.map((a) => a.getAttribute("href")));
      rec.check("fixtures are not listed", !hrefs.some((h) => /fixtures/.test(decodeURIComponent(h))), `${hrefs.length} rows`);
      await rec.shot(page, "01-list");

      // open
      await row.click();
      await page.waitForURL(/index\.html\?project=/, { timeout: 8000 });
      rec.check("clicking a row opens it in the editor workspace", decodeURIComponent(page.url()).includes(dir) && /workspace=1/.test(page.url()), page.url());
      await page.waitForFunction(() => document.getElementById("doc-title")?.textContent && document.getElementById("doc-title").textContent !== "未加载");
      rec.check("the editor shows that deck's title", (await page.locator("#doc-title").innerText()).includes("小米 YU7") || (await page.locator("#doc-title").innerText()).includes(title));
      rec.check("opening marks it as viewed on this browser", await page.evaluate((d) => JSON.parse(localStorage.getItem("oss.viewed.projects") || "[]").includes(d), dir));
      await openHub(page, ctx);
      const again = page.locator(".proj-row", { hasText: title });
      rec.check("back on the Hub the dot is gone", (await again.locator(".proj-dot.unread").count()) === 0);

      // delete: cancel, then accept
      const dialogs = [];
      let accept = false;
      page.on("dialog", async (dlg) => {
        dialogs.push(dlg.message());
        await (accept ? dlg.accept() : dlg.dismiss());
      });
      await again.hover();
      await again.locator(".proj-trash").click();
      await sleep(400);
      rec.check("the delete button asks first, naming the project", dialogs.length === 1 && dialogs[0].includes(title), dialogs[0]);
      rec.check("cancelling keeps the project on screen and on disk", (await page.locator(".proj-row", { hasText: title }).count()) === 1 && fs.existsSync(dir));
      accept = true;
      await again.hover();
      await again.locator(".proj-trash").click();
      await page.locator(".proj-row", { hasText: title }).waitFor({ state: "detached", timeout: 5000 });
      rec.check("confirming removes the row and the directory", await rec.until(() => !fs.existsSync(dir), 3000));
      rec.check("a toast confirms the deletion", (await page.locator("#toast").innerText()).includes("已删除"), await page.locator("#toast").innerText());
      await rec.shot(page, "02-after-delete");

      // the API refuses anything that is not a generated project under output/
      const outside = path.join(os.tmpdir(), `verify-outside-${ctx.runId}`);
      fs.rmSync(outside, { recursive: true, force: true });
      fs.cpSync(path.join(REPO, "fixtures/okp-yu7-ppt"), outside, { recursive: true, filter: (s) => !/[\\/](\.versions|_agent)([\\/]|$)/.test(s) });
      try {
        const r = await fetch(`${ctx.base}/api/projects`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: outside }) });
        rec.check("deleting a project outside output/ is refused", r.status === 400 && fs.existsSync(outside), `${r.status} ${(await r.text()).slice(0, 120)}`);
        const r2 = await fetch(`${ctx.base}/api/projects`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" });
        rec.check("a delete with no path is a 400", r2.status === 400, r2.status);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
      await page.__context.close();
    },
    ignoreErrors: [/status of 4\d\d/],
  },

  {
    id: "hub-settings",
    title: "Settings: panes, API-key providers (never echoed), subscription login, tool endpoints, theme that persists",
    async run(ctx, rec) {
      const page = await newPage(ctx, rec);
      // provider + tool state lives in these closures; the real kernel is never involved
      const providers = [{ id: "test", name: "Local", ready: true, models: ["cheap"], methods: ["api_key"], userAdded: false }];
      const presets = [{ id: "acme", name: "Acme", baseURL: "https://api.acme.example/v1" }];
      const sent = { keys: [], adds: [], deletes: [], tools: [], oauth: [] };
      let tools = { imageSearch: { kind: "off" }, imageGenerate: { kind: "off" } };
      let oauthSignedIn = false;
      await stubKernelRoutes(page);
      await page.route("**/slides/providers", async (r) => {
        if (r.request().method() === "POST") {
          const body = r.request().postDataJSON();
          sent.adds.push(body);
          const p = body.preset
            ? { id: body.preset, name: presets.find((x) => x.id === body.preset).name, ready: false, models: [], methods: ["api_key"], userAdded: true }
            : { id: body.id, name: body.name, ready: Boolean(body.apiKey), models: body.models, methods: ["api_key"], userAdded: true };
          providers.push(p);
          return r.fulfill({ json: { ok: true } });
        }
        return r.fulfill({ json: { providers, presets, connection: { ready: true } } });
      });
      await page.route("**/slides/providers/*/key", async (r) => {
        const id = decodeURIComponent(new URL(r.request().url()).pathname.split("/").at(-2));
        const p = providers.find((x) => x.id === id);
        if (r.request().method() === "DELETE") {
          sent.deletes.push(id);
          if (p) p.ready = false;
          return r.fulfill({ json: { ok: true } });
        }
        sent.keys.push({ id, apiKey: r.request().postDataJSON().apiKey });
        if (p) p.ready = true;
        return r.fulfill({ json: { ok: true } });
      });
      // Deleting a user-added provider removes the provider itself, not just its key.
      await page.route("**/slides/providers/*", async (r) => {
        if (r.request().method() !== "DELETE") return r.fallback();
        const id = decodeURIComponent(new URL(r.request().url()).pathname.split("/").at(-1));
        sent.deletes.push(`provider:${id}`);
        const at = providers.findIndex((x) => x.id === id);
        if (at >= 0) providers.splice(at, 1);
        return r.fulfill({ json: { ok: true } });
      });
      await page.route("**/slides/tool-settings", async (r) => {
        if (r.request().method() === "PUT") {
          const body = r.request().postDataJSON();
          sent.tools.push(body);
          const mask = (e) => (e.kind === "custom" ? { ...e, apiKey: undefined, apiKeySet: Boolean(e.apiKey) } : e);
          tools = { imageSearch: mask(body.imageSearch), imageGenerate: mask(body.imageGenerate) };
          return r.fulfill({ json: { ok: true, settings: tools } });
        }
        return r.fulfill({ json: { ok: true, settings: tools } });
      });
      await page.route("**/plugins/dsh-oauth-login/auth/status", (r) =>
        r.fulfill({ json: [{ id: "sub", route: "sub-route", account: { status: oauthSignedIn ? "signed-in" : "signed-out" } }] }),
      );
      await page.route("**/plugins/dsh-oauth-login/auth/login", (r) => {
        sent.oauth.push("login");
        return r.fulfill({ json: { kind: "input", input: { placeholder: "输入验证码", message: "请输入邮箱里的验证码" } } });
      });
      await page.route("**/plugins/dsh-oauth-login/auth/complete", (r) => {
        sent.oauth.push("complete");
        oauthSignedIn = true;
        providers.find((x) => x.id === "sub-route").ready = true;
        return r.fulfill({ json: { ok: true } });
      });
      providers.push({ id: "sub-route", name: "Sub 订阅", ready: false, models: ["sub-1"], methods: ["oauth"] });

      await openHub(page, ctx);
      await page.click("#btn-settings");
      rec.check("设置 swaps the Hub for the settings screen", (await visible(page, "#settings-screen")) && (await page.locator("#home-screen").isHidden()));
      rec.check("the tools pane is a public nav entry", await page.locator('[data-settings-pane="tools"]').isVisible());
      const panes = { models: "pane-models", oauth: "pane-oauth", tools: "pane-tools", appearance: "pane-appearance" };
      for (const [key, id] of Object.entries(panes)) {
        await page.click(`[data-settings-pane="${key}"]`);
        const shown = await page.$$eval(".settings-pane", (n) => n.filter((x) => !x.hidden).map((x) => x.id));
        rec.check(`the ${key} tab shows only its pane`, shown.length === 1 && shown[0] === id, shown.join(","));
      }

      // API-key providers
      await page.click('[data-settings-pane="models"]');
      await page.waitForSelector("#byok-list .byok-row");
      rec.check("the list shows API-key providers with a ready dot", (await page.locator("#byok-list .byok-row", { hasText: "Local" }).locator(".byok-dot.is-on").count()) === 1);
      await page.click("#btn-add-provider");
      rec.check("+ 添加提供方 lists unused presets", (await page.locator("#preset-picker button", { hasText: "Acme" }).count()) === 1);
      await page.locator("#preset-picker button", { hasText: "Acme" }).click();
      const acme = page.locator("#byok-list .byok-row", { hasText: "Acme" });
      await acme.waitFor();
      await rec.until(() => sent.adds.length > 0, 3000);
      rec.check("adding a preset opens its key field", (await acme.locator("input[type=password]").count()) === 1 && sent.adds[0]?.preset === "acme");
      await acme.locator("input[type=password]").fill(FAKE_KEY);
      await acme.locator("button", { hasText: "保存" }).click();
      await rec.until(() => sent.keys.length === 1, 3000);
      rec.check("saving posts the key to that provider only", sent.keys[0]?.id === "acme" && sent.keys[0]?.apiKey === FAKE_KEY);
      await sleep(400);
      const leaked = await page.evaluate((k) => document.body.innerText.includes(k) || [...document.querySelectorAll("input")].some((i) => i.value.includes(k)), FAKE_KEY);
      rec.check("the key is never shown again after saving", !leaked);
      rec.check("the provider is now marked configured", (await page.locator("#byok-list .byok-row", { hasText: "Acme" }).locator(".byok-dot.is-on").count()) === 1);
      await page.click("#btn-add-custom-provider");
      await page.fill("#custom-id", "verify-gw");
      await page.fill("#custom-name", "Verify Gateway");
      await page.fill("#custom-base", "https://gw.verify.example/v1");
      await page.fill("#custom-models", "m-1, m-2");
      await page.fill("#custom-key", FAKE_KEY);
      await page.locator("#custom-provider-form button[type=submit]").click();
      await page.locator("#byok-list .byok-row", { hasText: "Verify Gateway" }).waitFor({ timeout: 5000 });
      rec.check("a custom provider is added with the 自定义 tag", (await page.locator("#byok-list .byok-row", { hasText: "Verify Gateway" }).locator(".byok-tag").count()) === 1 && JSON.stringify(sent.adds.at(-1).models) === JSON.stringify(["m-1", "m-2"]));
      await page.locator("#byok-list .byok-row", { hasText: "Acme" }).locator("button", { hasText: "删除" }).click();
      await rec.until(() => sent.deletes.includes("provider:acme"), 3000);
      rec.check("删除 on a user-added provider removes the provider", sent.deletes.includes("provider:acme") && (await rec.until(async () => (await page.locator("#byok-list .byok-row", { hasText: "Acme" }).count()) === 0, 3000)), sent.deletes.join(","));
      await page.locator("#byok-list .byok-row", { hasText: "Local" }).locator("button", { hasText: "删除" }).click();
      await rec.until(() => sent.deletes.includes("test"), 3000);
      rec.check("删除 on a built-in provider removes only its stored key", sent.deletes.includes("test") && (await rec.until(async () => (await page.locator("#byok-list .byok-row", { hasText: "Local" }).locator(".byok-dot.is-on").count()) === 0, 3000)), sent.deletes.join(","));
      await rec.shot(page, "01-models");

      // subscription login
      await page.click('[data-settings-pane="oauth"]');
      const row = page.locator("#provider-list .provider-row", { hasText: "Sub 订阅" });
      await row.waitFor();
      rec.check("a subscription provider shows 未登录 and 账号登录", (await row.locator(".provider-badge").innerText()) === "未登录" && (await row.locator("button", { hasText: "账号登录" }).count()) === 1);
      await row.locator("button", { hasText: "账号登录" }).click();
      await row.locator("input[type=text]").waitFor();
      rec.check("a code challenge shows an input with the provider's message", /验证码/.test(await row.locator(".provider-status").innerText()));
      await row.locator("input[type=text]").fill("123456");
      await row.locator("button", { hasText: "继续" }).click();
      await rec.until(() => sent.oauth.includes("complete"), 3000);
      await page.locator("#provider-list .provider-row", { hasText: "Sub 订阅" }).locator(".provider-badge.is-on").waitFor({ timeout: 5000 });
      rec.check("completing the challenge marks it signed in", /已登录/.test(await page.locator("#provider-list .provider-row", { hasText: "Sub 订阅" }).locator(".provider-badge").innerText()));
      await rec.shot(page, "02-oauth");

      // tool endpoints: 接口格式 presets + 自定义模板, saved through the same PUT
      await page.click('[data-settings-pane="tools"]');
      const searchPresets = await page.$$eval("#search-preset option", (n) => n.map((x) => x.value));
      const imagePresets = await page.$$eval("#image-preset option", (n) => n.map((x) => x.value));
      rec.check("the search format select lists vendors + template", searchPresets.join(",") === "generic,pixabay,pexels,unsplash,bing,template", searchPresets.join(","));
      rec.check("the image format select lists vendors + template", imagePresets.join(",") === "openai,dashscope-sync,dashscope-task,gemini-imagen,stability,template", imagePresets.join(","));
      rec.check("template fields stay hidden until 自定义模板", (await page.locator("#search-tpl").isHidden()) && (await page.locator("#image-tpl").isHidden()));
      await page.selectOption("#search-preset", "template");
      rec.check("自定义模板 expands the search template fields", await page.locator("#search-tpl").isVisible());
      await page.selectOption("#search-preset", "generic");
      rec.check("a named preset collapses the template fields", await page.locator("#search-tpl").isHidden());
      await page.fill("#search-url", "https://search.verify.example");
      await page.fill("#search-key", FAKE_KEY);
      await page.fill("#image-url", "https://img.verify.example/v1");
      await page.fill("#image-model", "img-model-1");
      await page.click("#btn-settings-save");
      await page.waitForFunction(() => document.getElementById("settings-status")?.textContent === "已保存", null, { timeout: 5000 });
      rec.check("saving PUTs both endpoints with their presets", sent.tools[0]?.imageSearch?.url === "https://search.verify.example" && sent.tools[0]?.imageSearch?.preset === "generic" && sent.tools[0]?.imageGenerate?.model === "img-model-1" && sent.tools[0]?.imageGenerate?.preset === "openai");
      rec.check("the key field empties and says a key is stored", (await page.inputValue("#search-key")) === "" && /已保存/.test((await page.getAttribute("#search-key", "placeholder")) ?? ""), await page.getAttribute("#search-key", "placeholder"));
      // custom template config: method/path land in the PUT body
      await page.selectOption("#search-preset", "template");
      await page.fill("#search-tpl-method", "GET");
      await page.fill("#search-tpl-path", "hits.0.url");
      await page.fill("#search-tpl-headers", "{not json");
      await page.click("#btn-settings-save");
      rec.check("invalid template headers are refused before the PUT", sent.tools.length === 1 && /请求头不是合法 JSON/.test(await page.locator("#settings-status").innerText()));
      await page.fill("#search-tpl-headers", "");
      await page.click("#btn-settings-save");
      await page.waitForFunction(() => document.getElementById("settings-status")?.textContent === "已保存", null, { timeout: 5000 });
      rec.check("a template config PUTs preset + template", sent.tools[1]?.imageSearch?.preset === "template" && sent.tools[1]?.imageSearch?.template?.method === "GET" && sent.tools[1]?.imageSearch?.template?.imagePath === "hits.0.url", JSON.stringify(sent.tools[1]?.imageSearch));
      await page.fill("#search-url", "");
      await page.click("#btn-settings-save");
      await rec.until(() => sent.tools.length === 3, 3000);
      rec.check("clearing a URL switches that service off", sent.tools[2]?.imageSearch?.kind === "off");

      // appearance
      await page.click('[data-settings-pane="appearance"]');
      const options = await page.$$eval("#theme-options [role=radio]", (n) => n.map((x) => `${x.dataset.themeId}:${x.getAttribute("aria-checked")}`));
      rec.check("two themes, 暖调 selected by default", JSON.stringify(options) === JSON.stringify(["warm:true", "ink:false"]), options.join(","));
      await rec.shot(page, "03-theme-warm");
      await page.click('[data-theme-id="ink"]');
      rec.check("choosing 水墨 sets data-theme and remembers it", (await page.evaluate(() => document.documentElement.dataset.theme)) === "ink" && (await page.evaluate(() => localStorage.getItem("oss.theme"))) === "ink");
      rec.check("the radio state follows", (await page.locator('[data-theme-id="ink"]').getAttribute("aria-checked")) === "true");
      await rec.shot(page, "04-theme-ink");
      await page.reload({ waitUntil: "domcontentloaded" });
      rec.check("the theme is applied before first paint after a reload", (await page.evaluate(() => document.documentElement.dataset.theme)) === "ink");

      // the editor honours the same choice
      const deck = ctx.deck("hub-settings-theme");
      const editor = await newPage(ctx, rec);
      await editor.addInitScript(() => localStorage.setItem("oss.theme", "ink"));
      await openEditor(editor, ctx, deck);
      rec.check("the editor opens in the same theme", (await editor.evaluate(() => document.documentElement.dataset.theme)) === "ink");
      await rec.shot(editor, "05-editor-ink");
      await editor.__context.close();

      await page.click("#btn-settings");
      await page.click('[data-settings-pane="appearance"]');
      await page.click('[data-theme-id="warm"]');
      rec.check("choosing 暖调 removes the attribute and the stored value", (await page.evaluate(() => document.documentElement.dataset.theme)) === undefined && (await page.evaluate(() => localStorage.getItem("oss.theme"))) === null);
      await page.click("#btn-settings-back");
      rec.check("back returns to the Hub", await visible(page, "#home-screen"));
      const anyKey = JSON.stringify(rec.commands) + (await page.evaluate(() => document.documentElement.outerHTML));
      rec.check("no key value is anywhere in the page", !anyKey.includes(FAKE_KEY));
      await page.__context.close();
    },
  },
];
