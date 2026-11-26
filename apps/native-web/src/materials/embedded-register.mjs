/**
 * Registration of the pictures found in one DOCX or PDF as image materials. Each candidate
 * is parsed by the worker pool exactly as an uploaded image would be and stored under its
 * own id. Candidates are registered side by side, as many as the pool runs at once, and may
 * finish in any order; the result is always in document order, and the limit counts the
 * first pictures of the document, never the fastest ones.
 *
 * Candidates may arrive while earlier ones are already being registered (a PDF hands over
 * the pictures of each page as it is read), so a session is opened first, fed with `push`,
 * and closed once nothing more will come.
 */
import crypto from "node:crypto";
import { detectType } from "./detect.mjs";
import { PARSER_IDS } from "./derivative.mjs";

/**
 * @typedef {{name: string, bytes: Buffer, position: import("./embedded-images.mjs").EmbeddedPosition}} Candidate
 * @typedef {import("./embedded-images.mjs").EmbeddedImageEntry} EmbeddedImageEntry
 * @typedef {{store: import("../attachments.mjs").AttachmentStore,
 *   pool: import("./parse-pool.mjs").ParsePool,
 *   parent: {materialId: string, name: string}, origin: "docx"|"pdf",
 *   limit: number, budgetMs: number, now: () => number,
 *   bump: (key: string, count?: number) => void,
 *   verify?: (bytes: Buffer) => Promise<boolean>}} RegistrationOptions
 */

/** @param {"docx"|"pdf"} origin @param {import("./embedded-images.mjs").EmbeddedPosition} position */
function originNote(origin, position) {
  if (origin === "pdf") return `来自 PDF 第 ${position.page} 页`;
  if (position.table) return `来自文档第 ${position.table} 个表格`;
  return position.paragraph ? `来自文档第 ${position.paragraph} 段` : "来自文档";
}

/** A lane that has nothing to do yet but may later. */
const WAIT = Symbol("wait");

/**
 * @param {RegistrationOptions} options
 * @returns {{push: (candidates: Candidate[]) => void, close: () => void,
 *   done: Promise<{images: EmbeddedImageEntry[], createdIds: string[]}>}}
 */
export function openRegistration({ store, pool, parent, origin, limit, budgetMs, now, bump, verify }) {
  /** @type {Candidate[]} */
  const candidates = [];
  /** @type {(EmbeddedImageEntry|undefined)[]} */
  const results = [];
  const seen = new Set();
  /** @type {Set<() => void>} */
  const waiting = new Set();
  /** @type {number|undefined} */
  let startedAt;
  let closed = false;
  let cursor = 0;
  let inFlight = 0;
  let kept = 0;

  function wakeAll() {
    for (const resolve of waiting) resolve();
    waiting.clear();
  }

  /** The next candidate that needs a parse, WAIT when more may still come, or undefined. */
  function pull() {
    for (;;) {
      if (kept + inFlight >= limit) return undefined;
      if (cursor >= candidates.length) return closed ? undefined : WAIT;
      if (now() - /** @type {number} */ (startedAt) > budgetMs) {
        bump("budget", candidates.length - cursor);
        cursor = candidates.length;
        return closed ? undefined : WAIT;
      }
      const index = cursor;
      cursor += 1;
      const candidate = /** @type {Candidate} */ (candidates[index]);
      const detected = detectType({ name: candidate.name, bytes: candidate.bytes });
      if (!detected.ok || detected.parserId !== PARSER_IDS.image) {
        bump("unsupported");
        continue;
      }
      const sha256 = crypto.createHash("sha256").update(candidate.bytes).digest("hex");
      if (seen.has(sha256)) {
        bump("duplicate");
        continue;
      }
      seen.add(sha256);
      return { index, candidate, sha256, materialId: store.nextId(candidate.name) };
    }
  }

  /** @param {{candidate: Candidate, sha256: string, materialId: string}} job */
  async function registerOne({ candidate, sha256, materialId }) {
    // DOCX bytes are the author's own file and get the extra proof; PDF pictures were
    // just encoded by sharp from decoded pixels and the image parse decodes them again.
    if (verify && !(await verify(candidate.bytes))) {
      bump("undecodable");
      return undefined;
    }
    let outcome;
    try {
      outcome = await pool.run({ materialId, name: candidate.name, bytes: candidate.bytes });
    } catch {
      bump("undecodable");
      return undefined;
    }
    const child = outcome.ok ? outcome.derivative : undefined;
    if (!child || child.kind !== "image" || !["ok", "partial"].includes(child.status)) {
      bump("undecodable");
      return undefined;
    }
    const note = originNote(origin, candidate.position);
    const stored = /** @type {import("../attachments.mjs").StoredDerivative} */ (child);
    stored.image = {
      ...stored.image,
      origin,
      note,
      position: candidate.position,
      parent,
    };
    stored.summary = { ...stored.summary, zh: `${note} · ${stored.summary?.zh ?? "图片"}` };
    try {
      const record = await store.record({
        name: candidate.name,
        bytes: candidate.bytes,
        derivative: stored,
        needsVision: true,
      });
      return {
        id: record.meta.id,
        name: candidate.name,
        size: candidate.bytes.length,
        kind: /** @type {"image"} */ ("image"),
        status: /** @type {"parsed"} */ ("parsed"),
        parser: PARSER_IDS.image,
        summary: { zh: stored.summary.zh },
        warnings: stored.warnings,
        needsVision: true,
        origin,
        note,
        position: candidate.position,
        width: stored.image.width,
        height: stored.image.height,
        sha256,
      };
    } catch {
      bump("undecodable");
      return undefined;
    }
  }

  async function lane() {
    for (;;) {
      const job = pull();
      if (job === undefined) return;
      if (job === WAIT) {
        await new Promise((resolve) => {
          waiting.add(() => resolve(undefined));
        });
        continue;
      }
      inFlight += 1;
      let entry;
      try {
        entry = await registerOne(job);
      } finally {
        inFlight -= 1;
      }
      results[job.index] = entry;
      if (entry) kept += 1;
    }
  }

  const lanes = Array.from({ length: Math.max(1, pool.maxConcurrent ?? 1) }, lane);
  const done = Promise.all(lanes).then(() => {
    const images = /** @type {EmbeddedImageEntry[]} */ (results.filter(Boolean));
    return { images, createdIds: images.map((entry) => entry.id) };
  });

  return {
    push(more) {
      if (closed || !more.length) return;
      startedAt ??= now();
      candidates.push(...more);
      wakeAll();
    },
    close() {
      closed = true;
      wakeAll();
    },
    done,
  };
}

/**
 * Register a list that is known up front.
 * @param {RegistrationOptions & {candidates: Candidate[]}} input
 */
export function registerCandidates({ candidates, ...options }) {
  const session = openRegistration(options);
  session.push(candidates);
  session.close();
  return session.done;
}
