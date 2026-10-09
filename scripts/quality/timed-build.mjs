import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./source-files.mjs";

const stages = [
  ["native", ["run", "build:native"]],
  ["legacy", ["run", "build:legacy"]],
];
if (process.argv.includes("--with-plugin")) stages.push(["plugin", ["run", "build", "--prefix", "dsh-slidestudio"]]);
const measurements = [];
for (const [stage, args] of stages) {
  const start = performance.now();
  const code = await new Promise((resolve, reject) => {
    const child = spawn("npm", args, { cwd: ROOT, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", resolve);
  });
  measurements.push({ stage, elapsedMs: Math.round(performance.now() - start), exitCode: code });
  if (code !== 0) {
    process.exitCode = code ?? 1;
    break;
  }
}
const file = path.join(ROOT, "output/quality/build-history.json");
mkdirSync(path.dirname(file), { recursive: true });
const history = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
history.push({ at: new Date().toISOString(), incremental: true, measurements });
writeFileSync(file, `${JSON.stringify(history.slice(-30), null, 2)}\n`);
console.table(measurements);
