import fs from "node:fs";
import path from "node:path";

/** Project files captured by relative path; `null` records a file that did not exist.
 * @typedef {Array<[string, Buffer | null]>} CapturedProjectFiles */

/** @param {string} root @param {readonly string[]} relativePaths @returns {CapturedProjectFiles} */
export function captureProjectFiles(root, relativePaths) {
  return relativePaths.map((rel) => {
    const file = path.join(root, rel);
    return [rel, fs.existsSync(file) ? fs.readFileSync(file) : null];
  });
}

/** Puts every captured file back atomically, deleting the ones that were absent.
 * @param {string} root @param {CapturedProjectFiles} captured */
export function restoreProjectFiles(root, captured) {
  for (const [rel, bytes] of captured) {
    const file = path.join(root, rel);
    if (bytes === null) {
      fs.rmSync(file, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, file);
  }
}

const BARRIER_TIMEOUT_MS = 10_000;
const BARRIER_POLL_MS = 10;

/** Portable synchronous pause; Atomics.wait is unavailable in some embedders.
 * @param {number} ms */
function pauseSync(ms) {
  const until = Date.now() + Math.max(0, ms);
  while (Date.now() < until) {
    // bounded on purpose: the caller owns the project write lock and must not yield
  }
}

/**
 * Test-only fault injection. When `<dir>/arm` exists in the directory named by `envName`, the
 * barrier consumes it, writes `<dir>/<marker>` and blocks (still holding the caller's project
 * lock) until `<dir>/release` appears or ten seconds pass. Without the env var it is a no-op.
 * @param {string} envName @param {string} marker @param {string} label
 */
export function waitForTestBarrier(envName, marker, label) {
  const dir = process.env[envName];
  if (!dir) return;
  const armed = path.join(dir, "arm");
  if (!fs.existsSync(armed)) return;
  fs.rmSync(armed, { force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, marker), "ready\n", "utf8");
  const released = path.join(dir, "release");
  const giveUpAt = Date.now() + BARRIER_TIMEOUT_MS;
  while (!fs.existsSync(released)) {
    if (Date.now() >= giveUpAt) throw new Error(`${label} barrier timed out`);
    pauseSync(BARRIER_POLL_MS);
  }
}

/** Pause while the restore transaction owns the project lock, after the pre-restore snapshot. */
export function waitForRestoreBarrier() {
  waitForTestBarrier("NATIVE_WEB_RESTORE_BARRIER_DIR", "pre-snapshot", "restore");
}
