import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { currentLayoutRevision, latestLayoutFacts, recordLayoutRevision } from "./layout-ledger.js";
import { ensureRunLedger, readRunLedger } from "./run-ledger.js";

const context = { commandId: "layout-ledger-fixture", contextEpochId: "layout-ledger-epoch" };

function fixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "layout-ledger-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
  });
  return root;
}

it("records an editor-authored layout revision after an agent revision", (t) => {
  const root = fixture(t);
  const agent = recordLayoutRevision(root, context, {
    scope: "layout",
    layoutId: "body",
    layoutSha256: "sha-agent",
    source: "agent",
  });
  assert.equal(agent.revision, 1);
  assert.equal(agent.source, "agent");

  const editor = recordLayoutRevision(root, context, {
    scope: "layout",
    layoutId: "body",
    layoutSha256: "sha-editor",
    source: "editor",
  });
  assert.equal(editor.type, "layout.revision-committed");
  assert.equal(editor.revision, 2, "an editor commit is the next layout revision");
  assert.equal(editor.source, "editor");

  assert.deepEqual(currentLayoutRevision(root, "layout", "body"), editor);
  const ledger = readRunLedger(root);
  assert.ok(ledger, "the ledger reads back after the editor fact is appended");
  const stored = latestLayoutFacts(ledger).get("layout/body");
  assert.equal(stored?.source, "editor");
  assert.equal(stored?.layoutSha256, "sha-editor");
});

it("keeps the current fact when an editor commit leaves the layout sha unchanged", (t) => {
  const root = fixture(t);
  const first = recordLayoutRevision(root, context, {
    scope: "master",
    layoutId: "brand",
    layoutSha256: "sha-brand",
    source: "editor",
  });
  const again = recordLayoutRevision(root, context, {
    scope: "master",
    layoutId: "brand",
    layoutSha256: "sha-brand",
    source: "editor",
  });
  assert.equal(again.factId, first.factId, "an identical sha appends no new revision");
  assert.equal(again.revision, 1);
});
