import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { launchPinnedChromium } from "../../../scripts/lib/pinned-playwright.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("native question cards stay in chat through polling, errors, reload, selection and custom answers", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "slides-questions-dom-"));
  const project = path.join(scratch, "project");
  fs.cpSync(path.join(ROOT, "fixtures/okp-yu7-ppt"), project, { recursive: true });
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const server = spawn(process.execPath, ["apps/native-web/src/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), OPEN_SLIDESTUDIO_PROJECT: project, SLIDESTUDIO_RETENTION_DAYS: "0" },
    stdio: "ignore",
  });
  const out =
    process.env.SLIDESTUDIO_QA_OUTPUT_DIR || path.join(ROOT, "output/assistant-questions-acceptance-2026-09-20");
  fs.mkdirSync(out, { recursive: true });
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    browser = await launchPinnedChromium({ headless: true });
    const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1440, height: 900 } });
    const errors = [],
      answers = [],
      metrics = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let fail = true;
    const rows = [
      {
        id: "q1",
        at: new Date().toISOString(),
        status: "pending",
        questions: [
          {
            id: "color",
            question: "希望使用哪种深色背景？",
            options: [
              { label: "深蓝", description: "保持冷静、清晰的观感。" },
              { label: "深紫", description: "更有表现力。" },
            ],
          },
        ],
      },
    ];
    const activity = {
      ok: true,
      sessionId: "question-test",
      brief: "换一套深色配色，请先让我选",
      phase: "discussing",
      provider: { providerId: "test", modelId: "cheap" },
      project: { path: project, title: "Questions", pageCount: 2 },
      events: [],
      conversation: { version: 1, mode: "discuss", messages: [] },
    };
    await page.route("**/api/generation-activity**", (route) => route.fulfill({ json: activity }));
    await page.route("**/slides/providers", (route) =>
      route.fulfill({ json: { providers: [{ id: "test", ready: true, name: "Test", models: ["cheap"] }] } }),
    );
    await page.route("**/slides/state/question-test", (route) =>
      route.fulfill({ json: { agentStatus: "busy", questions: rows } }),
    );
    await page.route("**/slides/sessions/question-test/events", (route) => route.abort());
    await page.route("**/slides/sessions/question-test/questions/*", (route) => {
      if (fail) {
        fail = false;
        return route.fulfill({ status: 503, json: { ok: false, error: "连接中断，请重试" } });
      }
      const body = route.request().postDataJSON();
      answers.push(body);
      const row = rows.find((row) => route.request().url().endsWith(row.id));
      row.status = body.action === "answer" ? "answered" : "cancelled";
      row.answer = body.answer;
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto(`http://127.0.0.1:${port}/index.html?project=${encodeURIComponent(project)}&workspace=1`);
    const card = page.locator(".assistant-question-card");
    await card.waitFor();
    assert.equal(await page.locator("#editor-generation-event-list .assistant-question-card").count(), 1);
    assert.equal(await page.locator("dialog[open]").count(), 0);
    await page.getByRole("radio", { name: "深蓝", exact: true }).check();
    await card.getByRole("button", { name: "提交", exact: true }).click();
    await card.getByText("连接中断，请重试").waitFor();
    assert.equal(await page.getByRole("radio").first().isChecked(), true);
    await page.reload();
    await card.waitFor();
    assert.equal(
      await page.locator('.assistant-question-option[aria-checked="true"]').count(),
      0,
      "a reload never submits or restores a stale choice",
    );
    const input = page.getByLabel("与 AI 协作", { exact: true });
    await input.fill("等待回答时的新草稿");
    for (const width of [1440, 877, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const m = await page.evaluate(() => {
        const c = document.querySelector(".assistant-question-card"),
          list = document.getElementById("editor-generation-event-list");
        return {
          width: innerWidth,
          docWidth: document.documentElement.scrollWidth,
          cardWidth: c.clientWidth,
          cardScroll: c.scrollWidth,
          listWidth: list.clientWidth,
          listScroll: list.scrollWidth,
        };
      });
      assert.ok(m.docWidth <= width + 1, JSON.stringify(m));
      assert.ok(m.cardScroll <= m.cardWidth + 1, JSON.stringify(m));
      assert.ok(m.listScroll <= m.listWidth + 1, JSON.stringify(m));
      metrics.push(m);
      await page.screenshot({ path: path.join(out, `question-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("radio").first().check();
    await card.getByRole("button", { name: "提交", exact: true }).click();
    await card.locator(".assistant-question-answer").waitFor();
    assert.deepEqual(answers[0].answer, { answers: [{ id: "color", selected: ["深蓝"] }] });
    assert.equal(await input.inputValue(), "等待回答时的新草稿");
    rows.push({
      id: "q2",
      at: new Date().toISOString(),
      status: "pending",
      questions: [
        {
          id: "extras",
          question: "保留哪些细节？",
          multiSelect: true,
          options: [{ label: "页码" }, { label: "分隔线" }],
        },
      ],
    });
    const next = card.last();
    await next.getByRole("checkbox").first().waitFor();
    await next.getByRole("checkbox").first().check();
    await next.getByRole("checkbox").last().check();
    await next.getByRole("textbox").fill("统一使用灰蓝色");
    await next.getByRole("button", { name: "提交", exact: true }).click();
    await next.locator(".assistant-question-answer").waitFor();
    assert.deepEqual(answers[1].answer.answers[0], {
      id: "extras",
      selected: ["页码", "分隔线"],
      custom: "统一使用灰蓝色",
    });
    rows.push({
      id: "q3",
      at: new Date().toISOString(),
      status: "pending",
      questions: [{ id: "free", question: "补充一个要求" }],
    });
    await card.last().getByRole("textbox").waitFor();
    await input.fill("正文使用冷白色");
    await input.press("Enter");
    await card.last().locator(".assistant-question-answer").waitFor();
    assert.equal(answers[2].answer.answers[0].custom, "正文使用冷白色");
    assert.equal(await input.inputValue(), "");
    rows.push({
      id: "q4",
      at: new Date().toISOString(),
      status: "pending",
      questions: [{ id: "cancel", question: "要取消这个问题吗？" }],
    });
    await card.last().getByRole("button", { name: "放弃整组问题", exact: true }).waitFor();
    await card.last().getByRole("button", { name: "放弃整组问题", exact: true }).click();
    await card.last().getByText("已取消", { exact: true }).waitFor();
    assert.equal(answers[3].action, "cancel");
    // A set of questions is answered one page at a time (DeepSeek Harness QuestionFlow).
    rows.push({
      id: "q5",
      at: new Date().toISOString(),
      status: "pending",
      questions: [
        {
          id: "scope",
          header: "业务范围",
          question: "这份报告主要覆盖哪类业务？",
          options: [{ label: "互联网产品（推荐）", description: "DAU、留存、收入。" }, { label: "电商零售" }],
        },
        {
          id: "data",
          question: "没有真实数据时怎么出稿？",
          options: [{ label: "示意数据（推荐）" }, { label: "只留占位" }],
        },
        { id: "pages", question: "大概多少页？" },
      ],
    });
    const set = card.last();
    await set.getByText("问题 1/3", { exact: false }).waitFor();
    assert.equal(await set.locator(".assistant-question-title").count(), 1, "only the current question is shown");
    assert.equal(
      await set.getByText("推荐", { exact: true }).count(),
      1,
      "recommendation is a badge, not part of the label",
    );
    assert.equal(await set.getByRole("button", { name: "提交", exact: true }).count(), 0, "only the last page submits");
    await set.getByRole("radio", { name: "互联网产品", exact: true }).click();
    await set.getByText("问题 2/3").waitFor();
    await set.getByRole("button", { name: "上一题", exact: true }).click();
    await set.getByText("问题 1/3", { exact: false }).waitFor();
    assert.equal(
      await set.getByRole("radio", { name: "互联网产品", exact: true }).getAttribute("aria-checked"),
      "true",
      "going back keeps the choice",
    );
    await set.getByRole("button", { name: "下一题", exact: true }).last().click();
    await set.getByText("问题 2/3").waitFor();
    await set.getByRole("button", { name: "跳过本题", exact: true }).click();
    await set.getByText("问题 3/3").waitFor();
    await set.getByRole("button", { name: "提交", exact: true }).click();
    await set.getByText("请选择一个选项或填写自定义答案。").waitFor();
    await set.getByRole("textbox").fill("8 页");
    await set.getByRole("button", { name: "提交", exact: true }).click();
    await set.locator(".assistant-question-answer").first().waitFor();
    assert.deepEqual(answers.at(-1).answer, {
      answers: [
        { id: "scope", selected: ["互联网产品（推荐）"] },
        { id: "data", selected: [] },
        { id: "pages", selected: [], custom: "8 页" },
      ],
    });
    assert.match(await set.innerText(), /互联网产品[\s\S]*已跳过[\s\S]*8 页/);
    await page.screenshot({ path: path.join(out, "question-paged-settled.png") });
    // Typing in the chat box answers the current question as a custom answer, options or not.
    rows.push({
      id: "q6",
      at: new Date().toISOString(),
      status: "pending",
      questions: [
        {
          id: "kind",
          header: "报告类型",
          question: "这份月度报告更偏向哪一类？",
          options: [{ label: "业务经营月报（推荐）" }, { label: "部门管理月报" }],
        },
      ],
    });
    await card.last().getByText("这份月度报告更偏向哪一类？").waitFor();
    await input.fill("我等下发给你");
    await input.press("Enter");
    await card.last().locator(".assistant-question-answer").waitFor();
    assert.deepEqual(answers.at(-1).answer, { answers: [{ id: "kind", selected: [], custom: "我等下发给你" }] });
    assert.equal(await input.inputValue(), "", "the answered text leaves the chat box");
    rows.push({
      id: "q7",
      at: new Date().toISOString(),
      status: "pending",
      questions: [
        { id: "a", question: "第一问？", options: [{ label: "甲" }, { label: "乙" }] },
        { id: "b", question: "第二问？" },
      ],
    });
    await card.last().getByText("第一问？").waitFor();
    await input.fill("都可以");
    await input.press("Enter");
    await card.last().getByText("第二问？").waitFor();
    assert.equal(await input.inputValue(), "", "a paged answer from the chat box moves to the next question");
    await input.fill("10 页");
    await input.press("Enter");
    await card.last().locator(".assistant-question-answer").first().waitFor();
    assert.deepEqual(answers.at(-1).answer, {
      answers: [
        { id: "a", selected: [], custom: "都可以" },
        { id: "b", selected: [], custom: "10 页" },
      ],
    });
    // Long pasted material arrives complete: no client-side clipping below the 8000-character answer limit.
    const outline = Array.from(
      { length: 220 },
      (_, i) => `第 ${i + 1} 行：零售账户达2.12亿户，同比增加1,307.02万户。`,
    ).join("\n");
    assert.ok(outline.length > 6000 && outline.length < 8000);
    rows.push({
      id: "q8",
      at: new Date().toISOString(),
      status: "pending",
      questions: [{ id: "outline", question: "请提供大纲", options: [{ label: "稍后提供" }] }],
    });
    await card.last().getByText("请提供大纲").waitFor();
    await input.fill(outline);
    await input.press("Enter");
    await card.last().locator(".assistant-question-answer").waitFor();
    assert.equal(answers.at(-1).answer.answers[0].custom, outline, "the whole pasted outline reaches the server");
    // Beyond the limit nothing is clipped: the answer is refused with a reason and the text stays.
    const sentBefore = answers.length;
    rows.push({
      id: "q9",
      at: new Date().toISOString(),
      status: "pending",
      questions: [{ id: "huge", question: "再提供一次大纲", options: [{ label: "稍后提供" }] }],
    });
    await card.last().getByText("再提供一次大纲").waitFor();
    const huge = "长".repeat(8500);
    await input.fill(huge);
    await input.press("Enter");
    await card
      .last()
      .getByText(/8500 字，超过 8000 字上限/)
      .waitFor();
    assert.equal(answers.length, sentBefore, "an over-long answer is not sent");
    assert.equal(await input.inputValue(), huge, "the over-long text is kept for editing, not cut");
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, "question-dom-proof.json"), JSON.stringify({ metrics, answers, errors }, null, 2));
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
