import fs from "node:fs";
import path from "node:path";
import { hardenedRegistry } from "./legacy-convert-config.mjs";

const JOB_PREFIX = "oss-lo-";
const TEMPLATE_NAME = "soffice-profile-v1";
const TEMPLATE_MARKER = ".slidestudio-prewarmed";
const REGISTRY = path.join("user", "registrymodifications.xcu");
const STALE_JOB_MS = 60 * 60 * 1000;

/** @typedef {{dir: string, profile: string, input: string, out: string, tmp: string}} JobDir */

/** @param {string} dataDir */
export const templatePaths = (dataDir) => {
  const cache = path.join(dataDir, "cache");
  return { cache, template: path.join(cache, TEMPLATE_NAME) };
};

/**
 * One directory per job: profile, input, output and scratch space. Everything a
 * soffice process may write lives below it so a single removal is the cleanup.
 * @param {string} jobRoot
 * @returns {Promise<JobDir>}
 */
export async function createJobDir(jobRoot) {
  await fs.promises.mkdir(jobRoot, { recursive: true });
  const dir = await fs.promises.mkdtemp(path.join(jobRoot, JOB_PREFIX));
  const job = {
    dir,
    profile: path.join(dir, "profile"),
    input: path.join(dir, "in"),
    out: path.join(dir, "out"),
    tmp: path.join(dir, "tmp"),
  };
  try {
    await Promise.all([job.input, job.out, job.tmp].map((entry) => fs.promises.mkdir(entry, { mode: 0o700 })));
  } catch (error) {
    await removeJobDir(dir);
    throw error;
  }
  return job;
}

/** @param {string} dir */
export function removeJobDir(dir) {
  return fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
}

/**
 * The job's profile is a copy of the pre-warmed template with the hardening
 * rewritten on top, so a damaged or edited template is never trusted.
 * @param {string|undefined} template a ready template, when there is one
 * @param {string} profile
 */
export async function prepareProfile(template, profile) {
  if (template) await fs.promises.cp(template, profile, { recursive: true });
  else await fs.promises.mkdir(profile, { recursive: true });
  await fs.promises.chmod(profile, 0o700);
  const registry = path.join(profile, REGISTRY);
  await fs.promises.mkdir(path.dirname(registry), { recursive: true });
  const existing = await fs.promises.readFile(registry, "utf8").catch(() => "");
  await fs.promises.writeFile(registry, hardenedRegistry(existing), { mode: 0o600 });
}

/**
 * The template when a previous start finished building it. A directory without
 * the completion marker is a partial build and is removed.
 * @param {string} dataDir
 * @returns {Promise<string|undefined>}
 */
export async function readyTemplate(dataDir) {
  const { template } = templatePaths(dataDir);
  const marked = await fs.promises
    .access(path.join(template, TEMPLATE_MARKER))
    .then(() => true)
    .catch(() => false);
  if (marked) return template;
  await fs.promises.rm(template, { recursive: true, force: true }).catch(() => undefined);
  return undefined;
}

/**
 * Keep a warmed job profile as the template, atomically: the copy is built
 * beside the target and renamed into place, and the loser of a race with
 * another instance discards its own copy.
 * @param {string} dataDir @param {string} warmedProfile
 */
export async function promoteTemplate(dataDir, warmedProfile) {
  const { cache, template } = templatePaths(dataDir);
  await fs.promises.mkdir(cache, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(cache, 0o700);
  const staging = await fs.promises.mkdtemp(path.join(cache, `${TEMPLATE_NAME}.tmp-`));
  try {
    await fs.promises.cp(warmedProfile, staging, { recursive: true });
    await fs.promises.chmod(staging, 0o700);
    const user = path.join(staging, "user");
    for (const name of await fs.promises.readdir(user).catch(() => /** @type {string[]} */ ([]))) {
      if (name === ".lock" || name.endsWith(".lock")) await fs.promises.rm(path.join(user, name), { force: true });
    }
    await fs.promises.writeFile(
      path.join(staging, REGISTRY),
      hardenedRegistry(await fs.promises.readFile(path.join(staging, REGISTRY), "utf8").catch(() => "")),
      { mode: 0o600 },
    );
    await fs.promises.writeFile(path.join(staging, TEMPLATE_MARKER), "1\n", { mode: 0o600 });
    await fs.promises.rename(staging, template);
  } catch {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Job directories left behind by a process that died mid-conversion. Only
 * directories with the job prefix and an old modification time are removed, so
 * another instance's running job is never touched.
 * @param {string} jobRoot @param {number} [now]
 */
export async function sweepStaleJobs(jobRoot, now = Date.now()) {
  const names = await fs.promises.readdir(jobRoot).catch(() => /** @type {string[]} */ ([]));
  for (const name of names) {
    if (!name.startsWith(JOB_PREFIX)) continue;
    const dir = path.join(jobRoot, name);
    const stat = await fs.promises.lstat(dir).catch(() => undefined);
    if (stat?.isDirectory() && now - stat.mtimeMs > STALE_JOB_MS) await removeJobDir(dir);
  }
}

/**
 * LibreOffice writes its single-instance socket into the directory TMPDIR
 * points at. The job env sets TMPDIR to the job's own `tmp/`, so every pipe a
 * conversion creates is demonstrably job-owned and removed with the job
 * directory. Sockets that appear in a shared temp directory during a job
 * belong to other applications and are never touched.
 */

/**
 * Exactly one regular file with the target extension, a zip container, within
 * the size limit.
 * @param {string} outDir @param {string} to @param {number} maxBytes
 * @returns {Promise<{ok: true, bytes: Buffer} | {ok: false, code: "corrupt"|"too-large"}>}
 */
export async function collectOutput(outDir, to, maxBytes) {
  const names = await fs.promises.readdir(outDir).catch(() => /** @type {string[]} */ ([]));
  const [name] = names;
  if (names.length !== 1 || !name || path.extname(name).toLowerCase() !== `.${to}`) {
    return { ok: false, code: "corrupt" };
  }
  const file = path.join(outDir, name);
  const stat = await fs.promises.lstat(file).catch(() => undefined);
  if (!stat?.isFile() || stat.size === 0) return { ok: false, code: "corrupt" };
  if (stat.size > maxBytes) return { ok: false, code: "too-large" };
  const bytes = await fs.promises.readFile(file);
  return bytes[0] === 0x50 && bytes[1] === 0x4b ? { ok: true, bytes } : { ok: false, code: "corrupt" };
}

/**
 * True when a running job already wrote more than the limit, so a runaway
 * output is stopped before it fills the disk.
 * @param {string} outDir @param {number} maxBytes
 */
export function outputOverLimit(outDir, maxBytes) {
  try {
    return fs.readdirSync(outDir).some((name) => fs.lstatSync(path.join(outDir, name)).size > maxBytes);
  } catch {
    return false;
  }
}
