import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { exportEditablePptx } from "./export-deck.js";

const EXPORT_EPOCH = "export-snapshot-epoch";

/** A ledger whose only fact is a compose seal for the empty page set, so export may start. */
function writeComposedLedger(root: string): void {
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  const ledger = {
    schemaVersion: 1,
    runId: "export-snapshot",
    createdAt: "t",
    updatedAt: "t",
    sourcePack: { manifestSha256: "m", requirementsId: "r", requirements: [] },
    facts: [
      {
        type: "deck.composed",
        factId: "deck.composed:export-snapshot",
        at: "t",
        contextEpochId: EXPORT_EPOCH,
        commandId: "c",
        title: "快照",
        deckSha256: "d".repeat(64),
        pageRevisions: {},
      },
    ],
  };
  fs.writeFileSync(path.join(root, "_agent", "run-ledger.v1.json"), `${JSON.stringify(ledger, null, 2)}\n`);
}

test("an export whose snapshot copy is refused leaves no snapshot directory in the temp root", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "export-snapshot-temp-"));
  const savedTempDir = process.env.TMPDIR;
  process.env.TMPDIR = tempRoot;
  try {
    const root = path.join(tempRoot, "deck");
    createEmptyProject(root, { title: "快照" });
    writeComposedLedger(root);
    // The project still loads through a symlinked deck file, but the snapshot
    // copy refuses non-regular files, so the copy fails after the snapshot
    // directory exists. The real deck sits outside the project so that only
    // one .pptd is visible inside it.
    const realDeck = path.join(tempRoot, "real-deck.pptd");
    fs.renameSync(path.join(root, "deck.pptd"), realDeck);
    fs.symlinkSync(realDeck, path.join(root, "deck.pptd"));

    await assert.rejects(
      exportEditablePptx(root, { toolCallId: "snapshot-test", contextEpochId: EXPORT_EPOCH }),
      /refuses a non-regular file/,
    );
    assert.deepEqual(
      fs.readdirSync(tempRoot).filter((name) => name.startsWith("pptd-export-snap-")),
      [],
    );
  } finally {
    if (savedTempDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTempDir;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
