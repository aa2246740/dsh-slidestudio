import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureRunLedger, inspectRunLedger, persistPresentationRunProvider } from "../index.js";

function projectRoot(modalities: readonly string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-gate-"));
  // persistPresentationRunProvider only updates an existing binding file —
  // mint the same stub createAgent writes, then set the modalities.
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "presentation-run.v1.json"),
    `${JSON.stringify({ provider: { providerId: "pi-xai", modelId: "test-model" } })}\n`,
  );
  persistPresentationRunProvider(root, {
    providerId: "pi-xai",
    modelId: "test-model",
    ready: true,
    modelInputModalities: modalities as ["text"] | ["text", "image"],
  });
  ensureRunLedger(root, {
    manifestSha256: "d".repeat(64),
    requirementsId: "req-test",
    requirements: [],
  });
  return root;
}

describe("plan coverage gate vs model vision", () => {
  it("demands write_todo from a text-only model", () => {
    const root = projectRoot(["text"]);
    const status = inspectRunLedger(root, "epoch-text-only");
    assert.equal(
      status.composeBlockers.some((blocker) => blocker.includes("write_todo")),
      true,
      `text-only model must still owe a plan: ${status.composeBlockers.join("; ")}`,
    );
  });

  it("demands write_todo from a vision model", () => {
    const root = projectRoot(["text", "image"]);
    const status = inspectRunLedger(root, "epoch-vision");
    assert.equal(
      status.composeBlockers.some((blocker) => blocker.includes("write_todo")),
      true,
      `vision model must owe a plan: ${status.composeBlockers.join("; ")}`,
    );
  });

  it("never demands a Pi design contract for either model kind", () => {
    for (const modalities of [["text"], ["text", "image"]] as const) {
      const root = projectRoot(modalities);
      const status = inspectRunLedger(root, "epoch-contract");
      assert.equal(
        status.composeBlockers.some((blocker) => blocker.includes("design contract")),
        false,
        `${modalities.join("+")}: ${status.composeBlockers.join("; ")}`,
      );
    }
  });
});
