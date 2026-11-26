import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chromeSha256, createEmptyProject, loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { createPresentationRun } from "../run.js";
import type { ToolExecution } from "./agent-tools.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { persistPageKey } from "./page-identity.js";
import { currentPageRevision, ensureRunLedger, inspectRunLedger, readRunLedger } from "./run-ledger.js";
import { recordImagePrepared, recordRaster } from "./run-ledger-raster.js";

// Compose gates for masters and layouts (VAL-LAYOUT-008, VAL-LAYOUT-015). Every render is synthetic:
// no editor, browser, renderer or model runs. The chrome hash is computed exactly as render_page does.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const context = { commandId: "layout-compose", contextEpochId: "layout-compose-epoch" };
const ENV_KEYS = ["SLIDESTUDIO_VISION_REVIEWER", "SLIDESTUDIO_LLM_IMAGE"] as const;
const BODY_PAGES = ["p02", "p03", "p04", "p05"];
const PAGE_IDS = ["p01", ...BODY_PAGES];
const COMPOSE_TITLE = "版式合成";

type Receipt = Omit<ToolExecution, "payload"> & { payload: Record<string, unknown> };

const MASTER = {
  scope: "master",
  id: "main",
  name: "母版",
  elements: [
    {
      elementId: "footer",
      elementType: "text",
      bounds: [80, 500, 600, 40],
      content: { text: "页脚", fontSize: 14 },
      layoutRole: "footer",
    },
  ],
};

function bodyLayout(header: string) {
  return {
    scope: "layout",
    id: "body",
    name: "正文",
    masterId: "main",
    elements: [
      {
        elementId: "header",
        elementType: "text",
        bounds: [80, 20, 600, 40],
        content: { text: header, fontSize: 20 },
      },
      {
        elementId: "logo",
        elementType: "image",
        bounds: [860, 20, 80, 40],
        src: "media/logo-a.png",
      },
    ],
  };
}

function pageInput(pageId: string, layoutId?: string) {
  return {
    id: pageId,
    pageType: "content",
    notes: `${pageId} 完整备注`,
    ...(layoutId ? { layoutId } : {}),
    elements: [
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 120, 800, 70],
        content: { text: `第 ${pageId} 页标题`, fontSize: 32 },
      },
      {
        elementId: "body",
        elementType: "text",
        bounds: [80, 220, 800, 160],
        content: { text: "明确负责人，核对输入信息，再记录交付结果。", fontSize: 24 },
      },
    ],
  };
}

async function call(root: string, name: string, args: Record<string, unknown> = {}): Promise<Receipt> {
  const result = await runDomainHand(name, { ...args, __openSlideStudio: context }, root);
  return { ...result, payload: result.payload as Record<string, unknown> };
}

function deckFixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "layout-compose-"));
  const previous = ENV_KEYS.map((key) => process.env[key]);
  t.after(() => {
    ENV_KEYS.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    fs.rmSync(root, { recursive: true, force: true });
  });
  // A configured reviewer makes image delivery and visual review required, as in production.
  process.env.SLIDESTUDIO_VISION_REVIEWER = "offline-layout-compose";
  delete process.env.SLIDESTUDIO_LLM_IMAGE;
  createEmptyProject(root, { title: "版式合成" });
  writeDomainRuntime(root, { brief: "制作 5 页带统一版式的汇报。" });
  persistPresentationRunProvider(root, {
    providerId: "offline",
    modelId: "fixture",
    ready: true,
    modelInputModalities: ["text"],
  });
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: true, structuralReviewRequired: true },
  });
  fs.mkdirSync(path.join(root, "media"), { recursive: true });
  fs.writeFileSync(path.join(root, "media", "logo-a.png"), Buffer.from("synthetic logo"));
  return root;
}

function chromeOf(root: string, pageId: string): string {
  const project = loadProject(root);
  const entry = project.pages.find((item) => persistPageKey(item.path) === pageId);
  assert.ok(entry, `page ${pageId} is on disk`);
  return chromeSha256(project, entry.page);
}

/** Synthetic render of the page's current state. The bytes stand in for pixels. */
async function renderPage(root: string, pageId: string) {
  const revision = currentPageRevision(root, pageId);
  assert.ok(revision, `page ${pageId} has a committed revision`);
  const chrome = chromeOf(root, pageId);
  // Built as a variable so the chromeSha256 field is not an object-literal excess property.
  const input = {
    bytes: Buffer.from(`offline raster ${pageId} ${revision.pageSha256} ${chrome}`),
    src: `_agent/rasters/${pageId}.png`,
    width: 960,
    height: 540,
    layoutStatus: "pass" as const,
    layoutIssues: [],
    chromeSha256: chrome,
  };
  const raster = recordRaster(root, revision, input);
  recordImagePrepared(root, context, raster.fact, raster.deliveryToken);
  const emitted = await call(root, "_mark_image_emitted", {
    deliveryToken: raster.deliveryToken,
  });
  assert.equal(emitted.ok, true, emitted.detail);
  return { revision: revision.revision, deliveryToken: raster.deliveryToken };
}

async function renderAndReview(root: string, pageId: string): Promise<void> {
  const rendered = await renderPage(root, pageId);
  const review = await call(root, "review_page", {
    pageId,
    revision: rendered.revision,
    deliveryToken: rendered.deliveryToken,
    verdict: "pass",
    issues: [],
  });
  assert.equal(review.ok, true, review.detail);
}

/**
 * A five-page deck: p01 has no layout, p02-p05 use body. Every page is rendered and reviewed.
 * `withLayouts` false writes no master or layout, so every page is plain.
 */
async function reviewedDeck(root: string, withLayouts = true): Promise<Receipt> {
  if (withLayouts) {
    assert.equal((await call(root, "write_layout", MASTER)).ok, true);
    const layout = await call(root, "write_layout", bodyLayout("旧页眉"));
    assert.equal(layout.ok, true, layout.detail);
  }
  const layoutPages = withLayouts ? BODY_PAGES : [];
  const plan = PAGE_IDS.map((pageId) => ({
    pageId,
    title: `标题 ${pageId}`,
    layoutFamily: "content",
    exhibits: ["none"],
    ...(layoutPages.includes(pageId) ? { layoutId: "body" } : {}),
  }));
  assert.equal((await call(root, "write_todo", { items: plan })).ok, true);
  for (const pageId of PAGE_IDS) {
    const layoutId = layoutPages.includes(pageId) ? "body" : undefined;
    const written = await call(root, "write_page", pageInput(pageId, layoutId));
    assert.equal(written.ok, true, written.detail);
  }
  for (const pageId of PAGE_IDS) await renderAndReview(root, pageId);
  assert.equal((await call(root, "review_pages")).ok, true);
  const composed = await call(root, "compose_deck", { title: COMPOSE_TITLE });
  assert.equal(composed.ok, true, composed.detail);
  return composed;
}

function reviewFactCount(root: string): number {
  return readRunLedger(root)?.facts.filter((fact) => fact.type === "page.visual-review-recorded").length ?? 0;
}

function revisionFactCount(root: string): number {
  return readRunLedger(root)?.facts.filter((fact) => fact.type === "page.revision-committed").length ?? 0;
}

describe("layout compose gates", () => {
  it("a layout edit asks for render_page on the using pages only, and a re-render composes without a new review", async (t) => {
    const root = deckFixture(t);
    await reviewedDeck(root);
    const reviewsBefore = reviewFactCount(root);
    const revisionsBefore = revisionFactCount(root);

    const changed = await call(root, "write_layout", bodyLayout("新页眉"));
    assert.equal(changed.ok, true, changed.detail);
    assert.equal(changed.payload.pagesUsing, 4);
    assert.equal(changed.payload.pagesNeedingRender, 4);
    // A layout edit records no page revision and no review.
    assert.equal(revisionFactCount(root), revisionsBefore);
    assert.equal(reviewFactCount(root), reviewsBefore);

    const refused = await call(root, "compose_deck", { title: COMPOSE_TITLE });
    assert.equal(refused.ok, false, "a stale layout chrome must refuse compose");
    for (const pageId of BODY_PAGES) assert.match(refused.detail, new RegExp(`${pageId}: `));
    assert.doesNotMatch(refused.detail, /p01: /);
    // The domain gate names the stale pages; the next tool (render_page) is asserted on the real
    // createPresentationRun path below, where the compose refusal payload carries it.
    assert.match(refused.detail, /需要重新渲染/);
    assert.doesNotMatch(refused.detail, /review_page|visual review/);
    assert.equal(inspectRunLedger(root).composed, false);

    for (const pageId of BODY_PAGES) await renderPage(root, pageId);
    const composed = await call(root, "compose_deck", { title: COMPOSE_TITLE });
    assert.equal(composed.ok, true, composed.detail);
    assert.equal(reviewFactCount(root), reviewsBefore, "re-rendering must not add a review");
    assert.equal(inspectRunLedger(root).composed, true);
  });

  it("the compose refusal from the run names render_page and lists only the using pages", async (t) => {
    const root = deckFixture(t);
    await reviewedDeck(root);
    assert.equal((await call(root, "write_layout", bodyLayout("新页眉"))).ok, true);

    const run = createPresentationRun({ repoRoot: REPO_ROOT });
    const handle = await run.open({
      projectRoot: root,
      sessionId: "layout-compose-refusal",
      brief: "制作 5 页带统一版式的汇报。",
      editorBaseUrl: "",
      design: { kind: "self-directed" },
      provider: { providerId: "test", modelId: "test" },
    });
    const result = await run.execute(
      { name: "compose_deck", args: { title: COMPOSE_TITLE } },
      {
        runId: handle.runId,
        sessionId: handle.sessionId,
        toolCallId: "compose-layout-stale",
        projectRoot: root,
        abortSignal: new AbortController().signal,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.payload.error, "compose_not_ready");
    assert.equal(result.payload.next, "render_page");
    assert.deepEqual(
      result.payload.blockingPages,
      BODY_PAGES.map((pageId) => ({ pageId, reason: "版式已变更" })),
    );
    assert.doesNotMatch(JSON.stringify(result), /review_page/);
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 4096);
  });

  it("refuses a layout that no agent or editor revision ever committed, in Chinese", async (t) => {
    const root = deckFixture(t);
    await reviewedDeck(root);
    const project = loadProject(root);
    project.presentation.layouts = [
      ...(project.presentation.layouts ?? []),
      { id: "cover", name: "封面", elements: [] },
    ];
    saveProject(project);

    const refused = await call(root, "compose_deck", { title: COMPOSE_TITLE });
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /版式「封面」/);
  });

  it("refuses a page whose layoutId no longer resolves, in Chinese", async (t) => {
    const root = deckFixture(t);
    await reviewedDeck(root);
    const project = loadProject(root);
    project.presentation.layouts = (project.presentation.layouts ?? []).filter((layout) => layout.id !== "body");
    saveProject(project);

    const refused = await call(root, "compose_deck", { title: COMPOSE_TITLE });
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /p02: 版式 body 不存在，请先定义该版式或改用已有版式/);
  });

  it("the compose receipt and delivery provenance list layouts for a deck that uses them", async (t) => {
    const root = deckFixture(t);
    const composed = await reviewedDeck(root);
    assert.deepEqual(composed.payload.layouts, [{ id: "body", name: "正文", pages: 4 }]);

    const provenance = JSON.parse(
      fs.readFileSync(path.join(root, "_agent", "delivery-provenance.v1.json"), "utf8"),
    ) as { layouts: unknown };
    assert.deepEqual(provenance.layouts, [
      {
        scope: "layout",
        id: "body",
        name: "正文",
        pages: BODY_PAGES,
        componentRefs: [],
        media: ["media/logo-a.png"],
      },
    ]);
  });

  it("refuses a master that no agent or editor revision committed, in Chinese", async (t) => {
    const root = deckFixture(t);
    await reviewedDeck(root);
    // A deck allows one master, so a hand-written master id is a rename of the committed one.
    const project = loadProject(root);
    project.presentation.masters = (project.presentation.masters ?? []).map((master) => ({
      ...master,
      id: "spare",
    }));
    project.presentation.layouts = (project.presentation.layouts ?? []).map((layout) =>
      layout.masterId === "main" ? { ...layout, masterId: "spare" } : layout,
    );
    saveProject(project);

    const refused = await call(root, "compose_deck", { title: COMPOSE_TITLE });
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /母版「母版」还没有定义记录/);
  });

  it("accepts an unused master with no revision when the deck has no layouts", async (t) => {
    const root = deckFixture(t);
    await reviewedDeck(root, false);
    // Only a referenced master needs a revision; this stored master is used by nothing.
    const project = loadProject(root);
    project.presentation.masters = [{ id: "spare", name: "备用母版", elements: [] }];
    saveProject(project);

    const composed = await call(root, "compose_deck", { title: COMPOSE_TITLE });
    assert.equal(composed.ok, true, composed.detail);
  });

  it("accepts an unrecorded master that no layout references", async (t) => {
    const root = deckFixture(t);
    await reviewedDeck(root);
    // The recorded master now has an id no revision names, and the body layout names no master.
    // The body chrome changes, so the body pages render again; no page review is needed.
    const project = loadProject(root);
    project.presentation.masters = (project.presentation.masters ?? []).map((master) => ({
      ...master,
      id: "spare",
    }));
    for (const layout of project.presentation.layouts ?? []) delete layout.masterId;
    saveProject(project);
    for (const pageId of BODY_PAGES) await renderPage(root, pageId);

    const composed = await call(root, "compose_deck", { title: COMPOSE_TITLE });
    assert.equal(composed.ok, true, composed.detail);
  });
});
