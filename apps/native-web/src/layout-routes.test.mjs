import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import * as canvas from "@open-slidestudio/canvas-session";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { ensureRunLedger, readRunLedger, recordLayoutRevision } from "@open-slidestudio/presentation-run";
import { LAYOUT_COMMAND_PATH, LAYOUT_CONTROL_IDS, handleLayoutRoutes } from "./layout-routes.mjs";

// Layout-mode commands over the injectable POST /api/layout/command route, served by a minimal
// node:http server whose context wraps the real canvas session: request shape, Chinese refusals,
// persistence to deck.pptd and the page files, the AI review lock, the write guard, and the
// editor's layout revisions in the run ledger (masters-layouts §5, VAL-LAYOUT-008 editor half).
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = path.join(REPO, "test-fixtures/layouts-project");
const TAB = "tab-layout-routes";
const CONTROLS = [...LAYOUT_CONTROL_IDS, "chrome.pages.navigate"];

/** @type {string[]} */
const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function freshDeck() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slidestudio-layout-routes-"));
  fs.cpSync(FIXTURE, root, { recursive: true });
  roots.push(root);
  return root;
}

/** @param {import("node:http").IncomingMessage} req */
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
}

/**
 * A fake server context over the real canvas session, recording guard and persist calls.
 * @param {{ lock?: any, guardError?: Error }} [options]
 */
function harness(options = {}) {
  /** @type {Map<string, { session: any, diskRevision: string | null }>} */
  const entries = new Map();
  const state = { lock: options.lock ?? null, guardError: options.guardError, revision: 0 };
  /** @type {{ guard: string[], persisted: number, initial: number }} */
  const calls = { guard: [], persisted: 0, initial: 0 };
  const entryFor = (/** @type {string} */ root, /** @type {string} */ tab) => {
    const key = `${path.resolve(root)}\0${tab}`;
    if (!entries.has(key)) entries.set(key, { session: null, diskRevision: null });
    return /** @type {{ session: any, diskRevision: string | null }} */ (entries.get(key));
  };
  /** @type {any} */
  const base = {
    native: { canvas },
    json: (/** @type {any} */ res, /** @type {number} */ status, /** @type {unknown} */ body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    },
    readBody: readJson,
    projectForRequest: (/** @type {URL} */ url, /** @type {any} */ body) => {
      const hint = url.searchParams.get("project") ?? body?.project;
      if (!hint || !fs.existsSync(hint)) {
        throw Object.assign(new Error(`project not found: ${hint}`), { statusCode: 404 });
      }
      return path.resolve(hint);
    },
    tabIdFor: (/** @type {URL} */ url) => url.searchParams.get("tab") ?? "default",
    ensureSession: (
      /** @type {any} */ _native,
      /** @type {string} */ root,
      /** @type {any} */ _hint,
      /** @type {string} */ tab,
    ) => {
      const entry = entryFor(root, tab);
      if (!entry.session) {
        entry.session = canvas.openSession(root, { allowedControlIds: CONTROLS });
        entry.diskRevision = "rev-0";
      }
      return entry.session;
    },
    liveEntryFor: entryFor,
    activeReviewAiLock: () => state.lock,
    guardWrite: async (/** @type {string} */ root, /** @type {string} */ tab) => {
      calls.guard.push(`${path.basename(root)}:${tab}:persisted=${calls.persisted}`);
      if (state.guardError) throw state.guardError;
    },
    ensureInitialVersion: () => void calls.initial++,
    persistLiveSession: (
      /** @type {any} */ _native,
      /** @type {any} */ s,
      /** @type {string} */ root,
      /** @type {any} */ prior,
      /** @type {string} */ tab,
    ) => {
      const entry = entryFor(root, tab);
      if (entry.session !== prior) throw Object.assign(new Error("stale"), { statusCode: 409 });
      canvas.persist(s);
      entry.session = s;
      entry.diskRevision = `rev-${++state.revision}`;
      calls.persisted++;
    },
    liveModel: (/** @type {any} */ _native, /** @type {any} */ s) => canvas.renderModel(s),
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    handleLayoutRoutes({ ...base, req, res, url }).then((handled) => {
      if (!handled) base.json(res, 404, { error: "not a layout route" });
    });
  });
  return { server, state, calls, entryFor };
}

/** @type {import("node:http").Server[]} */
const servers = [];
after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

/** @param {{ lock?: any, guardError?: Error }} [options] */
async function start(options) {
  const h = harness(options);
  await new Promise((resolve) => h.server.listen(0, "127.0.0.1", () => resolve(undefined)));
  servers.push(h.server);
  const address = /** @type {import("node:net").AddressInfo} */ (h.server.address());
  const base = `http://127.0.0.1:${address.port}`;
  /** @param {string} root @param {unknown} body @param {string} [route] */
  const command = async (root, body, route = LAYOUT_COMMAND_PATH) => {
    const query = new URLSearchParams({ project: root, tab: TAB });
    const response = await fetch(`${base}${route}?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...h, command };
}

/** @param {string} root @param {string} id */
function savedLayout(root, id) {
  return (loadProject(root).presentation.layouts ?? []).find((layout) => layout.id === id);
}

/** @param {string} root @param {string} file */
function savedPage(root, file) {
  const entry = loadProject(root).pages.find((item) => item.path.endsWith(file));
  return /** @type {any} */ (entry?.page);
}

describe("layout mode over POST /api/layout/command", () => {
  it("enters a layout with the double-clicked element selected and lists every layout", async () => {
    const { command } = await start();
    const root = freshDeck();
    const entered = await command(root, { cmd: "layoutEnter", layoutId: "body", elementId: "logo-b" });
    assert.equal(entered.status, 200, entered.body.error);
    assert.deepEqual(entered.body.model.layoutPanel.surface, {
      kind: "layout",
      layoutId: "body",
      name: "正文",
      useCount: 22,
    });
    assert.deepEqual(entered.body.model.layoutPanel.layouts, [
      { id: "cover", name: "封面", useCount: 1 },
      { id: "body", name: "正文", useCount: 22 },
    ]);
    assert.equal(entered.body.model.selection.elementId, "logo-b");
    assert.equal(typeof entered.body.revision, "string");
    assert.ok(Array.isArray(entered.body.thumbs));
  });

  it("lists the master and returns to page mode with 完成, without any write", async () => {
    const { command, calls } = await start();
    const root = freshDeck();
    const master = await command(root, { cmd: "layoutSelect", scope: "master" });
    assert.equal(master.status, 200, master.body.error);
    assert.deepEqual(master.body.model.layoutPanel.surface, { kind: "master", name: "母版" });
    assert.deepEqual(master.body.model.layoutPanel.master, { id: "main", name: "母版" });
    const exited = await command(root, { cmd: "layoutExit" });
    assert.equal(exited.status, 200, exited.body.error);
    assert.deepEqual(exited.body.model.layoutPanel.surface, { kind: "page" });
    assert.deepEqual(calls.guard, [], "surface moves never ask the write guard");
    assert.equal(calls.persisted, 0);
  });

  it("sends a miniature of the master and each layout only while a layout surface is open", async () => {
    const { command } = await start();
    const root = freshDeck();
    const entered = await command(root, { cmd: "layoutEnter", layoutId: "body" });
    assert.equal(entered.status, 200, entered.body.error);
    const previews = entered.body.model.layoutPreviews;
    assert.deepEqual(
      previews.map((/** @type {any} */ { scope, id }) => [scope, id]),
      [
        ["master", "main"],
        ["layout", "cover"],
        ["layout", "body"],
      ],
    );
    const body = previews.find((/** @type {any} */ row) => row.id === "body").model;
    assert.deepEqual(body.size, [960, 540]);
    assert.ok(body.elements.some((/** @type {any} */ element) => element.id === "logo-b"));
    const exited = await command(root, { cmd: "layoutExit" });
    assert.equal("layoutPreviews" in exited.body.model, false);
  });

  it("refuses an unknown layout, and a layout switch made from inside a layout", async () => {
    const { command } = await start();
    const root = freshDeck();
    const missing = await command(root, { cmd: "layoutEnter", layoutId: "nope" });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "未找到版式：nope");
    assert.ok(missing.body.model, "a refusal still returns the live model");
    const entered = await command(root, { cmd: "layoutEnter", layoutId: "body" });
    assert.equal(entered.status, 200, entered.body.error);
    const applied = await command(root, { cmd: "layoutApply", layoutId: "cover" });
    assert.equal(applied.status, 400);
    assert.equal(applied.body.error, "请先点击「完成」退出版式编辑，再切换版式");
  });

  it("creates, renames and deletes an unused layout, refusing an illegal name", async () => {
    const { command } = await start();
    const root = freshDeck();
    const created = await command(root, { cmd: "layoutCreate", name: "封面备用" });
    assert.equal(created.status, 200, created.body.error);
    const id = created.body.model.layoutPanel.surface.layoutId;
    assert.deepEqual(
      created.body.model.layoutPanel.layouts.find((/** @type {any} */ row) => row.id === id),
      { id, name: "封面备用", useCount: 0 },
    );
    const renamed = await command(root, { cmd: "layoutRename", layoutId: id, name: "备用版式" });
    assert.equal(renamed.status, 200, renamed.body.error);
    assert.equal(savedLayout(root, id)?.name, "备用版式");
    const illegal = await command(root, { cmd: "layoutRename", layoutId: id, name: "a<b" });
    assert.equal(illegal.status, 400);
    assert.equal(illegal.body.error, "版式名称不能包含 < > & \" '");
    const empty = await command(root, { cmd: "layoutRename", layoutId: id, name: "  " });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, "版式名称不能为空");
    assert.equal((await command(root, { cmd: "layoutExit" })).status, 200);
    const deleted = await command(root, { cmd: "layoutDelete", layoutId: id });
    assert.equal(deleted.status, 200, deleted.body.error);
    assert.deepEqual(
      (loadProject(root).presentation.layouts ?? []).map((layout) => layout.id),
      ["cover", "body"],
    );
  });

  it("deletes a layout in use only after confirmation, and keeps the pages' own content", async () => {
    const { command } = await start();
    const root = freshDeck();
    const refused = await command(root, { cmd: "layoutDelete", layoutId: "body" });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "版式『正文』正在使用，删除后 22 页会失去版式内容，请确认后删除");
    assert.ok(savedLayout(root, "body"), "a refused delete keeps the layout");
    const confirmed = await command(root, { cmd: "layoutDelete", layoutId: "body", confirmed: true });
    assert.equal(confirmed.status, 200, confirmed.body.error);
    const page = savedPage(root, "03-body.page");
    assert.equal(page.layoutId, undefined);
    assert.equal(
      page.elements.some((/** @type {any} */ el) => String(el.elementId).startsWith("lyt-body-")),
      false,
    );
    assert.equal(savedPage(root, "01-cover.page").layoutId, "cover");
  });

  it("applies a layout to the current page, and 无版式 removes its copies", async () => {
    const { command, entryFor } = await start();
    const root = freshDeck();
    assert.equal((await command(root, { cmd: "layoutExit" })).status, 200);
    canvas.goToPage(entryFor(root, TAB).session, 2);
    const applied = await command(root, { cmd: "layoutApply", layoutId: "cover" });
    assert.equal(applied.status, 200, applied.body.error);
    assert.equal(applied.body.model.layoutPanel.pageLayoutId, "cover");
    const withCover = savedPage(root, "03-body.page");
    assert.equal(withCover.layoutId, "cover");
    assert.ok(withCover.elements.some((/** @type {any} */ el) => el.elementId === "lyt-cover-arc"));
    const none = await command(root, { cmd: "layoutApply", layoutId: null });
    assert.equal(none.status, 200, none.body.error);
    assert.equal(none.body.model.layoutPanel.pageLayoutId, undefined);
    const plain = savedPage(root, "03-body.page");
    assert.equal(plain.layoutId, undefined);
    assert.equal(
      plain.elements.some((/** @type {any} */ el) => el.inherited !== undefined),
      false,
    );
  });

  it("inserts a page number that shows the page's number, or ‹#› on a layout", async () => {
    const { command } = await start();
    const root = freshDeck();
    const onPage = await command(root, { cmd: "insertPageNumber" });
    assert.equal(onPage.status, 200, onPage.body.error);
    const pageNumber = savedPage(root, "01-cover.page").elements.find(
      (/** @type {any} */ el) => el.elementId === "pagenumber-1",
    );
    assert.equal(pageNumber.content.field, "pageNumber");
    assert.equal(pageNumber.content.text, "{page}");
    assert.equal((await command(root, { cmd: "layoutEnter", layoutId: "body" })).status, 200);
    const onLayout = await command(root, { cmd: "insertPageNumber" });
    assert.equal(onLayout.status, 200, onLayout.body.error);
    assert.ok(savedLayout(root, "body")?.elements?.some((el) => el.elementId === "pagenumber-1"));
    const shown = onLayout.body.model.elements.find((/** @type {any} */ el) => el.id === "pagenumber-1");
    assert.equal(shown?.text, "‹#›");
  });
});

describe("layout route guards", () => {
  it("answers only its own path and method", async () => {
    const { command } = await start();
    const root = freshDeck();
    const other = await command(root, { cmd: "layoutExit" }, "/api/command");
    assert.equal(other.status, 404);
    assert.equal(other.body.error, "not a layout route");
  });

  it("refuses a malformed body, an unknown cmd and an unknown project", async () => {
    const { command } = await start();
    const root = freshDeck();
    assert.equal((await command(root, "{not json")).status, 400);
    const unknown = await command(root, { cmd: "setBounds" });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, "LAYOUT_COMMAND_UNKNOWN");
    const missing = await command(path.join(root, "nope"), { cmd: "layoutExit" });
    assert.equal(missing.status, 404);
  });

  it("answers 423 under the AI review lock and writes nothing", async () => {
    const { command, calls } = await start({ lock: { pagePath: "pages/01-cover.page" } });
    const root = freshDeck();
    const before = fs.readFileSync(path.join(root, "deck.pptd"), "utf8");
    for (const body of [{ cmd: "layoutCreate" }, { cmd: "layoutEnter", layoutId: "body" }]) {
      const locked = await command(root, body);
      assert.equal(locked.status, 423);
      assert.equal(locked.body.code, "AI_REVIEW_LOCKED");
      assert.equal(locked.body.pagePath, "pages/01-cover.page");
    }
    assert.deepEqual(calls.guard, []);
    assert.equal(fs.readFileSync(path.join(root, "deck.pptd"), "utf8"), before);
  });

  it("asks the write guard before the first disk write and honours its refusal", async () => {
    const refusal = Object.assign(new Error("另一个编辑者正在写入"), {
      statusCode: 423,
      code: "EDITOR_WRITER_LEASE_HELD",
    });
    const refusedServer = await start({ guardError: refusal });
    const root = freshDeck();
    const before = fs.readFileSync(path.join(root, "deck.pptd"), "utf8");
    const refused = await refusedServer.command(root, { cmd: "layoutCreate" });
    assert.equal(refused.status, 423);
    assert.equal(refused.body.code, "EDITOR_WRITER_LEASE_HELD");
    assert.equal(refusedServer.calls.persisted, 0);
    assert.equal(refusedServer.calls.initial, 0, "no baseline version before the guard passes");
    assert.equal(fs.readFileSync(path.join(root, "deck.pptd"), "utf8"), before);

    const allowed = await start();
    const created = await allowed.command(root, { cmd: "layoutCreate" });
    assert.equal(created.status, 200, created.body.error);
    assert.deepEqual(allowed.calls.guard, [`${path.basename(root)}:${TAB}:persisted=0`]);
    assert.equal(allowed.calls.initial, 1);
    assert.equal(allowed.calls.persisted, 1);
  });

  it("refuses a deck change issued against a stale revision", async () => {
    const { command } = await start();
    const root = freshDeck();
    assert.equal((await command(root, { cmd: "layoutExit" })).status, 200);
    const stale = await command(root, { cmd: "layoutCreate", baseRevision: "rev-old" });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "BASE_REVISION_STALE");
    assert.equal(stale.body.revision, "rev-0");
  });
});

describe("editor layout revisions in the run ledger", () => {
  /** @param {string} root */
  const layoutFacts = (root) =>
    (readRunLedger(root)?.facts ?? []).filter((fact) => fact.type === "layout.revision-committed");

  it("records each editor layout change as a layout revision with source editor", async () => {
    const { command } = await start();
    const root = freshDeck();
    ensureRunLedger(root, { manifestSha256: "a".repeat(64), requirementsId: "b".repeat(64), requirements: [] });
    recordLayoutRevision(
      root,
      { commandId: "seed-cover", contextEpochId: "epoch-seed" },
      { scope: "layout", layoutId: "cover", layoutSha256: "c".repeat(64), source: "agent" },
    );
    const renamed = await command(root, { cmd: "layoutRename", layoutId: "body", name: "正文二" });
    assert.equal(renamed.status, 200, renamed.body.error);
    let body = layoutFacts(root).filter((/** @type {any} */ fact) => fact.layoutId === "body");
    assert.equal(body.length, 1);
    assert.equal(/** @type {any} */ (body[0]).source, "editor");
    assert.equal(/** @type {any} */ (body[0]).contextEpochId, "epoch-seed");
    assert.equal(/** @type {any} */ (body[0]).revision, 1);
    const back = await command(root, { cmd: "layoutRename", layoutId: "body", name: "正文" });
    assert.equal(back.status, 200, back.body.error);
    body = layoutFacts(root).filter((/** @type {any} */ fact) => fact.layoutId === "body");
    assert.equal(/** @type {any} */ (body.at(-1)).revision, 2, "each changed definition is a revision");
    const cover = layoutFacts(root).filter((/** @type {any} */ fact) => fact.layoutId === "cover");
    assert.deepEqual(
      cover.map((/** @type {any} */ fact) => fact.source),
      ["agent"],
      "the agent's fact is kept",
    );
  });

  it("records no layout revision for a project without a generation ledger", async () => {
    const { command } = await start();
    const root = freshDeck();
    const renamed = await command(root, { cmd: "layoutRename", layoutId: "body", name: "正文二" });
    assert.equal(renamed.status, 200, renamed.body.error);
    assert.equal(readRunLedger(root), undefined, "no ledger is created by an editor edit");
  });
});
