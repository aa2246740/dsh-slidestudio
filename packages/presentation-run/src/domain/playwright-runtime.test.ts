import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codexPlaywrightRuntimeFile,
  discoverMachinePlaywright,
  managedPlaywrightRuntimeFile,
  materializeManagedRuntime,
  playwrightRuntimeSource,
  provisionManagedRuntime,
  repoPlaywrightRuntimeFile,
  resolvePlaywrightRuntime,
  runtimeFileReady,
  runtimeLayoutUsable,
} from "./playwright-runtime.js";

const STUB_RUNTIME = `export function verifyPinnedRuntime() { return true; }
export async function launchPinnedChromium() { throw new Error("stub"); }
`;

function tmpdir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pw-rt-${tag}-`));
}

/** Fabricate the on-disk halves runtimeLayoutUsable checks for. */
function fakeUsableRuntime(dir: string, version = "1.61.1", browserDirName = "chromium_headless_shell-1228") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "runtime.mjs"),
    playwrightRuntimeSource({ version, revision: "1228", browserDirName }),
  );
  const pkgDir = path.join(dir, "node_modules", "playwright");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "playwright", version }),
  );
  const exe = path.join(dir, "browsers", browserDirName, "chrome-headless-shell");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "#!/bin/sh\n");
}

describe("resolvePlaywrightRuntime", () => {
  it("honours the env override exclusively", () => {
    const env = { SLIDESTUDIO_PLAYWRIGHT_RUNTIME: "/custom/runtime.mjs" } as NodeJS.ProcessEnv;
    const resolved = resolvePlaywrightRuntime(env, {});
    assert.equal(resolved.source, "env");
    assert.equal(resolved.path, "/custom/runtime.mjs");
    assert.equal(resolved.ready, false);
  });

  it("prefers the repo runtime over everything else", () => {
    const repo = tmpdir("repo");
    const home = tmpdir("home");
    fs.mkdirSync(path.dirname(repoPlaywrightRuntimeFile(repo)), { recursive: true });
    fs.writeFileSync(repoPlaywrightRuntimeFile(repo), STUB_RUNTIME);
    const resolved = resolvePlaywrightRuntime({}, { repoRoot: repo, homeDir: home });
    assert.equal(resolved.source, "repo");
    assert.equal(resolved.ready, true);
  });

  it("falls through to a usable managed runtime before the codex one", () => {
    const repo = tmpdir("repo2");
    const home = tmpdir("home2");
    const stateDir = tmpdir("state2");
    fakeUsableRuntime(path.join(stateDir, "playwright-runtime"));
    fakeUsableRuntime(path.join(home, ".codex", "playwright-runtime"));
    const resolved = resolvePlaywrightRuntime({}, { repoRoot: repo, homeDir: home, stateDir });
    assert.equal(resolved.source, "managed");
    assert.equal(resolved.path, managedPlaywrightRuntimeFile(stateDir));
  });

  it("uses the codex runtime only when its layout is self-consistent", () => {
    const repo = tmpdir("repo3");
    const home = tmpdir("home3");
    const stateDir = tmpdir("state3");
    fakeUsableRuntime(path.dirname(codexPlaywrightRuntimeFile(home)));
    const resolved = resolvePlaywrightRuntime({}, { repoRoot: repo, homeDir: home, stateDir });
    assert.equal(resolved.source, "codex");
    assert.equal(resolved.ready, true);
  });

  it("skips a stale codex runtime file instead of locking onto it", () => {
    const repo = tmpdir("repo4");
    const home = tmpdir("home4");
    const stateDir = tmpdir("state4");
    // looksPinned at a glance but the module half is gone — the reported bug.
    const codexDir = path.dirname(codexPlaywrightRuntimeFile(home));
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(codexPlaywrightRuntimeFile(home), STUB_RUNTIME);
    const resolved = resolvePlaywrightRuntime(
      {},
      { repoRoot: repo, homeDir: home, stateDir },
      { moduleDirs: [repo], browsersDirs: [tmpdir("emptybd")] },
    );
    assert.notEqual(resolved.path, codexPlaywrightRuntimeFile(home));
    assert.notEqual(resolved.source, "codex");
  });

  it("materializes a machine playwright into the managed dir", () => {
    const repo = tmpdir("repo5");
    const home = tmpdir("home5");
    const stateDir = tmpdir("state5");
    const browsers = tmpdir("browsers5");
    // Global install inside the repo's own node_modules (what discovery scans).
    const pkgDir = path.join(repo, "node_modules", "playwright");
    const coreDir = path.join(repo, "node_modules", "playwright-core");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(coreDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "playwright", version: "1.61.1" }));
    fs.writeFileSync(path.join(pkgDir, "index.mjs"), "export const chromium = {};\n");
    fs.writeFileSync(
      path.join(coreDir, "browsers.json"),
      JSON.stringify({ browsers: [{ name: "chromium-headless-shell", revision: "1228" }] }),
    );
    const exe = path.join(browsers, "chromium_headless_shell-1228", "chrome-headless-shell");
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, "#!/bin/sh\n");
    const env = { PLAYWRIGHT_BROWSERS_PATH: browsers } as NodeJS.ProcessEnv;
    const resolved = resolvePlaywrightRuntime(
      env,
      { repoRoot: repo, homeDir: home, stateDir },
      { moduleDirs: [path.join(repo, "node_modules")], browsersDirs: [browsers] },
    );
    assert.equal(resolved.source, "machine");
    assert.equal(resolved.path, managedPlaywrightRuntimeFile(stateDir));
    assert.equal(resolved.ready, true);
    assert.equal(runtimeLayoutUsable(resolved.path), true);
    const src = fs.readFileSync(resolved.path, "utf8");
    assert.match(src, /MODULE_DIR = "\/[^"]*node_modules"/);
  });

  it("reports pending when nothing usable exists", () => {
    const repo = tmpdir("repo6");
    const home = tmpdir("home6");
    const stateDir = tmpdir("state6");
    const env = { PLAYWRIGHT_BROWSERS_PATH: tmpdir("emptybrowsers") } as NodeJS.ProcessEnv;
    const resolved = resolvePlaywrightRuntime(
      env,
      { repoRoot: repo, homeDir: home, stateDir },
      { moduleDirs: [repo], browsersDirs: [env.PLAYWRIGHT_BROWSERS_PATH!] },
    );
    assert.equal(resolved.source, "pending");
    assert.equal(resolved.ready, false);
    assert.equal(resolved.path, managedPlaywrightRuntimeFile(stateDir));
  });
});

describe("runtimeLayoutUsable", () => {
  it("accepts a consistent module+browser layout", () => {
    const dir = tmpdir("usable");
    fakeUsableRuntime(dir);
    assert.equal(runtimeLayoutUsable(path.join(dir, "runtime.mjs")), true);
  });

  it("rejects version mismatch between stamp and installed module", () => {
    const dir = tmpdir("mismatch");
    fakeUsableRuntime(dir, "1.61.1");
    fs.writeFileSync(
      path.join(dir, "node_modules", "playwright", "package.json"),
      JSON.stringify({ name: "playwright", version: "1.60.0" }),
    );
    assert.equal(runtimeLayoutUsable(path.join(dir, "runtime.mjs")), false);
  });

  it("rejects when the browser executable is gone", () => {
    const dir = tmpdir("nobrowser");
    fakeUsableRuntime(dir);
    fs.rmSync(path.join(dir, "browsers"), { recursive: true, force: true });
    assert.equal(runtimeLayoutUsable(path.join(dir, "runtime.mjs")), false);
  });

  it("finds the executable under PLAYWRIGHT_BROWSERS_PATH", () => {
    const dir = tmpdir("envbrowsers");
    fakeUsableRuntime(dir);
    fs.rmSync(path.join(dir, "browsers"), { recursive: true, force: true });
    const browsers = tmpdir("envbrowsers-dir");
    const exe = path.join(browsers, "chromium_headless_shell-1228", "chrome-headless-shell");
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, "#!/bin/sh\n");
    assert.equal(
      runtimeLayoutUsable(path.join(dir, "runtime.mjs"), { PLAYWRIGHT_BROWSERS_PATH: browsers } as NodeJS.ProcessEnv),
      true,
    );
  });
});

describe("playwrightRuntimeSource", () => {
  it("emits a file that passes the ready sniff and stamps its layout", () => {
    const dir = tmpdir("source");
    const file = path.join(dir, "runtime.mjs");
    fs.writeFileSync(file, playwrightRuntimeSource({
      version: "1.61.1",
      revision: "1228",
      browserDirName: "chromium_headless_shell-1228",
      moduleDir: "/opt/x/node_modules",
      browsersDir: "/opt/x/ms-playwright",
    }));
    assert.equal(runtimeFileReady(file), true);
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /PINNED_PLAYWRIGHT_VERSION = "1\.61\.1"/);
    assert.match(src, /MODULE_DIR = "\/opt\/x\/node_modules"/);
    assert.match(src, /BROWSERS_DIR = "\/opt\/x\/ms-playwright"/);
    assert.match(src, /BROWSER_DIR_NAME = "chromium_headless_shell-1228"/);
  });
});

describe("discoverMachinePlaywright + materializeManagedRuntime", () => {
  it("finds a playwright module plus matching browsers", () => {
    const nodeModules = tmpdir("nm");
    const browsers = tmpdir("bd");
    fs.mkdirSync(path.join(nodeModules, "playwright"), { recursive: true });
    fs.mkdirSync(path.join(nodeModules, "playwright-core"), { recursive: true });
    fs.writeFileSync(
      path.join(nodeModules, "playwright", "package.json"),
      JSON.stringify({ name: "playwright", version: "1.61.1" }),
    );
    fs.writeFileSync(path.join(nodeModules, "playwright", "index.mjs"), "export {};\n");
    fs.writeFileSync(
      path.join(nodeModules, "playwright-core", "browsers.json"),
      JSON.stringify({ browsers: [{ name: "chromium-headless-shell", revision: "1228" }] }),
    );
    const exe = path.join(browsers, "chromium_headless_shell-1228", "chrome-headless-shell");
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, "#!/bin/sh\n");
    const found = discoverMachinePlaywright({
      moduleDirs: [nodeModules],
      browsersDirs: [browsers],
    });
    assert.ok(found);
    assert.equal(found.version, "1.61.1");
    assert.equal(found.browserDirName, "chromium_headless_shell-1228");
    assert.equal(found.revision, "1228");

    const stateDir = tmpdir("state-disc");
    const file = materializeManagedRuntime(stateDir, found);
    assert.equal(file, managedPlaywrightRuntimeFile(stateDir));
    assert.equal(runtimeLayoutUsable(file), true);
  });

  it("returns undefined when browsers exist but no playwright module does", () => {
    const browsers = tmpdir("bd-only");
    const exe = path.join(browsers, "chromium_headless_shell-1243", "chrome-headless-shell");
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, "#!/bin/sh\n");
    const found = discoverMachinePlaywright({
      moduleDirs: [tmpdir("nm-empty")],
      browsersDirs: [browsers],
      env: {} as NodeJS.ProcessEnv,
      roots: { repoRoot: tmpdir("r-empty"), homeDir: tmpdir("h-empty") },
    });
    assert.equal(found, undefined);
  });
});

describe("provisionManagedRuntime", () => {
  it("builds a usable managed runtime from a tarball + installer run", async () => {
    // Build real tarballs for a fake playwright/playwright-core pair.
    const fixture = tmpdir("fixture");
    for (const name of ["playwright", "playwright-core"]) {
      const pkg = path.join(fixture, name);
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(
        path.join(pkg, "package.json"),
        JSON.stringify({ name, version: "1.61.1" }),
      );
      fs.writeFileSync(path.join(pkg, "index.mjs"), "export const chromium = {};\n");
      if (name === "playwright") fs.writeFileSync(path.join(pkg, "cli.js"), "// cli\n");
    }
    const tars: Record<string, Buffer> = {};
    for (const name of ["playwright", "playwright-core"]) {
      const tgz = path.join(fixture, `${name}.tgz`);
      execFileSync("tar", ["-czf", tgz, "-C", fixture, name]);
      tars[name] = fs.readFileSync(tgz);
    }
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      const name = u.includes("playwright-core") ? "playwright-core" : "playwright";
      const body = tars[name];
      assert.ok(body);
      return new Response(new Uint8Array(body), { status: 200 });
    }) as unknown as typeof fetch;
    // The fake cli.js is not runnable; intercept the install call and drop the
    // browser where playwright would have put it.
    const execFileImpl = (async (
      _file: string,
      args: readonly string[] | undefined,
      options: { env?: NodeJS.ProcessEnv } | undefined,
    ) => {
      assert.equal(args?.[1], "install");
      const browsersPath = options?.env?.PLAYWRIGHT_BROWSERS_PATH;
      assert.ok(browsersPath);
      const exe = path.join(browsersPath, "chromium_headless_shell-1228", "chrome-headless-shell");
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      fs.writeFileSync(exe, "#!/bin/sh\n");
      return { stdout: "", stderr: "" };
    }) as never;

    const stateDir = tmpdir("prov-state");
    const result = await provisionManagedRuntime(stateDir, {
      fetchImpl,
      execFileImpl,
      log: () => undefined,
    });
    assert.equal(result.path, managedPlaywrightRuntimeFile(stateDir));
    assert.equal(runtimeLayoutUsable(result.path), true);
    assert.equal(runtimeFileReady(result.path), true);
    const pin = JSON.parse(
      fs.readFileSync(path.join(stateDir, "playwright-runtime", "node_modules", "playwright", "package.json"), "utf8"),
    ) as { version: string };
    assert.equal(pin.version, "1.61.1");
  });

  it("reuses an existing module and browsers without downloading", async () => {
    const reuseDir = tmpdir("reuse");
    fakeUsableRuntime(reuseDir);
    const fetchImpl = (async () => {
      throw new Error("must not fetch when halves are reused");
    }) as unknown as typeof fetch;
    const execFileImpl = (async () => {
      throw new Error("must not exec when halves are reused");
    }) as never;
    const stateDir = tmpdir("prov-reuse");
    const result = await provisionManagedRuntime(stateDir, {
      reuse: {
        moduleDir: path.join(reuseDir, "node_modules"),
        browsersDir: path.join(reuseDir, "browsers"),
        browserDirName: "chromium_headless_shell-1228",
        revision: "1228",
      },
      fetchImpl,
      execFileImpl,
      log: () => undefined,
    });
    assert.equal(runtimeLayoutUsable(result.path), true);
    assert.equal(result.reusedModuleDir, path.join(reuseDir, "node_modules"));
    const src = fs.readFileSync(result.path, "utf8");
    assert.match(src, /MODULE_DIR = "\/[^"]*node_modules"/);
  });
});
