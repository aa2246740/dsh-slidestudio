import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadProject, saveProject } from "./parse.js";

// Compiled tests run from packages/pptd-v2/dist, so the fixture is resolved from the repository root.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** Committed round-1-era deck: no M5 fields (custom geometry, gradient background, shadows). */
const committedFixture = path.join(repoRoot, "packages", "pptd-v2", "src", "__fixtures__", "round1-old-format");

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

describe("old PPTD files stay byte-identical on load then save", () => {
  it("the committed round-1 fixture loads and saves with the same sha256 for deck.pptd and every page", () => {
    const committed = digests(committedFixture);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptd-legacy-bytes-"));
    try {
      fs.cpSync(committedFixture, dir, { recursive: true });
      saveProject(loadProject(dir));
      assert.deepEqual(digests(dir), committed);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the committed fixture has no M5 fields to migrate", () => {
    for (const rel of fs.readdirSync(path.join(committedFixture, "pages"))) {
      const text = fs.readFileSync(path.join(committedFixture, "pages", rel), "utf8");
      assert.doesNotMatch(text, /^\s*geometry:/m);
    }
  });

  it("the committed M5 fidelity fixture (no layouts) loads and saves with the same bytes and no inheritance keys", () => {
    const fidelityFixture = path.join(repoRoot, "test-fixtures", "pptd-fidelity-project");
    const committed = digests(fidelityFixture);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptd-legacy-fidelity-"));
    try {
      fs.cpSync(fidelityFixture, dir, { recursive: true });
      saveProject(loadProject(dir));
      assert.deepEqual(digests(dir), committed);
      for (const rel of Object.keys(committed).filter((key) => key.endsWith(".pptd") || key.startsWith("pages/"))) {
        const text = fs.readFileSync(path.join(dir, rel), "utf8");
        assert.doesNotMatch(text, /^\s*(?:masters|layouts|layoutId|inherited|backgroundInherited):/m, rel);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
