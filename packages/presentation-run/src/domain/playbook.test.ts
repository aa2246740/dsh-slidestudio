import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contrastRatio } from "@open-slidestudio/pptd-v2";
import { extractPalette, listDesignSystems, loadPlaybook, resolveDesignSystemFile } from "./playbook.js";

describe("presentation playbook palette", () => {
  it("keeps paper-white courseware titles readable", () => {
    const root = loadPlaybook().skillRoot;
    const palette = extractPalette(
      fs.readFileSync(path.join(root, "reference/design_system/academic/paper-white-courseware/design.md"), "utf8"),
    );

    assert.equal(palette.background, "#FDFAF5");
    assert.equal(palette.primary, "#44712E");
    assert.ok(contrastRatio(palette.primary, palette.background) >= 4.5);
  });
});

describe("design system resolution", () => {
  it("resolves numbered English guides under the extra catalog namespace", () => {
    const root = loadPlaybook().skillRoot;
    const systems = listDesignSystems(root);
    assert.ok(
      systems.some((system) => system.id === "extra/xuan-paper-annual"),
      "extra/xuan-paper-annual must be listed",
    );
    assert.ok(
      systems.some((system) => system.id === "academic/paper-white-courseware"),
      "named design.md must still be listed",
    );
    assert.equal(
      resolveDesignSystemFile(root, "extra/xuan-paper-annual"),
      path.join(root, "reference/design_system/02_business/03/en/xuan-paper-annual.md"),
    );
  });

  it("does not let a short-slug alias hijack an exact extra id", () => {
    const root = loadPlaybook().skillRoot;
    assert.equal(
      resolveDesignSystemFile(root, "extra/orange-tech"),
      path.join(root, "reference/design_system/02_business/06/en/orange-tech.md"),
    );
  });
});
