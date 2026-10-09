import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, sourceFiles } from "./source-files.mjs";
import { debtMarkers } from "./debt-markers.mjs";

const markers = sourceFiles().flatMap((file) => debtMarkers(file, readFileSync(path.join(ROOT, file), "utf8")));
const baselineFile = path.join(ROOT, "config/debt-baseline.json");
if (process.argv.includes("--record-baseline")) {
  mkdirSync(path.dirname(baselineFile), { recursive: true });
  writeFileSync(baselineFile, `${JSON.stringify({ version: 1, markers }, null, 2)}\n`);
}
const baseline = new Set(
  JSON.parse(readFileSync(baselineFile, "utf8")).markers.map((item) => `${item.file}:${item.marker}`),
);
const failures = markers.filter(
  (item) =>
    !baseline.has(`${item.file}:${item.marker}`) &&
    !/\b(?:TODO|FIXME|HACK|XXX)\((?:[A-Z][A-Z0-9]+-\d+|https:\/\/[^)]+)\)/.test(item.marker),
);
mkdirSync(path.join(ROOT, "output/quality"), { recursive: true });
writeFileSync(
  path.join(ROOT, "output/quality/technical-debt.json"),
  `${JSON.stringify({ markers, failures }, null, 2)}\n`,
);
for (const item of failures) console.error(`${item.file}:${item.line}: link new debt markers to a ticket`);
console.log(`Technical debt: ${markers.length} tracked markers; ${failures.length} unlinked additions`);
process.exitCode = failures.length ? 1 : 0;
