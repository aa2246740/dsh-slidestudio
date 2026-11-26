import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { EDITOR_AUTHORITY_LOST_DETAIL, editorTurnAuthorityLost, recordEditorTurn } from "./editor-turn-authority.js";

function projectRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "editor-turn-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "_agent"));
  return root;
}

function writeLease(root: string, expiresAt: number): void {
  fs.writeFileSync(
    path.join(root, "_agent", "ai-review-lock.v1.json"),
    JSON.stringify({
      pagePath: "pages/page-1.page",
      scope: { kind: "page", pageId: "page-1", targetPageIds: ["page-1"] },
      expiresAt,
    }),
  );
}

it("records an accepted editor turn and clears the record for a turn that is not an edit", (t) => {
  const root = projectRoot(t);
  recordEditorTurn(root, { authorizationId: "turn-1" });
  const record = JSON.parse(fs.readFileSync(path.join(root, "_agent", "editor-turn.v1.json"), "utf8")) as {
    version: number;
    authorizationId: string;
  };
  assert.equal(record.version, 1);
  assert.equal(record.authorizationId, "turn-1");
  recordEditorTurn(root, undefined);
  assert.equal(fs.existsSync(path.join(root, "_agent", "editor-turn.v1.json")), false);
});

it("an accepted turn is lost only when no live review lease authorises it", (t) => {
  const root = projectRoot(t);
  assert.equal(editorTurnAuthorityLost(root), false, "no turn recorded");
  recordEditorTurn(root, { authorizationId: "turn-2" });
  assert.equal(editorTurnAuthorityLost(root), true, "recorded turn without a lease");
  writeLease(root, Date.now() + 60_000);
  assert.equal(editorTurnAuthorityLost(root), false, "live lease");
  writeLease(root, Date.now() - 1);
  assert.equal(editorTurnAuthorityLost(root), true, "expired lease");
});

it("the lost-authority refusal names no tool", () => {
  assert.doesNotMatch(EDITOR_AUTHORITY_LOST_DETAIL, /write_|delete_|reorder_|update_deck|edit_/);
});
