import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openslides-projects-"));

function writeProject(relativeRoot, manifest = "deck.pptd") {
  const projectRoot = path.join(workspaceRoot, relativeRoot);
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, manifest), "version: v2\npages: []\n");
  return projectRoot;
}

const fixture = writeProject("fixtures/fixture-one");
const legacy = writeProject("output/legacy-output");
const slice = writeProject("output/dsh-slices/generated-slice");
writeProject("output/dsh-slices/extra-level/too-deep");
fs.mkdirSync(path.join(workspaceRoot, "output", "dsh-slices", "missing-manifest"), { recursive: true });

const outside = fs.mkdtempSync(path.join(os.tmpdir(), "openslides-projects-outside-"));
fs.writeFileSync(path.join(outside, "deck.pptd"), "version: v2\npages: []\n");
fs.symlinkSync(outside, path.join(workspaceRoot, "output", "dsh-slices", "linked-project"));
const linkedManifest = path.join(workspaceRoot, "output", "dsh-slices", "linked-manifest");
fs.mkdirSync(linkedManifest, { recursive: true });
fs.symlinkSync(path.join(outside, "deck.pptd"), path.join(linkedManifest, "deck.pptd"));

const { deleteProject, discoverProjects } = await import("./server.mjs");

after(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("native project discovery", () => {
  it("includes fixtures, legacy output, and one known dsh-slices level only", () => {
    const rows = discoverProjects(workspaceRoot).map(({ id, path, group, updatedAt }) => ({
      id,
      path,
      group,
      updatedAt,
    }));
    assert.deepEqual(rows.map(({ id, path, group }) => ({ id, path, group })), [
      { id: "fixture-one", path: fixture, group: "fixture" },
      { id: "legacy-output", path: legacy, group: "generated" },
      { id: "generated-slice", path: slice, group: "generated" },
    ]);
    for (const row of rows) {
      assert.equal(typeof row.updatedAt, "number");
      assert.ok(row.updatedAt > 0);
    }
  });

  it("reports each project's on-disk size", () => {
    const rows = discoverProjects(workspaceRoot);
    for (const row of rows) {
      assert.equal(typeof row.sizeBytes, "number");
      assert.ok(row.sizeBytes > 0);
    }
  });

  it("does not follow linked project directories or linked manifests", () => {
    const ids = discoverProjects(workspaceRoot).map((project) => project.id);
    assert.equal(ids.includes("linked-project"), false);
    assert.equal(ids.includes("linked-manifest"), false);
  });

  it("deletes a generated project but refuses fixtures and outside paths", () => {
    const victim = writeProject("output/dsh-slices/doomed-draft");
    assert.ok(fs.existsSync(victim));
    deleteProject(workspaceRoot, victim);
    assert.equal(fs.existsSync(victim), false);
    assert.throws(() => deleteProject(workspaceRoot, fixture), /output\//);
    assert.throws(() => deleteProject(workspaceRoot, outside), /output\//);
    assert.throws(() => deleteProject(workspaceRoot, "output/dsh-slices"), /可删除的生成项目/);
  });
});
