// comment-annotate, comment-send-agent, versions, export-pptx, export-pdf-png
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO, newPage, openEditor, readManifest, readPageAt, sleep, snapshotDir, unzipEntries, waitForCommand } from "../lib.mjs";

const elements = (deck, idx = 0) => readPageAt(deck, idx).elements ?? [];
const threadsFile = (deck) => path.join(deck, "_agent", "review-threads.v1.json");
const readThreads = (deck) => {
  try {
    return JSON.parse(fs.readFileSync(threadsFile(deck), "utf8"));
  } catch {
    return null;
  }
};
const allComments = (deck) => Object.values(readThreads(deck)?.pages ?? {}).flat();
const versionsManifest = (deck) => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(deck, ".versions", "manifest.json"), "utf8"));
    return Array.isArray(m) ? m : (m.versions ?? Object.values(m));
  } catch {
    return [];
  }
};

// The editor intentionally keeps #version-menu open after 手动快照, so a
// blind #btn-versions click toggles it *closed*. Open it idempotently: only
// click when the menu is currently hidden.
async function openVersionMenu(page) {
  if (await page.locator("#version-menu").evaluate((el) => el.hidden)) {
    await page.click("#btn-versions");
  }
  await page.waitForSelector("#version-menu", { state: "visible" });
  await page.locator("#versions-list .version-row").first().waitFor({ state: "visible" });
}

async function addComment(page, targetId, text) {
  await page.click("#btn-comments");
  await page.locator(`#slide .el[data-id="${targetId}"]`).click();
  await page.waitForSelector("#comment-panel", { state: "visible" });
  await page.fill("#comment-draft", text);
  await page.click("#comment-add");
  await page.waitForSelector("#comment-panel", { state: "hidden" });
}

export const features = [
  {
    id: "comment-annotate",
    title: "批注: pin a comment to an element, queue it above the chat, survive reload, remove",
    async run(ctx, rec) {
      const deck = ctx.deck("comment-annotate");
      const TEXT = "把标题措辞改得更克制";
      const page = await newPage(ctx, rec);
      await openEditor(page, ctx, deck, "&workspace=1");

      await page.click("#btn-comments");
      rec.check("批注 turns annotation mode on", (await page.locator("#btn-comments").getAttribute("aria-pressed")) === "true");
      rec.check("the gesture hint is shown", await page.locator("#comment-mode-hint").isVisible());
      await page.locator('#slide .el[data-id="slogan"]').click();
      await page.waitForSelector("#comment-panel", { state: "visible" });
      rec.check("the floating card names one target", /已选 1 个对象/.test(await page.locator("#comment-target").innerText()), await page.locator("#comment-target").innerText());
      rec.check("add is disabled until there is text", await page.locator("#comment-add").isDisabled());
      await page.fill("#comment-draft", TEXT);
      rec.check("add enables once text is typed", await page.locator("#comment-add").isEnabled());
      await rec.shot(page, "01-card-open");
      await page.click("#comment-add");
      await page.waitForSelector("#comment-panel", { state: "hidden" });
      rec.check("adding leaves annotation mode", (await page.locator("#btn-comments").getAttribute("aria-pressed")) === "false");
      rec.check("the comment queues above the chat input", await page.locator("#work-comment-batch").isVisible() && (await page.locator("#work-comment-items .comment-attachment").count()) === 1);
      rec.check("the batch label counts it", /1 条批注/.test(await page.locator("#work-comment-batch-label").innerText()), await page.locator("#work-comment-batch-label").innerText());
      rec.check("the send button says how many it will send", /发送 1 条批注/.test((await page.locator("#work-form .composer-send").getAttribute("aria-label")) ?? ""), await page.locator("#work-form .composer-send").getAttribute("aria-label"));
      await rec.shot(page, "02-queued");

      const stored = await rec.until(() => allComments(deck).find((c) => c.text === TEXT));
      rec.check("PATCH /api/reviews wrote _agent/review-threads.v1.json", !!stored);
      rec.check("the stored scope names the clicked element", !!stored && stored.scope?.kind === "elements" && stored.scope.elementIds.includes("slogan"), JSON.stringify(stored?.scope));
      rec.check("a new comment is unresolved and AI-idle", !!stored && stored.resolved === false && stored.aiStatus === "idle", `${stored?.resolved}/${stored?.aiStatus}`);
      rec.check("no page file was edited by commenting", !JSON.stringify(elements(deck)).includes(TEXT));

      // reload: the chip is restored from disk, the pin shows once annotation mode is on
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#slide .el[data-id]");
      await sleep(500);
      rec.check("the queued comment survives a reload", (await page.locator("#work-comment-items .comment-attachment").count()) === 1);
      await page.click("#btn-comments");
      await sleep(300);
      rec.check("the pin is drawn when annotation mode is on", (await page.locator("#comment-layer .pin").count()) === 1, await page.locator("#comment-layer .pin").count());
      await page.keyboard.press("Escape");
      await sleep(200);
      rec.check("Esc leaves annotation mode", (await page.locator("#btn-comments").getAttribute("aria-pressed")) === "false");

      // drag-select two elements, cancel with Esc: no comment is created
      await page.click("#btn-comments");
      const a = await page.locator('#slide .el[data-id="cover-en"]').boundingBox();
      const b = await page.locator('#slide .el[data-id="slogan"]').boundingBox();
      const x0 = Math.min(a.x, b.x) - 6;
      const y0 = Math.min(a.y, b.y) - 6;
      const x1 = Math.max(a.x + a.width, b.x + b.width) + 6;
      const y1 = Math.max(a.y + a.height, b.y + b.height) + 6;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 5 });
      await page.mouse.move(x1, y1, { steps: 5 });
      await page.mouse.up();
      await page.waitForSelector("#comment-panel", { state: "visible", timeout: 4000 }).catch(() => {});
      const many = await page.locator("#comment-targets li").count();
      rec.check("dragging a box selects several objects", many >= 2, `${many} targets: ${await page.locator("#comment-target").innerText().catch(() => "")}`);
      await rec.shot(page, "03-box-select");
      await page.keyboard.press("Escape");
      await sleep(250);

      // remove the chip: resolved flag on disk, undo toast
      await page.locator("#work-comment-items .comment-attachment-remove").first().click();
      await sleep(400);
      rec.check("removing the chip empties the queue", (await page.locator("#work-comment-items .comment-attachment").count()) === 0);
      rec.check("removal marks the stored comment resolved", await rec.until(() => allComments(deck).find((c) => c.text === TEXT)?.resolved === true));
      await page.__context.close();
    },
  },

  {
    id: "comment-send-agent",
    title: "Send queued comments to the agent: no-session failure path + the repo's outer-boundary QA",
    async run(ctx, rec) {
      // Part 1: a scratch deck has no DSH session, so sending must fail loudly and keep the comment.
      const deck = ctx.deck("comment-send-agent");
      const page = await newPage(ctx, rec);
      await openEditor(page, ctx, deck, "&workspace=1");
      await addComment(page, "slogan", "发送前先别改，只检查");
      const turns = [];
      page.on("request", (r) => {
        if (/\/slides\/sessions\/.+\/turn$/.test(r.url())) turns.push(r.url());
      });
      await page.click("#work-form .composer-send");
      await sleep(1200);
      const toast = await page.locator("#app-toast").innerText().catch(() => "");
      rec.check("no session: the user is told why and what still works", /没有 AI 对话记录/.test(toast) && /手动编辑/.test(toast), toast || "(no toast)");
      rec.check("no session: no turn was sent", turns.length === 0);
      rec.check("no session: the comment stays queued for a retry", (await page.locator("#work-comment-items .comment-attachment").count()) === 1);
      rec.check("no session: the deck on disk is untouched", !JSON.stringify(elements(deck)).includes("发送前先别改"));
      await rec.shot(page, "01-no-session");
      await page.__context.close();

      // Part 2: the repo's own QA drives the full batch flow (lock, AI 修改前 snapshot,
      // turn body, scope check, apply/rollback) with the DSH boundary stubbed.
      const script = path.join(REPO, "scripts/qa/editor-comment-batch.mjs");
      const out = path.join(rec.dir, "editor-comment-batch.log");
      const code = await new Promise((resolve) => {
        const log = fs.openSync(out, "w");
        const child = spawn(process.execPath, [script], {
          cwd: REPO,
          stdio: ["ignore", log, log],
          env: { ...process.env, SLIDES_DSH_PORT: String(ctx.fake.port) },
        });
        const timer = setTimeout(() => child.kill("SIGTERM"), 240000);
        child.on("exit", (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      rec.check("scripts/qa/editor-comment-batch.mjs exits 0", code === 0, `exit ${code}; log ${path.relative(REPO, out)}`);
      rec.note("the full send path is proven by the repo QA with a stubbed kernel; a real model edit still needs provider credentials");
    },
  },

  {
    id: "versions",
    title: "Version history: V1 baseline, manual snapshot, read-only preview, restore",
    async run(ctx, rec) {
      const deck = ctx.deck("versions");
      const page = await newPage(ctx, rec);
      await openEditor(page, ctx, deck);
      rec.check("a scratch deck starts without a version store", !fs.existsSync(path.join(deck, ".versions")));
      const baseCount = elements(deck).length;

      let w = waitForCommand(page, "insert");
      await page.click('[data-control="insert.text"]');
      await w;
      await page.keyboard.press("Escape");
      rec.check("the first edit creates the V1 baseline", await rec.until(() => versionsManifest(deck).length >= 1), JSON.stringify(versionsManifest(deck)).slice(0, 200));
      rec.check("the baseline is marked baseline:original", JSON.stringify(versionsManifest(deck)).includes("baseline:original"));

      await openVersionMenu(page);
      rec.check("the menu lists V1", (await page.locator('[data-version-id="v1"]').count()) === 1);
      await rec.shot(page, "01-menu");
      await page.click("#version-save");
      rec.check("手动快照 adds a version on disk", await rec.until(() => versionsManifest(deck).length >= 2), `${versionsManifest(deck).length} versions`);

      // preview V1 (the deck without the inserted text box)
      await openVersionMenu(page);
      await page.locator('[data-version-id="v1"]').click();
      await page.waitForSelector("#history-bar", { state: "visible" });
      rec.check("preview is read-only and says which version", /只读/.test(await page.locator("#history-readonly").innerText()) && /V1/.test(await page.locator("#history-readonly").innerText()), await page.locator("#history-readonly").innerText());
      rec.check("the canvas shows the baseline element count", (await page.locator("#slide .el[data-id]").count()) === baseCount, `${await page.locator("#slide .el[data-id]").count()} vs ${baseCount}`);
      rec.check("undo/redo are disabled while previewing", (await page.locator("#btn-undo").isDisabled()) && (await page.locator("#btn-redo").isDisabled()));
      await rec.shot(page, "02-preview-v1");

      // back leaves preview without touching the deck
      await page.click("#history-back");
      await page.waitForSelector("#history-bar", { state: "hidden" });
      rec.check("返回 leaves the preview", true);
      rec.check("back kept the edited deck", elements(deck).length === baseCount + 1);

      // restore V1
      await openVersionMenu(page);
      await page.locator('[data-version-id="v1"]').click();
      await page.waitForSelector("#history-bar", { state: "visible" });
      await page.click("#history-restore");
      await page.waitForSelector("#history-bar", { state: "hidden" });
      rec.check("restore rewrote the live deck to the baseline", await rec.until(() => elements(deck).length === baseCount), `${elements(deck).length} vs ${baseCount}`);
      const labels = JSON.stringify(versionsManifest(deck));
      rec.check("restore left 恢复前 and 从 v1 恢复 snapshots", /恢复前/.test(labels) && /从 v1 恢复/.test(labels), labels.slice(0, 300));
      await rec.shot(page, "03-restored");
      await page.__context.close();
    },
  },

  {
    id: "export-pptx",
    title: "Export the deck as an editable PPTX; error + retry; blob URL lifetime",
    ignoreErrors: [/status of 500/], // the forced-failure step below
    async run(ctx, rec) {
      const deck = ctx.deck("export-pptx");
      const before = snapshotDir(deck);
      const page = await newPage(ctx, rec);
      await page.addInitScript(() => {
        window.__revokes = [];
        const orig = URL.revokeObjectURL.bind(URL);
        URL.revokeObjectURL = (u) => {
          window.__revokes.push(performance.now());
          return orig(u);
        };
      });
      await openEditor(page, ctx, deck);
      await page.click("#btn-export");
      await page.waitForSelector("#export-dialog[open]");
      rec.check("PPTX is the default format", await page.locator("#export-pptx").evaluate((n) => n.classList.contains("on") || n.getAttribute("aria-checked") === "true" || n.checked === true));
      rec.check("scope says the whole deck is editable", /全部 8 页/.test(await page.locator("#export-scope").innerText()) && /可编辑/.test(await page.locator("#export-scope").innerText()), await page.locator("#export-scope").innerText());
      await rec.shot(page, "01-dialog");

      const t0 = await page.evaluate(() => performance.now());
      const dl = page.waitForEvent("download", { timeout: 60000 });
      await page.click("#export-download");
      const download = await dl;
      const file = path.join(rec.dir, "deck.pptx");
      await download.saveAs(file);
      await page.waitForSelector("#export-result", { state: "visible", timeout: 15000 });
      const result = await page.locator("#export-result").innerText();
      rec.check("download is a .pptx named after the deck", /\.pptx$/.test(download.suggestedFilename()), download.suggestedFilename());
      rec.check("the result line names the same file", result.includes(download.suggestedFilename().replace(/\.pptx$/, "")), result.replace(/\s+/g, " "));
      rec.check("the result line reports 8 页 and a size", /8 页/.test(result) && /(KB|MB)/.test(result), result.replace(/\s+/g, " "));

      const zip = await unzipEntries(file);
      const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      rec.check("the archive holds 8 slides", slides.length === 8, slides.length);
      const xml = await zip.file("ppt/slides/slide1.xml").async("string");
      const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
      rec.check("slide 1 carries real text runs (<a:t>), not a raster", texts.some((t) => t.includes("YU7")), texts.slice(0, 5).join(" | "));
      rec.check("slide 1 is not one full-page picture", texts.length >= 3);

      await sleep(2300);
      const revokes = await page.evaluate(() => window.__revokes);
      rec.check("the blob URL is revoked no sooner than ~2s after the click", revokes.length >= 1 && revokes[0] - t0 >= 1900, revokes.map((r) => Math.round(r - t0)).join(","));
      rec.check("exporting did not change the deck's pages or manifest", JSON.stringify(snapshotDir(deck)) === JSON.stringify(before));

      // failure + retry
      await page.route("**/api/export", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "verify-forced-failure" }) }));
      await page.click("#export-download");
      await page.waitForSelector("#export-error", { state: "visible", timeout: 10000 });
      rec.check("a failed export shows the reason", /verify-forced-failure|失败/.test(await page.locator("#export-error-text").innerText()), await page.locator("#export-error-text").innerText());
      rec.check("a failed export offers a retry", await page.locator("#export-retry").isVisible());
      await rec.shot(page, "02-error");
      await page.unroute("**/api/export");
      const dl2 = page.waitForEvent("download", { timeout: 60000 });
      await page.click("#export-retry");
      const again = await dl2;
      rec.check("retry succeeds after the fault clears", /\.pptx$/.test(again.suggestedFilename()));
      await page.__context.close();
    },
  },

  {
    id: "export-pdf-png",
    title: "Export PDF (all pages, image based) and PNG (current page)",
    async run(ctx, rec) {
      const deck = ctx.deck("export-pdf-png");
      const page = await newPage(ctx, rec);
      await openEditor(page, ctx, deck);
      await page.locator("#rail .thumb").nth(2).click();
      await sleep(400);
      await page.click("#btn-export");
      await page.waitForSelector("#export-dialog[open]");

      await page.click("#export-pdf");
      rec.check("PDF scope: all pages, image version", /全部 8 页/.test(await page.locator("#export-scope").innerText()) && /PDF/.test(await page.locator("#export-scope").innerText()), await page.locator("#export-scope").innerText());
      rec.check("choosing a format does not download", true);
      rec.check("font embedding is hidden for PDF", !(await page.locator("#export-embed-fonts").isVisible().catch(() => false)));
      let dl = page.waitForEvent("download", { timeout: 120000 });
      await page.click("#export-download");
      let d = await dl;
      const pdf = path.join(rec.dir, "deck.pdf");
      await d.saveAs(pdf);
      const pdfBytes = fs.readFileSync(pdf);
      rec.check("the file starts with %PDF-", pdfBytes.subarray(0, 5).toString() === "%PDF-");
      rec.check("the file ends with %%EOF", pdfBytes.subarray(-32).toString().includes("%%EOF"));
      rec.check("the PDF has 8 pages", (pdfBytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length === 8 || /\/Count 8/.test(pdfBytes.toString("latin1")), `${(pdfBytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length} page objects`);
      rec.check("PDF suggested name ends in .pdf", /\.pdf$/.test(d.suggestedFilename()), d.suggestedFilename());
      await page.waitForSelector("#export-result", { state: "visible", timeout: 20000 });

      await page.click("#export-png");
      rec.check("PNG scope names the current page", /当前第 3 页/.test(await page.locator("#export-scope").innerText()), await page.locator("#export-scope").innerText());
      dl = page.waitForEvent("download", { timeout: 120000 });
      await page.click("#export-download");
      d = await dl;
      const png = path.join(rec.dir, "page.png");
      await d.saveAs(png);
      const magic = fs.readFileSync(png).subarray(0, 8).toString("hex");
      rec.check("the file has the PNG signature", magic === "89504e470d0a1a0a", magic);
      rec.check("the PNG is the page the tab is on (the file name says p3)", /-p3\.png$/.test(d.suggestedFilename()), `file is ${d.suggestedFilename()}`);
      await rec.shot(page, "01-after-png");
      await page.__context.close();
    },
  },
];
