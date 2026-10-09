import { describe, expect, it } from "vitest";
import { boundaryViolation, moduleImports } from "./check-boundaries.mjs";
import { debtMarkers } from "./debt-markers.mjs";
import { measureSource, metricRegressions } from "./source-metrics.mjs";

describe("source quality ratchet", () => {
  it("rejects new complexity and file growth, while accepting shrinking debt", () => {
    const source = `export function run(value) { ${Array.from({ length: 22 }, (_, i) => `if(value === ${i}) return ${i};`).join("")} }`;
    const metric = measureSource("fixture.js", source);
    expect(metric.functions["run#1"]).toBe(23);
    expect(metricRegressions("fixture.js", metric)).toHaveLength(1);
    expect(metricRegressions("fixture.js", metric, { functions: { "run#1": 24 } })).toEqual([]);
    expect(metricRegressions("fixture.js", { ...metric, lines: 501 }, { functions: { "run#1": 24 } })).toHaveLength(1);
  });
  it("does not charge nested functions to their parents", () => {
    const metric = measureSource(
      "fixture.js",
      "export function outer() { return function inner(v) { if(v) return 1; return 0; }; }",
    );
    expect(metric.functions).toEqual({ "outer#1": 1, "inner#1": 2 });
  });
});

describe("native/legacy architecture", () => {
  it("rejects cross-app and dual document-model imports", () => {
    expect(boundaryViolation("apps/native-web/src/file.mjs", "@open-slidestudio/pptd")).toContain("legacy");
    expect(boundaryViolation("apps/web/src/file.ts", "@open-slidestudio/pptd-v2")).toContain("native");
    expect(boundaryViolation("apps/web/src/file.ts", "../../server/src/index.mjs")).toContain("application");
    expect(boundaryViolation("packages/pptd-v2/src/file.ts", "../../../apps/web/src/App.tsx")).toContain("application");
    expect(boundaryViolation("apps/native-web/src/file.mjs", "@open-slidestudio/pptd-v2")).toBeNull();
    expect(boundaryViolation("dsh-slidestudio/src/file.ts", "@open-slidestudio/dsh-slides-host")).toBeNull();
  });
  it("inspects static imports, re-exports and literal dynamic imports", () => {
    expect(
      moduleImports(
        "fixture.ts",
        `import x from "one"; export { y } from "two"; import("three"); require("four"); import(variable);`,
      ),
    ).toEqual(["one", "two", "three", "four"]);
  });
});

describe("technical debt markers", () => {
  it("finds comment markers only, not strings that contain the word", () => {
    const markers = debtMarkers("fixture.js", 'const word = "TODO"; // TODO: tidy\n/* FIXME later */');
    expect(markers.map((marker) => marker.line)).toEqual([1, 2]);
  });
});
