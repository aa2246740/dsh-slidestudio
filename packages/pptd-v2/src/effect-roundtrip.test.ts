import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadProject, saveProject } from "./parse.js";
import type { ElementShadow, GradientFill } from "./types.js";

// Compiled tests run from packages/pptd-v2/dist, so the fixture is resolved from the repository root.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const committedFixture = path.join(repoRoot, "packages", "pptd-v2", "src", "__fixtures__", "round1-old-format");

const pageBackground: GradientFill = {
  type: "gradient",
  gradientType: "linear",
  angle: 90,
  stops: [
    { position: 0, color: "#FFF4F4", alpha: 0.6 },
    { position: 1, color: "#C00000" },
  ],
};
const shadow: ElementShadow = { blur: 8, color: "#000000", offsetX: 3, offsetY: 3, opacity: 0.35 };
const alphaFill: GradientFill = {
  type: "gradient",
  gradientType: "linear",
  angle: 90,
  stops: [
    { position: 0, color: "#FFF4F4", alpha: 0.5 },
    { position: 1, color: "#C00000" },
  ],
};

/** Text of deck.pptd and every page, so a second save can be compared exactly. */
function savedText(dir: string): Record<string, string> {
  const files = ["deck.pptd", ...fs.readdirSync(path.join(dir, "pages")).map((f) => `pages/${f}`)];
  return Object.fromEntries(files.map((rel) => [rel, fs.readFileSync(path.join(dir, rel), "utf8")]));
}

describe("M5 effect fields survive save and reload", () => {
  it("a page gradient, an element shadow and a gradient stop alpha reload unchanged and re-save to the same bytes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptd-effect-roundtrip-"));
    try {
      fs.cpSync(committedFixture, dir, { recursive: true });
      const project = loadProject(dir);
      const page = project.pages[0]?.page;
      assert.ok(page, "the committed fixture has a first page");
      page.background = pageBackground;
      page.elements.push(
        {
          elementId: "rect-shadow",
          elementType: "shape",
          bounds: [40, 40, 240, 120],
          shapeName: "rect",
          fill: { type: "solid", color: "#2563EB" },
          shadow,
        },
        {
          elementId: "ellipse-alpha",
          elementType: "shape",
          bounds: [320, 40, 240, 120],
          shapeName: "ellipse",
          fill: alphaFill,
        },
      );
      saveProject(project);
      const saved = savedText(dir);

      const reloaded = loadProject(dir).pages[0]?.page;
      assert.ok(reloaded, "the saved fixture still has a first page");
      const rect = reloaded.elements.find((el) => el.elementId === "rect-shadow");
      const ellipse = reloaded.elements.find((el) => el.elementId === "ellipse-alpha");
      assert.deepEqual(reloaded.background, pageBackground);
      assert.deepEqual(rect?.shadow, shadow);
      assert.ok(ellipse && "fill" in ellipse, "the ellipse keeps its fill");
      assert.deepEqual(ellipse.fill, alphaFill);

      saveProject(loadProject(dir));
      assert.deepEqual(savedText(dir), saved, "a save without edits leaves every file unchanged");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
