import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const readers = new Map();
const projected = new Map();

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

/**
 * Decode only complete JSONL records returned by the official readRaw API.
 *
 * `@deepseek-ai/dsh-session` 0.1.5-rc.2 dropped its public chunk-row codec (the
 * packed `reasoning-chunks` / `text-chunks` / `tool-call-chunks` rows are now an
 * internal persistence concern), so a missing codec means the journal already
 * stores plain event rows: pass each record through unchanged. A compressed
 * legacy row then fails the sequence check below instead of decoding silently.
 */
export function decodeJournalContent(content, decodeStorageRecord) {
  const decodeRecord = typeof decodeStorageRecord === "function" ? decodeStorageRecord : (record) => [record];
  const lines = content.split("\n");
  if (!lines[0]?.trim()) throw new Error("session journal has no header");
  const events = [];
  let expectedSeq = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const decoded = decodeRecord(JSON.parse(line));
    for (const event of decoded) {
      if (!event || typeof event !== "object" || event.seq !== expectedSeq) {
        throw new Error(`session journal sequence mismatch at ${expectedSeq}`);
      }
      events.push(event);
      expectedSeq += 1;
    }
  }
  return events;
}

function assertJournalIdentity(meta, sessionId, root) {
  if (!meta || meta.id !== sessionId || !meta.cwd || path.resolve(meta.cwd) !== root) {
    throw new Error("session journal identity does not match the current product workspace");
  }
}

/**
 * Read one stored session's events with the installed DSH build.
 *
 * DSH >= 0.1.5-rc.2 exposes stat()/open(read) and hands back decoded events
 * (format v3 and zstd compression are backend concerns now). Older builds expose
 * readStoredRevision()/readRaw() with raw JSONL that this module decodes itself.
 *
 * @returns undefined when the session has no stored journal.
 */
async function loadStoredJournal(reader, id, sessionId, root) {
  const { backend } = reader;
  if (typeof backend.stat === "function" && typeof backend.open === "function") {
    const snapshot = await backend.stat(id);
    if (!snapshot) return undefined;
    assertJournalIdentity(snapshot.header, sessionId, root);
    const handle = await backend.open(id, "read");
    try {
      const result = await handle.read();
      return {
        revision: snapshot.revision ?? snapshot.eventCount,
        events: [...(result?.events ?? [])],
      };
    } finally {
      await handle.close?.();
    }
  }
  const revision = await backend.readStoredRevision(id);
  if (revision === undefined) return undefined;
  const raw = await backend.readRaw(id);
  if (!raw) return undefined;
  assertJournalIdentity(raw.meta, sessionId, root);
  return { revision, events: decodeJournalContent(raw.content, reader.decodeStorageRecord) };
}

async function readerFor(sessionsRoot) {
  let pending = readers.get(sessionsRoot);
  if (pending) return pending;
  pending = (async () => {
    const [{ Context }, session, persistence] = await Promise.all([
      import("@deepseek-ai/cordis"),
      import("@deepseek-ai/dsh-session"),
      import("@deepseek-ai/dsh-session-persistence-jsonl"),
    ]);
    const ctx = new Context();
    // This private context has no live sessions. The official backend is used
    // only for readStoredRevision/readRaw; no prepare/load/inspect/append path.
    new session.SessionStore(ctx);
    // DSH renamed the export: JsonlSessionPersistence is the package default now
    // (the named export it used to be is gone since 0.1.5-rc.2).
    const JsonlSessionPersistence =
      Reflect.get(persistence, "JsonlSessionPersistence") ?? Reflect.get(persistence, "default");
    if (typeof JsonlSessionPersistence !== "function") {
      throw new Error("session journal backend is unavailable in this DSH build");
    }
    const backend = new JsonlSessionPersistence(ctx, {
      root: sessionsRoot,
      compression: "zstd",
    });
    return {
      backend,
      SessionId: session.SessionId,
      // Absent on DSH >= 0.1.5-rc.2; decodeJournalContent falls back to a
      // passthrough decoder for those journals.
      decodeStorageRecord: Reflect.get(session, "decodeStorageRecord"),
    };
  })();
  readers.set(sessionsRoot, pending);
  return pending;
}

/**
 * Read one project-bound Session through the official complete-frame decoder.
 * Returns public trace rows only; user messages, request headers and private
 * session metadata never leave this function.
 */
export async function readProjectSessionTrace({
  productRoot,
  dshHome,
  sessionId,
  // Test seams only. Production callers always use the official reader and
  // the built public projection module selected below.
  readerFactory = readerFor,
  traceModule,
}) {
  const root = fs.realpathSync(productRoot);
  const home = fs.realpathSync(dshHome);
  if (!inside(root, home)) throw new Error("DSH_HOME is outside the product root");
  const sessionsRoot = path.join(home, "sessions");
  if (!fs.existsSync(sessionsRoot)) return [];
  if (typeof sessionId !== "string" || !sessionId.trim()) return [];

  const cacheKey = `${sessionsRoot}\0${sessionId}`;
  const cached = projected.get(cacheKey);
  let reader;
  try {
    reader = await readerFactory(sessionsRoot);
  } catch (error) {
    if (cached) return cached.rows;
    throw error;
  }
  const id = reader.SessionId(sessionId);
  try {
    const stored = await loadStoredJournal(reader, id, sessionId, root);
    if (!stored) return cached?.rows ?? [];
    if (cached?.revision === stored.revision) return cached.rows;

    const trace =
      traceModule ??
      (await import(`${pathToFileURL(path.join(root, "packages", "dsh-slides-host", "dist", "agent-trace.js")).href}`));
    const rows = stored.events.flatMap((event) => trace.traceRowsFromSessionEvent(event));
    projected.set(cacheKey, { revision: stored.revision, rows });
    return rows;
  } catch (error) {
    if (cached) return cached.rows;
    throw error;
  }
}
