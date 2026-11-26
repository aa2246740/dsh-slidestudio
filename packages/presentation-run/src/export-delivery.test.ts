import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readVerifiedDelivery } from "./export-deck.js";

test("verified delivery requires the current receipt files, hashes and fingerprint", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oss-export-delivery-"));
  assert.equal(readVerifiedDelivery(root), null);
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "run-ledger.v1.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId: "r",
        createdAt: "t",
        updatedAt: "t",
        sourcePack: { manifestSha256: "m", requirementsId: "r", requirements: [] },
        facts: [
          {
            type: "export.succeeded",
            factId: "export.succeeded:x",
            at: "t",
            contextEpochId: "e",
            commandId: "c",
            artifactPath: "missing.pptx",
            artifactSha256: "a".repeat(64),
            artifactBytes: 4,
            reportPath: "missing.json",
            reportSha256: "b".repeat(64),
            slideCount: 1,
            materialFingerprint: "c".repeat(64),
            producer: "agent-tool",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  assert.equal(readVerifiedDelivery(root), null);
});
