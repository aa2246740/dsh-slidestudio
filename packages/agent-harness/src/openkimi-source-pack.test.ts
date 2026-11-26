import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createOpenKimiSourceManifest,
  listOpenKimiSourceRequirements,
  OpenKimiSourcePackError,
  openKimiSourceId,
  readOpenKimiSource,
  readOpenKimiSourceBytes,
  readOpenKimiSourceChunk,
  resolveOpenKimiPresetDesignSourceId,
  resolveOpenKimiScenarioSourceId,
  verifyOpenKimiPack,
  verifyOpenKimiPackAt,
} from "./openkimi-source-pack.js";

describe("OpenKimi checked source pack", () => {
  it("covers every regular vendor file and reassembles each one byte-for-byte", () => {
    const repoRoot = findRepositoryRoot();
    const pack = verifyOpenKimiPack(repoRoot);
    // Derive the expectation from the vendor tree so the manifest can neither
    // drop a file nor keep serving one that was removed on purpose (the desktop
    // export scripts, for example).
    const vendorFiles: string[] = [];
    const walk = (dir: string, prefix = "") => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else if (entry.isFile()) vendorFiles.push(rel);
      }
    };
    walk(pack.sourceRoot);
    assert.deepEqual([...pack.manifest.files.map((entry) => entry.relativePath)].sort(), vendorFiles.sort());

    for (const entry of pack.manifest.files) {
      const sourcePath = path.join(pack.sourceRoot, ...entry.relativePath.split("/"));
      const original = fs.readFileSync(sourcePath);
      const restored = readOpenKimiSourceBytes(pack, entry.sourceId);
      assert.deepEqual(restored, original, entry.relativePath);
      assert.equal(readOpenKimiSource(pack, entry.sourceId), original.toString("utf8"));

      let byteStart = 0;
      for (const chunk of entry.chunks) {
        const read = readOpenKimiSourceChunk(pack, entry.sourceId, chunk.index);
        assert.equal(read.byteStart, byteStart);
        assert.equal(read.byteEndExclusive, chunk.byteEndExclusive);
        assert.equal(read.text, original.subarray(byteStart, chunk.byteEndExclusive).toString("utf8"));
        byteStart = chunk.byteEndExclusive;
      }
      assert.equal(byteStart, original.length);
    }
  });

  it("resolves complete baseline source coverage and only adds an explicit preset", () => {
    const pack = verifyOpenKimiPack(findRepositoryRoot());
    const presetSourceId = resolveOpenKimiPresetDesignSourceId(pack, "consulting/pine-green-strategy");
    const presetRequirements = listOpenKimiSourceRequirements(pack, {
      categoryId: "management-report",
      designDirection: { kind: "preset", sourceId: presetSourceId },
    });
    assert.deepEqual(
      presetRequirements.map((requirement) => requirement.kind),
      ["skill", "pptd", "categories", "scenario", "preset-design"],
    );
    assert.ok(presetRequirements.every((requirement) => requirement.requiredChunkIndexes.length > 0));
    assert.equal(
      resolveOpenKimiScenarioSourceId(pack, "management-report"),
      openKimiSourceId("reference/slides_categories/management-report.md"),
    );

    const userDesignRequirements = listOpenKimiSourceRequirements(pack, {
      categoryId: "management-report",
      designDirection: { kind: "user-design" },
    });
    assert.deepEqual(
      userDesignRequirements.map((requirement) => requirement.kind),
      ["skill", "pptd", "categories", "scenario"],
    );

    const selfDirected = listOpenKimiSourceRequirements(pack, {
      designDirection: { kind: "self-directed" },
    });
    assert.deepEqual(
      selfDirected.map((requirement) => requirement.kind),
      ["skill", "pptd", "categories"],
    );
  });

  it("rejects an added, missing, changed, linked, or traversing source pack", () => {
    const fixture = createFixture();
    assert.doesNotThrow(() => verifyOpenKimiPackAt(fixture.repoRoot, fixture.options));

    fs.writeFileSync(path.join(fixture.sourceRoot, "added.md"), "unexpected\n");
    assert.throws(() => verifyOpenKimiPackAt(fixture.repoRoot, fixture.options), /file set mismatch.*added/i);
    fs.rmSync(path.join(fixture.sourceRoot, "added.md"));

    fs.rmSync(path.join(fixture.sourceRoot, "reference", "pptd.md"));
    assert.throws(() => verifyOpenKimiPackAt(fixture.repoRoot, fixture.options), /file set mismatch.*missing/i);
    fs.writeFileSync(path.join(fixture.sourceRoot, "reference", "pptd.md"), "pptd restored\n");
    assert.throws(
      () => verifyOpenKimiPackAt(fixture.repoRoot, fixture.options),
      /byte length mismatch|file hash mismatch/i,
    );
    fs.writeFileSync(path.join(fixture.sourceRoot, "reference", "pptd.md"), "pptd rules\n");

    fs.symlinkSync("SKILL.md", path.join(fixture.sourceRoot, "linked.md"));
    assert.throws(() => verifyOpenKimiPackAt(fixture.repoRoot, fixture.options), /symbolic links are forbidden/i);
    fs.unlinkSync(path.join(fixture.sourceRoot, "linked.md"));

    const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8")) as {
      files: Array<{ sourceId: string; relativePath: string }>;
    };
    manifest.files[0]!.relativePath = "../outside.md";
    manifest.files[0]!.sourceId = "openkimi:../outside.md";
    fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest));
    assert.throws(
      () => verifyOpenKimiPackAt(fixture.repoRoot, fixture.options),
      (error: unknown) =>
        error instanceof OpenKimiSourcePackError && /unsafe source relative path/i.test(error.message),
    );
  });
});

function findRepositoryRoot(): string {
  let current = path.resolve(process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, "vendor", "open-kimi-ppt"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("repository root not found");
    current = parent;
  }
}

function createFixture(): {
  repoRoot: string;
  sourceRoot: string;
  manifestPath: string;
  options: { sourceRoot: string; manifestPath: string };
} {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openkimi-source-pack-"));
  const sourceRoot = path.join(repoRoot, "vendor-pack");
  fs.mkdirSync(path.join(sourceRoot, "reference", "slides_categories"), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "reference", "design_system", "consulting", "pine-green"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(sourceRoot, "SKILL.md"), "skills 原文\n");
  fs.writeFileSync(path.join(sourceRoot, "reference", "pptd.md"), "pptd rules\n");
  fs.writeFileSync(path.join(sourceRoot, "reference", "slides_categories.md"), "categories\n");
  fs.writeFileSync(
    path.join(sourceRoot, "reference", "slides_categories", "management-report.md"),
    "management report\n",
  );
  fs.writeFileSync(
    path.join(sourceRoot, "reference", "design_system", "consulting", "pine-green", "design.md"),
    "design preset\n",
  );
  const manifestPath = path.join(repoRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(createOpenKimiSourceManifest(sourceRoot), null, 2) + "\n");
  return {
    repoRoot,
    sourceRoot,
    manifestPath,
    options: { sourceRoot, manifestPath },
  };
}
