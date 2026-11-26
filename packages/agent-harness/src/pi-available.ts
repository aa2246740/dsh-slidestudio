/**
 * Probe whether a Pi binary exists. Never start a session here.
 */
import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { piConfigFromEnv } from "./pi-rpc.js";

export type PiAvailability = {
  available: boolean;
  bin: string;
  note: string;
};

const require = createRequire(import.meta.url);

function packageRootFromResolvedFile(file: string): string | undefined {
  try {
    const real = realpathSync(file);
    const direct = path.resolve(path.dirname(real), "..");
    if (existsSync(path.join(direct, "dist", "index.js"))) return direct;
  } catch {
    return undefined;
  }
  return undefined;
}

function resolvePiOnPath(bin: string): string | undefined {
  try {
    const found = execFileSync("which", [bin], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return found || undefined;
  } catch {
    return undefined;
  }
}

/** Installed `@earendil-works/pi-coding-agent` next to SLIDESTUDIO_PI_BIN. */
export function findPiSdkRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const bin = piConfigFromEnv(env).bin;
  try {
    const entry = require.resolve("@earendil-works/pi-coding-agent");
    const root = packageRootFromResolvedFile(entry);
    if (root) return root;
  } catch {
    /* The product may be using an existing global Pi during development. */
  }
  const resolvedBin = bin.includes("/") || bin.includes("\\") ? bin : resolvePiOnPath(bin);
  if (resolvedBin) {
    const root = packageRootFromResolvedFile(resolvedBin);
    if (root) return root;
  }
  const candidates: string[] = [];
  if (bin.includes("/") || bin.includes("\\")) {
    candidates.push(path.resolve(path.dirname(bin), ".."));
  }
  const home = env.HOME || process.env.HOME;
  if (home) candidates.push(path.join(home, ".local", "pi-agent"));
  for (const root of candidates) {
    const pkg = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(path.join(pkg, "dist", "index.js"))) return pkg;
  }
  return undefined;
}

export function piAvailable(env: NodeJS.ProcessEnv = process.env): PiAvailability {
  const bin = piConfigFromEnv(env).bin;
  if (bin.includes("/") || bin.includes("\\")) {
    if (existsSync(bin)) {
      const pinned = /@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js$/.test(bin);
      return {
        available: true,
        bin,
        note: pinned ? "repository-pinned Pi Agent" : "Pi binary from SLIDESTUDIO_PI_BIN",
      };
    }
    return {
      available: false,
      bin,
      note: `SLIDESTUDIO_PI_BIN points at a missing file: ${bin}`,
    };
  }
  try {
    execFileSync("which", [bin], { timeout: 1500, stdio: "pipe" });
    return { available: true, bin, note: `${bin} is on PATH` };
  } catch {
    return {
      available: false,
      bin,
      note: "Pi Agent runtime is unavailable — product generation is blocked",
    };
  }
}
