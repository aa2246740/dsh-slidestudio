import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APPS, ROOT } from "./source-files.mjs";

const measurements = {};
for (const app of APPS) {
  const output = path.join(ROOT, "output/quality/duplication", app.replaceAll("/", "-"));
  const result = spawnSync(
    path.join(ROOT, "node_modules/.bin/jscpd"),
    [path.join(ROOT, app), "--config", path.join(ROOT, ".jscpd.json"), "--output", output, "--silent"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || "jscpd failed");
  const report = JSON.parse(readFileSync(path.join(output, "jscpd-report.json"), "utf8"));
  measurements[app] = {
    duplicatedLines: report.statistics.total.duplicatedLines,
    percentage: report.statistics.total.percentage,
  };
}
const baselineFile = path.join(ROOT, "config/duplication-baseline.json");
if (process.argv.includes("--record-baseline")) {
  mkdirSync(path.dirname(baselineFile), { recursive: true });
  writeFileSync(baselineFile, `${JSON.stringify({ version: 1, measurements }, null, 2)}\n`);
}
const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
const failures = Object.entries(measurements)
  .filter(([app, value]) => value.duplicatedLines > (baseline.measurements[app]?.duplicatedLines ?? 0))
  .map(([app, value]) => `${app}: ${value.duplicatedLines} duplicated lines exceed baseline`);
writeFileSync(
  path.join(ROOT, "output/quality/duplication-summary.json"),
  `${JSON.stringify({ measurements, failures }, null, 2)}\n`,
);
for (const failure of failures) console.error(failure);
console.log(`Duplication: ${APPS.length} apps; ${failures.length} regressions`);
process.exitCode = failures.length ? 1 : 0;
