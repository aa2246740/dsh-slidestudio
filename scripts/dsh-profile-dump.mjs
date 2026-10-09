#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dshEnv } from "./lib/dsh-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.DSH_HOME || path.join(ROOT, ".dsh", "home");
const dsh = path.join(ROOT, "node_modules", ".bin", "dsh");
const outFile = path.join(ROOT, "packages", "dsh-slides-bundle", "profile.baseline.yaml");

if (!fs.existsSync(dsh)) {
  throw new Error("dsh binary missing; run npm install");
}
if (!fs.existsSync(path.join(HOME, "profiles", "slides", "package.json"))) {
  throw new Error("slides profile missing; run npm run dsh:profile:init");
}

const result = spawnSync(dsh, ["--profile", "slides", "--dump-config"], {
  cwd: ROOT,
  env: dshEnv({ DSH_HOME: HOME }),
  encoding: "utf8",
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || "dump-config failed\n");
  process.exit(result.status || 1);
}
const dump = result.stdout;
if (process.argv.includes("--write")) {
  fs.writeFileSync(outFile, dump);
  console.error(`wrote ${outFile}`);
}
process.stdout.write(dump);
if (!dump.includes("id: ui-layout") || !/id: ui-layout[\s\S]*?disabled:\s*true/.test(dump)) {
  process.stderr.write("dump-config is missing a disabled ui-layout row\n");
  process.exit(1);
}
if (/id: ui-settings\n {2}name: '@deepseek-ai\/dsh-client-ui-settings'\n {2}disabled: true/.test(dump)) {
  process.stderr.write("ui-settings must stay enabled so settingsScope exists\n");
  process.exit(1);
}
if (!dump.includes("@open-slidestudio/dsh-slides-client")) {
  process.stderr.write("dump-config is missing slides-client\n");
  process.exit(1);
}
