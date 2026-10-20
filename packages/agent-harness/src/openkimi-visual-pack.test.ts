import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createOpenKimiVisualManifest,
  openKimiVisualSourceId,
  readOpenKimiVisualBytes,
  resolveOpenKimiDesignPreview,
  resolveOpenKimiVisualRoot,
  verifyOpenKimiVisualPack,
} from "./openkimi-visual-pack.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("OpenKimi visual pack", () => {
  it("covers every pinned theme preview and returns exact JPEG bytes", () => {
    const pack = verifyOpenKimiVisualPack(repoRoot);
    const generated = createOpenKimiVisualManifest(resolveOpenKimiVisualRoot(repoRoot));
    assert.deepEqual(generated, pack.manifest);
    assert.equal(pack.manifest.files.length, 44);

    for (const entry of pack.manifest.files) {
      const bytes = readOpenKimiVisualBytes(pack, entry.sourceId);
      assert.equal(bytes.length, entry.byteLength);
      assert.equal(bytes[0], 0xff);
      assert.equal(bytes[1], 0xd8);
    }
  });

  it("resolves the selected preview by the same group/slug design id", () => {
    const pack = verifyOpenKimiVisualPack(repoRoot);
    const entry = resolveOpenKimiDesignPreview(pack, "consulting/marine-blue-research");
    assert.equal(entry.sourceId, openKimiVisualSourceId("consulting/marine-blue-research"));
    assert.equal(entry.relativePath, "consulting/marine-blue-research.jpg");
  });

  it("fails closed when the checked file set or bytes drift", () => {
    const sourceRoot = resolveOpenKimiVisualRoot(repoRoot);
    const original = createOpenKimiVisualManifest(sourceRoot);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openkimi-visual-pack-"));
    const copiedRoot = path.join(tempRoot, "themes");
    fs.cpSync(sourceRoot, copiedRoot, { recursive: true });
    const manifestPath = path.join(tempRoot, "manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(original)}\n`, "utf8");

    fs.writeFileSync(path.join(copiedRoot, "consulting", "extra.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    assert.throws(
      () => verifyOpenKimiVisualPack(repoRoot, { sourceRoot: copiedRoot, manifestPath }),
      /file set mismatch/,
    );
    fs.unlinkSync(path.join(copiedRoot, "consulting", "extra.jpg"));

    fs.appendFileSync(path.join(copiedRoot, original.files[0]!.relativePath), "drift");
    assert.throws(
      () => verifyOpenKimiVisualPack(repoRoot, { sourceRoot: copiedRoot, manifestPath }),
      /byte length mismatch|hash mismatch|complete JPEG/,
    );
  });
});
