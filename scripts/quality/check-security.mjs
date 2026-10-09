import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./source-files.mjs";

const result = spawnSync("npm", ["audit", "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
if (result.error) throw result.error;
const report = JSON.parse(result.stdout);
if (report.error) throw new Error(`Dependency advisory service failed: ${report.error.code}`);
const findings = [];
for (const [name, value] of Object.entries(report.vulnerabilities ?? {})) {
  for (const advisory of value.via) {
    if (typeof advisory !== "object") continue;
    findings.push({ name, severity: advisory.severity, url: advisory.url, range: advisory.range });
  }
}
findings.sort((a, b) => `${a.name} ${a.url}`.localeCompare(`${b.name} ${b.url}`));
const baselineFile = path.join(ROOT, "config/security-baseline.json");
if (process.argv.includes("--record-baseline")) {
  mkdirSync(path.dirname(baselineFile), { recursive: true });
  const expires = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  writeFileSync(
    baselineFile,
    `${JSON.stringify(
      {
        version: 1,
        reviewedAt: new Date().toISOString().slice(0, 10),
        expires,
        rationale:
          "Remaining advisories are inherited through pinned Harness RC2/legacy dependencies. Automatic major runtime changes are unsafe; compatibility migration is required. This temporary exception does not assert remediation. New advisories and all critical findings fail.",
        findings,
      },
      null,
      2,
    )}\n`,
  );
}
const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
const accepted = new Set(baseline.findings.map((item) => `${item.name} ${item.url} ${item.severity} ${item.range}`));
const failures = findings.filter(
  (item) => item.severity === "critical" || !accepted.has(`${item.name} ${item.url} ${item.severity} ${item.range}`),
);
if (new Date() > new Date(`${baseline.expires}T23:59:59Z`))
  failures.push({ name: "baseline", severity: "expired", url: "Renew only after a real security review" });
mkdirSync(path.join(ROOT, "output/quality"), { recursive: true });
writeFileSync(
  path.join(ROOT, "output/quality/security.json"),
  `${JSON.stringify({ summary: report.metadata.vulnerabilities, findings, failures }, null, 2)}\n`,
);
for (const finding of failures) console.error(`${finding.name}: ${finding.severity} ${finding.url}`);
console.log(
  `Security advisories: ${report.metadata.vulnerabilities.total} affected packages; ${failures.length} unaccepted/critical findings; baseline expires ${baseline.expires}`,
);
process.exitCode = failures.length ? 1 : 0;
