import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(here, "../../..");
/**
 * Slide and chart parts that the exporter wrote at 1437ac4, the commit before the neutral
 * chrome (3fe1779). Decks without `theme.neutralChrome` must still produce these bytes, except
 * for the chart strokes: ruling 112 moved them to the px convention (1 px = 9 525 EMU), so the
 * grid, axis, scatter ring and chart-area values in these goldens are the ruling 112 values.
 * The chart-area frame was a pt 0 border that pptxgenjs replaced with a 1 pt white line. Ruling
 * 113 removed the scatter plot-area frame, which the editor never paints, so the golden has none.
 */
const golden = path.join(repoRoot, "packages/exporter-native/src/__golden__/pre-3fe1779");

/**
 * pptxgenjs numbers chart parts with a counter kept in the module, so the names depend on
 * every export made earlier in the same process. Each export runs in a fresh process so
 * that the numbering matches the golden output.
 */
const EXPORT_CHILD = `
import fs from "node:fs";
const { loadProject } = await import("@open-slidestudio/pptd-v2");
const { exportProjectToPptx } = await import(process.env.EXPORTER_URL);
const project = loadProject(process.env.EXPORT_PROJECT);
if (process.env.EXPORT_NEUTRAL === "1") {
  project.presentation.theme = { ...project.presentation.theme, neutralChrome: true };
}
const result = await exportProjectToPptx(project);
if (!result.report.ok) throw new Error("export reported failure");
fs.writeFileSync(process.env.EXPORT_OUT, result.data);
`;

/** Export a copy of a checked-in project and return its slide and chart parts. */
async function exportChrome(source: string, neutral: boolean): Promise<Map<string, string>> {
  const { default: JSZip } = await import("jszip");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "exp-chrome-"));
  try {
    const project = path.join(work, "project");
    const out = path.join(work, "out.pptx");
    fs.cpSync(source, project, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EXPORTER_URL: pathToFileURL(path.join(here, "export-pptd.js")).href,
      EXPORT_PROJECT: project,
      EXPORT_OUT: out,
      EXPORT_NEUTRAL: neutral ? "1" : "0",
    };
    delete env.NODE_TEST_CONTEXT;
    execFileSync(process.execPath, ["--input-type=module", "-e", EXPORT_CHILD], {
      cwd: packageRoot,
      env,
      stdio: "pipe",
    });
    const zip = await JSZip.loadAsync(fs.readFileSync(out));
    const parts = new Map<string, string>();
    for (const name of Object.keys(zip.files)) {
      if (/^ppt\/(slides|charts)\//.test(name) && !zip.files[name]!.dir) {
        parts.set(name, await zip.file(name)!.async("string"));
      }
    }
    return parts;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function readTree(root: string): Map<string, string> {
  const parts = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const key = path.relative(root, full).split(path.sep).join("/");
        parts.set(key, fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(root);
  return parts;
}

function assertMatchesGolden(actual: Map<string, string>, expectedDir: string): void {
  const expected = readTree(expectedDir);
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), "same parts");
  for (const [name, xml] of expected) {
    assert.equal(actual.get(name), xml, `${name} matches the golden export byte for byte`);
  }
}

/** The legacy greys and the neutral set they become under `neutralChrome: true`. */
const CHROME_SWAP: [string, string][] = [
  ["D1D5DB", "CCCCCC"],
  ["CBD5E1", "D4D4D4"],
  ["475569", "525252"],
  ["E5E7EB", "E5E5E5"],
];

describe("export chrome follows the neutralChrome flag", () => {
  it("syn-smoke without the flag keeps the 1437ac4 slide bytes and the ruling 112 chart strokes", async () => {
    const parts = await exportChrome(path.join(repoRoot, "fixtures/syn-smoke"), false);
    assertMatchesGolden(parts, path.join(golden, "syn-smoke/expected"));
  });

  it("a legacy project with dark charts, a table and a placeholder keeps the pre-3fe1779 bytes outside chart strokes", async () => {
    const source = path.join(golden, "legacy-chrome/project");
    const parts = await exportChrome(source, false);
    assertMatchesGolden(parts, path.join(golden, "legacy-chrome/expected"));
    const slide2 = parts.get("ppt/slides/slide2.xml") ?? "";
    assert.match(slide2, /D1D5DB/, "table borders keep the legacy grey");
    assert.match(slide2, /E5E7EB/, "unmapped image placeholder keeps the legacy grey");
    const dark = parts.get("ppt/charts/chart1.xml") ?? "";
    assert.match(dark, /CBD5E1/, "dark-surface chart text keeps the legacy ink");
    assert.match(dark, /475569/, "dark-surface chart grid keeps the legacy grid");
  });

  it("the neutral flag swaps only the chrome colours and keeps every other byte", async () => {
    const source = path.join(golden, "legacy-chrome/project");
    const legacy = await exportChrome(source, false);
    const neutral = await exportChrome(source, true);
    assert.deepEqual([...neutral.keys()].sort(), [...legacy.keys()].sort());
    for (const [name, xml] of legacy) {
      const swapped = CHROME_SWAP.reduce((text, [from, to]) => text.split(from).join(to), xml);
      assert.equal(neutral.get(name), swapped, `${name} differs only in chrome colours`);
    }
    const slide2 = neutral.get("ppt/slides/slide2.xml") ?? "";
    assert.match(slide2, /CCCCCC/, "table borders use the neutral grey");
    assert.match(slide2, /E5E5E5/, "placeholder uses the neutral grey");
    const dark = neutral.get("ppt/charts/chart1.xml") ?? "";
    assert.match(dark, /D4D4D4/, "dark-surface chart text uses the neutral ink");
    assert.match(dark, /525252/, "dark-surface chart grid uses the neutral grid");
    assert.doesNotMatch(
      [...neutral.values()].join("\n"),
      /D1D5DB|CBD5E1|475569|E5E7EB/,
      "no legacy chrome colour survives the flag",
    );
  });
});
