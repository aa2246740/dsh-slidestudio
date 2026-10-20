import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolvePlaywrightRuntimeFile, runtimeLayoutUsable } from "./playwright-runtime-path.mjs";

describe("runtimeLayoutUsable", () => {
  it("resolves the repository runtime from a workspace working directory", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const previousCwd = process.cwd();
    try {
      process.chdir(path.join(repoRoot, "apps", "native-web"));
      const resolved = resolvePlaywrightRuntimeFile({});
      assert.equal(resolved.path, path.join(repoRoot, ".runtime", "playwright", "runtime.mjs"));
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("accepts the Windows headless shell executable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-runtime-"));
    try {
      const moduleDir = path.join(root, "node_modules");
      const browsersDir = path.join(root, "browsers");
      const browserDirName = "chromium_headless_shell-1228";
      const runtimeFile = path.join(root, "runtime.mjs");
      const browserExe = path.join(browsersDir, browserDirName, "chrome-headless-shell.exe");
      fs.mkdirSync(path.dirname(browserExe), { recursive: true });
      fs.mkdirSync(path.join(moduleDir, "playwright"), { recursive: true });
      fs.writeFileSync(path.join(moduleDir, "playwright", "package.json"), JSON.stringify({ version: "1.61.1" }));
      fs.writeFileSync(browserExe, "");
      fs.writeFileSync(
        runtimeFile,
        [
          'export const PINNED_PLAYWRIGHT_VERSION = "1.61.1";',
          'export const PINNED_CHROMIUM_REVISION = "1228";',
          `export const MODULE_DIR = ${JSON.stringify(moduleDir)};`,
          `export const BROWSERS_DIR = ${JSON.stringify(browsersDir)};`,
          `export const BROWSER_DIR_NAME = ${JSON.stringify(browserDirName)};`,
          "export function launchPinnedChromium() {}",
          "export function verifyPinnedRuntime() {}",
        ].join("\n"),
      );

      assert.equal(runtimeLayoutUsable(runtimeFile), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
