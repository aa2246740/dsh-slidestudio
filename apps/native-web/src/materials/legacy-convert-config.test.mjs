import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  LEGACY_CONVERT_DEFAULTS,
  fixedSofficeCandidates,
  hardenedRegistry,
  resolveLegacyConfig,
} from "./legacy-convert-config.mjs";
import { createLegacyConverter, lazyLegacyConverter } from "./legacy-convert.mjs";
import { defaultHandler, jobDirsIn, makeScratch, until } from "../testlib/fake-soffice.mjs";
import {
  advance,
  build,
  callWhere,
  failed,
  hangRuns,
  hasChinese,
  input,
  useFakeClock,
} from "./test-fixtures/legacy-convert-harness.mjs";

/** @param {import("node:test").TestContext} t */
function scratchFor(t) {
  const scratch = makeScratch();
  t.after(scratch.cleanup);
  return scratch;
}

/** @param {string[]} names @returns {import("./legacy-convert-isolation.mjs").RunProbe} */
const probeOnly = (names) => async (command) => names.includes(path.basename(command));

test("Linux with every isolation probe failing is unavailable and never spawns soffice (fail-closed)", async (t) => {
  const scratch = scratchFor(t);
  /** @type {[string, string[]][]} */
  const probed = [];
  const { converter, fake, logs } = build(scratch, {
    options: {
      platform: "linux",
      runProbe: async (command, args) => {
        probed.push([path.basename(command), args]);
        return false;
      },
    },
  });
  const info = await converter.ready();
  assert.equal(info.available, false);
  assert.equal(info.isolation, "none");
  assert.match(String(info.reason), /网络隔离/);
  assert.deepEqual(
    [...new Set(probed.map(([name]) => name))].sort(),
    ["bwrap", "unshare"],
    "both bwrap and unshare -rn were tried",
  );
  assert.ok(probed.some(([name, args]) => name === "unshare" && args.includes("-rn")));
  assert.equal(fake.calls.length, 0);
  assert.equal(logs.length, 1);
  assert.deepEqual(jobDirsIn(scratch.jobRoot), []);
});

test("Linux isolation picks bwrap, then unshare -rn, and adds a systemd scope only on top of bwrap", async (t) => {
  const scratch = scratchFor(t);
  /** @type {string[]} */
  const modes = [];
  for (const [available, expected] of /** @type {[string[], string][]} */ ([
    [["bwrap", "systemd-run"], "systemd-scope+bwrap"],
    [["bwrap"], "bwrap"],
    [["unshare", "systemd-run"], "unshare"],
  ])) {
    const { converter, fake } = build(scratch, {
      options: { platform: "linux", runProbe: probeOnly(available) },
    });
    const info = await converter.ready();
    assert.equal(info.available, true, expected);
    assert.equal(info.isolation, expected);
    await converter.run(input("ppt"));
    const call = callWhere(fake.calls, (entry) => entry.isRun);
    const argv = [call.command, ...call.args];
    const soffice = argv.indexOf(scratch.soffice);
    assert.ok(soffice > 0, "the converter runs soffice inside the wrapper");
    if (expected === "unshare") {
      assert.ok(path.basename(call.command) === "unshare" && call.args[0] === "-rn");
    } else {
      const bwrap = argv.findIndex((arg) => path.basename(arg) === "bwrap");
      for (const flag of ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv"]) {
        assert.ok(argv.indexOf(flag, bwrap) > bwrap, flag);
      }
      const jobDir = path.dirname(path.dirname(call.input));
      const bind = argv.indexOf("--bind");
      assert.deepEqual(argv.slice(bind, bind + 3), ["--bind", jobDir, jobDir]);
      assert.equal(argv[soffice - 1], "--", "sandbox options end before soffice");
    }
    assert.equal(path.basename(call.command) === "systemd-run", expected === "systemd-scope+bwrap");
    modes.push(info.isolation);
  }
  assert.equal(new Set(modes).size, 3);
  assert.deepEqual(jobDirsIn(scratch.jobRoot), []);
});

test("the scope-wrapped job is also killed through its systemd scope", async (t) => {
  const scratch = scratchFor(t);
  useFakeClock(t);
  const { converter, fake } = build(scratch, {
    handler: hangRuns,
    options: {
      platform: "linux",
      timeoutMs: 2000,
      maxRssMb: 777,
      runProbe: probeOnly(["bwrap", "systemd-run"]),
    },
  });
  await converter.ready();
  const run = converter.run(input("doc"));
  await until(() => fake.calls.some((entry) => entry.isRun));
  const call = callWhere(fake.calls, (entry) => entry.isRun);
  for (const property of ["MemoryMax=777M", "MemorySwapMax=0", "TasksMax=128"]) {
    assert.ok(call.args.includes(property), property);
  }
  await advance(2000);
  assert.equal(failed(await run).code, "timeout");
  const scopeKill = callWhere(fake.calls, (entry) => path.basename(entry.command) === "systemctl");
  assert.deepEqual(scopeKill.args.slice(0, 3), ["--user", "kill", "--signal=SIGKILL"]);
});

test("macOS wraps soffice in sandbox-exec when the probe passes and falls back to profile-only otherwise", async (t) => {
  const scratch = scratchFor(t);
  const withSandbox = build(scratch, {
    options: { isolation: "auto", runProbe: async (command) => command.endsWith("sandbox-exec") },
  });
  assert.equal((await withSandbox.converter.ready()).isolation, "sandbox-exec");
  await withSandbox.converter.run(input("ppt"));
  const call = callWhere(withSandbox.fake.calls, (entry) => entry.isRun);
  assert.ok(call.command.endsWith("sandbox-exec"));
  const profile = call.args[call.args.indexOf("-p") + 1] ?? "";
  assert.match(profile, /\(deny network\*\)/);
  // The launcher needs its /tmp socket; nothing else may be re-allowed.
  const allows = profile.split("\n").filter((line) => line.startsWith("(allow network"));
  assert.ok(allows.length > 0);
  for (const line of allows) assert.match(line, /unix-socket \(subpath "\/private\/tmp"\)/);
  const without = build(scratch, { options: { isolation: "auto", runProbe: async () => false } });
  assert.equal((await without.converter.ready()).isolation, "profile-only");
  assert.equal(without.converter.available, true);
});

test("a platform without any supported isolation (e.g. Windows) is unavailable and spawns nothing", async (t) => {
  const scratch = scratchFor(t);
  const { converter, fake } = build(scratch, { options: { platform: "win32" } });
  const info = await converter.ready();
  assert.equal(info.available, false);
  assert.ok(hasChinese(info.reason));
  assert.equal(fake.calls.length, 0);
});

test("SLIDESTUDIO_LEGACY_CONVERT=off is unavailable at once and soffice is never spawned", async (t) => {
  const scratch = scratchFor(t);
  const { converter, fake, logs } = build(scratch, {
    options: { env: { SLIDESTUDIO_LEGACY_CONVERT: "off" } },
  });
  const info = await converter.ready();
  assert.equal(info.available, false);
  assert.equal(info.isolation, "none");
  assert.match(String(info.reason), /已关闭/);
  assert.equal("engineVersion" in info, false);
  assert.equal(failed(await converter.run(input("ppt"))).code, "convert-failed");
  assert.equal(fake.calls.length, 0);
  assert.equal(logs.filter((entry) => entry.level === "warn").length, 0);
  assert.equal(logs.filter((entry) => entry.event === "legacy-convert.state").length, 0);
  assert.deepEqual(jobDirsIn(scratch.jobRoot), []);
});

test("any other SLIDESTUDIO_LEGACY_CONVERT value, including on, is treated as auto with exactly one warning", async (t) => {
  const scratch = scratchFor(t);
  for (const value of ["bogus", "on", "1"]) {
    const { converter, logs } = build(scratch, {
      options: { env: { SLIDESTUDIO_LEGACY_CONVERT: value } },
    });
    assert.equal((await converter.ready()).available, true, value);
    await converter.run(input("doc"));
    const warnings = logs.filter((entry) => entry.level === "warn");
    assert.equal(warnings.length, 1, value);
    assert.equal(warnings[0]?.event, "legacy-convert.config");
    assert.equal(warnings[0]?.key, "SLIDESTUDIO_LEGACY_CONVERT");
    if (value === "bogus") assert.ok(!JSON.stringify(warnings[0]).includes("bogus"));
  }
  for (const value of [undefined, "", "auto", "AUTO"]) {
    const { converter, logs } = build(scratch, {
      options: { env: value === undefined ? {} : { SLIDESTUDIO_LEGACY_CONVERT: value } },
    });
    assert.equal((await converter.ready()).available, true);
    assert.equal(logs.filter((entry) => entry.level === "warn").length, 0, String(value));
  }
});

test("SLIDESTUDIO_SOFFICE_PATH is the only candidate: set but missing is unavailable with no fallback", async (t) => {
  const scratch = scratchFor(t);
  const present = scratch.soffice;
  const common = { sofficePath: undefined, candidates: [present] };
  const missing = build(scratch, {
    options: { ...common, env: { SLIDESTUDIO_SOFFICE_PATH: "/nonexistent/soffice" } },
  });
  const info = await missing.converter.ready();
  assert.equal(info.available, false);
  assert.equal(info.isolation, "none");
  assert.match(String(info.reason), /SLIDESTUDIO_SOFFICE_PATH/);
  assert.equal(missing.fake.calls.length, 0, "the fixed candidate list was not consulted");
  assert.equal(missing.logs.length, 1);
  assert.ok(!JSON.stringify(missing.logs).includes("/nonexistent"), "the path is not logged");

  const relative = build(scratch, {
    options: { ...common, env: { SLIDESTUDIO_SOFFICE_PATH: "soffice" } },
  });
  assert.equal((await relative.converter.ready()).available, false);

  const set = build(scratch, { options: { ...common, env: { SLIDESTUDIO_SOFFICE_PATH: present } } });
  assert.equal((await set.converter.ready()).available, true);
  assert.equal(callWhere(set.fake.calls, (entry) => entry.isWarmup).command, present);

  const unset = build(scratch, { options: { ...common, env: {} } });
  assert.equal((await unset.converter.ready()).available, true, "unset uses the fixed list");
});

test("no soffice anywhere (the default on CI) is a clean unavailable state: Chinese reason, no spawn, no job", async (t) => {
  const scratch = scratchFor(t);
  const { converter, fake, logs } = build(scratch, {
    options: { sofficePath: undefined, candidates: ["/nonexistent/a", "/nonexistent/b"] },
  });
  const info = await converter.ready();
  assert.deepEqual(Object.keys(info).sort(), ["available", "isolation", "reason"]);
  assert.equal(info.available, false);
  assert.match(String(info.reason), /未找到 LibreOffice/);
  const result = failed(await converter.run(input("xls")));
  assert.equal(result.code, "convert-failed");
  assert.match(result.message, /另存为 \.xlsx/);
  assert.equal(fake.calls.length, 0);
  assert.equal(logs.filter((entry) => entry.event === "legacy-convert.state").length, 1);
  assert.deepEqual(jobDirsIn(scratch.jobRoot), []);
});

test("the fixed candidate list never consults PATH", async (t) => {
  const scratch = scratchFor(t);
  const list = fixedSofficeCandidates((dir) =>
    dir === "/opt" ? ["homebrew", "libreoffice7.6", "libreoffice24.2", "libreoffice"] : [],
  );
  assert.deepEqual(list, [
    "/usr/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
    "/opt/libreoffice24.2/program/soffice",
    "/opt/libreoffice7.6/program/soffice",
    "/opt/libreoffice/program/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  ]);
  const unreadable = fixedSofficeCandidates(() => {
    throw new Error("EACCES");
  });
  assert.equal(unreadable.length, 3, "an unreadable /opt only drops the /opt candidates");
  const { converter } = build(scratch, {
    options: {
      sofficePath: undefined,
      candidates: ["/nonexistent/soffice"],
      env: { PATH: `${scratch.root}:/usr/bin` },
    },
  });
  assert.equal((await converter.ready()).available, false);
});

test("SLIDESTUDIO_SOFFICE_CONCURRENCY other than 1 is clamped to 1 with one warning, and jobs never overlap", async (t) => {
  const scratch = scratchFor(t);
  for (const value of ["2", "0", "abc", "-1"]) {
    let running = 0;
    let peak = 0;
    const { converter, logs } = build(scratch, {
      handler: (call) => {
        if (!call.isRun) return defaultHandler(call);
        running += 1;
        peak = Math.max(peak, running);
        setTimeout(() => {
          running -= 1;
          call.writeOutput();
          call.exit(0);
        }, 5);
      },
      options: { env: { SLIDESTUDIO_SOFFICE_CONCURRENCY: value } },
    });
    assert.equal(converter.limits.concurrency, 1, value);
    await converter.ready();
    await Promise.all([converter.run(input("doc")), converter.run(input("doc"))]);
    assert.equal(peak, 1, value);
    const warnings = logs.filter((entry) => entry.level === "warn");
    assert.equal(warnings.length, 1, value);
    assert.equal(warnings[0]?.key, "SLIDESTUDIO_SOFFICE_CONCURRENCY");
  }
  const { converter, logs } = build(scratch, {
    options: { env: { SLIDESTUDIO_SOFFICE_CONCURRENCY: "1" } },
  });
  assert.equal(converter.limits.concurrency, 1);
  await converter.ready();
  assert.equal(logs.filter((entry) => entry.level === "warn").length, 0);
});

test("timeoutMs and maxRssMb come from their documented variables; the queue cap and concurrency are fixed", async (t) => {
  const scratch = scratchFor(t);
  assert.deepEqual(
    { ...LEGACY_CONVERT_DEFAULTS },
    {
      timeoutMs: 60_000,
      maxRssMb: 1024,
      queueCap: 8,
      concurrency: 1,
      maxOutputBytes: 50 * 1024 * 1024,
      rssSampleMs: 250,
    },
  );
  const fixed = { queueCap: 8, concurrency: 1 };
  const defaults = build(scratch);
  assert.deepEqual(defaults.converter.limits, { timeoutMs: 60_000, maxRssMb: 1024, ...fixed });
  const custom = build(scratch, {
    options: {
      env: { SLIDESTUDIO_SOFFICE_TIMEOUT_MS: "45000", SLIDESTUDIO_SOFFICE_MAX_RSS_MB: "768" },
    },
  });
  assert.deepEqual(custom.converter.limits, { timeoutMs: 45_000, maxRssMb: 768, ...fixed });
  // Let both warm-ups finish before the scratch directory is removed.
  await Promise.all([defaults.converter.ready(), custom.converter.ready()]);
  assert.equal(custom.logs.filter((entry) => entry.level === "warn").length, 0);
  /** @type {import("./legacy-convert-config.mjs").ConfigWarning[]} */
  const warned = [];
  const invalid = resolveLegacyConfig(
    {
      SLIDESTUDIO_SOFFICE_TIMEOUT_MS: "soon",
      SLIDESTUDIO_SOFFICE_MAX_RSS_MB: "-5",
      SLIDESTUDIO_SOFFICE_SANDBOX: "chroot",
    },
    (warning) => warned.push(warning),
  );
  assert.equal(invalid.timeoutMs, 60_000);
  assert.equal(invalid.maxRssMb, 1024);
  assert.equal(invalid.sandbox, "auto");
  assert.deepEqual(warned.map((entry) => entry.key).sort(), [
    "SLIDESTUDIO_SOFFICE_MAX_RSS_MB",
    "SLIDESTUDIO_SOFFICE_SANDBOX",
    "SLIDESTUDIO_SOFFICE_TIMEOUT_MS",
  ]);
  for (const warning of warned) assert.ok(!warning.message.includes("soon"));
});

test("the hardened registry keeps foreign items once and rewrites every hardening item", () => {
  const foreign =
    '<item oor:path="/org.openoffice.Office.Common/View"><prop oor:name="Zoom" oor:op="fuse"><value>2</value></prop></item>';
  const edited =
    '<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>0</value></prop></item>';
  const xcu = hardenedRegistry(`<oor:items x="1">${foreign}\n${edited}</oor:items>`);
  assert.equal(xcu.split('oor:name="Zoom"').length, 2, "the foreign item is kept once");
  assert.equal(xcu.split('oor:name="MacroSecurityLevel"').length, 2, "hardening appears once");
  assert.match(xcu, /MacroSecurityLevel" oor:op="fuse"><value>3<\/value>/);
  assert.equal(hardenedRegistry(), hardenedRegistry(""), "an empty profile is hardened too");
});

test("lazyLegacyConverter creates one converter on first use and nothing before", async (t) => {
  const scratch = scratchFor(t);
  let created = 0;
  const lazy = lazyLegacyConverter({
    env: { SLIDESTUDIO_SOFFICE_PATH: "/nonexistent/soffice" },
    dataDir: scratch.dataDir,
    jobRoot: scratch.jobRoot,
    kill: () => undefined,
    log: () => {
      created += 1;
    },
  });
  assert.equal(created, 0);
  const first = lazy();
  assert.equal(lazy(), first, "the same converter every time");
  assert.equal((await first.ready()).available, false);
  assert.equal(created, 1, "one start, one state line");
  const direct = createLegacyConverter({
    env: { SLIDESTUDIO_LEGACY_CONVERT: "off" },
    kill: () => undefined,
    log: () => undefined,
  });
  assert.equal((await direct.ready()).available, false);
});
