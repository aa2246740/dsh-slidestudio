import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { ensureSlidesProfileCurrent } from "./dsh-profile-sync.mjs";

function portFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;
}

// 13080 is the product Hub. 3080 is DSH.app's well-known default — do not steal it.
export const DSH_PORT = portFromEnv("SLIDES_DSH_PORT", 13080);
export const DSH_BASE = `http://127.0.0.1:${DSH_PORT}`;
export const EDITOR_PORT = portFromEnv("SLIDES_EDITOR_PORT", 55200);
export const EDITOR_ORIGIN = `http://127.0.0.1:${EDITOR_PORT}`;

function nodeHasZstd(bin) {
  const probe = spawnSync(
    bin,
    ["-e", "import('node:zlib').then((z) => { process.exit(typeof z.createZstdDecompress === 'function' ? 0 : 2); })"],
    { stdio: "ignore" },
  );
  return probe.status === 0;
}

export function zstdNodeBinDir() {
  if (typeof zlib.createZstdDecompress === "function") {
    return path.dirname(process.execPath);
  }
  const nvmRoot = path.join(os.homedir(), ".nvm", "versions", "node");
  if (fs.existsSync(nvmRoot)) {
    const versions = fs.readdirSync(nvmRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const dir = path.join(nvmRoot, version, "bin");
      const bin = path.join(dir, "node");
      if (fs.existsSync(bin) && nodeHasZstd(bin)) return dir;
    }
  }
  throw new Error(`DSH rc.2 needs Node >= 22.19.0 (zlib createZstdDecompress). Current process is ${process.version}.`);
}

function firstNonempty(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function bindMinimaxKeysForChild(env) {
  const value = firstNonempty([env.MINIMAX_CN_API_KEY, env.MINIMAXCN_API_KEY, env.MINIMAX_API_KEY]);
  if (value) {
    env.MINIMAX_CN_API_KEY = value;
    env.MINIMAXCN_API_KEY = value;
    env.MINIMAX_API_KEY = value;
  }
  return env;
}

export function dshEnv(extra = {}) {
  const binDir = zstdNodeBinDir();
  return bindMinimaxKeysForChild({
    ...process.env,
    ...extra,
    OPEN_SLIDESTUDIO_ROOT: extra.OPEN_SLIDESTUDIO_ROOT ?? process.env.OPEN_SLIDESTUDIO_ROOT ?? process.cwd(),
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  });
}

/** `node_modules/.bin/dsh` is a shell shim Windows cannot spawn; run the package entry with the current Node instead. */
export function dshCommand(dsh, args) {
  const entry = path.join(path.dirname(dsh), "..", "@deepseek-ai", "dsh", "lib", "bin.js");
  return fs.existsSync(entry) ? { command: process.execPath, args: [entry, ...args] } : { command: dsh, args };
}

/** DSH's launcher starts only when `import.meta.main` exists (Node 22.18+ / 24.2+; this repo requires 22.19+ / 24.11+); older Node exits 0 silently. */
export function assertDshNodeRuntime() {
  if (typeof import.meta.main === "boolean") return;
  throw new Error(
    `Node ${process.versions.node} cannot start DSH (import.meta.main is missing). Install Node 22.19+ or 24.11+ and retry.`,
  );
}

export function spawnSlidesDsh(opts) {
  assertDshNodeRuntime();
  ensureSlidesProfileCurrent(opts.cwd, opts.home);
  if (DSH_PORT === 3080) {
    throw new Error("SLIDES_DSH_PORT=3080 collides with DSH.app's default port. Use 13080 (product default).");
  }
  const dsh = dshCommand(opts.dsh, ["--profile", "slides", "--port", String(DSH_PORT), "--no-open"]);
  const child = spawn(dsh.command, dsh.args, {
    cwd: opts.cwd,
    env: dshEnv({
      DSH_HOME: opts.home,
      SLIDESTUDIO_EDITOR_URL: opts.env?.SLIDESTUDIO_EDITOR_URL ?? EDITOR_ORIGIN,
      ...(opts.env ?? {}),
    }),
    stdio: opts.onStdoutLine ? ["inherit", "pipe", "inherit"] : "inherit",
  });
  if (opts.onStdoutLine && child.stdout) {
    let pending = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      pending += String(chunk);
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        opts.onStdoutLine(line);
        nl = pending.indexOf("\n");
      }
    });
  }
  return child;
}

export async function ensureNativeWebSidecar(root) {
  try {
    const res = await fetch(`${EDITOR_ORIGIN}/api/health`);
    if (res.ok) {
      // A listening port is not proof it is OUR editor — an unrelated app on
      // the same port would silently shadow the sidecar. Require the product
      // marker the sidecar reports in /api/health.
      const body = await res.json().catch(() => null);
      if (body?.product !== "DSH SlideStudio") {
        throw new Error(
          `port ${EDITOR_PORT} is occupied by a foreign service ` +
            `(health.product=${JSON.stringify(body?.product ?? null)}). ` +
            `Stop it or set SLIDES_EDITOR_PORT.`,
        );
      }
      return null;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("foreign service")) throw error;
    // nothing listening — start ours
  }
  const child = spawn(process.execPath, ["apps/native-web/src/server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(EDITOR_PORT), SLIDES_DSH_PORT: String(DSH_PORT) },
    stdio: "inherit",
  });
  await waitHttpOk(`${EDITOR_ORIGIN}/api/health`, 45_000, "native-web", watchExit(child));
  return child;
}

export function watchExit(child) {
  const state = { exited: false, code: undefined, signal: undefined };
  child.on("exit", (code, signal) => {
    state.exited = true;
    state.code = code;
    state.signal = signal;
  });
  return state;
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitHttpOk(url, timeoutMs, label, childState) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (childState?.exited) {
      throw new Error(`${label} exited before ${url} (code=${childState.code} signal=${childState.signal})`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      // boot
    }
    await wait(250);
  }
  throw new Error(`${label} timed out waiting for ${url}`);
}
