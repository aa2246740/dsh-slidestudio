import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { PptdError } from "./errors.js";
import { materializeInheritance } from "./inheritance.js";
import { assertLayoutSchema, assertPageOwnership } from "./layout-schema.js";
import type { Page, PptdProject, Presentation } from "./types.js";

export { PptdError };

/**
 * A PPTD save updates a manifest and one or more page files. Keep every
 * writer behind one cross-process lock so a reader/writer never observes a
 * competing save halfway through that multi-file operation.
 */
const WRITE_LOCK_NAME = ".pptd-write.lock";

/**
 * YAML parse results keyed by file identity (mtime + size). Writers always go
 * through writeFileAtomic's rename, which changes both, so a hit is always the
 * current content. Hits are deep-cloned: callers receive fresh objects, same
 * as an uncached parse, so mutations can never leak through the cache. Inspect
 * paths re-load the same project on every poll — without this a host slow
 * enough to make parse cost measurable burns a whole core on re-parses.
 */
const parseCache = new Map<string, { mtimeMs: number; size: number; doc: unknown }>();
const PARSE_CACHE_MAX = 256;

function readYamlFileCached(file: string): unknown {
  const st = fs.statSync(file);
  const hit = parseCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    parseCache.delete(file);
    parseCache.set(file, hit);
    return structuredClone(hit.doc);
  }
  const doc = YAML.parse(fs.readFileSync(file, "utf8"));
  if (parseCache.size >= PARSE_CACHE_MAX) {
    parseCache.delete(parseCache.keys().next().value!);
  }
  parseCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, doc });
  return structuredClone(doc);
}
const LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const lockDepthByRoot = new Map<string, number>();

function lockDir(rootDir: string): string {
  return path.join(path.resolve(rootDir), WRITE_LOCK_NAME);
}

const syncSleepBuffer = new SharedArrayBuffer(4);
const syncSleepView = new Int32Array(syncSleepBuffer);

function sleepSync(ms: number): void {
  // Real blocking sleep: Atomics.wait parks the thread instead of spinning at
  // 100% CPU while a lock is held. Fall back to the bounded spin for embedders
  // where Atomics.wait on the main thread is unavailable (renderer processes).
  try {
    Atomics.wait(syncSleepView, 0, 0, Math.max(0, ms));
  } catch {
    const end = Date.now() + Math.max(0, ms);
    while (Date.now() < end) {
      // intentional bounded spin
    }
  }
}

function pidIsAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const HOSTNAME = os.hostname();
// A lock owned by another host cannot be pid-checked; on a shared filesystem
// it is only reclaimable after it has clearly been abandoned.
const CROSS_HOST_STALE_MS = 10 * 60_000;

function reclaimDeadWriteLock(dir: string): boolean {
  const owner = path.join(dir, "owner.json");
  try {
    const data = JSON.parse(fs.readFileSync(owner, "utf8")) as {
      pid?: unknown;
      host?: unknown;
    };
    if (typeof data.host === "string" && data.host !== HOSTNAME) {
      // Different host: pid liveness is meaningless. Only a lock untouched
      // for a long window counts as stale.
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs < CROSS_HOST_STALE_MS) return false;
      } catch {
        return false;
      }
    } else if (pidIsAlive(data.pid)) {
      return false;
    }
  } catch {
    // A crash can happen after mkdir and before owner.json is flushed. Do not
    // steal a fresh lock while its owner is still recording itself.
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs < 1_000) return false;
    } catch {
      return false;
    }
  }
  // Two reclaimers can decide the lock is dead at once. Rename the stale dir
  // aside first: only one rename wins, so only the winner deletes the lock
  // and retries the acquire. The loser's rename fails and it keeps waiting.
  const trash = `${dir}.stale-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(dir, trash);
  } catch {
    return false;
  }
  try {
    fs.rmSync(trash, { recursive: true, force: true });
  } catch {
    // Trash cleanup is best-effort; the lock dir itself is already released.
  }
  return true;
}

/** Execute a synchronous multi-file project operation under the PPTD lock. */
export function withProjectWriteLock<T>(rootDir: string, action: () => T, opts: { timeoutMs?: number } = {}): T {
  const root = path.resolve(rootDir);
  const heldDepth = lockDepthByRoot.get(root) ?? 0;
  if (heldDepth > 0) {
    lockDepthByRoot.set(root, heldDepth + 1);
    try {
      return action();
    } finally {
      lockDepthByRoot.set(root, heldDepth);
    }
  }

  fs.mkdirSync(root, { recursive: true });
  const dir = lockDir(root);
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, host: HOSTNAME, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (reclaimDeadWriteLock(dir)) continue;
      if (Date.now() >= deadline) {
        throw new PptdError(`timed out waiting for project write lock: ${root}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  lockDepthByRoot.set(root, 1);
  try {
    return action();
  } finally {
    lockDepthByRoot.delete(root);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertPresentation(raw: unknown, file: string): Presentation {
  if (!raw || typeof raw !== "object") {
    throw new PptdError(`${file}: expected YAML mapping`);
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== "v2") {
    throw new PptdError(`${file}: version must be "v2", got ${String(o.version)}`);
  }
  if (
    !Array.isArray(o.size) ||
    o.size.length !== 2 ||
    !o.size.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
  ) {
    throw new PptdError(`${file}: size must be [width, height] positive numbers`);
  }
  if (!Array.isArray(o.pages)) {
    throw new PptdError(`${file}: pages must be an array of relative paths`);
  }
  const seenPages = new Set<string>();
  for (const p of o.pages) {
    if (typeof p !== "string" || !p.trim()) {
      throw new PptdError(`${file}: each pages entry must be a non-empty string`);
    }
    if (path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) {
      throw new PptdError(`${file}: pages entry escapes project root: ${p}`);
    }
    const key = path.normalize(p);
    if (seenPages.has(key)) {
      throw new PptdError(`${file}: duplicate pages entry: ${p}`);
    }
    seenPages.add(key);
  }
  const theme = o.theme as Record<string, unknown> | null | undefined;
  if (theme && typeof theme === "object" && theme.neutralChrome !== undefined) {
    if (typeof theme.neutralChrome !== "boolean") {
      throw new PptdError(`${file}: theme.neutralChrome must be true or false`);
    }
  }
  return o as unknown as Presentation;
}

function isFiniteNumberArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) && value.length === length && value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function assertPage(raw: unknown, file: string): Page {
  if (!raw || typeof raw !== "object") {
    throw new PptdError(`${file}: expected YAML mapping`);
  }
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.elements)) {
    throw new PptdError(`${file}: elements must be an array`);
  }
  if (o.pageType !== undefined && typeof o.pageType !== "string") {
    throw new PptdError(`${file}: pageType must be a string`);
  }
  if (o.background !== undefined && (typeof o.background !== "object" || o.background === null)) {
    throw new PptdError(`${file}: background must be a mapping`);
  }
  for (const [index, el] of o.elements.entries()) {
    if (!el || typeof el !== "object" || Array.isArray(el)) {
      throw new PptdError(`${file}: elements[${index}] must be a mapping`);
    }
    const rec = el as Record<string, unknown>;
    if (rec.elementId !== undefined && typeof rec.elementId !== "string") {
      throw new PptdError(`${file}: elements[${index}].elementId must be a string`);
    }
    if (rec.elementType !== undefined && typeof rec.elementType !== "string") {
      throw new PptdError(`${file}: elements[${index}].elementType must be a string`);
    }
    if (rec.bounds !== undefined && !isFiniteNumberArray(rec.bounds, 4)) {
      throw new PptdError(`${file}: elements[${index}].bounds must be [x, y, w, h] numbers`);
    }
  }
  return o as unknown as Page;
}

function safeJoin(root: string, rel: string): string {
  const resolved = path.resolve(root, rel);
  const rootResolved = path.resolve(root);
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    throw new PptdError(`path escapes project root: ${rel}`);
  }
  return resolved;
}

function projectRootForSource(source: string): string {
  const abs = path.resolve(source);
  return fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
}

/** Load a PPTD project from a .pptd file or a directory containing one. */
function loadProjectUnlocked(source: string): PptdProject {
  const abs = path.resolve(source);
  let manifestPath: string;
  let rootDir: string;

  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    rootDir = abs;
    const found = fs
      .readdirSync(abs)
      .filter((f) => f.endsWith(".pptd"))
      .map((f) => path.join(abs, f));
    if (found.length === 0) throw new PptdError(`no .pptd under ${abs}`);
    if (found.length > 1) {
      throw new PptdError(`multiple .pptd under ${abs}; pass one explicitly`);
    }
    manifestPath = found[0]!;
  } else {
    manifestPath = abs;
    rootDir = path.dirname(abs);
  }

  if (!manifestPath.endsWith(".pptd")) {
    throw new PptdError(`manifest must be a .pptd file: ${manifestPath}`);
  }

  const presentation = assertPresentation(readYamlFileCached(manifestPath), manifestPath);
  assertLayoutSchema(presentation, manifestPath);

  const pages = presentation.pages.map((rel) => {
    const pagePath = safeJoin(rootDir, rel);
    if (!fs.existsSync(pagePath)) {
      throw new PptdError(`missing page file: ${rel}`);
    }
    const page = assertPage(readYamlFileCached(pagePath), pagePath);
    return { path: rel, page };
  });

  return {
    rootDir,
    manifestPath,
    presentation,
    pages,
  };
}

/**
 * Read a coherent manifest/page snapshot. The lock is shared with every
 * saveProject caller; this is intentionally reentrant for callers that need
 * a read-modify-write transaction.
 */
export function loadProject(source: string): PptdProject {
  // Lock-free read: saveProject writes every page atomically and commits the
  // manifest last, so a reader always resolves a complete, coherent set —
  // either the old manifest with its files or the new one. Callers that need
  // a read-modify-write transaction still use withProjectWriteLock.
  return loadProjectUnlocked(source);
}

/**
 * Atomic single-file write: stage a sibling temp file, fsync, then rename
 * over the destination so readers never observe a partial file.
 */
function writeFileAtomic(target: string, contents: string): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, contents, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

/** Write project back to disk (manifest + all page files). */
export function saveProject(project: PptdProject): void {
  const { rootDir, presentation, pages } = project;
  withProjectWriteLock(rootDir, () => {
    const manifestName = path.basename(project.manifestPath);
    const manifestOut = path.join(rootDir, manifestName);
    // Validate every destination before a single byte is written so a bad
    // page path cannot leave the manifest already replaced.
    const seen = new Set<string>();
    const targets = pages.map(({ path: rel, page }) => {
      if (typeof rel !== "string" || !rel.trim()) {
        throw new PptdError("page path must be a non-empty string");
      }
      if (rel === manifestName) {
        throw new PptdError(`page path collides with manifest: ${rel}`);
      }
      const out = safeJoin(rootDir, rel);
      const key = path.normalize(out);
      if (seen.has(key)) {
        throw new PptdError(`duplicate page path: ${rel}`);
      }
      seen.add(key);
      return { out, page, rel };
    });
    // Masters, layouts and page ownership are checked with the destinations, so a deck that
    // fails any of them leaves every file as it was. Copies are refreshed only after that.
    assertLayoutSchema(presentation, manifestName);
    for (const { rel, page } of targets) assertPageOwnership(presentation, page, rel);
    materializeInheritance(project);
    const manifestDoc: Presentation = {
      ...presentation,
      version: "v2",
      pages: pages.map((p) => p.path),
    };
    fs.mkdirSync(path.join(rootDir, "pages"), { recursive: true });
    for (const { out, page } of targets) {
      writeFileAtomic(out, YAML.stringify(page));
    }
    // The manifest names the page set, so it commits last: a lock-free reader
    // either sees the old manifest with its old files, or the new manifest
    // with every page already durable.
    writeFileAtomic(manifestOut, YAML.stringify(manifestDoc));
  });
}

/** White title-only cover used when a caller lists a page on purpose. */
export function titleOnlyCoverPage(title: string): Page {
  return {
    pageType: "cover",
    background: { type: "solid", color: "#FFFFFF" },
    elements: [
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 200, 800, 80],
        content: {
          text: title,
          style: "$title",
          align: ["center", "middle"],
        },
      },
    ],
  };
}

/** Put a page on the composed list. Does not save. createEmptyProject does not call this. */
export function listComposedPage(project: PptdProject, rel: string, page: Page): void {
  const pathNorm = rel.replace(/\\/g, "/");
  const idx = project.pages.findIndex((loaded) => loaded.path === pathNorm);
  if (idx >= 0) project.pages[idx] = { path: pathNorm, page };
  else project.pages.push({ path: pathNorm, page });
  project.presentation.pages = project.pages.map((loaded) => loaded.path);
}

/** Create a project with zero composed pages. A placeholder file is not a slide. */
export function createEmptyProject(
  rootDir: string,
  opts: { title?: string; size?: [number, number] } = {},
): PptdProject {
  fs.mkdirSync(path.join(rootDir, "pages"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "media"), { recursive: true });
  const size = opts.size ?? ([960, 540] as [number, number]);
  const presentation: Presentation = {
    version: "v2",
    title: opts.title ?? "Untitled",
    size,
    theme: {
      colors: {
        primary: "#2563EB",
        text: "#111111",
        background: "#FFFFFF",
      },
      textStyles: {
        title: { fontSize: 36, bold: true, color: "$text" },
        body: { fontSize: 18, color: "$text" },
      },
    },
    pages: [],
  };
  const project: PptdProject = {
    rootDir: path.resolve(rootDir),
    manifestPath: path.join(path.resolve(rootDir), "deck.pptd"),
    presentation,
    pages: [],
  };
  saveProject(project);
  return project;
}

/** Calculate the material fingerprint covering deck.pptd, pages, and media. */
export function calculateMaterialFingerprint(rootDir: string): string {
  const root = path.resolve(rootDir);
  const files: Array<{ rel: string; bytes: Buffer }> = [];
  const visit = (dir: string, rel = "") => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!rel && (name === ".versions" || name === "_agent" || name === ".git" || name === WRITE_LOCK_NAME)) {
        continue;
      }
      const abs = path.join(dir, name);
      const nextRel = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) {
        visit(abs, nextRel);
      } else if (st.isFile()) {
        if (nextRel === "deck.pptd" || nextRel.startsWith("pages/") || nextRel.startsWith("media/")) {
          files.push({ rel: nextRel, bytes: fs.readFileSync(abs) });
        }
      }
    }
  };
  visit(root);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.rel).update("\0").update(file.bytes).update("\0");
  }
  return hash.digest("hex");
}
