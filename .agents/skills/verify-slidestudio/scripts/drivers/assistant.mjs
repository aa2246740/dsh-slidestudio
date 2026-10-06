// assistant-panel, assistant-chat-turn, assistant-questions, generation-live, assistant-attachments, assistant-model
//
// Everything here runs against a fake DSH session at the outer provider boundary (lib.fakeSession).
// Replies are canned strings the driver wrote; none of this proves model quality or a real generation.
import fs from "node:fs";
import path from "node:path";
import { REPO, fakeSession, newPage, openEditor, readManifest, manifestPath, editorUrl, sleep } from "../lib.mjs";

const input = (page) => page.locator("#work-brief");
const thread = (page) => page.locator("#editor-generation-event-list");
const sessionUrl = "&workspace=1";
// The stubbed /events stream is aborted on purpose (no live kernel), and the failure paths answer 5xx by design.
const stubNoise = [/ERR_FAILED/, /status of 5\d\d/];

async function boundSession(ctx, rec, name, { viewport, extra = sessionUrl, busy = false, phase = "complete", events } = {}) {
  const deck = ctx.deck(name);
  const page = await newPage(ctx, rec, viewport);
  const s = await fakeSession(page, { project: deck, pagePaths: readManifest(deck).pages, pageCount: readManifest(deck).pages.length });
  s.busy = busy;
  s.phase = phase;
  if (events) s.current.events.push(...events);
  await openEditor(page, ctx, deck, extra);
  return { deck, page, s };
}

export const features = [
  {
    id: "assistant-panel",
    title: "AI panel: open/close, suggestion chips, one morphing send/stop button, no-session send",
    ignoreErrors: stubNoise,
    async run(ctx, rec) {
      const deck = ctx.deck("assistant-panel");
      const page = await newPage(ctx, rec);
      const intents = [];
      page.on("request", (r) => {
        if (r.url().endsWith("/slides/assistant-intent")) intents.push(r.url());
      });
      await openEditor(page, ctx, deck, "&workspace=1");
      rec.check("the panel is open by default", await page.locator("#work-chat").isVisible());
      rec.check("an empty conversation shows suggestions", await page.locator("#work-empty").isVisible() && (await page.locator("#work-empty [data-agent-prompt]").count()) === 3);
      await rec.shot(page, "01-open");
      await page.click("#chat-close");
      await sleep(250);
      rec.check("× hides the panel", await page.locator("#work-chat").isHidden());
      rec.check("the AI button reports it collapsed", (await page.locator("#btn-sparkles").getAttribute("aria-expanded")) === "false");
      await page.click("#btn-sparkles");
      await sleep(250);
      rec.check("the AI button reopens it with focus in the composer", (await page.locator("#work-chat").isVisible()) && (await input(page).evaluate((n) => n === document.activeElement)));
      const chip = page.locator("#work-empty [data-agent-prompt]").first();
      const chipPrompt = await chip.getAttribute("data-agent-prompt");
      await chip.click();
      rec.check("a chip fills the composer with its prompt, without sending", (await input(page).inputValue()) === chipPrompt && intents.length === 0, await input(page).inputValue());

      // Enter with no AI session bound to this deck: the message stays and the reason is said out loud
      await input(page).fill("你好，随便聊聊");
      await input(page).press("Enter");
      await rec.until(() => page.evaluate(() => /没有 AI 对话记录/.test(document.body.innerText)), 5000);
      const visible = await page.evaluate(() => document.body.innerText.match(/这份文稿没有 AI 对话记录[^\n]*/)?.[0] ?? "");
      rec.check("sending with no AI session says why nothing was started and what still works", /没有 AI 对话记录/.test(visible) && /手动编辑/.test(visible), visible || "(nothing shown)");
      rec.check("the typed message is not lost", (await input(page).inputValue()) === "你好，随便聊聊" || (await thread(page).innerText()).includes("你好，随便聊聊"));
      await rec.shot(page, "02-no-session-send");
      await page.__context.close();

      // Live session: the send control morphs into stop and back
      const { page: live, s } = await boundSession(ctx, rec, "assistant-panel-live", { extra: `${sessionUrl}&live=1&session=verify-session`, busy: true, phase: "generating" });
      await live.waitForFunction(() => document.querySelector("#work-form .composer-send")?.classList.contains("is-stopping"));
      rec.check("while generating and empty the button is the stop square", (await live.locator("#work-form .composer-send").getAttribute("data-control")) === "chrome.workspace.stop");
      rec.check("there is exactly one submit control", (await live.locator("#work-form .composer-send").count()) === 1);
      await input(live).fill("补充一句");
      await sleep(200);
      rec.check("typing turns it back into send (steer)", !(await live.locator("#work-form .composer-send").evaluate((n) => n.classList.contains("is-stopping"))));
      await input(live).fill("");
      await sleep(200);
      rec.check("clearing the text restores stop", await live.locator("#work-form .composer-send").evaluate((n) => n.classList.contains("is-stopping")));
      // Real regression: the live CSS used to hide the only reopen button.
      await live.click("#chat-close");
      rec.check("live × hides the panel but keeps its reopen button", await live.locator("#work-chat").isHidden() && await live.locator("#btn-sparkles").isVisible());
      await live.click("#btn-sparkles");
      await input(live).press("Escape");
      rec.check("live Escape can be recovered without navigating away", await live.locator("#work-chat").isHidden() && await live.locator("#btn-sparkles").isVisible());
      await rec.shot(live, "03-live-panel-collapsed");
      await live.click("#btn-sparkles");
      rec.check("reopened live panel retains the stop control", await live.locator("#work-chat").isVisible() && (await live.locator("#work-form .composer-send").getAttribute("data-control")) === "chrome.workspace.stop");
      rec.check("live export stays unavailable", await live.locator("#btn-export").isHidden());
      await live.click("#work-form .composer-send");
      await rec.until(() => s.stops.length > 0, 5000);
      rec.check("stop remains usable after reopening the panel", s.stops.length === 1);
      await rec.shot(live, "04-live-stop-after-reopen");
      await live.__context.close();

      // Fresh generation has no slide, so its canvas allowlist is empty.
      const emptyDeck = ctx.deck("assistant-before-first-slide");
      const emptyManifest = readManifest(emptyDeck);
      fs.writeFileSync(manifestPath(emptyDeck), JSON.stringify({ ...emptyManifest, pages: [] }));
      const empty = await newPage(ctx, rec);
      const initial = await fakeSession(empty, { project: emptyDeck, pageCount: 0, pagePaths: [] });
      initial.busy = true;
      initial.phase = "generating";
      await empty.goto(editorUrl(ctx, emptyDeck, `${sessionUrl}&live=1&session=verify-session`));
      await empty.waitForFunction(() => document.querySelector("#work-form .composer-send")?.classList.contains("is-stopping"));
      await empty.click("#chat-close");
      rec.check("before the first slide the reopen button is visible and enabled", await empty.locator("#btn-sparkles").isVisible() && await empty.locator("#btn-sparkles").isEnabled());
      await empty.click("#btn-sparkles");
      await empty.click("#work-form .composer-send");
      rec.check("before the first slide closing the panel does not lose Stop", await rec.until(() => initial.stops.length === 1));
      await rec.shot(empty, "05-before-first-slide");
      await empty.__context.close();
    },
  },

  {
    id: "assistant-chat-turn",
    title: "Chat turn: send, clear draft, reply appears, IME/newline, failure keeps input + retry, reload keeps history",
    ignoreErrors: stubNoise,
    async run(ctx, rec) {
      const { page, s } = await boundSession(ctx, rec, "assistant-chat-turn");
      s.onTurn = () => {
        s.phase = "discussion";
      };
      await page.waitForSelector("#work-brief");
      await input(page).fill("中文候选确认");
      await input(page).dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: false, bubbles: true, cancelable: true });
      await input(page).dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
      await sleep(400);
      rec.check("Enter during IME composition does not send", s.plans.length === 0);
      await input(page).fill("第一行");
      await input(page).press("Shift+Enter");
      await page.keyboard.type("第二行");
      rec.check("Shift+Enter inserts a newline", /第一行\n第二行/.test(await input(page).inputValue()));
      await input(page).fill("先给我一些建议");
      await input(page).press("Enter");
      await page.waitForFunction(() => document.getElementById("editor-generation-event-list")?.textContent.includes("回复 1"), null, { timeout: 8000 });
      rec.check("the draft clears once the request is accepted", (await input(page).inputValue()) === "");
      rec.check("the user's message is in the thread", (await thread(page).innerText()).includes("先给我一些建议"));
      rec.check("the reply is rendered (bold markdown)", (await thread(page).locator(".md-body strong").count()) >= 1);
      rec.check("intent was read once, turn posted once", s.plans.length === 1 && s.turns.length === 1, `${s.plans.length}/${s.turns.length}`);
      rec.check("a discussion turn carries no edit authorization", s.turns[0].conversationMode === "discuss" && !s.turns[0].editorEdit, JSON.stringify(Object.keys(s.turns[0])));
      // The panel status follows the session phase the kernel reports after the turn.
      await page.waitForFunction(() => document.getElementById("editor-generation-status")?.textContent === "继续聊聊", null, { timeout: 6000 }).catch(() => {});
      rec.check("status reads 继续聊聊 while the session sits in discussion", (await page.locator("#editor-generation-status").innerText()) === "继续聊聊", await page.locator("#editor-generation-status").innerText());
      await rec.shot(page, "01-after-turn");

      // failure keeps the message, offers retry, and does not eat a newer draft
      s.intentFail = "模型暂时不可用，输入内容已保留。";
      await input(page).fill("第二个问题");
      await input(page).press("Enter");
      await page.waitForFunction(() => document.getElementById("editor-generation-event-list")?.textContent.includes("模型暂时不可用"), null, { timeout: 8000 });
      rec.check("a failed request shows the cause in the thread", true);
      await input(page).fill("失败后写的新草稿");
      s.intentFail = null;
      await page.locator(".assistant-reply-actions button", { hasText: "重试" }).click();
      await page.waitForFunction(() => document.getElementById("editor-generation-event-list")?.textContent.includes("回复 2"), null, { timeout: 8000 });
      rec.check("retry re-sends and succeeds", s.turns.length === 2, s.turns.length);
      rec.check("retry left the newer draft alone", (await input(page).inputValue()) === "失败后写的新草稿", await input(page).inputValue());

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.getElementById("editor-generation-event-list")?.textContent.includes("回复 2"), null, { timeout: 8000 });
      rec.check("history is restored after a reload", (await thread(page).innerText()).includes("先给我一些建议"));
      await page.__context.close();
    },
  },

  {
    id: "assistant-questions",
    title: "Agent questions in the chat: paged cards, recommendations, skip, validation, retry, cancel",
    ignoreErrors: stubNoise,
    async run(ctx, rec) {
      const { page, s } = await boundSession(ctx, rec, "assistant-questions", { busy: true, phase: "discussing" });
      const now = () => new Date().toISOString();
      s.questions.push({
        id: "q1",
        at: now(),
        status: "pending",
        questions: [
          { id: "scope", header: "业务范围", question: "这份报告主要覆盖哪类业务？", options: [{ label: "互联网产品（推荐）", description: "DAU、留存、收入。" }, { label: "电商零售" }] },
          { id: "data", question: "没有真实数据时怎么出稿？", options: [{ label: "示意数据（推荐）" }, { label: "只留占位" }] },
          { id: "pages", question: "大概多少页？" },
        ],
      });
      const card = page.locator(".assistant-question-card").last();
      await card.waitFor({ timeout: 8000 });
      rec.check("the question sits in the chat, not a modal", (await page.locator("#editor-generation-event-list .assistant-question-card").count()) === 1 && (await page.locator("dialog[open]").count()) === 0);
      rec.check("it shows 问题 1/3 and one question at a time", (await card.getByText("问题 1/3", { exact: false }).count()) >= 1 && (await card.locator(".assistant-question-title").count()) === 1);
      rec.check("推荐 is a badge, not part of the label", (await card.getByText("推荐", { exact: true }).count()) === 1);
      rec.check("only the last page has 提交", (await card.getByRole("button", { name: "提交", exact: true }).count()) === 0);
      await rec.shot(page, "01-paged");
      await card.getByRole("radio", { name: "互联网产品", exact: true }).click();
      await card.getByText("问题 2/3").waitFor();
      rec.check("choosing an option on a single-choice page advances", true);
      await card.getByRole("button", { name: "上一题", exact: true }).click();
      await card.getByText("问题 1/3", { exact: false }).first().waitFor();
      rec.check("going back keeps the choice", (await card.getByRole("radio", { name: "互联网产品", exact: true }).getAttribute("aria-checked")) === "true");
      await card.getByRole("button", { name: "下一题", exact: true }).last().click();
      await card.getByText("问题 2/3").waitFor();
      await card.getByRole("button", { name: "跳过本题", exact: true }).click();
      await card.getByText("问题 3/3").waitFor();
      await card.getByRole("button", { name: "提交", exact: true }).click();
      rec.check("submitting with nothing answered on the last page is refused", (await card.getByText("请选择一个选项或填写自定义答案。").count()) >= 1);
      s.answerFail = "连接中断，请重试";
      await card.getByRole("textbox").fill("8 页");
      await card.getByRole("button", { name: "提交", exact: true }).click();
      await card.getByText("连接中断，请重试").waitFor({ timeout: 5000 });
      rec.check("a failed submit shows the reason and keeps the answer", (await card.getByRole("textbox").inputValue()) === "8 页");
      await card.getByRole("button", { name: "提交", exact: true }).click();
      await card.locator(".assistant-question-answer").first().waitFor({ timeout: 8000 });
      rec.check("the answers posted are exactly what was chosen", JSON.stringify(s.answers.at(-1)?.answer) === JSON.stringify({ answers: [{ id: "scope", selected: ["互联网产品（推荐）"] }, { id: "data", selected: [] }, { id: "pages", selected: [], custom: "8 页" }] }), JSON.stringify(s.answers.at(-1)?.answer));
      rec.check("the settled card becomes a question→answer summary", /互联网产品[\s\S]*已跳过[\s\S]*8 页/.test(await card.innerText()), (await card.innerText()).replace(/\s+/g, " ").slice(0, 200));
      await rec.shot(page, "02-settled");

      s.questions.push({ id: "q2", at: now(), status: "pending", questions: [{ id: "cancel", question: "要取消这个问题吗？" }] });
      const c2 = page.locator(".assistant-question-card").last();
      await c2.getByRole("button", { name: "放弃整组问题", exact: true }).waitFor({ timeout: 8000 });
      await c2.getByRole("button", { name: "放弃整组问题", exact: true }).click();
      await c2.getByText("已取消", { exact: true }).waitFor({ timeout: 5000 });
      rec.check("放弃整组问题 posts a cancel, not an answer", s.answers.at(-1)?.action === "cancel", JSON.stringify(s.answers.at(-1)));
      await page.__context.close();
    },
  },

  {
    id: "generation-live",
    title: "Live generation: steer, stop, new instruction, held draft during a composer-started turn",
    ignoreErrors: stubNoise,
    async run(ctx, rec) {
      const events = [
        { id: "r1", turn: 1, at: new Date().toISOString(), kind: "reasoning", detail: "先读取参考资料。", status: "complete" },
        { id: "t1", turn: 1, at: new Date().toISOString(), kind: "tool", callId: "t1", name: "read_reference", detail: '{"sourceId":"x"}', status: "running" },
      ];
      const { page, s } = await boundSession(ctx, rec, "generation-live", { extra: `${sessionUrl}&live=1&session=verify-session`, busy: true, phase: "generating", events });
      s.intent = { intent: "generate", scope: "deck", pages: [] };
      s.onTurn = () => {
        s.busy = true;
        s.phase = "generating";
      };
      const send = page.locator("#work-form .composer-send");
      await page.waitForFunction(() => document.querySelector("#work-form .composer-send")?.classList.contains("is-stopping"));
      rec.check("the live panel is locked and shows progress rows", (await page.locator("#work-chat.is-live-generation").count()) === 1 && (await thread(page).innerText()).length > 0);
      await rec.shot(page, "01-running");

      // A run that was not started from this composer takes typed text as a steer.
      await input(page).fill("先把封面做出来");
      await input(page).press("Enter");
      await rec.until(() => s.turns.length === 1, 5000);
      rec.check("text typed during a live run is posted as steer", s.turns[0]?.steer === true && s.turns[0]?.text === "先把封面做出来", JSON.stringify(s.turns[0] ?? {}).slice(0, 200));
      rec.check("a steer skips the intent read", s.plans.length === 0, s.plans.length);
      rec.check("the draft is cleared once the steer is accepted", await rec.until(async () => (await input(page).inputValue()) === "", 3000));

      // Empty composer = stop.
      const t0 = Date.now();
      await send.click();
      await page.waitForFunction(() => {
        const b = document.querySelector("#work-form .composer-send");
        return !b.classList.contains("is-stopping") && !b.disabled;
      }, null, { timeout: 5000 });
      rec.check("stop is confirmed within seconds", Date.now() - t0 < 5000, `${Date.now() - t0}ms`);
      rec.check("exactly one stop request, typed JSON", s.stops.length === 1 && /application\/json/.test(s.stops[0]), JSON.stringify(s.stops));
      rec.check("no lingering 正在思考 after a confirmed stop", !(await page.locator("#generation-think-status").isVisible()));
      await rec.shot(page, "02-stopped");

      const resume = page.locator("#editor-generation-resume");
      if (await resume.isVisible().catch(() => false)) {
        rec.check("a paused run offers 继续完成生成", /继续/.test(await resume.innerText()), await resume.innerText());
      } else rec.note("the resume row was not visible after stop (run not in a resumable state)");

      // A new instruction after the stop goes through the intent read and becomes a generate turn.
      await input(page).fill("方向不对，改成电商零售的月报");
      await input(page).press("Enter");
      await rec.until(() => s.turns.length === 2, 6000);
      rec.check("the new instruction reaches the same session", JSON.stringify(s.turns[1] ?? {}).includes("电商零售"), JSON.stringify(s.turns[1] ?? {}).slice(0, 160));
      rec.check("a fresh instruction is a generate turn after one intent read", s.turns[1]?.conversationMode === "generate" && s.plans.length === 1, `${s.turns[1]?.conversationMode}/${s.plans.length}`);

      // While that composer-started turn is still running, typed text is held, not steered.
      await page.waitForFunction(() => document.getElementById("work-chat")?.classList.contains("is-live-generation"), null, { timeout: 10000 });
      await input(page).fill("再加一页价格对比");
      await input(page).press("Enter");
      await sleep(600);
      rec.check("typing during a composer-started turn keeps the draft and says so", (await input(page).inputValue()) === "再加一页价格对比" && /完成后可以继续发送/.test(await page.locator("#app-toast").innerText().catch(() => "")), await page.locator("#app-toast").innerText().catch(() => ""));
      rec.check("no extra turn was posted for the held text", s.turns.length === 2, s.turns.length);
      await rec.shot(page, "03-held-draft");
      await page.__context.close();
    },
  },

  {
    id: "assistant-attachments",
    title: "Composer attachments: upload, list, survive reload, remove, refuse unsupported types",
    async run(ctx, rec) {
      const deck = ctx.deck("assistant-attachments");
      const page = await newPage(ctx, rec);
      await openEditor(page, ctx, deck, "&workspace=1");
      const dir = path.join(REPO, "output/attachments");
      const before = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
      let id = null;
      try {
        await page.setInputFiles("#agent-attachment-file", { name: "verify-brief.txt", mimeType: "text/plain", buffer: Buffer.from("VERIFY attachment 内容\n第二行") });
        await page.waitForSelector(".agent-attachment-chip", { timeout: 8000 });
        const chip = page.locator(".agent-attachment-chip").first();
        id = await chip.getAttribute("data-attachment-id");
        rec.check("a chip named after the file appears", (await chip.innerText()).includes("verify-brief.txt"), await chip.innerText());
        const rec1 = await (await fetch(`${ctx.base}/api/attachments/${id}`)).json();
        rec.check("the server parsed it", rec1.parsed === true || rec1.attachment?.parsed === true || JSON.stringify(rec1).includes("VERIFY attachment"), JSON.stringify(rec1).slice(0, 160));
        await rec.shot(page, "01-attached");
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#slide .el[data-id]");
        await sleep(600);
        rec.check("the chip survives a reload", (await page.locator(".agent-attachment-chip").count()) === 1);
        await page.locator(".agent-attachment-chip button").first().click();
        await sleep(600);
        rec.check("× removes the chip", (await page.locator(".agent-attachment-chip").count()) === 0);
        rec.check("removal deletes it on the server", (await fetch(`${ctx.base}/api/attachments/${id}`)).status === 404, (await fetch(`${ctx.base}/api/attachments/${id}`)).status);
        id = null;
        await page.setInputFiles("#agent-attachment-file", { name: "pic.png", mimeType: "image/png", buffer: Buffer.from("not really a png") });
        await sleep(800);
        const toast = await page.locator("#app-toast").innerText().catch(() => "");
        rec.check("an unsupported type is refused with a visible reason", (await page.locator(".agent-attachment-chip").count()) === 0 && /附件|不支持|失败/.test(toast), toast || "(no toast)");
      } finally {
        if (id) await fetch(`${ctx.base}/api/attachments/${id}`, { method: "DELETE" }).catch(() => {});
        const after = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        for (const f of after) if (!before.has(f)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      }
      await page.__context.close();
    },
    ignoreErrors: [/status of 4\d\d/],
  },

  {
    id: "assistant-model",
    title: "Model picker: roster from the kernel, selection travels with the turn, persists on the session",
    ignoreErrors: stubNoise,
    async run(ctx, rec) {
      // no session: the neutral default
      const deck = ctx.deck("assistant-model-none");
      const bare = await newPage(ctx, rec);
      await openEditor(bare, ctx, deck, "&workspace=1");
      const opts0 = await bare.$$eval("#assistant-model option", (o) => o.map((x) => x.textContent.trim()));
      rec.check("with no session the picker holds the neutral 当前模型", opts0.length >= 1 && opts0[0] === "当前模型", opts0.join("|"));
      await bare.__context.close();

      const { page, s } = await boundSession(ctx, rec, "assistant-model");
      await page.waitForFunction(() => document.querySelector("#assistant-model")?.options.length === 2, null, { timeout: 8000 });
      const opts = await page.$$eval("#assistant-model option", (o) => o.map((x) => x.value));
      rec.check("the roster lists the ready provider's models", JSON.stringify(opts) === JSON.stringify(["test/model-a", "test/model-b"]), opts.join("|"));
      rec.check("the session's own model is preselected", (await page.locator("#assistant-model").inputValue()) === "test/model-a");
      await page.selectOption("#assistant-model", "test/model-b");
      s.onTurn = () => {
        s.current.provider = { providerId: "test", modelId: "model-b" };
      };
      await input(page).fill("用另一个模型回答");
      await input(page).press("Enter");
      for (let i = 0; i < 60 && !s.turns.length; i++) await sleep(100);
      rec.check("the turn carries modelSelection for the chosen model", JSON.stringify(s.turns[0]?.modelSelection) === JSON.stringify({ provider: "test", model: "model-b" }), JSON.stringify(s.turns[0]?.modelSelection));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("#assistant-model")?.options.length === 2, null, { timeout: 8000 });
      rec.check("after reload the picker shows the session's model", (await page.locator("#assistant-model").inputValue()) === "test/model-b", await page.locator("#assistant-model").inputValue());
      await rec.shot(page, "01-picker");
      await page.__context.close();
    },
  },
];
