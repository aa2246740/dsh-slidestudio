import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadProject, saveProject } from "./parse.js";
import { parseCustomPath, resolveCustomGeometry } from "./custom-geometry.js";
import type { Fill, ShapeElement } from "./types.js";
import { canonicalWritePageIssues, isCanonicalWritePageArgs } from "./write-page-schema.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const CJK = /[\u4e00-\u9fff]/;

const solidFill: Fill = { type: "solid", color: "#2563EB" };
const gradientFill: Fill = {
  type: "gradient",
  gradientType: "linear",
  angle: 90,
  stops: [
    { position: 0, color: "#FFF4F4" },
    { position: 0.5, color: "#E06666" },
    { position: 1, color: "#C00000" },
  ],
};

/** A custom shape as write_page receives it: plain JSON, not yet typed as a PPTD element. */
function customShape(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    elementId: id,
    elementType: "shape",
    bounds: [40, 40, 200, 120],
    shapeName: "custom",
    geometry: { viewBox: [200, 120], path: "M 0 0 L 200 0 L 200 120 Z" },
    ...extra,
  };
}

function pageWith(element: Record<string, unknown>) {
  return { id: "geometry-page", elements: [element] };
}

test("accepts a valid solid custom path and a three-stop gradient custom path", () => {
  const solid = customShape("custom-solid", { fill: solidFill });
  const gradient = customShape("custom-gradient", {
    bounds: [300, 40, 200, 120],
    geometry: { viewBox: [100, 60], path: "M 0 30 C 20 0 40 60 60 30 Q 80 0 100 30 Z" },
    fill: gradientFill,
    border: { width: 2, color: "#111111" },
  });
  const args = { id: "p1", elements: [solid, gradient] };
  assert.deepEqual(canonicalWritePageIssues(args), []);
  assert.equal(isCanonicalWritePageArgs(args), true);
});

test("a custom path survives validate, save and load with deep-equal geometry and fill", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptd-custom-geometry-"));
  try {
    fs.cpSync(path.join(repoRoot, "fixtures", "syn-smoke"), dir, { recursive: true });
    const project = loadProject(dir);
    const solid = customShape("custom-solid", { fill: solidFill });
    const gradient = customShape("custom-gradient", {
      geometry: { viewBox: [100, 60], path: "M 0 30 C 20 0 40 60 60 30 Q 80 0 100 30 Z" },
      fill: gradientFill,
    });
    const args = { id: "geometry-page", elements: [solid, gradient] };
    assert.deepEqual(canonicalWritePageIssues(args), []);
    project.pages[1]!.page.elements = args.elements as unknown as ShapeElement[];
    saveProject(project);

    const saved = loadProject(dir).pages[1]!.page.elements as unknown as Array<Record<string, unknown>>;
    const savedSolid = saved.find((el) => el.elementId === "custom-solid");
    const savedGradient = saved.find((el) => el.elementId === "custom-gradient");
    assert.deepEqual(savedSolid?.geometry, solid.geometry);
    assert.deepEqual(savedSolid?.fill, solidFill);
    assert.deepEqual(savedGradient?.geometry, gradient.geometry);
    assert.deepEqual(savedGradient?.fill, gradientFill);
    assert.equal(savedGradient?.shapeName, "custom");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a custom shape without geometry in Chinese, naming the element id", () => {
  const issues = canonicalWritePageIssues(
    pageWith({
      elementId: "custom-bad",
      elementType: "shape",
      bounds: [40, 40, 200, 120],
      shapeName: "custom",
      fill: solidFill,
    }),
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0]!, /^\$\.elements\[0\]/);
  assert.match(issues[0]!, /custom-bad/);
  assert.match(issues[0]!, /缺少 geometry/);
  assert.match(issues[0]!, CJK);
});

test("refuses an empty path in Chinese", () => {
  const issues = canonicalWritePageIssues(
    pageWith(customShape("custom-bad", { geometry: { viewBox: [200, 120], path: "   " } })),
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0]!, /custom-bad/);
  assert.match(issues[0]!, /geometry\.path 为空/);
});

test("refuses unknown path commands such as arcTo (A) and horizontal (H) in Chinese", () => {
  for (const [id, commandPath] of [
    ["custom-arc", "M 0 0 A 10 10 0 0 1 20 20 Z"],
    ["custom-horizontal", "M 0 0 H 20 Z"],
  ] as const) {
    const issues = canonicalWritePageIssues(
      pageWith(customShape(id, { geometry: { viewBox: [200, 120], path: commandPath } })),
    );
    assert.equal(issues.length, 1, id);
    assert.match(issues[0]!, new RegExp(id));
    assert.match(issues[0]!, /不支持的命令/);
    assert.match(issues[0]!, CJK);
  }
});

test("refuses NaN, Infinity and overflowing coordinates in Chinese", () => {
  for (const [id, nonFinitePath] of [
    ["custom-nan", "M 0 0 L NaN 10 L 20 20 Z"],
    ["custom-infinity", "M 0 0 L Infinity 10 L 20 20 Z"],
    ["custom-overflow", "M 0 0 L 1e400 10 L 20 20 Z"],
  ] as const) {
    const issues = canonicalWritePageIssues(
      pageWith(customShape(id, { geometry: { viewBox: [200, 120], path: nonFinitePath } })),
    );
    assert.equal(issues.length, 1, id);
    assert.match(issues[0]!, new RegExp(id));
    assert.match(issues[0]!, /非有限数字/);
  }
});

test("refuses more than 256 segments in Chinese", () => {
  const longPath = `M 0 0${" L 1 1".repeat(256)}`;
  const issues = canonicalWritePageIssues(
    pageWith(customShape("custom-long", { geometry: { viewBox: [200, 120], path: longPath } })),
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0]!, /custom-long/);
  assert.match(issues[0]!, /超过 256 段/);
});

test("accepts exactly 256 segments", () => {
  const edgePath = `M 0 0${" L 1 1".repeat(255)}`;
  assert.deepEqual(
    canonicalWritePageIssues(
      pageWith(customShape("custom-edge", { geometry: { viewBox: [200, 120], path: edgePath } })),
    ),
    [],
  );
});

test("refuses a path longer than 4 KiB in Chinese", () => {
  const heavyPath = `M 0 0${" L 0.123456789012345678 0.123456789012345678".repeat(100)}`;
  assert.ok(Buffer.byteLength(heavyPath, "utf8") > 4096);
  const issues = canonicalWritePageIssues(
    pageWith(customShape("custom-heavy", { geometry: { viewBox: [200, 120], path: heavyPath } })),
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0]!, /custom-heavy/);
  assert.match(issues[0]!, /超过 4 KiB/);
});

test("refuses a viewBox with a non-positive side in Chinese", () => {
  for (const viewBox of [
    [0, 120],
    [200, -5],
  ]) {
    const issues = canonicalWritePageIssues(
      pageWith(customShape("custom-viewbox", { geometry: { viewBox, path: "M 0 0 L 10 10 Z" } })),
    );
    assert.equal(issues.length, 1);
    assert.match(issues[0]!, /custom-viewbox/);
    assert.match(issues[0]!, /viewBox/);
    assert.match(issues[0]!, /大于 0/);
  }
});

test("refuses geometry on a preset shape in Chinese", () => {
  const issues = canonicalWritePageIssues(
    pageWith({
      elementId: "preset-with-path",
      elementType: "shape",
      bounds: [40, 40, 200, 120],
      shapeName: "rect",
      geometry: { viewBox: [200, 120], path: "M 0 0 L 10 10 Z" },
    }),
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0]!, /preset-with-path/);
  assert.match(issues[0]!, /只有 shapeName "custom" 可以带 geometry/);
});

test("parseCustomPath accepts absolute M/L/C/Q/Z and keeps the command order", () => {
  const parsed = parseCustomPath("M 0 0 L 10 0 C 10 5 5 10 0 10 Q 0 5 0 0 Z");
  assert.ok("segments" in parsed);
  assert.deepEqual(
    parsed.segments.map((segment) => segment.command),
    ["M", "L", "C", "Q", "Z"],
  );
  assert.deepEqual(parsed.segments[2]!.points, [10, 5, 5, 10, 0, 10]);
});

test("parseCustomPath refuses implicit repetition and paths that do not start with M", () => {
  assert.ok("issue" in parseCustomPath("M 0 0 10 10"));
  assert.ok("issue" in parseCustomPath("L 0 0 L 10 10"));
});

test("parseCustomPath accepts adjacent command letters such as ZM in the compact form", () => {
  const compact = "M0 0L100 0L100 100ZM20 20L40 20L40 40Z";
  const parsed = parseCustomPath(compact);
  assert.ok("segments" in parsed);
  assert.deepEqual(
    parsed.segments.map((segment) => segment.command),
    ["M", "L", "L", "Z", "M", "L", "L", "Z"],
  );
  assert.deepEqual(parsed.segments[4]!.points, [20, 20]);
  assert.deepEqual(
    canonicalWritePageIssues(
      pageWith(customShape("custom-compact", { geometry: { viewBox: [100, 100], path: compact } })),
    ),
    [],
  );
});

test("parseCustomPath refuses a letter that is not a command, even when it touches a valid one", () => {
  for (const path of ["M0 0L10 0ZH5 5Z", "M0 0L10 0Zm5 5Z"]) {
    const parsed = parseCustomPath(path);
    assert.ok("issue" in parsed, path);
    assert.match(parsed.issue, /不支持的命令/);
    assert.match(parsed.issue, CJK);
  }
});

test("refuses NaN and Infinity in the compact form in Chinese", () => {
  for (const [id, nonFinitePath] of [
    ["custom-compact-nan", "M0 0L10 0ZMNaN 10Z"],
    ["custom-compact-infinity", "M0 0L10 0ZM-Infinity 10Z"],
  ] as const) {
    const issues = canonicalWritePageIssues(
      pageWith(customShape(id, { geometry: { viewBox: [200, 120], path: nonFinitePath } })),
    );
    assert.equal(issues.length, 1, id);
    assert.match(issues[0]!, new RegExp(id));
    assert.match(issues[0]!, /非有限数字/);
  }
});

test("resolveCustomGeometry returns the paintable viewBox, path and segments", () => {
  const resolved = resolveCustomGeometry({
    viewBox: [200, 120],
    path: "M 0 0 L 200 0 L 200 120 Z",
  });
  assert.ok("segments" in resolved);
  assert.deepEqual(resolved.viewBox, [200, 120]);
  assert.equal(resolved.path, "M 0 0 L 200 0 L 200 120 Z");
  assert.deepEqual(
    resolved.segments.map((segment) => segment.command),
    ["M", "L", "L", "Z"],
  );
});

test("resolveCustomGeometry reports, without throwing, geometry the editor and exporter cannot draw", () => {
  const cases: unknown[] = [
    undefined,
    "M 0 0 L 1 1 Z",
    { viewBox: [0, 120], path: "M 0 0 Z" },
    { viewBox: [200], path: "M 0 0 Z" },
    { viewBox: [200, 120], path: 42 },
    { viewBox: [200, 120], path: "M 0 0 A 5 5 0 0 1 10 10" },
  ];
  for (const geometry of cases) {
    const resolved = resolveCustomGeometry(geometry);
    assert.ok("issue" in resolved, `expected an issue for ${JSON.stringify(geometry)}`);
    assert.match(resolved.issue, CJK);
  }
});
