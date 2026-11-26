import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { excludedToolsFor, sessionProduceToolAllowlist } from "./produce-tool-policy.js";
import { SliceSessionStore } from "./slice-session.js";

test("ordinary generation keeps edit_elements hidden until an active elements scope exists", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "edit-elements-allowlist-"));
  const store = new SliceSessionStore(workspace);
  const sessionId = "edit-elements-allowlist";
  const opened = store.openProject({
    dshSessionId: sessionId,
    title: "Allowlist",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "test" },
  });
  const projectRoot = store.resolveRoot(opened.binding);
  const deps = {
    store,
    provider: { providerId: "test", modelId: "test", ready: true },
  };
  const ordinary = sessionProduceToolAllowlist(deps, sessionId);
  assert.equal(ordinary.has("edit_elements"), false);
  assert.equal(ordinary.has("render_deck"), false);
  assert.equal(ordinary.has("review_deck"), false);

  // The runtime never offers what the turn allowlist hides.
  const ordinaryExcluded = excludedToolsFor(ordinary);
  assert.equal(ordinaryExcluded.has("edit_elements"), true);
  assert.equal(ordinaryExcluded.has("web_search"), true);
  assert.equal(ordinaryExcluded.has("open_in_editor"), true);

  fs.mkdirSync(path.join(projectRoot, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "_agent", "ai-review-lock.v1.json"),
    JSON.stringify({
      pagePath: "pages/page-1.page",
      scope: { kind: "elements", pageId: "page-1", elementIds: ["title"] },
      expiresAt: Date.now() + 60_000,
    }),
  );
  const scoped = sessionProduceToolAllowlist(deps, sessionId);
  // A page-scoped editor turn never defines layouts: write_layout is the one generation tool it drops.
  assert.equal(ordinary.has("write_layout"), true);
  assert.equal(scoped.has("write_layout"), false);
  assert.equal(scoped.size, ordinary.size - 1);
  assert.equal(scoped.has("edit_elements"), true);
  assert.equal(scoped.has("write_page"), false);
  const scopedExcluded = excludedToolsFor(scoped);
  assert.equal(scopedExcluded.has("edit_elements"), false);
  assert.equal(scopedExcluded.has("write_page"), true);

  fs.writeFileSync(
    path.join(projectRoot, "_agent", "ai-review-lock.v1.json"),
    JSON.stringify({
      pagePath: "pages/page-1.page",
      scope: { kind: "elements", pageId: "page-1", elementIds: ["title"] },
      expiresAt: Date.now() - 1,
    }),
  );
  assert.equal(sessionProduceToolAllowlist(deps, sessionId).has("edit_elements"), false);

  for (const kind of ["page", "deck"]) {
    fs.writeFileSync(
      path.join(projectRoot, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        pagePath: "pages/page-1.page",
        scope: { kind, pageId: "page-1", elementIds: [] },
        expiresAt: Date.now() + 60_000,
      }),
    );
    const wholePage = sessionProduceToolAllowlist(deps, sessionId);
    // The review lock adds edit_page_background and drops the generation-only write_layout.
    assert.equal(wholePage.size, ordinary.size);
    assert.equal(wholePage.has("write_layout"), false);
    assert.equal(wholePage.has("edit_page_background"), true);
    assert.equal(wholePage.has("edit_elements"), false);
    assert.equal(wholePage.has("write_page"), true);
  }
});
