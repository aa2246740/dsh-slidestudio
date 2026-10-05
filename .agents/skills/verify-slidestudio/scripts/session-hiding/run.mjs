#!/usr/bin/env node
// Boot an isolated RC2 Web Host with dsh-slidestudio + the session-hiding
// probe and assert the Work-sidebar hiding path against the real
// workspaceRegistry / sessionQuery / session header store.
//
//   node scripts/session-hiding/run.mjs [--timeout <sec>]
//
// Env:
//   DSH_RC2_HOST          dir containing node_modules/@deepseek-ai/dsh@rc.2
//                         (default /tmp/rc2-host; create with `npm i @deepseek-ai/dsh@0.2.0-rc.2`)
//   OPEN_SLIDESTUDIO_ROOT repo checkout (default: this repo root)
//
// A fresh timestamped DSH_HOME is created per run; the OS picks the web port
// (--port 0) and the editor sidecar port, so a live stack is never disturbed.
// Never --keep: verification must stop its temporary Host and keep only the
// log under output/session-hiding/. Exit 1 on any failed assertion.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(process.env.OPEN_SLIDESTUDIO_ROOT ?? join(here, "../../../../.."));
const rc2Host = resolve(process.env.DSH_RC2_HOST ?? "/tmp/rc2-host");
const timeoutSec = Number(process.argv[process.argv.indexOf("--timeout") + 1] ?? 90);

const pluginEntry = join(repoRoot, "dsh-slidestudio/lib/types/dsh-slidestudio.js");
const probeEntry = join(here, "probe.js");
const hostModule = join(repoRoot, "packages/dsh-slides-host/dist/session-workspace.js");
for (const [label, p] of [
  ["plugin entry", pluginEntry],
  ["host module", hostModule],
  ["rc2 dsh", join(rc2Host, "node_modules/@deepseek-ai/dsh/lib/bin.js")],
]) {
  if (!existsSync(p)) {
    console.error(`${label} missing: ${p}`);
    process.exit(2);
  }
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }).on("error", rej);
});

const work = mkdtempSync(join(tmpdir(), "session-hiding-"));
const dshHome = join(work, "dsh-home");
mkdirSync(dshHome, { recursive: true });
const probeCwd = join(work, "agent-cwd");
mkdirSync(join(probeCwd, "output", "dsh-slices"), { recursive: true });
const outDir = join(repoRoot, "output/session-hiding");
mkdirSync(outDir, { recursive: true });
const logPath = join(outDir, `run-${Date.now().toString(36)}.log`);
const editorPort = await freePort();

writeFileSync(join(work, "probe.patch.yml"), [
  "- insert:",
  "    - id: dsh-slidestudio",
  `      name: '${pluginEntry}'`,
  "    - id: dps-probe-sessions",
  `      name: '${probeEntry}'`,
  "",
].join("\n"));

const log = createWriteStream(logPath);
const child = spawn("npx", ["dsh", "web", "--patch", join(work, "probe.patch.yml"), "--no-open", "--port", "0"], {
  cwd: rc2Host,
  env: {
    ...process.env,
    DSH_HOME: dshHome,
    OPEN_SLIDESTUDIO_ROOT: repoRoot,
    PROBE_CWD: probeCwd,
    SLIDES_EDITOR_PORT: String(editorPort),
  },
});
child.stdout.pipe(log);
child.stderr.pipe(log);

let buf = "";
child.stdout.on("data", (d) => { buf += d.toString(); });
child.stderr.on("data", (d) => { buf += d.toString(); });

const deadline = Date.now() + timeoutSec * 1000;
while (!buf.includes("[probe] done") && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  if (buf.includes("[probe] fatal")) break;
}
child.kill("SIGTERM");

const checks = [
  ["Host exposes workspaceRegistry + sessionQuery", /\[probe\] services: registry=function query=function/],
  ["subagent session accepted, header keeps origin", /\[probe\] subagent header origin=subagent preset=slides/],
  ["sweep archived the legacy session and removed its workspace", /\[probe\] sweep archived=1 removedWorkspaces=1 failures=0/],
  ["legacy archived, subagent untouched", /\[probe\] after sweep: legacy archived=true sub archived=false/],
  ["SlideStudio workspace registration deleted", /\[probe\] slides workspace gone=true/],
  ["ensureRunnable unarchives for a resume", /\[probe\] after ensureRunnable archived=false/],
  ["settle re-archives the resumed legacy session", /\[probe\] after settle archived=true/],
  ["plugin startup sweep logged no failures", /^(?!.*hiding slides sessions:).*$/s],
  ["probe finished", /\[probe\] done/],
];

let fail = 0;
for (const [label, re] of checks) {
  const ok = re.test(buf);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) fail++;
}
console.log(`[session-hiding] log: ${logPath}`);
for (const line of buf.split("\n").filter((l) => l.includes("[probe]") || l.includes("[slides-host]"))) {
  console.log(`  ${line}`);
}
process.exit(fail === 0 ? 0 : 1);
