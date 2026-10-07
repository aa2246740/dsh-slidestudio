/**
 * Playwright raster runtime resolution.
 *
 * The plugin package ships no browser: a runtime is a directory containing a
 * generated `runtime.mjs` that knows how to launch a headless Chromium. Lookup
 * order:
 *
 *   1. SLIDESTUDIO_PLAYWRIGHT_RUNTIME — explicit override, exclusive.
 *   2. <repo>/.runtime/playwright/runtime.mjs — dev checkout (`setup:browser`).
 *   3. <stateDir>/playwright-runtime/runtime.mjs — managed dir under the DSH
 *      data root (~/.dsh/data/dsh-slidestudio), survives plugin upgrades.
 *   4. ~/.codex/playwright-runtime/runtime.mjs — legacy seed; only used when
 *      it is self-consistent (module + executable actually present).
 *   5. machine discovery — any existing playwright install (global or repo
 *      node_modules) plus a browser in PLAYWRIGHT_BROWSERS_PATH or the OS
 *      default registry is materialized into the managed dir.
 *   6. none — resolve to the managed path, `ready: false`; callers may
 *      provision it via provisionManagedRuntime().
 *
 * Mirrored by scripts/lib/playwright-runtime-path.mjs and
 * packages/agent-harness/src/page-raster.ts — keep them aligned.
 */
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);

export const PINNED_PLAYWRIGHT_VERSION = "1.61.1";
export const PINNED_CHROMIUM_REVISION = "1228";

export type PlaywrightRuntimeRoots = {
  readonly repoRoot?: string;
  readonly homeDir?: string;
  /** DSH data root for this plugin, e.g. <home>/data/dsh-slidestudio. */
  readonly stateDir?: string;
};

export type PlaywrightRuntimeSource =
  | "env"
  | "repo"
  | "managed"
  | "codex"
  | "machine"
  | "pending";

export type PlaywrightRuntimeResolution = {
  /** runtime.mjs path that should be launched (or provisioned). */
  readonly path: string;
  /** true when the file exists and looks usable right now. */
  readonly ready: boolean;
  readonly source: PlaywrightRuntimeSource;
};

export function repoPlaywrightRuntimeFile(repoRoot: string): string {
  return path.join(repoRoot, ".runtime", "playwright", "runtime.mjs");
}

export function codexPlaywrightRuntimeFile(homeDir = os.homedir()): string {
  return path.join(homeDir, ".codex", "playwright-runtime", "runtime.mjs");
}

export function defaultSlidesStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): string {
  const home = env.DSH_HOME?.trim() || path.join(homeDir, ".dsh");
  return path.join(home, "data", "dsh-slidestudio");
}

export function managedPlaywrightRuntimeDir(stateDir: string): string {
  return path.join(stateDir, "playwright-runtime");
}

export function managedPlaywrightRuntimeFile(stateDir: string): string {
  return path.join(managedPlaywrightRuntimeDir(stateDir), "runtime.mjs");
}

/**
 * Cheap contract check only: the file exists and advertises the launch API.
 * Does not prove the playwright module or browser are present — use
 * runtimeLayoutUsable() for candidates we did not provision ourselves.
 */
export function runtimeFileReady(runtimeFile: string): boolean {
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

type RuntimeStamp = {
  version?: string;
  revision?: string;
  moduleDir?: string;
  browsersDir?: string;
  browserDirName?: string;
};

function readRuntimeStamp(runtimeFile: string): RuntimeStamp {
  try {
    const head = fs.readFileSync(runtimeFile, "utf8").slice(0, 16000);
    const pick = (re: RegExp) => head.match(re)?.[1];
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

export const RUNTIME_EXECUTABLE_NAMES = [
  "chrome-headless-shell",
  // Windows: the headless-shell binary is chrome-headless-shell.exe — without
  // it a perfectly installed runtime reads as unusable on Windows.
  "chrome-headless-shell.exe",
  "headless_shell.exe",
  "chrome",
  "Chromium",
  "chrome.exe",
] as const;

export function findBrowserExecutable(directory: string): string {
  if (!fs.existsSync(directory)) return "";
  const stack = [directory];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile() && (RUNTIME_EXECUTABLE_NAMES as readonly string[]).includes(entry.name)) {
        return p;
      }
    }
  }
  return "";
}

/**
 * Deeper check used for candidates this process did not just write: the
 * runtime file's stamped playwright package and browser must actually exist.
 * Mirrors verifyPinnedRuntime() without importing the module.
 */
export function runtimeLayoutUsable(
  runtimeFile: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!runtimeFileReady(runtimeFile)) return false;
  const stamp = readRuntimeStamp(runtimeFile);
  const dir = path.dirname(runtimeFile);
  const moduleDir = stamp.moduleDir ?? path.join(dir, "node_modules");
  const packagePath = path.join(moduleDir, "playwright", "package.json");
  try {
    if (stamp.version) {
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: string };
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
  ].filter((d): d is string => Boolean(d));
  return browsersDirs.some(
    (base) => findBrowserExecutable(path.join(base, browserDirName)) !== "",
  );
}

/**
 * A machine playwright that can be adopted as-is: an installed playwright
 * package plus a downloaded chromium/headless-shell in a registry dir.
 */
export type DiscoveredPlaywright = {
  /** dir containing the playwright package (its node_modules dir). */
  readonly moduleDir: string;
  /** playwright package version actually found. */
  readonly version: string;
  /** registry dir containing browserDirName. */
  readonly browsersDir: string;
  /** e.g. chromium_headless_shell-1243 or chromium-1243. */
  readonly browserDirName: string;
  readonly revision: string;
  readonly executablePath: string;
};

export function defaultPlaywrightBrowsersDirs(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
): string[] {
  const dirs: string[] = [];
  const configured = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (configured) dirs.push(configured);
  if (platform === "darwin") dirs.push(path.join(homeDir, "Library", "Caches", "ms-playwright"));
  else if (platform === "win32") dirs.push(path.join(env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local"), "ms-playwright"));
  else dirs.push(path.join(homeDir, ".cache", "ms-playwright"));
  return dirs;
}

function playwrightModuleAt(nodeModulesDir: string): { moduleDir: string; version: string } | undefined {
  const packagePath = path.join(nodeModulesDir, "playwright", "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: string };
    if (!pkg.version) return undefined;
    if (!fs.existsSync(path.join(nodeModulesDir, "playwright", "index.mjs"))) return undefined;
    return { moduleDir: nodeModulesDir, version: pkg.version };
  } catch {
    return undefined;
  }
}

let cachedGlobalNodeModules: string | undefined;
function globalNodeModulesDir(): string {
  if (cachedGlobalNodeModules !== undefined) return cachedGlobalNodeModules;
  cachedGlobalNodeModules = "";
  try {
    const out = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 5000 });
    if (out.status === 0) cachedGlobalNodeModules = out.stdout.trim();
  } catch {
    /* npm not installed — discovery just skips the global dir */
  }
  return cachedGlobalNodeModules;
}

/** Every place an existing playwright package might already live. */
export function playwrightModuleSearchDirs(
  env: NodeJS.ProcessEnv,
  roots: PlaywrightRuntimeRoots,
): string[] {
  const dirs: string[] = [];
  const repo = env.OPEN_SLIDESTUDIO_ROOT?.trim() || roots.repoRoot;
  const push = (d: string | undefined) => {
    const v = d?.trim();
    if (v && !dirs.includes(v)) dirs.push(v);
  };
  for (const base of [repo, roots.stateDir, process.cwd(), roots.homeDir ?? os.homedir()]) {
    push(base ? path.join(base, "node_modules") : undefined);
    push(base);
  }
  for (const entry of (env.NODE_PATH ?? "").split(path.delimiter)) push(entry);
  push(globalNodeModulesDir());
  return dirs;
}

function expectedBrowserDirs(moduleDir: string): { headlessShell?: string; chromium?: string } {
  try {
    const browsersJson = path.join(moduleDir, "playwright-core", "browsers.json");
    const data = JSON.parse(fs.readFileSync(browsersJson, "utf8")) as {
      browsers?: Array<{ name?: string; revision?: string }>;
    };
    const find = (name: string) =>
      data.browsers?.find((b) => b.name === name)?.revision;
    return {
      headlessShell: find("chromium-headless-shell"),
      chromium: find("chromium"),
    };
  } catch {
    return {};
  }
}

function scanBrowsersDir(
  browsersDir: string,
  preferred: Array<{ dirName: string; revision: string }>,
): { browserDirName: string; revision: string; executablePath: string } | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(browsersDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates = entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const m = e.name.match(/^(chromium_headless_shell|chromium)-(\d+)$/);
      return m ? { browserDirName: e.name, revision: m[2]!, kind: m[1]! } : undefined;
    })
    .filter((c): c is { browserDirName: string; revision: string; kind: string } => Boolean(c));
  const usable = candidates
    .map((c) => ({ ...c, executablePath: findBrowserExecutable(path.join(browsersDir, c.browserDirName)) }))
    .filter((c) => c.executablePath !== "");
  for (const want of preferred) {
    const hit = usable.find((c) => c.browserDirName === want.dirName);
    if (hit) return hit;
  }
  usable.sort((a, b) => {
    const shellBias = (c: { kind: string }) => (c.kind === "chromium_headless_shell" ? 0 : 1);
    return shellBias(a) - shellBias(b) || Number(b.revision) - Number(a.revision);
  });
  const top = usable[0];
  return top ? { browserDirName: top.browserDirName, revision: top.revision, executablePath: top.executablePath } : undefined;
}

/**
 * Find a playwright package plus a downloaded browser on this machine —
 * e.g. the reporter's global `npm i -g playwright` + `npx playwright install`.
 */
export function discoverMachinePlaywright(opts: {
  env?: NodeJS.ProcessEnv;
  roots?: PlaywrightRuntimeRoots;
  moduleDirs?: string[];
  browsersDirs?: string[];
}): DiscoveredPlaywright | undefined {
  const env = opts.env ?? process.env;
  const roots = opts.roots ?? {};
  const moduleDirs = opts.moduleDirs ?? playwrightModuleSearchDirs(env, roots);
  const browsersDirs = opts.browsersDirs ?? defaultPlaywrightBrowsersDirs(env, roots.homeDir);

  // A playwright module with no browsers is still worth provisioning against,
  // but discovery itself requires both halves to exist.
  let module: { moduleDir: string; version: string } | undefined;
  for (const dir of moduleDirs) {
    module = playwrightModuleAt(dir);
    if (module) break;
  }
  if (!module) {
    // Last resort: node's own resolution from the repo/cwd — catches hoisted
    // workspace installs and other unusual layouts.
    for (const base of [env.OPEN_SLIDESTUDIO_ROOT?.trim(), roots.repoRoot, process.cwd()]) {
      if (!base) continue;
      try {
        const req = createRequire(path.join(base, "package.json"));
        const pkgPath = req.resolve("playwright/package.json");
        const nodeModules = path.dirname(path.dirname(pkgPath));
        module = playwrightModuleAt(nodeModules);
        if (module) break;
      } catch {
        /* not resolvable from this base */
      }
    }
  }
  if (!module) return undefined;

  const expected = expectedBrowserDirs(module.moduleDir);
  const preferred = [
    expected.headlessShell
      ? { dirName: `chromium_headless_shell-${expected.headlessShell}`, revision: expected.headlessShell }
      : undefined,
    expected.chromium
      ? { dirName: `chromium-${expected.chromium}`, revision: expected.chromium }
      : undefined,
  ].filter((d): d is { dirName: string; revision: string } => Boolean(d));

  for (const browsersDir of browsersDirs) {
    const found = scanBrowsersDir(browsersDir, preferred);
    if (found) {
      return {
        moduleDir: module.moduleDir,
        version: module.version,
        browsersDir,
        ...found,
      };
    }
  }
  return undefined;
}

/**
 * Partial reuse for provisioning: a playwright module without matching
 * browsers still saves the registry download; when browsers for the module's
 * expected revision also exist the pair is complete (discovery would have
 * already surfaced it).
 */
export function machineRuntimeReuse(
  env: NodeJS.ProcessEnv = process.env,
  roots: PlaywrightRuntimeRoots = {},
): Partial<DiscoveredPlaywright> | undefined {
  let module: { moduleDir: string; version: string } | undefined;
  for (const dir of playwrightModuleSearchDirs(env, roots)) {
    module = playwrightModuleAt(dir);
    if (module) break;
  }
  if (!module) {
    for (const base of [env.OPEN_SLIDESTUDIO_ROOT?.trim(), roots.repoRoot, process.cwd()]) {
      if (!base) continue;
      try {
        const req = createRequire(path.join(base, "package.json"));
        const pkgPath = req.resolve("playwright/package.json");
        module = playwrightModuleAt(path.dirname(path.dirname(pkgPath)));
        if (module) break;
      } catch {
        /* not resolvable from this base */
      }
    }
  }
  if (!module) return undefined;
  const expected = expectedBrowserDirs(module.moduleDir);
  const preferred = [
    expected.headlessShell
      ? { dirName: `chromium_headless_shell-${expected.headlessShell}`, revision: expected.headlessShell }
      : undefined,
    expected.chromium
      ? { dirName: `chromium-${expected.chromium}`, revision: expected.chromium }
      : undefined,
  ].filter((d): d is { dirName: string; revision: string } => Boolean(d));
  for (const browsersDir of defaultPlaywrightBrowsersDirs(env, roots.homeDir)) {
    const found = scanBrowsersDir(browsersDir, preferred);
    if (found) {
      return { moduleDir: module.moduleDir, version: module.version, browsersDir, ...found };
    }
  }
  return { moduleDir: module.moduleDir, version: module.version };
}

export type RuntimeSourceOptions = {
  version: string;
  revision: string;
  /** e.g. chromium_headless_shell-1228 or chromium-1243 (full browser). */
  browserDirName: string;
  /** Absolute node_modules dir; default <runtime dir>/node_modules. */
  moduleDir?: string;
  /** Absolute browsers registry dir; default <runtime dir>/browsers. */
  browsersDir?: string;
};

/**
 * The runtime.mjs contract consumed by page-raster launchBrowser(). Baked-in
 * constants let the file carry discovered (non-pinned) installs while keeping
 * runtimeFileReady()/runtimeLayoutUsable() honest. Mirrored by
 * scripts/setup-browser-runtime.mjs — keep the generated code aligned.
 */
export function playwrightRuntimeSource(opts: RuntimeSourceOptions): string {
  const moduleDirExpr = opts.moduleDir
    ? JSON.stringify(path.resolve(opts.moduleDir))
    : `join(root, "node_modules")`;
  const browsersDirExpr = opts.browsersDir
    ? JSON.stringify(path.resolve(opts.browsersDir))
    : `join(root, "browsers")`;
  return `import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PINNED_PLAYWRIGHT_VERSION = ${JSON.stringify(opts.version)};
const PINNED_CHROMIUM_REVISION = ${JSON.stringify(opts.revision)};
const BROWSER_DIR_NAME = ${JSON.stringify(opts.browserDirName)};
const root = fileURLToPath(new URL(".", import.meta.url));
const MODULE_DIR = ${moduleDirExpr};
const BROWSERS_DIR = ${browsersDirExpr};
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || BROWSERS_DIR;
const chromiumRoot = join(browsersPath, BROWSER_DIR_NAME);
const modulePath = join(MODULE_DIR, "playwright", "index.mjs");
const packagePath = join(MODULE_DIR, "playwright", "package.json");
const EXECUTABLE_NAMES = new Set([
  "chrome-headless-shell",
  "chrome-headless-shell.exe",
  "headless_shell.exe",
  "chrome",
  "Chromium",
  "chrome.exe",
]);

function findExecutable(directory) {
  if (!existsSync(directory)) return "";
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const p = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findExecutable(p);
      if (found) return found;
    } else if (entry.isFile() && EXECUTABLE_NAMES.has(entry.name)) {
      return p;
    }
  }
  return "";
}

export const pinnedRuntime = Object.freeze({
  playwrightVersion: PINNED_PLAYWRIGHT_VERSION,
  chromiumRevision: PINNED_CHROMIUM_REVISION,
  root,
  browsersPath,
  modulePath,
  packagePath,
  executablePath: existsSync(chromiumRoot) ? findExecutable(chromiumRoot) : "",
});

export function verifyPinnedRuntime() {
  if (!existsSync(packagePath)) throw new Error("Pinned Playwright package is missing: " + packagePath);
  const packageData = JSON.parse(readFileSync(packagePath, "utf8"));
  if (packageData.version !== pinnedRuntime.playwrightVersion) {
    throw new Error(
      "Pinned Playwright version mismatch: expected " +
        pinnedRuntime.playwrightVersion +
        ", found " +
        packageData.version,
    );
  }
  if (!pinnedRuntime.executablePath || !existsSync(pinnedRuntime.executablePath)) {
    throw new Error("Pinned Chromium executable is missing under " + chromiumRoot);
  }
  if (!pinnedRuntime.executablePath.includes(BROWSER_DIR_NAME)) {
    throw new Error(
      "Pinned Chromium executable resolved outside " + BROWSER_DIR_NAME + ": " + pinnedRuntime.executablePath,
    );
  }
  return pinnedRuntime;
}

export async function launchPinnedChromium(options = {}) {
  verifyPinnedRuntime();
  if (options.headless === false) throw new Error("SlideStudio render_page Playwright runtime is headless-only.");
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  const { chromium } = await import(pathToFileURL(modulePath).href);
  return chromium.launch({ ...options, headless: true, executablePath: pinnedRuntime.executablePath });
}

export async function loadPinnedPlaywright() {
  verifyPinnedRuntime();
  return import(pathToFileURL(modulePath).href);
}
`;
}

/** Write a runtime.mjs into the managed dir that delegates to a discovered install. */
export function materializeManagedRuntime(
  stateDir: string,
  discovered: DiscoveredPlaywright,
): string {
  const dir = managedPlaywrightRuntimeDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = managedPlaywrightRuntimeFile(stateDir);
  fs.writeFileSync(
    file,
    playwrightRuntimeSource({
      version: discovered.version,
      revision: discovered.revision,
      browserDirName: discovered.browserDirName,
      moduleDir: discovered.moduleDir,
      browsersDir: discovered.browsersDir,
    }),
    "utf8",
  );
  return file;
}

export function resolvePlaywrightRuntime(
  env: NodeJS.ProcessEnv = process.env,
  roots: PlaywrightRuntimeRoots = {},
  discovery: { moduleDirs?: string[]; browsersDirs?: string[] } = {},
): PlaywrightRuntimeResolution {
  const configured = env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME?.trim();
  if (configured) {
    return { path: configured, ready: runtimeFileReady(configured), source: "env" };
  }
  const repo = env.OPEN_SLIDESTUDIO_ROOT?.trim() || roots.repoRoot || process.cwd();
  const local = repoPlaywrightRuntimeFile(repo);
  if (runtimeFileReady(local)) return { path: local, ready: true, source: "repo" };

  const stateDir = roots.stateDir ?? defaultSlidesStateDir(env, roots.homeDir);
  const managed = managedPlaywrightRuntimeFile(stateDir);
  if (runtimeLayoutUsable(managed, env)) {
    return { path: managed, ready: true, source: "managed" };
  }

  const codex = codexPlaywrightRuntimeFile(roots.homeDir);
  if (runtimeLayoutUsable(codex, env)) {
    return { path: codex, ready: true, source: "codex" };
  }

  const discovered = discoverMachinePlaywright({ env, roots, ...discovery });
  if (discovered) {
    try {
      materializeManagedRuntime(stateDir, discovered);
      if (runtimeLayoutUsable(managed, env)) {
        return { path: managed, ready: true, source: "machine" };
      }
    } catch {
      /* could not write the managed dir — fall through to pending */
    }
  }
  return { path: managed, ready: false, source: "pending" };
}

const NPM_REGISTRIES = [
  "https://registry.npmjs.org",
  "https://registry.npmmirror.com",
] as const;

const PLAYWRIGHT_DOWNLOAD_HOSTS = [
  undefined,
  "https://registry.npmmirror.com/-/binary/playwright",
] as const;

export type ProvisionResult = {
  readonly path: string;
  /** which halves were reused from the machine instead of downloaded. */
  readonly reusedModuleDir?: string;
  readonly reusedBrowsersDir?: string;
};

export type ProvisionOptions = {
  readonly playwrightVersion?: string;
  readonly log?: (message: string) => void;
  readonly registries?: readonly string[];
  readonly downloadHosts?: readonly (string | undefined)[];
  readonly fetchImpl?: typeof fetch;
  readonly execFileImpl?: typeof execFileAsync;
};

async function fetchTarball(
  registry: string,
  name: string,
  version: string,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  const url = `${registry}/${name}/-/${name}-${version}.tgz`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function extractTarball(tgz: Buffer, name: string, nodeModulesDir: string): Promise<void> {
  const tmp = path.join(nodeModulesDir, `.download-${name}-${process.pid}.tgz`);
  fs.writeFileSync(tmp, tgz);
  const unpackDir = path.join(nodeModulesDir, `.unpack-${name}-${process.pid}`);
  fs.mkdirSync(unpackDir, { recursive: true });
  try {
    await execFileAsync("tar", ["-xzf", tmp, "-C", unpackDir], { maxBuffer: 16 * 1024 * 1024 });
    const top = fs.readdirSync(unpackDir).filter((e) => e !== "package");
    const src = fs.existsSync(path.join(unpackDir, "package"))
      ? path.join(unpackDir, "package")
      : top.length === 1
        ? path.join(unpackDir, top[0]!)
        : undefined;
    if (!src) throw new Error(`unexpected tarball layout for ${name}`);
    fs.renameSync(src, path.join(nodeModulesDir, name));
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(unpackDir, { recursive: true, force: true });
  }
}

async function installPlaywrightPackages(
  dir: string,
  version: string,
  registries: readonly string[],
  fetchImpl: typeof fetch,
  log: (m: string) => void,
): Promise<void> {
  const nodeModules = path.join(dir, "node_modules");
  fs.mkdirSync(nodeModules, { recursive: true });
  let lastError: unknown;
  for (const registry of registries) {
    try {
      log(`[slides] downloading playwright@${version} from ${registry}`);
      const playwrightTgz = await fetchTarball(registry, "playwright", version, fetchImpl);
      await extractTarball(playwrightTgz, "playwright", nodeModules);
      const pkg = JSON.parse(
        fs.readFileSync(path.join(nodeModules, "playwright", "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };
      const coreVersion = (pkg.dependencies?.["playwright-core"] ?? version).replace(/^[\^~]/, "");
      log(`[slides] downloading playwright-core@${coreVersion} from ${registry}`);
      const coreTgz = await fetchTarball(registry, "playwright-core", coreVersion, fetchImpl);
      await extractTarball(coreTgz, "playwright-core", nodeModules);
      return;
    } catch (error) {
      lastError = error;
      log(`[slides] registry ${registry} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function installHeadlessShell(
  dir: string,
  moduleDir: string,
  opts: ProvisionOptions & { log: (message: string) => void },
): Promise<{ browserDirName: string; revision: string }> {
  const cli = path.join(moduleDir, "playwright", "cli.js");
  const browsersDir = path.join(dir, "browsers");
  const execFileImpl = opts.execFileImpl ?? execFileAsync;
  const hosts = opts.downloadHosts ?? PLAYWRIGHT_DOWNLOAD_HOSTS;
  let lastError: unknown;
  for (const host of hosts) {
    try {
      opts.log(`[slides] downloading Chromium Headless Shell${host ? ` via ${host}` : ""}`);
      await execFileImpl(
        process.execPath,
        [cli, "install", "chromium-headless-shell"],
        {
          env: {
            ...process.env,
            PLAYWRIGHT_BROWSERS_PATH: browsersDir,
            ...(host ? { PLAYWRIGHT_DOWNLOAD_HOST: host } : {}),
          },
          maxBuffer: 16 * 1024 * 1024,
          timeout: 10 * 60 * 1000,
        },
      );
      const expected = expectedBrowserDirs(moduleDir);
      const found = scanBrowsersDir(browsersDir, [
        expected.headlessShell
          ? { dirName: `chromium_headless_shell-${expected.headlessShell}`, revision: expected.headlessShell }
          : undefined,
      ].filter((d): d is { dirName: string; revision: string } => Boolean(d)));
      if (!found) throw new Error("chromium-headless-shell download produced no executable");
      return { browserDirName: found.browserDirName, revision: found.revision };
    } catch (error) {
      lastError = error;
      opts.log(`[slides] browser download failed${host ? ` via ${host}` : ""}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Download the pinned Playwright runtime into the managed dir — no npm, works
 * inside the packaged DSH host: registry tarballs plus playwright's own
 * browser downloader. Reuses an already-installed module/browsers when
 * `reuse` is given. Returns the managed runtime.mjs path.
 */
export async function provisionManagedRuntime(
  stateDir: string,
  opts: ProvisionOptions & { reuse?: Partial<DiscoveredPlaywright> } = {},
): Promise<ProvisionResult> {
  const log = opts.log ?? (() => undefined);
  const finalDir = managedPlaywrightRuntimeDir(stateDir);
  const finalFile = managedPlaywrightRuntimeFile(stateDir);
  if (runtimeLayoutUsable(finalFile)) return { path: finalFile };

  const stageDir = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  try {
    const version = opts.playwrightVersion ?? PINNED_PLAYWRIGHT_VERSION;
    let moduleDir = opts.reuse?.moduleDir;
    const provisionedModule = !moduleDir;
    if (!moduleDir) {
      await installPlaywrightPackages(stageDir, version, opts.registries ?? NPM_REGISTRIES, opts.fetchImpl ?? fetch, log);
      moduleDir = path.join(stageDir, "node_modules");
    }
    let browser: { browserDirName: string; revision: string; browsersDir: string };
    if (opts.reuse?.browsersDir && opts.reuse.browserDirName && opts.reuse.revision) {
      browser = {
        browsersDir: opts.reuse.browsersDir,
        browserDirName: opts.reuse.browserDirName,
        revision: opts.reuse.revision,
      };
    } else {
      const installed = await installHeadlessShell(stageDir, moduleDir, { ...opts, log });
      browser = { browsersDir: path.join(stageDir, "browsers"), ...installed };
    }
    const moduleVersion = provisionedModule
      ? version
      : (JSON.parse(
          fs.readFileSync(path.join(moduleDir, "playwright", "package.json"), "utf8"),
        ) as { version?: string }).version ?? version;

    fs.writeFileSync(
      path.join(stageDir, "runtime.mjs"),
      playwrightRuntimeSource({
        version: moduleVersion,
        revision: browser.revision,
        browserDirName: browser.browserDirName,
        moduleDir: opts.reuse?.moduleDir ? moduleDir : undefined,
        browsersDir: opts.reuse?.browsersDir ? browser.browsersDir : undefined,
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(stageDir, "package.json"),
      `${JSON.stringify({ name: "dsh-slidestudio-playwright-runtime", private: true, type: "module" }, null, 2)}\n`,
      "utf8",
    );

    // Publish atomically: swap the staged dir in only once it is complete.
    fs.mkdirSync(stateDir, { recursive: true });
    const oldDir = `${finalDir}.old-${process.pid}`;
    fs.rmSync(oldDir, { recursive: true, force: true });
    const hadFinal = fs.existsSync(finalDir);
    if (hadFinal) fs.renameSync(finalDir, oldDir);
    try {
      fs.renameSync(stageDir, finalDir);
    } catch (error) {
      if (hadFinal) fs.renameSync(oldDir, finalDir);
      throw error;
    }
    fs.rmSync(oldDir, { recursive: true, force: true });
    if (!runtimeLayoutUsable(finalFile)) {
      throw new Error(`provisioned runtime failed verification at ${finalFile}`);
    }
    log(`[slides] playwright runtime ready at ${finalDir}`);
    return {
      path: finalFile,
      reusedModuleDir: opts.reuse?.moduleDir,
      reusedBrowsersDir: opts.reuse?.browsersDir,
    };
  } catch (error) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}
