import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSkillRoot } from "./playbook.js";
import { catalogPackPaletteHexes } from "./theme-pack.js";

it("resolves installed resources from another launch directory and refreshes the palette cache when the resource root changes", () => {
  const cwd = process.cwd();
  const override = process.env.SLIDESTUDIO_SKILL_ROOT;
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slides-empty-skill-"));
  fs.writeFileSync(path.join(emptyRoot, "SKILL.md"), "# Empty test skill");
  try {
    delete process.env.SLIDESTUDIO_SKILL_ROOT;
    process.chdir(os.tmpdir());
    const root = resolveSkillRoot();
    assert.ok(fs.existsSync(path.join(root, "SKILL.md")));
    assert.ok(catalogPackPaletteHexes().size > 0);
    process.env.SLIDESTUDIO_SKILL_ROOT = emptyRoot;
    assert.equal(catalogPackPaletteHexes().size, 0);
    delete process.env.SLIDESTUDIO_SKILL_ROOT;
    assert.ok(catalogPackPaletteHexes().size > 0);
  } finally {
    process.chdir(cwd);
    fs.rmSync(emptyRoot, { recursive: true, force: true });
    if (override === undefined) delete process.env.SLIDESTUDIO_SKILL_ROOT;
    else process.env.SLIDESTUDIO_SKILL_ROOT = override;
  }
});
