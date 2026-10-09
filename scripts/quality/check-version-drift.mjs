import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./source-files.mjs";

const paths = [
  "package.json",
  ...["apps", "packages"].flatMap((dir) =>
    readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${dir}/${entry.name}/package.json`),
  ),
  "dsh-slidestudio/package.json",
];
const declarations = new Map();
for (const file of paths) {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
  for (const [name, value] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (/^(?:file|link|workspace):/.test(value)) continue;
    const version = value.replace(/^[~^]/, "");
    const locations = declarations.get(name) ?? {};
    (locations[version] ??= []).push(file);
    declarations.set(name, locations);
  }
}
const drift = Object.fromEntries([...declarations].filter(([, values]) => Object.keys(values).length > 1));
const baselineFile = path.join(ROOT, "config/version-drift-baseline.json");
if (process.argv.includes("--record-baseline")) {
  mkdirSync(path.dirname(baselineFile), { recursive: true });
  writeFileSync(baselineFile, `${JSON.stringify({ version: 1, drift }, null, 2)}\n`);
}
const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
const failures = Object.entries(drift).flatMap(([name, versions]) =>
  Object.entries(versions).flatMap(([version, locations]) =>
    locations
      .filter((file) => !baseline.drift[name]?.[version]?.includes(file))
      .map((file) => `${file}: ${name}@${version} creates version drift`),
  ),
);
mkdirSync(path.join(ROOT, "output/quality"), { recursive: true });
writeFileSync(
  path.join(ROOT, "output/quality/version-drift.json"),
  `${JSON.stringify({ drift, failures }, null, 2)}\n`,
);
for (const failure of failures) console.error(failure);
console.log(`Version drift: ${paths.length} manifests; ${failures.length} new conflicts`);
process.exitCode = failures.length ? 1 : 0;
