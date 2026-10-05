import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PINNED_PLAYWRIGHT_VERSION = "1.61.1";
export const PINNED_CHROMIUM_REVISION = "1228";

export function repoPlaywrightRuntimeFile(repoRoot) {
  return path.join(repoRoot, ".runtime", "playwright", "runtime.mjs");
}

export function homePlaywrightRuntimeFile(homeDir = os.homedir()) {
  return path.join(homeDir, ".codex", "playwright-runtime", "runtime.mjs");
}

export function managedPlaywrightRuntimeFile(stateDir) {
  return path.join(stateDir, "playwright-runtime", "runtime.mjs");
}

export function defaultSlidesStateDir(env = process.env, homeDir = os.homedir()) {
  const home = env.DSH_HOME?.trim() || path.join(homeDir, ".dsh");
  return path.join(home, "data", "dsh-slidestudio");
}

export function runtimeFileLooksPinned(runtimeFile) {
  try {
    if (!fs.existsSync(runtimeFile)) return false;
    const st = fs.statSync(runtimeFile);
    if (!st.isFile() || st.size < 32) return false;
    const head = fs.readFileSync(runtimeFile, "utf8").slice(0, 8000);
    return head.includes("launchPinnedChromium") && head.includes("verifyPinnedRuntime");
  } catch {
    return false;
  }
}

const STAMP_RE = {
  version: /PINNED_PLAYWRIGHT_VERSION\s*=\s*"([^"]+)"/,
  revision: /PINNED_CHROMIUM_REVISION\s*=\s*"([^"]+)"/,
  moduleDir: /MODULE_DIR\s*=\s*"([^"]+)"/,
  browsersDir: /BROWSERS_DIR\s*=\s*"([^"]+)"/,
  browserDirName: /BROWSER_DIR_NAME\s*=\s*"([^"]+)"/,
};

function readRuntimeStamp(runtimeFile) {
  try {
    const head = fs.readFileSync(runtimeFile, "utf8").slice(0, 16000);
    const pick = (re) => head.match(re)?.[1];
    return {
      version: pick(STAMP_RE.version),
      revision: pick(STAMP_RE.revision),
      moduleDir: pick(STAMP_RE.moduleDir),
      browsersDir: pick(STAMP_RE.browsersDir),
      browserDirName: pick(STAMP_RE.browserDirName),
    };
  } catch {
    return {};
  }
}

const EXECUTABLE_NAMES = new Set([
  "chrome-headless-shell",
  "headless_shell.exe",
  "chrome",
  "Chromium",
  "chrome.exe",
]);

function findBrowserExecutable(directory) {
  if (!fs.existsSync(directory)) return "";
  const stack = [directory];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile() && EXECUTABLE_NAMES.has(entry.name)) return p;
    }
  }
  return "";
}

/**
 * Self-consistency check for candidates this process did not just write —
 * mirrors packages/presentation-run playwright-runtime.ts runtimeLayoutUsable.
 */
export function runtimeLayoutUsable(runtimeFile, env = process.env) {
  if (!runtimeFileLooksPinned(runtimeFile)) return false;
  const stamp = readRuntimeStamp(runtimeFile);
  const dir = path.dirname(runtimeFile);
  const moduleDir = stamp.moduleDir ?? path.join(dir, "node_modules");
  const packagePath = path.join(moduleDir, "playwright", "package.json");
  try {
    if (stamp.version) {
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      if (pkg.version !== stamp.version) return false;
    } else if (!fs.existsSync(packagePath)) {
      return false;
    }
  } catch {
    return false;
  }
  const browserDirName =
    stamp.browserDirName ?? `chromium_headless_shell-${stamp.revision ?? PINNED_CHROMIUM_REVISION}`;
  const browsersDirs = [
    env.PLAYWRIGHT_BROWSERS_PATH?.trim(),
    stamp.browsersDir,
    path.join(dir, "browsers"),
  ].filter(Boolean);
  return browsersDirs.some(
    (base) => findBrowserExecutable(path.join(base, browserDirName)) !== "",
  );
}

/**
 * Same lookup as packages/presentation-run playwright-runtime.ts. Keep aligned:
 * SLIDESTUDIO_PLAYWRIGHT_RUNTIME (exclusive if set) → repo .runtime → managed
 * <stateDir>/playwright-runtime → self-consistent ~/.codex seed → managed path
 * (not ready). Machine discovery + provisioning live in the runtime package;
 * dev scripts recover a missing runtime via setup:browser.
 */
export function resolvePlaywrightRuntimeFile(
  env = process.env,
  roots = { repoRoot: env.OPEN_SLIDESTUDIO_ROOT?.trim() || process.cwd(), homeDir: os.homedir() },
) {
  const configured = env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME?.trim();
  if (configured) {
    return { path: configured, ready: runtimeFileLooksPinned(configured), source: "env" };
  }
  const local = repoPlaywrightRuntimeFile(roots.repoRoot);
  if (runtimeFileLooksPinned(local)) return { path: local, ready: true, source: "repo" };
  const stateDir = roots.stateDir ?? defaultSlidesStateDir(env, roots.homeDir);
  const managed = managedPlaywrightRuntimeFile(stateDir);
  if (runtimeLayoutUsable(managed, env)) {
    return { path: managed, ready: true, source: "managed" };
  }
  const home = homePlaywrightRuntimeFile(roots.homeDir);
  if (runtimeLayoutUsable(home, env)) return { path: home, ready: true, source: "codex" };
  // Dev scripts recover via setup:browser, which writes the repo .runtime —
  // point the pending path there so the error tells you what to run.
  return { path: local, ready: false, source: "pending" };
}
