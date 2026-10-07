#!/usr/bin/env node
/**
 * Pin Playwright 1.61.1 + Chromium headless shell 1228 into <repo>/.runtime/playwright.
 * Prefers a verified seed (SLIDESTUDIO_PLAYWRIGHT_RUNTIME_SOURCE or ~/.codex/playwright-runtime).
 * Hub generate must not depend on a Codex homedir that may be missing on the box.
 */
import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PINNED_CHROMIUM_REVISION, PINNED_PLAYWRIGHT_VERSION } from "./lib/playwright-pin.mjs";
import {
  homePlaywrightRuntimeFile,
  repoPlaywrightRuntimeFile,
  runtimeFileLooksPinned,
} from "./lib/playwright-runtime-path.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(ROOT, ".runtime", "playwright");
const browsersPath = path.join(runtimeRoot, "browsers");
const runtimeFile = repoPlaywrightRuntimeFile(ROOT);
const seedEnv = String(process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME_SOURCE || "").trim();

// Same runtime.mjs contract as playwrightRuntimeSource() in
// packages/presentation-run/src/domain/playwright-runtime.ts — keep aligned.
const runtimeSource = `import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PINNED_PLAYWRIGHT_VERSION = ${JSON.stringify(PINNED_PLAYWRIGHT_VERSION)};
const PINNED_CHROMIUM_REVISION = ${JSON.stringify(PINNED_CHROMIUM_REVISION)};
const BROWSER_DIR_NAME = ${JSON.stringify(`chromium_headless_shell-${PINNED_CHROMIUM_REVISION}`)};
const root = fileURLToPath(new URL(".", import.meta.url));
const MODULE_DIR = join(root, "node_modules");
const BROWSERS_DIR = join(root, "browsers");
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

function seedRuntimePath() {
  if (seedEnv) return path.resolve(seedEnv);
  const home = homePlaywrightRuntimeFile();
  if (runtimeFileLooksPinned(home)) return home;
  return "";
}

async function copySeed(seedPath) {
  const seed = await import(`${pathToFileURL(seedPath).href}?setup=${Date.now()}`);
  const pinned = seed.verifyPinnedRuntime();
  if (
    pinned.playwrightVersion !== PINNED_PLAYWRIGHT_VERSION ||
    pinned.chromiumRevision !== PINNED_CHROMIUM_REVISION
  ) {
    throw new Error(
      `Browser runtime seed mismatch: expected Playwright ${PINNED_PLAYWRIGHT_VERSION} / Chromium ${PINNED_CHROMIUM_REVISION}, found ${pinned.playwrightVersion} / ${pinned.chromiumRevision}`,
    );
  }
  const seedPlaywrightRoot = path.dirname(pinned.packagePath);
  const seedNodeModules = path.dirname(seedPlaywrightRoot);
  const seedCoreRoot = path.join(seedNodeModules, "playwright-core");
  const corePackage = JSON.parse(await readFile(path.join(seedCoreRoot, "package.json"), "utf8"));
  if (corePackage.version !== PINNED_PLAYWRIGHT_VERSION) {
    throw new Error(`Playwright Core seed mismatch: ${corePackage.version}`);
  }
  const seedBrowserRoot = path.join(pinned.browsersPath, `chromium_headless_shell-${PINNED_CHROMIUM_REVISION}`);
  await access(seedBrowserRoot);
  await rm(path.join(runtimeRoot, "node_modules"), { recursive: true, force: true });
  await rm(browsersPath, { recursive: true, force: true });
  await mkdir(path.join(runtimeRoot, "node_modules"), { recursive: true });
  await mkdir(browsersPath, { recursive: true });
  await cp(seedPlaywrightRoot, path.join(runtimeRoot, "node_modules", "playwright"), {
    recursive: true,
    dereference: false,
  });
  await cp(seedCoreRoot, path.join(runtimeRoot, "node_modules", "playwright-core"), {
    recursive: true,
    dereference: false,
  });
  await cp(seedBrowserRoot, path.join(browsersPath, `chromium_headless_shell-${PINNED_CHROMIUM_REVISION}`), {
    recursive: true,
    dereference: false,
  });
  console.log(`[setup:browser] copied verified runtime from ${seedPath}`);
}

async function npmInstall() {
  console.log(`[setup:browser] installing Playwright ${PINNED_PLAYWRIGHT_VERSION}`);
  await writeFile(
    path.join(runtimeRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "open-slidestudio-playwright-runtime",
        private: true,
        type: "module",
        dependencies: { playwright: PINNED_PLAYWRIGHT_VERSION },
      },
      null,
      2,
    )}\n`,
  );
  await execFileAsync("npm", ["install", "--prefix", runtimeRoot, "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: ROOT,
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    maxBuffer: 10 * 1024 * 1024,
  });
  console.log(`[setup:browser] installing Chromium Headless Shell revision ${PINNED_CHROMIUM_REVISION}`);
  await execFileAsync(
    process.execPath,
    [path.join(runtimeRoot, "node_modules", "playwright", "cli.js"), "install", "chromium-headless-shell"],
    {
      cwd: ROOT,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

async function writeRuntime() {
  await mkdir(runtimeRoot, { recursive: true });
  if (!existsSync(path.join(runtimeRoot, "package.json"))) {
    await writeFile(
      path.join(runtimeRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "open-slidestudio-playwright-runtime",
          private: true,
          type: "module",
          dependencies: { playwright: PINNED_PLAYWRIGHT_VERSION },
        },
        null,
        2,
      )}\n`,
    );
  }
  await writeFile(runtimeFile, runtimeSource, "utf8");
}

async function verify() {
  const runtime = await import(`${pathToFileURL(runtimeFile).href}?check=${Date.now()}`);
  return runtime.verifyPinnedRuntime();
}

async function smoke() {
  const runtime = await import(`${pathToFileURL(runtimeFile).href}?smoke=${Date.now()}`);
  const browser = await runtime.launchPinnedChromium();
  try {
    const page = await browser.newPage();
    await page.setContent("<title>open-slidestudio-browser-ok</title><main>raster</main>");
    const title = await page.title();
    if (title !== "open-slidestudio-browser-ok") throw new Error(`smoke title ${title}`);
    console.log("[setup:browser] smoke ok");
  } finally {
    await browser.close();
  }
}

const mode = process.argv[2] || "--install";

if (mode === "--check") {
  const pinned = await verify();
  console.log(JSON.stringify(pinned, null, 2));
} else if (mode === "--smoke") {
  await verify();
  await smoke();
} else if (mode === "--install") {
  await mkdir(runtimeRoot, { recursive: true });
  const seed = seedRuntimePath();
  if (seed) await copySeed(seed);
  else await npmInstall();
  await writeRuntime();
  const pinned = await verify();
  console.log(`[setup:browser] ready: ${runtimeFile}`);
  console.log(JSON.stringify({ playwrightVersion: pinned.playwrightVersion, chromiumRevision: pinned.chromiumRevision, executablePath: pinned.executablePath }, null, 2));
} else {
  throw new Error(`Unknown setup:browser mode ${mode}`);
}
