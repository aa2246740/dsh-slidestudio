import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "./source-files.mjs";

/**
 * CPU-profiles a disposable local app process with `node --cpu-prof`; never an
 * existing user service or a provider. Targets:
 *   server   legacy API        apps/server/src/index.mjs      (/api/diagnostics)
 *   editor   native sidecar    apps/native-web/src/server.mjs (/api/health)
 * The editor sidecar is the same process the dsh-slidestudio plugin spawns, so
 * `profile:editor` covers the plugin's interactive surface as well.
 */
const TARGETS = {
  server: { entry: "apps/server/src/index.mjs", probe: "/api/diagnostics" },
  editor: { entry: "apps/native-web/src/server.mjs", probe: "/api/health" },
  web: {
    entry: "node_modules/vite/bin/vite.js",
    args: ["--host", "127.0.0.1", "--strictPort"],
    cwd: "apps/web",
    probe: "/health.json",
  },
};
const name = process.argv.includes("--app") ? process.argv[process.argv.indexOf("--app") + 1] : "server";
const target = TARGETS[name];
if (!target) {
  console.error(`profile: unknown --app '${name}' (known: ${Object.keys(TARGETS).join(", ")})`);
  process.exit(2);
}

const freePort = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const profileDir = path.join(ROOT, "output/profiles");
mkdirSync(profileDir, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), "slidestudio-profile-"));
const cwd = path.join(ROOT, target.cwd ?? ".");
const entry = path.join(ROOT, target.entry);
const child = spawn(
  process.execPath,
  [
    "--cpu-prof",
    `--cpu-prof-dir=${profileDir}`,
    entry,
    ...(target.args ?? []),
    ...(target.args ? ["--port", String(freePort)] : []),
  ],
  {
    cwd: target.cwd ? cwd : scratch,
    env: { ...process.env, PORT: String(freePort), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
const exited = new Promise((resolve) => child.once("exit", resolve));
let timer;
try {
  await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`profile ${name} did not accept connections`)), 15000);
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`profile ${name} exited before readiness`)));
    (async () => {
      for (let i = 0; i < 60; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${freePort}${target.probe}`);
          if (r.status === 200) return resolve();
        } catch {}
        await new Promise((r) => setTimeout(r, 250));
      }
      reject(new Error(`profile ${name} probe ${target.probe} never returned 200`));
    })();
  });
  for (let i = 0; i < 50; i++) await fetch(`http://127.0.0.1:${freePort}${target.probe}`);
} finally {
  clearTimeout(timer);
  child.kill("SIGINT");
  await exited;
  rmSync(scratch, { recursive: true, force: true });
}
console.log(
  `Local CPU profile for ${name} written under ${profileDir}; contains runtime internals, review before sharing.`,
);
