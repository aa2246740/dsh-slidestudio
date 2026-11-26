import assert from "node:assert/strict";
import { test } from "node:test";
import "../public/snap-guides.js";

function helpers() {
  return {
    computeSnapGuides: globalThis.computeSnapGuides,
    animationGroups: globalThis.animationGroups,
    staggerDelays: globalThis.staggerDelays,
    isDarkCss: globalThis.isDarkCss,
  };
}

test("native pointer snapping respects the exact pixel tolerance including fractional positions", () => {
  const { computeSnapGuides } = helpers();
  const outside = computeSnapGuides([26.75, 200, 80, 40], [[20, 10, 80, 40]], 6);
  assert.deepEqual(outside.snap, [26.75, 200, 80, 40]);
  assert.deepEqual(outside.guides, []);
  const boundary = computeSnapGuides([26, 200, 80, 40], [[20, 10, 80, 40]], 6);
  assert.equal(boundary.snap[0], 20);
  assert.equal(boundary.guides[0].pos, 20);
});

test("invalid pointer geometry rejects and malformed references never supply guide coordinates", () => {
  const { computeSnapGuides } = helpers();
  for (const moving of [[NaN, 20, 80, 40], [20, 20, -80, 40], ["20", 20, 80, 40], null]) {
    assert.throws(() => computeSnapGuides(moving, [], 6), /finite.*bounds/);
  }
  for (const threshold of [NaN, Infinity, -1, "6"]) {
    assert.throws(() => computeSnapGuides([20, 20, 80, 40], [], threshold), /tolerance/);
  }
  const hit = computeSnapGuides(
    [24, 200, 80, 40],
    [["20", 10, 80, 40], [20, 10, -80, 40], [20, 10, Infinity, 40], null],
    6,
    ["960", 540],
  );
  assert.deepEqual(hit.guides, []);
  assert.deepEqual(hit.snap, [24, 200, 80, 40]);
});

test("animation projection rejects malformed records and preserves explicit zero timing", () => {
  const { animationGroups, staggerDelays } = helpers();
  const instant = {
    elementId: "title",
    effect: "appear",
    trigger: "onClick",
    durationMs: 0,
    delayMs: 0,
  };
  const valid = { elementId: "body", effect: "fade-in", trigger: "withPrevious", durationMs: 400 };
  for (const invalid of [null, {}, "frames", { ...valid, delayMs: "20" }, { ...valid, durationMs: -1 }]) {
    assert.deepEqual(animationGroups([instant, invalid, valid]), [[instant, valid]]);
    const next = staggerDelays([instant, invalid, valid]);
    assert.equal(next.length, 2);
    assert.equal(next[0].durationMs, 0);
    assert.equal(next[0].delayMs, 0);
    assert.equal(next[1].delayMs, 70);
  }
  assert.deepEqual(animationGroups({}), []);
  assert.deepEqual(staggerDelays({}), []);
});

test("only valid CSS color tokens choose dark slide chrome", () => {
  const { isDarkCss } = helpers();
  for (const invalid of [["#000"], { toString: () => "#000" }, "#00000", "rgb(0,0,999)"]) {
    assert.equal(isDarkCss(invalid), false);
  }
  for (const color of ["#102E52", "#123", "#123f", "#102E52ff", "rgba(17,17,17,0.8)"]) {
    assert.equal(isDarkCss(color), true);
  }
  assert.equal(isDarkCss("linear-gradient(90deg, #102E52 0%, #ffffff 100%)"), true);
  assert.equal(isDarkCss("#ffffff"), false);
});
