import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, sourceFiles } from "./source-files.mjs";
import { measureSource, metricRegressions } from "./source-metrics.mjs";

const baselineFile = path.join(ROOT, "config/source-quality-baseline.json");
const measurements = Object.fromEntries(
  sourceFiles().map((file) => [file, measureSource(file, readFileSync(path.join(ROOT, file), "utf8"))]),
);
const exceptions = Object.fromEntries(
  Object.entries(measurements)
    .map(([file, metric]) => [
      file,
      {
        ...(metric.lines > 500 ? { lines: metric.lines } : {}),
        functions: Object.fromEntries(Object.entries(metric.functions).filter(([, value]) => value > 20)),
      },
    ])
    .filter(([, metric]) => metric.lines || Object.keys(metric.functions).length),
);
if (process.argv.includes("--record-baseline")) {
  mkdirSync(path.dirname(baselineFile), { recursive: true });
  writeFileSync(baselineFile, `${JSON.stringify({ version: 1, exceptions }, null, 2)}\n`);
}
const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
const failures = Object.entries(measurements).flatMap(([file, metric]) =>
  metricRegressions(file, metric, baseline.exceptions[file]),
);
mkdirSync(path.join(ROOT, "output/quality"), { recursive: true });
writeFileSync(
  path.join(ROOT, "output/quality/source-metrics.json"),
  `${JSON.stringify({ measurements, failures }, null, 2)}\n`,
);
for (const failure of failures) console.error(failure);
console.log(`Source metrics: ${Object.keys(measurements).length} files; ${failures.length} regressions`);
process.exitCode = failures.length ? 1 : 0;
