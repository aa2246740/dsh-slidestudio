/**
 * Shared setup for the legacy converter tests: a converter on the fake
 * soffice spawn (nothing real is ever started), a stepping fake clock for
 * node:test, and small predicates the suites share.
 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { createLegacyConverter } from "../legacy-convert.mjs";
import { createFakeSpawn, defaultHandler } from "../../testlib/fake-soffice.mjs";

/**
 * @typedef {ReturnType<typeof import("../../testlib/fake-soffice.mjs").makeScratch>} Scratch
 * @typedef {Parameters<typeof createFakeSpawn>[0]} FakeHandler
 * @typedef {Parameters<NonNullable<FakeHandler>>[0]} FakeCall
 * @typedef {import("../legacy-convert.mjs").LegacyConverterOptions} ConverterOptions
 * @typedef {Record<string, unknown> & {event?: string, level?: string, key?: string}} LogEntry
 */

/** @param {string} [family] */
export const input = (family = "ppt") => ({ bytes: Buffer.from("legacy-bytes"), family });

/** @param {unknown} text */
export const hasChinese = (text) => /[\u4e00-\u9fff]/.test(String(text));

/**
 * Fake-spawn converter on a macOS-shaped platform with no sandbox wrapper.
 * @param {Scratch} scratch
 * @param {{handler?: FakeHandler, options?: ConverterOptions}} [setup]
 */
export function build(scratch, { handler, options = {} } = {}) {
  /** @type {LogEntry[]} */
  const logs = [];
  /** @type {{pid: number, signal: string}[]} */
  const kills = [];
  /** @type {import("../legacy-convert.mjs").ConvertEvent[]} */
  const events = [];
  const fake = createFakeSpawn(handler);
  const converter = createLegacyConverter({
    env: {},
    platform: "darwin",
    isolation: "none",
    sofficePath: scratch.soffice,
    dataDir: scratch.dataDir,
    jobRoot: scratch.jobRoot,
    spawn: /** @type {never} */ (fake.spawn),
    kill: (pid, signal) => kills.push({ pid, signal }),
    sampleRssMb: async () => 0,
    log: (entry) => logs.push(entry),
    onEvent: (event) => events.push(event),
    ...options,
  });
  return { converter, fake, kills, logs, events };
}

/** The fake soffice for conversions stays silent; warm-up and --version still work.
 * @param {FakeCall} call */
export const hangRuns = (call) => (call.isRun ? undefined : defaultHandler(call));

/**
 * @param {{pid: number, signal: string}[]} kills @param {{pid: number}} call
 */
export const groupKills = (kills, call) =>
  kills.filter((kill) => kill.pid === -call.pid && kill.signal === "SIGKILL");

/**
 * The first recorded spawn matching a predicate; fails the test when none exists.
 * @template T
 * @param {T[]} calls @param {(call: T) => boolean} predicate @returns {T}
 */
export function callWhere(calls, predicate) {
  const call = calls.find(predicate);
  if (!call) throw new Error("no matching fake soffice call");
  return call;
}

/** Fake the timers (not setImmediate, which the fake spawn and real I/O use) for one test.
 * @param {import("node:test").TestContext} t */
export function useFakeClock(t) {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  t.after(() => mock.timers.reset());
}

const flushIo = async () => {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/**
 * Advance the fake clock in small steps, letting promises and real I/O settle
 * between them (the node:test counterpart of an async timer advance).
 * @param {number} ms
 */
export async function advance(ms) {
  let left = ms;
  while (left > 0) {
    const step = Math.min(left, 50);
    mock.timers.tick(step);
    left -= step;
    await flushIo();
  }
}

/**
 * Set environment variables for one test and restore the previous values after it.
 * @param {import("node:test").TestContext} t @param {Record<string, string>} values
 */
export function stubEnv(t, values) {
  /** @type {Record<string, string|undefined>} */
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/**
 * @param {import("../legacy-convert.mjs").ConvertSuccess | import("../legacy-convert.mjs").ConvertFailure} result
 * @returns {import("../legacy-convert.mjs").ConvertFailure}
 */
export function failed(result) {
  if (result.ok) assert.fail("the conversion was expected to fail");
  return result;
}

/**
 * @param {import("../legacy-convert.mjs").ConvertSuccess | import("../legacy-convert.mjs").ConvertFailure} result
 * @returns {import("../legacy-convert.mjs").ConvertSuccess}
 */
export function succeeded(result) {
  if (!result.ok) assert.fail(`the conversion failed: ${result.code}`);
  return result;
}
