import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LEGACY_CONVERT_DEFAULTS } from "./legacy-convert-config.mjs";
import { ParsePool } from "./parse-pool.mjs";
import { defaultHandler, jobDirsIn, makeScratch, until } from "../testlib/fake-soffice.mjs";
import { build, callWhere, failed, hasChinese, input } from "./test-fixtures/legacy-convert-harness.mjs";

/** @typedef {import("./test-fixtures/legacy-convert-harness.mjs").FakeCall} FakeCall */

/** @param {import("node:test").TestContext} t */
function scratchFor(t) {
  const scratch = makeScratch();
  t.after(scratch.cleanup);
  return scratch;
}

/** The job directory a fake soffice call works in. @param {{input: string}} call */
const jobDirOf = (call) => path.dirname(path.dirname(call.input));

test("the 9th job with concurrency 1 and queue cap 8 is convert-busy at once; the rest run one at a time", async (t) => {
  const scratch = scratchFor(t);
  let running = 0;
  let peak = 0;
  /** @type {(() => void)[]} */
  const releases = [];
  const { converter, fake } = build(scratch, {
    handler: (call) => {
      if (!call.isRun) return defaultHandler(call);
      running += 1;
      peak = Math.max(peak, running);
      releases.push(() => {
        running -= 1;
        call.writeOutput();
        call.exit(0);
      });
    },
  });
  await converter.ready();
  const jobs = Array.from({ length: 8 }, () => converter.run(input("doc")));
  await until(() => releases.length === 1);
  assert.equal(converter.outstanding, 8);
  const busy = failed(await converter.run(input("doc")));
  assert.equal(busy.code, "convert-busy");
  assert.ok(hasChinese(busy.message));
  assert.equal(fake.calls.filter((entry) => entry.isRun).length, 1, "busy spawns nothing");
  for (let done = 1; done <= 8; done += 1) {
    await until(() => releases.length === done);
    releases[done - 1]?.();
  }
  const settled = await Promise.all(jobs);
  assert.ok(settled.every((result) => result.ok));
  assert.equal(peak, 1, "concurrency is fixed at 1");
  assert.equal(LEGACY_CONVERT_DEFAULTS.queueCap, 8);
  assert.deepEqual(jobDirsIn(scratch.jobRoot), []);
});

test("a failed warm-up conversion makes the converter unavailable with a Chinese reason and one log line", async (t) => {
  const scratch = scratchFor(t);
  const { converter, fake, logs, events } = build(scratch, {
    handler: (call) => (call.isWarmup ? call.exit(1) : defaultHandler(call)),
  });
  const info = await converter.ready();
  assert.equal(info.available, false);
  assert.equal(info.isolation, "none");
  assert.ok(hasChinese(info.reason));
  assert.equal(converter.available, false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.event, "legacy-convert.state");
  assert.equal(logs[0]?.available, false);
  const result = failed(await converter.run(input("ppt")));
  assert.equal(result.code, "convert-failed");
  assert.match(result.message, /预热/);
  assert.equal(fake.calls.filter((entry) => entry.isRun).length, 0);
  assert.equal(events.length, 1, "the refused run is still counted once");
  assert.deepEqual(jobDirsIn(scratch.jobRoot), []);
});

test("an upload during a stalled warm-up is refused within timeoutMs, and the shared warm-up keeps running", async (t) => {
  const scratch = scratchFor(t);
  /** @type {() => void} */
  let releaseWarmup = () => {};
  const held = new Promise((resolve) => {
    releaseWarmup = () => resolve(undefined);
  });
  const { converter, fake } = build(scratch, {
    handler: (call) => {
      if (!call.isWarmup) return defaultHandler(call);
      void held.then(() => {
        call.writeOutput();
        call.exit(0);
      });
    },
    options: { timeoutMs: 40 },
  });
  const started = Date.now();
  const result = failed(await converter.run(input("ppt")));
  const waitedMs = Date.now() - started;
  assert.equal(result.code, "timeout", "the wait expiry keeps the retryable timeout");
  assert.ok(hasChinese(result.message));
  assert.ok(waitedMs < 5000, `the upload waited ${waitedMs} ms; its bound is 40 ms plus slack`);
  assert.equal(
    fake.calls.some((entry) => entry.isRun),
    false,
    "no conversion started while warm-up was still running",
  );
  releaseWarmup();
  const info = await converter.ready();
  assert.equal(info.available, true, "the shared warm-up was not cancelled by the waiting upload");
  assert.equal((await converter.run(input("ppt"))).ok, true);
  assert.deepEqual(jobDirsIn(scratch.jobRoot), []);
});

test("warm-up is asynchronous: info answers at once and a queued job waits for it", async (t) => {
  const scratch = scratchFor(t);
  /** @type {(() => void) | null} */
  let releaseWarmup = null;
  const { converter, fake } = build(scratch, {
    handler: (call) => {
      if (call.isWarmup) {
        releaseWarmup = () => defaultHandler(call);
        return;
      }
      defaultHandler(call);
    },
  });
  const early = converter.info();
  assert.equal(early.available, false);
  assert.match(String(early.reason), /正在启动/);
  const run = converter.run(input("doc"));
  // The fake runs its handler a tick after spawn, so wait for the held warm-up itself.
  await until(() => releaseWarmup !== null);
  assert.equal(
    fake.calls.some((entry) => entry.isRun),
    false,
    "the job waits for warm-up",
  );
  assert.equal(converter.info().available, false, "still starting while warm-up is held");
  /** @type {() => void} */ (/** @type {unknown} */ (releaseWarmup))();
  assert.equal((await run).ok, true);
  assert.equal(converter.info().available, true);
});

test("the hardened profile template is pre-warmed once into the data dir and copied into each job", async (t) => {
  const scratch = scratchFor(t);
  const template = path.join(scratch.dataDir, "cache", "soffice-profile-v1");
  /** @type {{marker: boolean, xcu: string}[]} */
  const profiles = [];
  /** @param {FakeCall} call */
  const handler = (call) => {
    const profileDir = call.profileDir ?? "";
    if (call.isWarmup) {
      // Real soffice fills the profile on first start; a marker stands in for that.
      fs.mkdirSync(path.join(profileDir, "user"), { recursive: true });
      fs.writeFileSync(path.join(profileDir, "user", "prewarmed.marker"), "1");
    }
    if (call.isRun) {
      profiles.push({
        marker: fs.existsSync(path.join(profileDir, "user", "prewarmed.marker")),
        xcu: fs.readFileSync(path.join(profileDir, "user", "registrymodifications.xcu"), "utf8"),
      });
    }
    defaultHandler(call);
  };
  const first = build(scratch, { handler });
  await first.converter.ready();
  assert.ok(fs.existsSync(path.join(template, "user", "prewarmed.marker")));
  assert.equal(fs.statSync(template).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(template)).mode & 0o777, 0o700);
  const xcu = fs.readFileSync(path.join(template, "user", "registrymodifications.xcu"), "utf8");
  for (const needle of [
    'oor:name="MacroSecurityLevel"',
    "<value>3</value>",
    'oor:name="DisableMacrosExecution"',
    'oor:name="BlockUntrustedRefererLinks"',
    'oor:name="DisableOLEAutomation"',
    'oor:name="Executable"',
  ]) {
    assert.ok(xcu.includes(needle), needle);
  }
  await first.converter.run(input("ppt"));
  assert.deepEqual(
    profiles.map((profile) => profile.marker),
    [true],
    "the job profile is a copy of the template",
  );
  assert.match(profiles[0]?.xcu ?? "", /MacroSecurityLevel/);

  // A second start reuses the template instead of building another one.
  fs.writeFileSync(path.join(template, "user", "second.marker"), "1");
  const second = build(scratch, { handler });
  await second.converter.ready();
  assert.ok(fs.existsSync(path.join(template, "user", "second.marker")));
  // A template whose hardening was lost is repaired in the job copy, never trusted.
  fs.writeFileSync(
    path.join(template, "user", "registrymodifications.xcu"),
    '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"></oor:items>',
  );
  await second.converter.run(input("doc"));
  assert.match(profiles.at(-1)?.xcu ?? "", /MacroSecurityLevel[\s\S]*<value>3<\/value>/);
});

test("OSL_PIPE sockets in shared directories are never deleted; the job removes only its own directory", async (t) => {
  const scratch = scratchFor(t);
  const pipeDir = path.join(scratch.root, "pipes");
  fs.mkdirSync(pipeDir);
  fs.writeFileSync(path.join(pipeDir, "OSL_PIPE_501_SingleOfficeIPC_old"), "");
  fs.writeFileSync(path.join(pipeDir, "unrelated.txt"), "");
  let jobDir = "";
  const { converter, fake } = build(scratch, {
    handler: (call) => {
      if (call.isRun) {
        jobDir = jobDirOf(call);
        // Another LibreOffice instance of the same user starts mid-job: its
        // socket in the shared directory is not the job's to remove.
        fs.writeFileSync(path.join(pipeDir, "OSL_PIPE_501_SingleOfficeIPC_new"), "", {
          flag: "wx",
        });
        // The job's own socket is created in the private job tmp (TMPDIR).
        fs.writeFileSync(path.join(jobDir, "tmp", "OSL_PIPE_501_SingleOfficeIPC_job"), "", {
          flag: "wx",
        });
      }
      defaultHandler(call);
    },
  });
  await converter.ready();
  const result = await converter.run(input("ppt"));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(fs.readdirSync(pipeDir).sort(), [
    "OSL_PIPE_501_SingleOfficeIPC_new",
    "OSL_PIPE_501_SingleOfficeIPC_old",
    "unrelated.txt",
  ]);
  const run = callWhere(fake.calls, (entry) => entry.isRun);
  assert.ok(jobDir);
  assert.equal(run.options.env.TMPDIR, path.join(jobDir, "tmp"), "the pipe dir is job-private");
  assert.deepEqual(jobDirsIn(scratch.jobRoot), [], "the job's own socket went with the job dir");
});

test("a conversion in progress does not occupy a parse-pool slot", async (t) => {
  const scratch = scratchFor(t);
  /** @type {() => void} */
  let release = () => {};
  const { converter, fake } = build(scratch, {
    handler: (call) => {
      if (!call.isRun) return defaultHandler(call);
      release = () => call.exit(1);
    },
  });
  await converter.ready();
  const slow = converter.run(input("ppt"));
  await until(() => fake.calls.some((entry) => entry.isRun));
  const workerPath = path.join(scratch.root, "slow-worker.mjs");
  fs.writeFileSync(
    workerPath,
    `import { parentPort } from "node:worker_threads";
parentPort.on("message", (job) => {
  setTimeout(() => parentPort.postMessage({ jobId: job.jobId, ok: true, derivative: { parser: { id: "t" } } }), 150);
});`,
  );
  const pool = new ParsePool({ workerPath, timeoutMs: 5000 });
  t.after(() => pool.close());
  const jobs = ["a", "b"].map((id) => pool.run({ materialId: id, name: `${id}.txt`, bytes: Buffer.from("x") }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pool.activeCount, 2, "two parse jobs run beside the conversion");
  assert.equal(converter.outstanding, 1);
  const outcomes = /** @type {{ok: boolean}[]} */ (await Promise.all(jobs));
  assert.ok(outcomes.every((outcome) => outcome.ok));
  release();
  assert.equal(failed(await slow).code, "convert-failed");
});
