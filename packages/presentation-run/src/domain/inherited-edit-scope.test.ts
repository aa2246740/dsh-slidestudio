import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject, ownPageBody, saveProject, type Page, type TextElement } from "@open-slidestudio/pptd-v2";
import { persistWrittenPages } from "./agent-tools.js";
import { pageRevisionSha256 } from "./hashing.js";
import { persistPageKey } from "./layout-qa.js";
import { loadPlaybook } from "./playbook.js";
import type { SkillPageInput } from "./skill-pages.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const fixture = path.join(repoRoot, "test-fixtures", "layouts-project");
const PAGE_ID = "02-body";

/** The human review lock the sidecar writes: pageBody is the FULL snapshot, copies included. */
function lockedProject(elementIds: readonly string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inherited-edit-scope-"));
  fs.cpSync(fixture, root, { recursive: true });
  saveProject(loadProject(root));
  const loaded = loadProject(root).pages.find((entry) => entry.path === `pages/${PAGE_ID}.page`)!;
  assert.ok(
    loaded.page.elements.some((element) => element.inherited !== undefined),
    "fixture page must carry inherited copies",
  );
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "ai-review-lock.v1.json"),
    JSON.stringify({
      pagePath: `pages/${PAGE_ID}.page`,
      expiresAt: Date.now() + 60_000,
      scope: { kind: "elements", pageId: PAGE_ID, elementIds },
      pageBody: structuredClone(loaded.page),
    }),
  );
  const state = {
    brief: "inherited layout element edit",
    playbook: loadPlaybook({ hostDefaults: false }),
    todos: [],
    researchNotes: [],
    writtenPages: [],
    projectRoot: root,
  };
  const sha = pageRevisionSha256(loaded.page, persistPageKey(loaded.path));
  /** What edit_elements submits: the page's own body with the given text replaced. */
  const proposal = (texts: Record<string, string>): SkillPageInput => {
    const own = structuredClone(ownPageBody(loaded.page)) as Page;
    for (const element of own.elements) {
      const text = texts[element.elementId];
      if (text !== undefined) (element as TextElement).content.text = text;
    }
    return { ...own, id: PAGE_ID } as unknown as SkillPageInput;
  };
  return { root, state, sha, proposal, loaded };
}

describe("element review guard on a page that inherits layout copies", () => {
  it("accepts a change to the target element when the baseline is the full snapshot", () => {
    const f = lockedProject(["title"]);
    const result = persistWrittenPages(f.state, [f.proposal({ title: "新的标题" })], {
      expectedPageSha256: f.sha,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const after = loadProject(f.root).pages.find((entry) => entry.path === `pages/${PAGE_ID}.page`)!;
    const title = after.page.elements.find((element) => element.elementId === "title") as TextElement;
    assert.equal(title.content.text, "新的标题");
    assert.deepEqual(
      after.page.elements.filter((element) => element.inherited).map((element) => element.elementId),
      f.loaded.page.elements.filter((element) => element.inherited).map((element) => element.elementId),
    );
  });

  it("still refuses a change to an own element outside the target", () => {
    const f = lockedProject(["title"]);
    const before = fs.readFileSync(path.join(f.root, "pages", `${PAGE_ID}.page`), "utf8");
    const result = persistWrittenPages(f.state, [f.proposal({ "body-text": "越权改动" })], {
      expectedPageSha256: f.sha,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "review_scope_violation");
    assert.match(String(result.detail), /Unselected elements would change: body-text/);
    assert.equal(fs.readFileSync(path.join(f.root, "pages", `${PAGE_ID}.page`), "utf8"), before);
  });

  it("still refuses reordering or dropping own elements", () => {
    const f = lockedProject(["title"]);
    const reordered = f.proposal({ title: "新的标题" });
    reordered.elements.reverse();
    const result = persistWrittenPages(f.state, [reordered], { expectedPageSha256: f.sha });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "review_scope_violation");
    assert.match(String(result.detail), /layer order/);
  });

  it("still refuses page settings changes such as notes", () => {
    const f = lockedProject(["title"]);
    const proposed = { ...f.proposal({ title: "新的标题" }), notes: "越权备注" };
    const result = persistWrittenPages(f.state, [proposed], { expectedPageSha256: f.sha });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "review_scope_violation");
    assert.match(String(result.detail), /Page settings/);
  });

  it("fails closed when the persisted element baseline is missing", () => {
    const f = lockedProject(["title"]);
    const lockPath = path.join(f.root, "_agent", "ai-review-lock.v1.json");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    delete lock.pageBody;
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    const result = persistWrittenPages(f.state, [f.proposal({ title: "新的标题" })], {
      expectedPageSha256: f.sha,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "review_scope_violation");
  });
});
