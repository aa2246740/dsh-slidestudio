import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Animation } from "@open-slidestudio/pptd-v2";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
await import(pathToFileURL(path.join(repoRoot, "apps/native-web/public/snap-guides.js")).href);

type GuideLib = {
  computeSnapGuides: (
    moving: number[],
    others: number[][],
    threshold?: number,
  ) => { guides: { axis: "x" | "y"; pos: number; kind: string }[]; snap: number[] };
  animationGroups: (anims: Animation[]) => Animation[][];
  staggerDelays: (anims: Animation[], stepMs?: number) => { delayMs: number }[];
  isDarkCss: (css: string) => boolean;
};

function loadGuides(): GuideLib {
  const g = globalThis as unknown as Partial<GuideLib>;
  if (typeof g.computeSnapGuides !== "function") throw new Error("snap-guides.js missing computeSnapGuides");
  return g as GuideLib;
}

describe("selection snap guides + animation groups", () => {
  it("snaps left edges and emits a vertical guide", () => {
    const { computeSnapGuides } = loadGuides();
    const hit = computeSnapGuides([24, 20, 80, 40], [[20, 10, 80, 50]], 8);
    assert.equal(hit.snap[0], 20);
    assert.ok(hit.guides.some((g) => g.axis === "x" && g.pos === 20 && g.kind === "edge"));
  });

  it("snaps centers for SmartArt-style alignment", () => {
    const { computeSnapGuides } = loadGuides();
    const hit = computeSnapGuides([46, 40, 40, 40], [[20, 20, 80, 80]], 8);
    assert.equal(hit.snap[0], 40);
    assert.ok(hit.guides.some((g) => g.axis === "x" && g.kind === "center"));
  });

  it("does not snap when farther than the threshold", () => {
    const { computeSnapGuides } = loadGuides();
    const hit = computeSnapGuides([200, 20, 40, 40], [[20, 10, 40, 40]], 6);
    assert.equal(hit.snap[0], 200);
    assert.equal(hit.guides.length, 0);
  });

  it("groups withPrevious onto the previous click step", () => {
    const { animationGroups } = loadGuides();
    const groups = animationGroups([
      { elementId: "a", effect: "fade-in", trigger: "onClick" },
      { elementId: "b", effect: "fly-in", trigger: "withPrevious" },
      { elementId: "c", effect: "zoom-in", trigger: "afterPrevious" },
      { elementId: "d", effect: "none", trigger: "onClick" },
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]!.length, 2);
    assert.equal(groups[1]!.length, 1);
  });

  it("staggers simultaneous items by 70ms", () => {
    const { staggerDelays } = loadGuides();
    const next = staggerDelays([
      { elementId: "a", effect: "fade-in", trigger: "onClick", durationMs: 400 },
      { elementId: "b", effect: "fly-in", trigger: "withPrevious", durationMs: 400 },
    ]);
    assert.equal(next[0]!.delayMs, 0);
    assert.equal(next[1]!.delayMs, 70);
  });

  it("treats navy slide fills as dark chrome", () => {
    const { isDarkCss } = loadGuides();
    assert.equal(isDarkCss("#102E52"), true);
    assert.equal(isDarkCss("#ffffff"), false);
    assert.equal(isDarkCss("rgb(17, 17, 17)"), true);
  });
});
