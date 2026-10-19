import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./source-files.mjs";
import { parseTypeDiagnostics } from "./type-diagnostics.mjs";

/**
 * checkJs adoption ratchet for the JavaScript apps. `tsc -p <app>/tsconfig.json`
 * runs real static type checking; findings are compared to
 * config/type-baseline.json so new type errors fail while existing adoption
 * debt stays visible. --record-baseline re-records the debt after a justified
 * change, like the other quality ratchets.
 */
const APPS = {
  "apps/server": "tsconfig.json",
  "apps/native-web": "tsconfig.json",
};

const onlyIdx = process.argv.indexOf("--app");
const only = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;
const apps = Object.keys(APPS).filter((a) => !only || a === `apps/${only}` || a === only);
if (!apps.length) {
  console.error(`check-types: unknown app '${only}' (known: ${Object.keys(APPS).join(", ")})`);
  process.exit(2);
}

const tsc = path.join(ROOT, "node_modules/typescript/bin/tsc");
const findingsByApp = {};
for (const app of apps) {
  const result = spawnSync(process.execPath, [tsc, "-p", path.join(ROOT, app, APPS[app]), "--pretty", "false"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const findings = parseTypeDiagnostics(out);
  if (result.error) throw result.error;
  if (result.status === null || (result.status === 2 && findings.length === 0)) {
    // tsc crashed without diagnostics (missing tsconfig, OOM) is itself a failure.
    if (!findings.length) findings.push(`${app} tsc exited ${result.status ?? result.signal}`);
  }
  findingsByApp[app] = findings.sort();
  console.log(`check-types: ${app} -> ${findings.length} type findings`);
}

const baselineFile = path.join(ROOT, "config/type-baseline.json");
if (process.argv.includes("--record-baseline")) {
  const existing = JSON.parse(readFileSync(baselineFile, "utf8"));
  writeFileSync(
    baselineFile,
    `${JSON.stringify({ version: 1, apps: { ...existing.apps, ...findingsByApp } }, null, 2)}\n`,
  );
  console.log(`check-types: baseline updated at ${path.relative(ROOT, baselineFile)}`);
  process.exit(0);
}
const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
const failures = Object.entries(findingsByApp).flatMap(([app, findings]) => {
  const known = new Set(baseline.apps?.[app] ?? []);
  return findings.filter((f) => !known.has(f)).map((f) => `${f} (new in ${app})`);
});
mkdirSync(path.join(ROOT, "output/quality"), { recursive: true });
writeFileSync(
  path.join(ROOT, "output/quality/type-findings.json"),
  `${JSON.stringify({ findings: findingsByApp, failures }, null, 2)}\n`,
);
for (const failure of failures) console.error(failure);
console.log(`Type findings: baseline-tracked debt unchanged; ${failures.length} new errors`);
process.exitCode = failures.length ? 1 : 0;
