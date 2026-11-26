import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject, saveProject, PptdError } from "./parse.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** A scratch copy of a checked-in fixture, so saving never touches the repository. */
function copyFixture(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptd-neutral-flag-"));
  fs.cpSync(path.join(repoRoot, "fixtures", name), dir, { recursive: true });
  return dir;
}

function digests(dir: string): Record<string, string> {
  const files = ["deck.pptd", ...fs.readdirSync(path.join(dir, "pages")).map((f) => `pages/${f}`)];
  return Object.fromEntries(
    files.map((rel) => [
      rel,
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(dir, rel)))
        .digest("hex"),
    ]),
  );
}

describe("theme.neutralChrome flag", () => {
  it("an old deck without the flag loads and saves byte for byte", () => {
    // The checked-in fixture is hand-written YAML. The first save writes the canonical form that
    // every project saved by the product already has on disk; the byte check starts there.
    const dir = copyFixture("syn-smoke");
    saveProject(loadProject(dir));
    const before = digests(dir);
    saveProject(loadProject(dir));
    assert.deepEqual(digests(dir), before);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "deck.pptd"), "utf8"), /neutralChrome/);
  });

  it("round-trips a true flag and keeps the version at v2", () => {
    const dir = copyFixture("syn-smoke");
    const project = loadProject(dir);
    project.presentation.theme = { ...project.presentation.theme, neutralChrome: true };
    saveProject(project);

    const manifest = fs.readFileSync(path.join(dir, "deck.pptd"), "utf8");
    assert.match(manifest, /^ {2}neutralChrome: true$/m);
    assert.match(manifest, /^version: v2$/m);
    const again = loadProject(dir);
    assert.equal(again.presentation.theme?.neutralChrome, true);
    assert.equal(again.presentation.version, "v2");
  });

  it("rejects a flag that is not a boolean when the deck loads", () => {
    const dir = copyFixture("syn-smoke");
    const manifestPath = path.join(dir, "deck.pptd");
    const manifest = fs.readFileSync(manifestPath, "utf8");
    fs.writeFileSync(manifestPath, manifest.replace(/^theme:\n/m, 'theme:\n  neutralChrome: "yes"\n'));
    assert.throws(
      () => loadProject(dir),
      (error: unknown) =>
        error instanceof PptdError && /theme\.neutralChrome must be true or false/.test(error.message),
    );
  });
});
