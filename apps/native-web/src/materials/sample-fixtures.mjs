/**
 * Shared test helper: the contract sample set (scripts/qa/attachment-samples.mjs)
 * is built once per generator-input hash into <repo>/.cache/test-samples/<hash>/
 * and reused by every test file and every run. The set is read-only: a test that
 * must change a sample copies it first.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const GENERATOR = path.join(REPO_ROOT, "scripts/qa/attachment-samples.mjs");
const CACHE_ROOT = path.join(REPO_ROOT, ".cache/test-samples");
/** Packages whose versions change the bytes the generator writes. */
const GENERATOR_PACKAGES = ["fflate", "sharp"];
/** Bump when the cache layout or the publish rules change. */
const CACHE_LAYOUT = "1";
const LOCK_STALE_MS = 5 * 60_000;
const STAGING_STALE_MS = 60 * 60_000;
/** A set used within this window may still be read by another run, so it is kept. */
const SET_IDLE_MS = 30 * 60_000;
const KEY_PATTERN = /^[0-9a-f]{16}$/;
const RELATIVE_IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

/** @type {Promise<string> | undefined} */
let pending;

/**
 * `false` when the contract sample generator is present, otherwise the reason
 * sample-backed tests are skipped (pass it as node:test's `skip` option).
 * @type {false | string}
 */
export const SAMPLES_SKIP = fs.existsSync(GENERATOR)
  ? false
  : "the contract sample generator scripts/qa/attachment-samples.mjs is not part of this checkout";

/** @returns {Promise<string>} absolute path of the shared, read-only sample set */
export function generateSamples() {
  pending ??= ensureSampleSet();
  return pending;
}

/**
 * Returns the published set for these inputs, building it first when absent.
 * Concurrent callers (vitest workers, parallel runs) share one build: the first
 * takes a lock and the others wait for the set to appear. The generator writes
 * a staging directory that is renamed into place, so readers never see a partial
 * set.
 * @param {{
 *   cacheRoot?: string,
 *   generator?: string,
 *   inputs?: string[],
 *   versions?: [string, string][],
 * }} [options]
 * @returns {Promise<string>}
 */
export async function ensureSampleSet({
  cacheRoot = CACHE_ROOT,
  generator = GENERATOR,
  inputs = generatorInputs(generator),
  versions = GENERATOR_PACKAGES.map((name) => [name, packageVersion(name)]),
} = {}) {
  const key = sampleKey(inputs, versions);
  const dir = path.join(cacheRoot, key);
  if (isPublished(dir)) {
    touch(dir);
    pruneOtherSets(cacheRoot, key);
    return dir;
  }
  fs.mkdirSync(cacheRoot, { recursive: true });
  const release = await acquireBuildLock(cacheRoot, key, dir);
  if (!release) return dir;
  try {
    if (isPublished(dir)) return dir;
    const staging = path.join(cacheRoot, `.build-${key}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(staging);
    try {
      await runGenerator(generator, staging);
      if (!isPublished(staging)) throw new Error("sample generator wrote no manifest.json");
      makeReadOnly(staging);
      publish(staging, dir);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    pruneOtherSets(cacheRoot, key);
    return dir;
  } finally {
    release();
  }
}

/**
 * Read one generated sample as a Buffer.
 * @param {string} dir @param {string} name
 */
export function readSample(dir, name) {
  return fs.readFileSync(path.join(dir, name));
}

/**
 * The generator and every local module it imports, directly or transitively.
 * @param {string} entry
 */
function generatorInputs(entry) {
  const seen = new Set();
  const queue = [path.resolve(entry)];
  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.pop());
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of fs.readFileSync(file, "utf8").matchAll(RELATIVE_IMPORT)) {
      // Group 1 always participates when RELATIVE_IMPORT matches.
      queue.push(path.resolve(path.dirname(file), /** @type {string} */ (match[1])));
    }
  }
  return [...seen].sort();
}

/** @param {string} name */
function packageVersion(name) {
  const manifest = path.join(REPO_ROOT, "node_modules", name, "package.json");
  return JSON.parse(fs.readFileSync(manifest, "utf8")).version;
}

/**
 * @param {string[]} inputs
 * @param {[string, string][]} versions
 */
function sampleKey(inputs, versions) {
  const hash = crypto.createHash("sha256");
  hash.update(`layout:${CACHE_LAYOUT}\nplatform:${process.platform}-${process.arch}\n`);
  for (const [name, version] of versions) hash.update(`package:${name}@${version}\n`);
  for (const file of inputs) {
    hash.update(`file:${path.relative(REPO_ROOT, file)}\n`);
    hash.update(fs.readFileSync(file));
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

/** @param {string} dir */
function isPublished(dir) {
  return fs.existsSync(path.join(dir, "manifest.json"));
}

/**
 * Stamps a set as in use. Pruning reads this timestamp, so a set that other
 * runs keep using is never removed. Best effort: a missed stamp only means an
 * earlier prune.
 * @param {string} dir
 */
function touch(dir) {
  try {
    const now = new Date();
    fs.utimesSync(dir, now, now);
  } catch {
    // Read-only or foreign directory: nothing to stamp.
  }
}

/**
 * Creates the build lock, or waits until another process publishes the set.
 * A lock older than LOCK_STALE_MS belongs to a crashed builder and is replaced.
 * @param {string} cacheRoot
 * @param {string} key
 * @param {string} dir
 * @returns {Promise<(() => void) | null>} the release function, or null when the
 *   set was published while this caller waited
 */
async function acquireBuildLock(cacheRoot, key, dir) {
  const lock = path.join(cacheRoot, `${key}.lock`);
  for (;;) {
    if (isPublished(dir)) return null;
    try {
      fs.mkdirSync(lock);
      return () => fs.rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
    }
    if (ageMs(lock) > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
    else await delay(200);
  }
}

/** @param {string} staging @param {string} dir */
function publish(staging, dir) {
  try {
    fs.renameSync(staging, dir);
  } catch (error) {
    // Another builder renamed an identical set into place first; keep theirs.
    if (!isPublished(dir)) throw error;
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Files become read-only so an accidental write fails loudly. Directories stay
 * writable so that old sets can still be pruned.
 * @param {string} dir
 */
function makeReadOnly(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) makeReadOnly(full);
    else fs.chmodSync(full, 0o444);
  }
}

/**
 * Removes sets built from other inputs once they have been idle, plus abandoned
 * staging directories and abandoned locks.
 * @param {string} cacheRoot @param {string} key
 */
function pruneOtherSets(cacheRoot, key) {
  for (const name of fs.readdirSync(cacheRoot)) {
    if (name === key || name === `${key}.lock`) continue;
    const full = path.join(cacheRoot, name);
    const abandoned =
      (name.startsWith(".build-") && ageMs(full) > STAGING_STALE_MS) ||
      (name.endsWith(".lock") && ageMs(full) > LOCK_STALE_MS);
    const idleSet = KEY_PATTERN.test(name) && ageMs(full) > SET_IDLE_MS;
    if (idleSet || abandoned) {
      fs.rmSync(full, { recursive: true, force: true });
    }
  }
}

/**
 * @param {string} generator
 * @param {string} outDir
 * @returns {Promise<void>}
 */
function runGenerator(generator, outDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [generator, "--out", outDir], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2_000);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sample generator exited ${code}: ${stderr.trim()}`));
    });
  });
}

/** @param {string} target */
function ageMs(target) {
  try {
    return Date.now() - fs.statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
