import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "./source-files.mjs";

// Profiles a disposable legacy API, never an existing user service or provider.
const profileDir = path.join(ROOT, "output/profiles");
mkdirSync(profileDir, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), "slidestudio-profile-"));
const child = spawn(
  process.execPath,
  ["--cpu-prof", `--cpu-prof-dir=${profileDir}`, path.join(ROOT, "apps/server/src/index.mjs")],
  {
    cwd: scratch,
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
let output = "";
let timer;
const exited = new Promise((resolve) => child.once("exit", resolve));
try {
  const port = await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("profile API did not announce its ephemeral port")), 10000);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("profile API exited before readiness")));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /127\.0\.0\.1:(\d+)/.exec(output);
      if (match && match[1] !== "0") {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  for (let i = 0; i < 50; i++) await fetch(`http://127.0.0.1:${port}/api/diagnostics`);
} finally {
  clearTimeout(timer);
  child.kill("SIGINT");
  await exited;
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`Local CPU profile written under ${profileDir}; contains runtime internals, review before sharing.`);
