import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./source-files.mjs";

const result = spawnSync(
  path.join(ROOT, "node_modules/.bin/knip"),
  ["--config", path.join(ROOT, "knip.json"), "--dependencies", "--reporter", "json", "--no-progress", "--no-exit-code"],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
);
if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || "Knip failed");
const report = JSON.parse(result.stdout);
const issues = [];
for (const issue of report.issues ?? []) {
  for (const type of ["dependencies", "unlisted", "unresolved", "binaries"]) {
    for (const entry of issue[type] ?? []) {
      issues.push(`${issue.file} ${type} ${typeof entry === "string" ? entry : entry.name}`);
    }
  }
}
issues.sort();
const baselineFile = path.join(ROOT, "config/dependency-baseline.json");
if (process.argv.includes("--record-baseline")) {
  mkdirSync(path.dirname(baselineFile), { recursive: true });
  writeFileSync(baselineFile, `${JSON.stringify({ version: 1, issues }, null, 2)}\n`);
}
const baseline = new Set(JSON.parse(readFileSync(baselineFile, "utf8")).issues);
const failures = issues.filter((issue) => !baseline.has(issue));
mkdirSync(path.join(ROOT, "output/quality"), { recursive: true });
writeFileSync(
  path.join(ROOT, "output/quality/dependencies.json"),
  `${JSON.stringify({ report, issues, failures }, null, 2)}\n`,
);
for (const failure of failures) console.error(failure);
console.log(`Dependency use: ${issues.length} existing findings; ${failures.length} new findings`);
process.exitCode = failures.length ? 1 : 0;
