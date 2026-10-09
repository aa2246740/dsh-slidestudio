#!/usr/bin/env node
/**
 * One Hub journey, one new brief, one deck. No leftover project. No CLI login.
 */
import { launchPinnedChromium } from "../lib/pinned-playwright.mjs";
import fs from "node:fs";
import path from "node:path";
import {
  ROOT,
  clickSlide,
  clickUi,
  dblclickEl,
  readModel,
  restartNativeWebServer,
  typeInto,
} from "./gestures.mjs";
import { loadRootEnv } from "./load-env.mjs";
import { requireExternalModelConsent } from "./external-model-consent.mjs";

loadRootEnv();
delete process.env.SLIDESTUDIO_PI_AUTH_PATH;
delete process.env.SLIDESTUDIO_PI_ALLOW_ENV;

const OUT = process.env.QA_JOURNEY_OUT || path.join(ROOT, "output", "qa-product-journey");
const ART = process.env.QA_JOURNEY_ART || "/opt/cursor/artifacts/qa-product-journey";
const VIDEO_DIR = path.join(OUT, "playwright-video");
const BASE = process.env.BASE || "http://127.0.0.1:55200";
const BRIEF = process.env.QA_JOURNEY_BRIEF || "给二年级讲一讲种子怎么发芽";
const BRIEF_TOKEN = process.env.QA_JOURNEY_TOKEN || "种子";
const MODEL = process.env.SLIDESTUDIO_QA_PI_MODEL || "gemini-3.5-flash-lite";
const GENERATE_MS = Number(process.env.QA_JOURNEY_GENERATE_MS || 12 * 60 * 1000);

const modelConsent = requireExternalModelConsent({
  script: "record-product-journey",
  brief: BRIEF,
});

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });
try {
  fs.rmSync(ART, { recursive: true, force: true });
} catch {
  /* artifact dir may be immutable; overwrite files later */
}

const notes = {
  startedAt: new Date().toISOString(),
  brief: BRIEF,
  briefToken: BRIEF_TOKEN,
  model: MODEL,
  errors: [],
  steps: [],
  login: null,
  generate: null,
  download: null,
  edit: null,
  titles: null,
  disk: null,
  modelConsent,
};

function pass(name, extra) {
  notes.steps.push({ name, ok: true, ...extra });
}

function fail(name, msg) {
  notes.errors.push(`${name}: ${msg}`);
  notes.steps.push({ name, ok: false, msg });
}

function shot(page, name) {
  return page.screenshot({ path: path.join(OUT, `${name}.png`) }).then(() => name);
}

function publicAuth(data) {
  return {
    ready: data.auth?.ready ?? data.ready ?? null,
    kind: data.auth?.kind ?? data.kind ?? null,
    source: data.auth?.source ?? data.source ?? null,
    provider: data.auth?.provider ?? data.provider ?? null,
    note: data.auth?.note ?? data.note ?? null,
    stored: data.stored,
  };
}

function collectDisk(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) return null;
  const traceFile = path.join(projectPath, "_agent", "pi-trace.json");
  const skillFile = path.join(projectPath, "_agent", "skill-deck.json");
  const deckFile = path.join(projectPath, "deck.pptd");
  const pagesDir = path.join(projectPath, "pages");
  const out = {
    path: projectPath,
    hasTrace: fs.existsSync(traceFile),
    hasSkillDeck: fs.existsSync(skillFile),
    hasDeck: fs.existsSync(deckFile),
    pageCount: fs.existsSync(pagesDir)
      ? fs.readdirSync(pagesDir).filter((f) => f.endsWith(".page")).length
      : 0,
  };
  if (fs.existsSync(traceFile)) {
    const trace = JSON.parse(fs.readFileSync(traceFile, "utf8"));
    out.trace = {
      usedPi: trace.usedPi,
      live: trace.live,
      produce: trace.produce,
      produceKind: trace.produceKind,
      skills: trace.skills,
      events: trace.events,
      timedEvents: trace.timedEvents,
      agentStart: trace.agentStart,
      agentEnd: trace.agentEnd,
      wallMs: trace.wallMs,
      toolWrites: trace.toolWrites,
      skillStack: trace.skillStack,
      skillsAs: trace.skillsAs,
      fileMtimes: trace.fileMtimes,
      model: trace.model,
      provider: trace.provider,
    };
  }
  const runtimeFile = path.join(projectPath, "_agent", "runtime.json");
  if (fs.existsSync(runtimeFile)) {
    const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
    out.runtime = {
      categoryId: runtime.categoryId,
      designSystemId: runtime.designSystemId,
    };
  }
  const visualFile = path.join(projectPath, "_agent", "visual-review.json");
  if (fs.existsSync(visualFile)) {
    const visual = JSON.parse(fs.readFileSync(visualFile, "utf8"));
    out.visualReview = {
      kind: visual.kind,
      note: visual.note,
      seen: visual.seen,
      rasters: visual.rasters,
    };
  }
  const rasterDir = path.join(projectPath, "_agent", "rasters");
  out.rasterCount = fs.existsSync(rasterDir)
    ? fs.readdirSync(rasterDir).filter((f) => f.endsWith(".png")).length
    : 0;
  return out;
}

function isNeutralHex(hex) {
  const h = String(hex || "").replace("#", "").toUpperCase();
  if (h.length !== 6) return true;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (sat < 0.14) return true;
  if (lum > 0.9 && sat < 0.28) return true;
  return false;
}

function pageLooksLikeDoc(yaml, name = "") {
  const hexes = [...String(yaml).matchAll(/#([0-9A-Fa-f]{6})/g)].map((m) => `#${m[1].toUpperCase()}`);
  const hasColor = hexes.some((hex) => !isNeutralHex(hex));
  const hasShape = /elementType:\s*shape/.test(yaml);
  const official =
    /elementId:\s*(title-band|result-bar|pink-band|panel-0|well-0|circle)/.test(yaml) ||
    (/shapeName:\s*roundRect/.test(yaml) && /#F5987E/.test(yaml) && /#D7EBCE/.test(yaml));
  const homemade =
    (yaml.match(/shapeName:\s*ellipse/g) || []).length >= 4 &&
    /72,\s*168,\s*96,\s*96/.test(yaml) &&
    !/path-spine/.test(yaml);
  const hasDrawing =
    official ||
    /shapeName:\s*(ellipse|rightArrow|triangle|chevron|heart|star|pie|donut|tear|cloud)/i.test(
      yaml,
    ) ||
    /elementType:\s*(table|chart|image)/.test(yaml);
  const hasCopy = /content:\s*\n(?:.*\n)*?\s+text:\s*\S/.test(yaml) || /text:\s+\S/.test(yaml);
  const coverBroken =
    /01_cover/.test(name) &&
    (/让我们一起/.test(yaml) ||
      (yaml.match(/shapeName:\s*ellipse/g) || []).length !== 1 ||
      !/elementId:\s*chip/.test(yaml));
  const conceptPills =
    /03_concept/.test(name) && (!/elementId:\s*aside/.test(yaml) || !/elementId:\s*ring-outer/.test(yaml));
  const routeBare =
    /02_route/.test(name) &&
    (!/elementId:\s*rule/.test(yaml) ||
      !/elementId:\s*chapter/.test(yaml) ||
      !/elementId:\s*path-spine/.test(yaml) ||
      /elementId:\s*panel-0/.test(yaml) ||
      /认识种子|发芽条件|小小的身躯|缺一不可/.test(yaml) ||
      !/先喝饱水/.test(yaml));
  const conceptWrong =
    /03_concept/.test(name) &&
    (/适量的水|充足的空气|合适的温度/.test(yaml) || !/种皮/.test(yaml) || !/子叶/.test(yaml) || !/胚/.test(yaml));
  return (
    homemade ||
    coverBroken ||
    conceptPills ||
    conceptWrong ||
    routeBare ||
    !hasColor ||
    !hasShape ||
    !hasDrawing ||
    !hasCopy
  );
}

function isLeftoverProject(p) {
  const s = String(p || "");
  return /勾股|光合作用|下雨|彩虹|1787060869019|1787061591260|1787062321824|1787062982294|1787064321040|1787064740024|1787068468340|1787069651401|1787070848351|1787072203094|1787072800056|1787073097078|1787073741782|1787097476608|1787097715864|1787098763603|1787099863391|1787099914770|1787101598427/.test(s);
}

await restartNativeWebServer();
const authSnapshot = await fetch(`${BASE}/api/pi/auth`).then((response) => response.json());
const provider =
  process.env.QA_PI_PROVIDER ||
  authSnapshot.auth?.provider ||
  authSnapshot.stored?.[0]?.providerId ||
  "";
notes.provider = provider;

const browser = await launchPinnedChromium({
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-position=40,40", "--window-size=1440,900"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
  recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
page.setDefaultTimeout(20000);

try {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector("#brief", { timeout: 8000 });
  await page.click("#btn-model");
  await page.waitForSelector("#pi-panel:not([hidden])", { timeout: 8000 });
  if (!provider || !authSnapshot.stored?.some((row) => row.providerId === provider)) {
    throw new Error(`selected supplier is not logged in: ${provider || "(none)"}`);
  }
  await page.selectOption("#pi-provider", provider);
  await page.fill("#pi-model", MODEL);
  await page.waitForFunction(
    () => /已登录/.test(document.getElementById("pi-login-status")?.textContent || ""),
    null,
    { timeout: 8000 },
  );
  await shot(page, "01-provider-ready");
  notes.login = publicAuth(await fetch(`${BASE}/api/pi/auth`).then((r) => r.json()));
  pass("provider-ready", { provider, stored: true });
  await page.click("#btn-model");

  await page.fill("#brief", BRIEF);
  await page.waitForFunction(() => !document.getElementById("btn-send")?.disabled, null, { timeout: 4000 });
  await page.click("#btn-send");
  await page.waitForSelector("#agent-screen:not([hidden])", { timeout: 8000 });
  await page.waitForTimeout(800);
  await shot(page, "03-generating");
  pass("ask");

  const deadline = Date.now() + GENERATE_MS;
  while (Date.now() < deadline && !(await page.locator('#result-wrap[data-authentic="1"]').count())) {
    if (await page.locator("#btn-retry-now").count()) {
      throw new Error("generation paused or failed — no result may be injected or reused");
    }
    await page.waitForTimeout(2000);
  }
  if (!(await page.locator("#result-wrap").count())) {
    throw new Error("generate paused or did not finish — no Hub result card");
  }

  const meta = await page.evaluate(() => {
    const wrap = document.getElementById("result-wrap");
    const title = document.querySelector("#result-wrap b")?.textContent || "";
    return {
      path: wrap?.dataset.path || "",
      composeSource: wrap?.dataset.composeSource || "",
      usedPi: wrap?.dataset.usedPi === "1",
      authentic: wrap?.dataset.authentic === "1",
      provider: wrap?.dataset.provider || "",
      pageCount: Number(wrap?.dataset.pageCount || 0),
      title,
    };
  });
  notes.generate = meta;
  const hero = await page.evaluate(() => {
    const complete = document.getElementById("agent-complete")?.innerText || "";
    const card = document.getElementById("tool-card")?.innerText || "";
    return `${complete}\n${card}`;
  });
  if (/用量超|429/.test(hero)) {
    fail("generate", `rate-limit pause still visible on success result: ${hero.slice(0, 280)}`);
  } else if (!meta.path || isLeftoverProject(meta.path)) {
    fail("generate", `result card is missing or is a leftover project: ${JSON.stringify(meta)}`);
  } else if (meta.composeSource !== "pi-rpc" || !meta.usedPi || !meta.authentic) {
    fail("generate", `not Pi+Skills: ${JSON.stringify(meta)}`);
  } else if (meta.provider !== provider) {
    fail("generate", `wrong supplier: expected ${provider}, got ${meta.provider}`);
  } else if (!String(meta.path).includes(BRIEF_TOKEN) && !String(meta.title).includes(BRIEF_TOKEN)) {
    fail("generate", `result does not match this brief token ${BRIEF_TOKEN}: ${JSON.stringify(meta)}`);
  } else {
    pass("generate", meta);
  }
  notes.disk = collectDisk(meta.path);
  const clocks = notes.disk?.trace;
  if (!clocks?.agentStart || !clocks?.agentEnd) {
    fail("trace", `missing agent_start/agent_end clocks: ${JSON.stringify(clocks)}`);
  } else if (!clocks.skillStack?.ok) {
    fail("trace", `skill stack did not run as Pi tools: ${JSON.stringify(clocks.skillStack || clocks.timedEvents)}`);
  } else {
    pass("trace", {
      agentStart: clocks.agentStart,
      agentEnd: clocks.agentEnd,
      wallMs: clocks.wallMs,
      toolWrites: clocks.toolWrites,
    });
  }
  if (/pine-green|analysis-decision/.test(JSON.stringify(notes.disk?.runtime || {}))) {
    fail("taste", `classroom brief still on consulting: ${JSON.stringify(notes.disk?.runtime)}`);
  } else if (notes.disk?.runtime?.categoryId !== "education-training") {
    fail("taste", `expected education-training, got ${JSON.stringify(notes.disk?.runtime)}`);
  } else {
    pass("taste", notes.disk.runtime);
  }
  if (/Host raster after Pi/.test(String(notes.disk?.visualReview?.note || ""))) {
    fail("visual", `host still rastered after agent_end: ${JSON.stringify(notes.disk?.visualReview)}`);
  } else if (notes.disk?.visualReview?.kind !== "pi-tools") {
    fail("visual", `expected Pi visual-review, got ${JSON.stringify(notes.disk?.visualReview)}`);
  } else {
    pass("visual", notes.disk.visualReview);
  }
  const stack = clocks?.skillStack || {};
  const pageCount = notes.disk?.pageCount || 0;
  const rasterCount = notes.disk?.rasterCount || 0;
  if (pageCount < 2 || rasterCount < pageCount) {
    fail("render", `render_page did not cover the pages the user sees: ${JSON.stringify({
      pageWrites: stack.pageWrites,
      renderPages: stack.renderPages,
      renderCoverage: stack.renderCoverage,
      rasterCount,
      pageCount,
    })}`);
  } else {
    pass("render", { rasterCount, pageCount, pageWrites: stack.pageWrites });
  }
  const pagesDir = path.join(meta.path, "pages");
  const pageFiles = fs.existsSync(pagesDir)
    ? fs.readdirSync(pagesDir).filter((f) => f.endsWith(".page"))
    : [];
  const docPages = pageFiles.filter((name) =>
    pageLooksLikeDoc(fs.readFileSync(path.join(pagesDir, name), "utf8"), name),
  );
  const noteTitles = pageFiles.filter((name) =>
    /text:\s*["']?(Cover|Path|Concept|Remember|Exhibit|Takeaway|Close)\s+page\b/i.test(
      fs.readFileSync(path.join(pagesDir, name), "utf8"),
    ),
  );
  const titleBad = pageFiles.filter((name) => {
    const yaml = fs.readFileSync(path.join(pagesDir, name), "utf8");
    const blocks = yaml.split(/- elementId:\s*/);
    let title = "";
    for (const block of blocks) {
      if (!/^title\s*\n/.test(block)) continue;
      title = /text:\s*(.+)/.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
      if (title) break;
    }
    return !title || title.length > 16 || /[：:]$/.test(title) || /让我们一起探究|外壳（种皮）/.test(title);
  });
  const hostStamp = pageFiles.filter((name) =>
    /elementId:\s*(cover-stem|cover-leaf-a|cover-soil|need-sun|before-sun)/.test(
      fs.readFileSync(path.join(pagesDir, name), "utf8"),
    ),
  );
  const handsFile = path.join(meta.path, "_agent", "hands-log.jsonl");
  let writeOk = 0;
  let writeBad = 0;
  let restamp = 0;
  if (fs.existsSync(handsFile)) {
    for (const line of fs.readFileSync(handsFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.name !== "write_page") continue;
        if (row.ok) writeOk += 1;
        else writeBad += 1;
        if (row.payload?.painted === true || row.payload?.restamped === true) {
          restamp += 1;
        }
      } catch {
        /* skip */
      }
    }
  }
  if (writeBad > 0 || writeOk < 2) {
    fail("write_page", `need write_page×N accepted, got ok=${writeOk} invalid=${writeBad}`);
  } else if (restamp > 0) {
    fail("write_page", `write_page restamped official recipes (${restamp})`);
  } else {
    pass("write_page", { ok: writeOk, invalid: writeBad, restamp });
  }
  if (docPages.length) {
    fail("courseware", `not official paper-white recipes: ${docPages.join(", ")}`);
  } else if (noteTitles.length) {
    fail("courseware", `YAML notes leaked onto the slide: ${noteTitles.join(", ")}`);
  } else if (titleBad.length) {
    fail("courseware", `title not short+whole: ${titleBad.join(", ")}`);
  } else if (hostStamp.length) {
    fail("courseware", `host-stamped leftover shapes: ${hostStamp.join(", ")}`);
  } else {
    pass("courseware", { pages: pageFiles.length });
  }
  await shot(page, "04-generated");

  if (notes.errors.some((e) => e.startsWith("generate"))) {
    throw new Error(notes.errors.find((e) => e.startsWith("generate")));
  }

  const [hubDl] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click("#btn-result-download"),
  ]);
  const hubFile = path.join(OUT, hubDl.suggestedFilename() || "deck.pptx");
  await hubDl.saveAs(hubFile);
  notes.download = { from: "result", file: hubFile, bytes: fs.statSync(hubFile).size, filename: path.basename(hubFile) };
  if (notes.download.bytes < 4000) fail("download", `pptx too small: ${notes.download.bytes}`);
  else pass("download", notes.download);
  await shot(page, "05-download");

  await page.click("#btn-result-view");
  await page.waitForSelector("#slide, #present", { timeout: 20000 });
  if (!(await page.locator("#present:not([hidden])").count())) {
    await clickUi(page, "#btn-play");
  }
  await page.waitForSelector("#present:not([hidden])", { timeout: 12000 });
  const presentText = async () =>
    page.locator("#present-slide, #slide").first().innerText().catch(() => "");
  const presentUntil = async (re, max = 10) => {
    for (let i = 0; i < max; i++) {
      if (re.test(await presentText())) return true;
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(350);
    }
    return re.test(await presentText());
  };
  if (!(await presentUntil(/种子怎么发芽/))) {
    fail("view", `present did not open on the official cover: ${(await presentText()).slice(0, 160)}`);
  }
  await page.waitForTimeout(200);
  await shot(page, "06-view");
  if (!(await presentUntil(/先喝饱水/))) {
    fail("view", `present page 2 is not the official route: ${(await presentText()).slice(0, 160)}`);
  }
  await shot(page, "06b-page2");
  if (
    !(await presentUntil(/种子里面有什么/)) ||
    !/种皮/.test(await presentText()) ||
    /适量的水/.test(await presentText())
  ) {
    fail("view", `present page 3 is not the official concept: ${(await presentText()).slice(0, 160)}`);
  }
  await shot(page, "06c-page3");
  pass("view");

  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("present")?.hidden, null, { timeout: 6000 });
  await page.waitForSelector("#slide", { timeout: 8000 });
  const opened = await readModel(page);
  const editorTitle = opened.model?.title || "";
  notes.titles = { result: meta.title, editor: editorTitle, download: notes.download.filename };
  if (editorTitle && meta.title && editorTitle !== meta.title) {
    fail("title", `editor "${editorTitle}" != result card "${meta.title}"`);
  }
  const titleBlob = `${meta.title}\n${editorTitle}\n${notes.download.filename}`;
  if (!titleBlob.includes(BRIEF_TOKEN)) {
    fail("title", `Hub/editor/download missing ${BRIEF_TOKEN}: ${JSON.stringify(notes.titles)}`);
  }
  await shot(page, "07-editor");

  const textEl = (opened.model?.elements || []).find((e) => e.type === "text" && String(e.text || "").trim());
  if (!textEl) {
    fail("edit", "no text on the open page");
  } else {
    await dblclickEl(page, textEl.id);
    await page.waitForFunction(
      () => Boolean(document.activeElement?.isContentEditable && document.activeElement.closest?.("#slide")),
      null,
      { timeout: 6000 },
    );
    await page.keyboard.press("End");
    await typeInto(page, " · 已改");
    await clickSlide(page, 20, 20);
    await page.waitForFunction(() => !document.querySelector("#slide .el.is-editing"), null, { timeout: 5000 });
    const after = await readModel(page);
    const now = (after.model?.elements || []).find((e) => e.id === textEl.id);
    notes.edit = { id: textEl.id, text: now?.text || "" };
    if (!String(now?.text || "").includes("已改")) fail("edit", `edit did not land: ${JSON.stringify(now?.text)}`);
    else pass("edit", notes.edit);
    await shot(page, "08-edit");
  }

  await clickUi(page, "#btn-export");
  await page.waitForSelector("#export-dialog[open]", { timeout: 4000 });
  const [edDl] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    clickUi(page, "#export-pptx"),
  ]);
  const edFile = path.join(OUT, `editor-${edDl.suggestedFilename() || "deck.pptx"}`);
  await edDl.saveAs(edFile);
  notes.download.editorFile = edFile;
  notes.download.editorBytes = fs.statSync(edFile).size;
  await page.waitForSelector("#export-result:not([hidden])", { timeout: 15000 }).catch(() => {});
  await shot(page, "09-export");
  pass("export-editor", { bytes: notes.download.editorBytes });
} catch (err) {
  fail("crash", err instanceof Error ? err.message : String(err));
  await shot(page, "99-crash").catch(() => {});
} finally {
  const video = page.video();
  await page.close().catch(() => {});
  if (video) {
    const raw = await video.path().catch(() => "");
    if (raw && fs.existsSync(raw)) {
      const dest = path.join(OUT, "journey.webm");
      try {
        fs.renameSync(raw, dest);
      } catch {
        fs.copyFileSync(raw, dest);
      }
    }
  }
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  notes.finishedAt = new Date().toISOString();
  notes.ok = notes.errors.length === 0 && Boolean(notes.generate?.path) && !isLeftoverProject(notes.generate.path);
  fs.writeFileSync(path.join(OUT, "notes.json"), `${JSON.stringify(notes, null, 2)}\n`);
  if (notes.ok) {
    try { fs.unlinkSync(path.join(OUT, "99-crash.png")); } catch { /* none */ }
    try { fs.unlinkSync(path.join(ART, "99-crash.png")); } catch { /* none */ }
  }
  try {
    fs.mkdirSync(ART, { recursive: true });
    for (const name of fs.readdirSync(OUT)) {
      if (name === "playwright-video" || name === "99-crash.png") continue;
      const src = path.join(OUT, name);
      const dest = path.join(ART, name);
      if (fs.statSync(src).isDirectory()) continue;
      fs.copyFileSync(src, dest);
    }
  } catch {
    /* do not flip ok for artifact copy */
  }
  console.log(JSON.stringify({
    ok: notes.ok,
    errors: notes.errors,
    provider: notes.provider,
    login: notes.login,
    generate: notes.generate,
    titles: notes.titles,
    download: notes.download,
    out: OUT,
  }, null, 2));
}

process.exit(notes.ok ? 0 : 1);
