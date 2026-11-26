import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import * as pptd from "@open-slidestudio/pptd-v2";
import * as presentation from "@open-slidestudio/presentation-run";
import {
  captureLayoutGrant,
  definitionShas,
  expectedLayoutSha256,
  grantedLayoutId,
  judgeWorkspaceRecord,
  layoutGrant,
  layoutLockPayload,
  pageFacts,
} from "./server-layout-scope.mjs";

// Layout-mode AI lock rules (masters-layouts §5.2) at the function level: what a layout grant
// covers, the hash the turn must echo, and how verification judges moved layouts and pages. The
// lock acquisition and verify routes that call these helpers live in server.mjs.
const { loadProject, saveProject } = pptd;
const { stableSha256 } = presentation;

/** @type {string[]} */
const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const LAYOUT_KEYS = ["id", "name", "masterId", "showMasterElements", "background", "elements", "slots", "archetype"];

/** @param {string} src */
function logo(src) {
  return { elementId: "logo", elementType: "image", bounds: [860, 20, 80, 40], src };
}

/** @param {string} elementId @param {string} text */
function textElement(elementId, text) {
  return { elementId, elementType: "text", bounds: [80, 80, 800, 60], content: { text, fontSize: 32 } };
}

/** @param {Record<string, any>} layout */
function pickedLayout(layout) {
  return Object.fromEntries(LAYOUT_KEYS.filter((key) => layout[key] !== undefined).map((key) => [key, layout[key]]));
}

function standardLayouts(logoSrc = "media/logo-a.png") {
  return [
    { id: "body", name: "正文", elements: [logo(logoSrc)] },
    { id: "cover", name: "封面", elements: [] },
  ];
}

/** Two pages use the body layout; the cover page uses cover. */
function standardPages({ one = "One", two = "Two", cover = "Cover" } = {}) {
  return [
    { file: "01_page.page", layoutId: "body", text: one },
    { file: "02_page.page", layoutId: "body", text: two },
    { file: "03_page.page", layoutId: "cover", text: cover },
  ];
}

/**
 * Saving is how the product refreshes every using page's layout copies, so the fixture saves too.
 * @param {string} root
 * @param {{ layouts: any[], pages: { file: string, layoutId: string, text: string }[] }} deck
 */
function writeDeck(root, { layouts, pages }) {
  fs.mkdirSync(path.join(root, "pages"), { recursive: true });
  const deck = {
    version: "v2",
    title: "版式授权",
    size: [960, 540],
    theme: {},
    pages: pages.map((page) => `pages/${page.file}`),
    layouts,
  };
  fs.writeFileSync(path.join(root, "deck.pptd"), `${JSON.stringify(deck)}\n`);
  for (const page of pages) {
    const body = {
      pageType: "content",
      layoutId: page.layoutId,
      elements: [textElement(`${page.file}-title`, page.text)],
    };
    fs.writeFileSync(path.join(root, "pages", page.file), `${JSON.stringify(body)}\n`);
  }
  saveProject(loadProject(root));
}

function deckRoot({ layouts = standardLayouts(), pages = standardPages() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slidestudio-layout-scope-"));
  roots.push(root);
  writeDeck(root, { layouts, pages });
  return root;
}

/** What verification reads from disk: every page's facts and every definition's hash. @param {string} root */
function snapshot(root) {
  const project = loadProject(root);
  return {
    project,
    pages: project.pages.map((entry) => pageFacts(entry, presentation, pptd)),
    definitions: definitionShas(project.presentation, stableSha256),
  };
}

/** A lock as server.mjs stores it after acquiring the grant. @param {string} root @param {Record<string, unknown>} grant */
function acquire(root, grant) {
  const before = snapshot(root);
  return { scope: { ...grant, layoutShas: before.definitions }, projectPages: before.pages };
}

const bodyGrant = (layoutId = "body") => ({ editableMeta: ["layouts"], layoutId });
const VERDICT = { changed: false, targetChanged: false, scopeViolation: false };

describe("layout grant", () => {
  it("grants one layout and every page that uses it, with the saved layout's hash", () => {
    const root = deckRoot();
    const grant = layoutGrant(snapshot(root).project, bodyGrant(), "01_page", ["01_page"]);
    assert.ok(grant);
    assert.equal(grant.layoutId, "body");
    assert.equal(grant.layoutName, "正文");
    assert.deepEqual(grant.pageIds, ["01_page", "02_page"]);
    assert.equal(/** @type {any} */ (grant.definition).elements[0].src, "media/logo-a.png");
    const payload = layoutLockPayload(grant, presentation, root);
    assert.deepEqual(payload && { id: payload.id, name: payload.name }, { id: "body", name: "正文" });
    assert.equal(payload?.layoutSha256, stableSha256(pickedLayout(standardLayouts()[0])));
    assert.equal(expectedLayoutSha256(presentation, root, "body"), payload?.layoutSha256);
    assert.equal(layoutLockPayload(undefined, presentation, root), undefined);
  });

  it("grants nothing for a lock without the layouts field", () => {
    const root = deckRoot();
    assert.equal(layoutGrant(snapshot(root).project, { editableMeta: ["title"] }, "01_page", []), undefined);
    assert.equal(grantedLayoutId(undefined), undefined);
    assert.equal(grantedLayoutId({ editableMeta: ["layouts"] }), "");
  });

  it("refuses a missing layout and a requested page that does not use the layout", () => {
    const { project } = snapshot(deckRoot());
    assert.throws(() => layoutGrant(project, bodyGrant("missing"), "01_page", ["01_page"]), {
      code: "WORKSPACE_EDIT_SCOPE_INVALID",
    });
    assert.throws(() => layoutGrant(project, bodyGrant(), "01_page", ["01_page", "03_page"]), {
      code: "WORKSPACE_EDIT_SCOPE_STALE",
    });
  });

  it("a layout no page uses covers only the anchor page", () => {
    const layouts = [...standardLayouts(), { id: "appendix", name: "附录", elements: [logo("media/x.png")] }];
    const grant = layoutGrant(snapshot(deckRoot({ layouts })).project, bodyGrant("appendix"), "01_page", ["01_page"]);
    assert.deepEqual(grant?.pageIds, ["01_page"]);
  });
});

describe("layout grant request shape", () => {
  const raw = { kind: "page", editableMeta: ["layouts"], layoutId: "body", elementIds: [] };

  it("accepts a page-kind lock naming one layout and leaves other requests to the caller", () => {
    assert.deepEqual(captureLayoutGrant(raw), { editableMeta: ["layouts"], layoutId: "body" });
    assert.equal(captureLayoutGrant({ kind: "page", editableMeta: ["title"] }), undefined);
    assert.equal(captureLayoutGrant({ kind: "page" }), undefined);
  });

  it("refuses a grant that mixes fields, lacks a layout or targets elements", () => {
    for (const bad of [
      { ...raw, editableMeta: ["layouts", "title"] },
      { ...raw, layoutId: "" },
      { ...raw, layoutId: undefined },
      { ...raw, elementIds: ["logo"] },
      { ...raw, kind: "pages" },
      { ...raw, metaOnly: true },
      { ...raw, structureOnly: true },
      { ...raw, rewrite: true },
    ]) {
      assert.throws(() => captureLayoutGrant(bad), { code: "WORKSPACE_EDIT_SCOPE_INVALID" }, JSON.stringify(bad));
    }
  });
});

describe("layout-mode verification", () => {
  it("accepts a logo replaced in the layout and the moved copies on every using page", () => {
    const root = deckRoot();
    const lock = acquire(root, bodyGrant());
    writeDeck(root, { layouts: standardLayouts("media/logo-b.png"), pages: standardPages() });
    const verdict = judgeWorkspaceRecord(VERDICT, lock, snapshot(root));
    assert.equal(verdict.changed, true);
    assert.equal(verdict.targetChanged, true);
    assert.equal(verdict.scopeViolation, false);
    assert.deepEqual(verdict.changedLayoutIds, ["body"]);
    assert.deepEqual(verdict.ownChangedPageIds, []);
    assert.deepEqual(verdict.unauthorizedLayoutCopyPageIds, []);
  });

  it("refuses an edit to the own content of a page that uses the layout", () => {
    const root = deckRoot();
    const lock = acquire(root, bodyGrant());
    writeDeck(root, { layouts: standardLayouts("media/logo-b.png"), pages: standardPages({ two: "Rewritten" }) });
    const verdict = judgeWorkspaceRecord(VERDICT, lock, snapshot(root));
    assert.equal(verdict.scopeViolation, true);
    assert.deepEqual(verdict.ownChangedPageIds, ["02_page"]);
  });

  it("refuses a change to a page that does not use the layout", () => {
    const root = deckRoot();
    const lock = acquire(root, bodyGrant());
    writeDeck(root, { layouts: standardLayouts("media/logo-b.png"), pages: standardPages({ cover: "Changed" }) });
    const verdict = judgeWorkspaceRecord(VERDICT, lock, snapshot(root));
    assert.equal(verdict.scopeViolation, true);
    assert.deepEqual(verdict.unauthorizedLayoutCopyPageIds, ["03_page"]);
  });

  it("refuses a change to a layout other than the granted one", () => {
    const root = deckRoot();
    const lock = acquire(root, bodyGrant());
    const layouts = [
      { id: "body", name: "正文", elements: [logo("media/logo-b.png")] },
      { id: "cover", name: "封面", elements: [logo("media/cover-b.png")] },
    ];
    writeDeck(root, { layouts, pages: standardPages() });
    const verdict = judgeWorkspaceRecord(VERDICT, lock, snapshot(root));
    assert.equal(verdict.scopeViolation, true);
    assert.deepEqual(verdict.changedLayoutIds, ["body", "cover"]);
  });

  it("judges a layout that no page uses by its own hash", () => {
    const appendix = (/** @type {string} */ src) => ({ id: "appendix", name: "附录", elements: [logo(src)] });
    const root = deckRoot({ layouts: [...standardLayouts(), appendix("media/appendix-a.png")] });
    const lock = acquire(root, bodyGrant("appendix"));
    writeDeck(root, { layouts: [...standardLayouts(), appendix("media/appendix-b.png")], pages: standardPages() });
    const verdict = judgeWorkspaceRecord(VERDICT, lock, snapshot(root));
    assert.equal(verdict.targetChanged, true);
    assert.equal(verdict.scopeViolation, false);
    assert.deepEqual(verdict.changedLayoutIds, ["appendix"]);
  });

  it("refuses a page-mode turn that moves a layout definition, and keeps a quiet one clean", () => {
    const appendix = (/** @type {string} */ src) => ({ id: "appendix", name: "附录", elements: [logo(src)] });
    const root = deckRoot({ layouts: [...standardLayouts(), appendix("media/appendix-a.png")] });
    const lock = acquire(root, { kind: "page" });
    const quiet = judgeWorkspaceRecord(VERDICT, lock, snapshot(root));
    assert.equal(quiet.scopeViolation, false);
    assert.deepEqual(quiet.changedLayoutIds, []);
    writeDeck(root, { layouts: [...standardLayouts(), appendix("media/appendix-b.png")], pages: standardPages() });
    const verdict = judgeWorkspaceRecord(VERDICT, lock, snapshot(root));
    assert.equal(verdict.scopeViolation, true);
    assert.deepEqual(verdict.changedLayoutIds, ["appendix"]);
    assert.equal("ownChangedPageIds" in verdict, false);
  });

  it("keeps a violation the page checks already found", () => {
    const root = deckRoot();
    const lock = acquire(root, bodyGrant());
    const verdict = judgeWorkspaceRecord({ ...VERDICT, scopeViolation: true }, lock, snapshot(root));
    assert.equal(verdict.scopeViolation, true);
    assert.equal(verdict.changed, false);
  });
});
