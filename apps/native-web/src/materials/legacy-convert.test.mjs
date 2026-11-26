import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FAKE_ENGINE_VERSION, defaultHandler, jobDirsIn, makeScratch, until } from "../testlib/fake-soffice.mjs";
import {
  advance,
  build,
  callWhere,
  failed,
  groupKills,
  hangRuns,
  hasChinese,
  input,
  stubEnv,
  succeeded,
  useFakeClock,
} from "./test-fixtures/legacy-convert-harness.mjs";

/** @param {import("node:test").TestContext} t */
function scratchFor(t) {
  const scratch = makeScratch();
  t.after(scratch.cleanup);
  return scratch;
}

test("success: one output with the right extension gives bytes, timings, peak RSS and the engine version", async (t) => {
  const scratch = scratchFor(t);
  const { converter, fake, kills } = build(scratch, {
    options: { sampleRssMb: async () => 123 },
  });
  const info = await converter.ready();
  assert.deepEqual(info, {
    available: true,
    isolation: "profile-only",
    engineVersion: FAKE_ENGINE_VERSION,
  });
  const result = succeeded(await converter.run(input("ppt")));
  assert.ok(Buffer.from(result.bytes).toString().startsWith("PK"));
  assert.equal(typeof result.durationMs, "number");
  assert.equal(result.peakRssMb, 123);
  assert.equal(result.engineVersion, FAKE_ENGINE_VERSION);
  assert.equal(result.isolation, "profile-only");
  assert.equal(result.to, "pptx");
  const call = callWhere(fake.calls, (entry) => entry.isRun);
  assert.equal(groupKills(kills, call).length, 1, "an extra group SIGKILL follows every outcome");
  assert.deepEqual(jobDirsIn(scratch.jobRoot), []);
});

test("each family spawns an argv array with an explicit infilter, a job-local profile and input.<ext>", async (t) => {
  const scratch = scratchFor(t);
  const { converter, fake } = build(scratch);
  await converter.ready();
  const table = [
    ["ppt", "MS PowerPoint 97", "pptx:Impress MS PowerPoint 2007 XML", "pptx"],
    ["doc", "MS Word 97", "docx:MS Word 2007 XML", "docx"],
    ["xls", "MS Excel 97", "xlsx:Calc MS Excel 2007 XML", "xlsx"],
  ];
  for (const [family, infilter, filter, to] of table) {
    const result = succeeded(await converter.run(input(family)));
    assert.equal(result.to, to);
    const call = fake.calls.findLast((entry) => entry.isRun);
    assert.ok(call && Array.isArray(call.args));
    assert.notEqual(call.options.shell, true);
    assert.equal(call.options.detached, true);
    assert.ok(call.args.includes(`--infilter=${infilter}`), family);
    assert.equal(call.args[call.args.indexOf("--convert-to") + 1], filter);
    assert.ok(call.args.includes("--headless"));
    const jobDir = path.dirname(path.dirname(call.input));
    assert.equal(path.basename(call.input), `input.${family}`);
    assert.equal(path.dirname(jobDir), scratch.jobRoot);
    assert.match(path.basename(jobDir), /^oss-lo-/);
    assert.equal(call.profileDir, path.join(jobDir, "profile"));
    assert.ok(
      call.args.includes(`-env:UserInstallation=file://${path.join(jobDir, "profile")}`),
      "UserInstallation points inside the job dir",
    );
    assert.equal(call.outDir, path.join(jobDir, "out"));
    assert.equal(call.options.cwd, path.join(jobDir, "tmp"));
  }
});

test("the child environment is cleared: no proxy, credential or SLIDESTUDIO_* variable reaches soffice", async (t) => {
  const scratch = scratchFor(t);
  stubEnv(t, {
    http_proxy: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    no_proxy: "localhost",
    SLIDESTUDIO_TEST_SECRET: "must-not-leak",
    OPENAI_API_KEY: "must-not-leak",
  });
  const { converter, fake } = build(scratch);
  await converter.ready();
  await converter.run(input("doc"));
  for (const call of fake.calls) {
    const keys = Object.keys(call.options.env).sort();
    assert.deepEqual(keys, ["HOME", "LANG", "PATH", "SAL_USE_VCLPLUGIN", "TMPDIR"]);
    assert.ok(!keys.some((key) => /proxy|^SLIDESTUDIO_|KEY/i.test(key)));
    assert.ok(!JSON.stringify(call.options.env).includes("must-not-leak"));
  }
  const run = callWhere(fake.calls, (entry) => entry.isRun);
  const jobDir = path.dirname(path.dirname(run.input));
  assert.equal(run.options.env.HOME, jobDir);
  assert.equal(run.options.env.TMPDIR, path.join(jobDir, "tmp"));
  assert.equal(run.options.env.PATH, "/usr/local/bin:/usr/bin:/bin", "PATH is never inherited");
});

test("exit 0 without an output file is corrupt", async (t) => {
  const scratch = scratchFor(t);
  const { converter, fake, kills } = build(scratch, {
    handler: (call) => (call.isRun ? call.exit(0) : defaultHandler(call)),
  });
  await converter.ready();
  const result = failed(await converter.run(input("doc")));
  assert.equal(result.code, "corrupt");
  assert.ok(hasChinese(result.message));
  const call = callWhere(fake.calls, (entry) => entry.isRun);
  assert.equal(groupKills(kills, call).length, 1);
  assert.deepEqual(jobDirsIn(scratch.jobRoot), []);
});

test("a child that never exits is group-killed by an independent timer at timeoutMs, not by the RSS poll", async (t) => {
  const scratch = scratchFor(t);
  useFakeClock(t);
  const { converter, fake, kills } = build(scratch, {
    handler: hangRuns,
    // A sampler that never answers proves the deadline does not depend on polling.
    options: { timeoutMs: 5000, sampleRssMb: () => new Promise(() => {}) },
  });
  await converter.ready();
  const run = converter.run(input("ppt"));
  await until(() => fake.calls.some((entry) => entry.isRun));
  const call = callWhere(fake.calls, (entry) => entry.isRun);
  await advance(4999);
  assert.equal(groupKills(kills, call).length, 0, "nothing is killed before the deadline");
  await advance(1);
  const result = failed(await run);
  assert.equal(result.code, "timeout");
  assert.ok(hasChinese(result.message));
  assert.ok(groupKills(kills, call).length >= 1, "kill(-pgid, SIGKILL) fired");
  assert.deepEqual(jobDirsIn(scratch.jobRoot), []);
});

test("an RSS sample above maxRssMb group-kills the job as out-of-memory", async (t) => {
  const scratch = scratchFor(t);
  useFakeClock(t);
  let rss = 10;
  const { converter, fake, kills } = build(scratch, {
    handler: hangRuns,
    options: { maxRssMb: 512, sampleRssMb: async () => rss },
  });
  await converter.ready();
  const run = converter.run(input("xls"));
  await until(() => fake.calls.some((entry) => entry.isRun));
  const call = callWhere(fake.calls, (entry) => entry.isRun);
  await advance(250);
  assert.equal(groupKills(kills, call).length, 0, "below the cap nothing is killed");
  rss = 513;
  await advance(250);
  const result = failed(await run);
  assert.equal(result.code, "out-of-memory");
  assert.ok(hasChinese(result.message));
  assert.equal(result.peakRssMb, 513);
  assert.ok(groupKills(kills, call).length >= 1);
  assert.deepEqual(jobDirsIn(scratch.jobRoot), []);
});

test("a non-zero exit and a spawn error are convert-failed", async (t) => {
  const scratch = scratchFor(t);
  let mode = "exit";
  const { converter } = build(scratch, {
    handler: (call) => {
      if (!call.isRun) return defaultHandler(call);
      if (mode === "exit") {
        call.writeOutput();
        return call.exit(77);
      }
      call.error(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    },
  });
  await converter.ready();
  const exited = failed(await converter.run(input("ppt")));
  assert.equal(exited.code, "convert-failed");
  assert.ok(hasChinese(exited.message));
  mode = "error";
  assert.equal(failed(await converter.run(input("ppt"))).code, "convert-failed");
  assert.deepEqual(jobDirsIn(scratch.jobRoot), []);
});

test("the job directory (profile, in, out, tmp) is gone after success, failure, timeout and an RSS kill", async (t) => {
  const scratch = scratchFor(t);
  useFakeClock(t);
  let mode = "ok";
  let rss = 0;
  /** @type {{jobDir: string, entries: string[], profile: boolean}[]} */
  const seen = [];
  const { converter, fake } = build(scratch, {
    handler: (call) => {
      if (!call.isRun) return defaultHandler(call);
      const jobDir = path.dirname(path.dirname(call.input));
      seen.push({
        jobDir,
        entries: fs.readdirSync(jobDir).sort(),
        profile: fs.existsSync(path.join(call.profileDir ?? "", "user", "registrymodifications.xcu")),
      });
      if (mode === "ok") {
        call.writeOutput();
        call.exit(0);
      } else if (mode === "fail") call.exit(1);
    },
    options: { timeoutMs: 3000, maxRssMb: 100, sampleRssMb: async () => rss },
  });
  await converter.ready();
  assert.equal((await converter.run(input("ppt"))).ok, true);
  mode = "fail";
  assert.equal(failed(await converter.run(input("ppt"))).code, "convert-failed");
  mode = "hang";
  const hung = converter.run(input("ppt"));
  await until(() => seen.length === 3);
  await advance(3000);
  assert.equal(failed(await hung).code, "timeout");
  rss = 5000;
  const heavy = converter.run(input("ppt"));
  await until(() => seen.length === 4);
  await advance(250);
  assert.equal(failed(await heavy).code, "out-of-memory");
  assert.equal(seen.length, 4);
  for (const job of seen) {
    assert.deepEqual(job.entries, ["in", "out", "profile", "tmp"]);
    assert.equal(job.profile, true, "the job profile was copied before soffice started");
    assert.equal(fs.existsSync(job.jobDir), false, "removed in finally");
  }
  assert.deepEqual(jobDirsIn(scratch.jobRoot), []);
  assert.ok(fake.calls.length > 4);
});

test("the output must be exactly one file with the target extension within the size limit", async (t) => {
  const scratch = scratchFor(t);
  let shape = "two";
  const { converter } = build(scratch, {
    handler: (call) => {
      if (!call.isRun) return defaultHandler(call);
      if (shape === "two") {
        call.writeOutput(undefined, "input.pptx");
        call.writeOutput(undefined, "extra.pptx");
      } else if (shape === "wrong-ext") call.writeOutput(undefined, "input.odp");
      else if (shape === "big") call.writeOutput(Buffer.alloc(2048), "input.pptx");
      call.exit(0);
    },
    options: { maxOutputBytes: 1024 },
  });
  await converter.ready();
  assert.equal(failed(await converter.run(input("ppt"))).code, "corrupt");
  shape = "wrong-ext";
  assert.equal(failed(await converter.run(input("ppt"))).code, "corrupt");
  shape = "big";
  const big = failed(await converter.run(input("ppt")));
  assert.equal(big.code, "too-large");
  assert.match(big.message, /50 MB/);
  assert.deepEqual(jobDirsIn(scratch.jobRoot), []);
});

test("run rejects an unknown family or non-byte input without spawning", async (t) => {
  const scratch = scratchFor(t);
  const { converter, fake } = build(scratch);
  await converter.ready();
  const before = fake.calls.length;
  const result = failed(await converter.run({ bytes: Buffer.from("x"), family: "dps" }));
  assert.equal(result.code, "convert-failed");
  assert.ok(hasChinese(result.message));
  const notBytes = /** @type {Uint8Array} */ (/** @type {unknown} */ ("text"));
  assert.equal(failed(await converter.run({ bytes: notBytes, family: "doc" })).code, "convert-failed");
  assert.equal(fake.calls.length, before);
});

test("each conversion logs one content-free material.legacy-convert event and reports its outcome", async (t) => {
  const scratch = scratchFor(t);
  const bytes = Buffer.from("hash-me");
  const { converter, logs, events } = build(scratch, {
    options: { sampleRssMb: async () => 64 },
  });
  await converter.ready();
  const before = logs.length;
  await converter.run({ bytes, family: "doc", vendor: "wps" });
  const conversion = logs.slice(before).filter((entry) => entry.event === "material.legacy-convert");
  assert.equal(logs.length - before, 1);
  const [event] = conversion;
  assert.ok(event);
  assert.deepEqual(Object.keys(event).sort(), [
    "bytes",
    "code",
    "durationMs",
    "engineVersion",
    "event",
    "family",
    "isolation",
    "killed",
    "outcome",
    "peakRssMb",
    "queueWaitMs",
    "sha256Prefix",
    "vendor",
  ]);
  assert.equal(event.sha256Prefix, crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 8));
  assert.equal(event.bytes, bytes.length);
  assert.equal(event.family, "doc");
  assert.equal(event.vendor, "wps");
  assert.equal(event.outcome, "success");
  assert.equal(event.killed, false);
  assert.equal(event.isolation, "profile-only");
  assert.equal(event.engineVersion, FAKE_ENGINE_VERSION);
  assert.equal(event.peakRssMb, 64);
  assert.equal(typeof event.queueWaitMs, "number");
  const last = events.at(-1);
  assert.deepEqual(last, { outcome: "success", code: null, durationMs: last?.durationMs });
  const serialized = JSON.stringify(logs);
  for (const leak of ["oss-lo-", scratch.root, "legacy-bytes", "hash-me"]) {
    assert.ok(!serialized.includes(leak), leak);
  }
});

test("a failed conversion logs its code and whether it was killed", async (t) => {
  const scratch = scratchFor(t);
  useFakeClock(t);
  const { converter, fake, logs, events } = build(scratch, {
    handler: hangRuns,
    options: { timeoutMs: 1000 },
  });
  await converter.ready();
  const run = converter.run(input("xls"));
  await until(() => fake.calls.some((entry) => entry.isRun));
  await advance(1000);
  await run;
  const event = logs.findLast((entry) => entry.event === "material.legacy-convert");
  assert.ok(event);
  assert.equal(event.outcome, "timeout");
  assert.equal(event.code, "timeout");
  assert.equal(event.killed, true);
  assert.equal(events.at(-1)?.outcome, "timeout");
});

test("a throwing log sink or metrics hook never breaks a conversion", async (t) => {
  const scratch = scratchFor(t);
  const { converter } = build(scratch, {
    options: {
      log: () => {
        throw new Error("sink down");
      },
      onEvent: () => {
        throw new Error("metrics down");
      },
    },
  });
  assert.equal((await converter.ready()).available, true);
  assert.equal((await converter.run(input("doc"))).ok, true);
});
