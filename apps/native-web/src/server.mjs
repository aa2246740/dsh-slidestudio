#!/usr/bin/env node
/**
 * Offline native PPTD shell server.
 * Production path: no Kimi hosts. Serves static UI + local project API.
 *
 *   npm start
 *   node apps/native-web/src/server.mjs
 *   OPEN_SLIDESTUDIO_PROJECT=fixtures/okp-yu7-ppt npm run start -w @open-slidestudio/native-web
 */
import crypto from "node:crypto";
import { assistantVersionArtifacts } from "./assistant-artifacts.mjs";
import { createCommentSubmission, finishCommentSubmission, readCommentSubmissions } from "./comment-submissions.mjs";
import { parse as parseYaml } from "yaml";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { readProjectSessionTrace } from "./session-trace-journal.mjs";
import { buildPdfFromPngs } from "./png-pdf.mjs";
import { AttachmentStore, parseAttachmentBuffer, attachmentPublic, decodeAttachmentUpload as decodeDataUrl } from "./attachments.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
loadRootEnv(ROOT);
const DATA_ROOT = path.resolve(process.env.SLIDESTUDIO_DATA_DIR || ROOT);

// Runtime packages must resolve to ONE copy each: bare `@open-slidestudio/*`
// imports inside the packages always land on node_modules, so loading the
// entry points through packages/ would create a second module instance with
// its own state (pptd-v2's write-lock map is module-level — two instances
// self-deadlock every mutating command). Resolve the node_modules dir and
// import through it; in a pnpm checkout the workspace links realpath back to
// packages/, so dev and packaged installs share one code path.
const nativeRequire = createRequire(import.meta.url);
const runtimeImport = (specifier, rel = "dist/index.js") => {
  for (const base of nativeRequire.resolve.paths(`${specifier}/package.json`) ?? []) {
    const dir = path.join(base, specifier);
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return pathToFileURL(path.join(fs.realpathSync(dir), rel)).href;
    }
  }
  throw new Error(`cannot resolve runtime package ${specifier}`);
};
const PUBLIC = path.resolve(__dirname, "../public");
const PORT = Number(process.env.PORT || 55200);

/** Load gitignored repo-root `.env` into process.env. Never logs values. */
function loadRootEnv(root) {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = val;
    }
  }
}
const DEFAULT_PROJECT = process.env.OPEN_SLIDESTUDIO_PROJECT
  ? path.resolve(process.env.OPEN_SLIDESTUDIO_PROJECT)
  : path.join(ROOT, "fixtures/okp-yu7-ppt");

// One native server owns every browser tab for its live project. AI review
// turns use this short-lived server lock so a second tab cannot replace the
// same page while the DSH agent is performing a whole-page write.
const reviewAiLocks = new Map();
// A review turn waits for the model to settle before it can safely verify or
// restore a snapshot. Keep enough lease headroom for that stop/restore window;
// the browser renews this lease while the turn remains in flight.
const REVIEW_AI_LOCK_TTL_MS = 15 * 60 * 1000;
const REVIEW_AI_LOCK_REL = path.join("_agent", "ai-review-lock.v1.json");

function writeReviewAiGuard(root, lock) {
  const file = path.join(root, REVIEW_AI_LOCK_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({
    version: 1,
    token: lock.token,
    pagePath: lock.pagePath,
    commentId: lock.commentId,
    scope: lock.scope,
    commentRevision: lock.commentRevision,
    pageSha256: lock.pageSha256,
    // Immutable element-scope baseline for the Host's prospective write gate.
    // It allows repeated fixes to selected elements while every proposal is
    // still compared with the exact page the human originally annotated.
    pageBody: lock.pageBody,
    // Cross-page batch: every comment anchor this turn owns. Absent for the
    // single-comment contract, which keeps the legacy shape byte-identical.
    ...(Array.isArray(lock.items) && lock.items.length ? { items: lock.items } : {}),
    // Structural edits need the page-set baseline so sequential writes keep
    // landing after the pages this same turn already inserted.
    ...(Array.isArray(lock.projectPages) && lock.projectPages.length ? { projectPages: lock.projectPages } : {}),
    createdAt: lock.createdAt,
    expiresAt: lock.expiresAt,
  }, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function removeReviewAiGuard(root) {
  fs.rmSync(path.join(root, REVIEW_AI_LOCK_REL), { force: true });
}

function readReviewAiGuardFile(root) {
  try {
    const file = path.join(root, REVIEW_AI_LOCK_REL);
    if (!fs.existsSync(file)) return undefined;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `aiStatus: "running"` and `preparing` submissions are only legal while a
 * live lock owns the project — this process's in-memory lease or another
 * server's unexpired durable guard. A closed tab, a rejected turn, or a
 * server restart strands them forever because finishReviewBatch can no longer
 * find the lock token. Fail them closed so the user can retry; the pre-batch
 * version snapshot already preserves restore semantics.
 */
function reconcileOrphanedAiReviews(native, root) {
  const key = path.resolve(root);
  if (activeReviewAiLock(key)) return false;
  const guard = readReviewAiGuardFile(key);
  if (guard && Number(guard.expiresAt) > Date.now()) return false;
  try {
    return native.pptd.withProjectWriteLock(root, () => {
      // Re-check inside the write lock: a new batch may have acquired the
      // lease between the cheap early-out above and now.
      if (activeReviewAiLock(key)) return false;
      const record = readReviewThreads(root);
      const submissions = readCommentSubmissions(root);
      const preparing = new Set(
        submissions.filter((entry) => entry?.status === "preparing").map((entry) => entry.id),
      );
      const orphanedSubmissionIds = new Set();
      const pages = { ...record.pages };
      let touched = false;
      for (const [pagePath, threads] of Object.entries(pages)) {
        if (!Array.isArray(threads)) continue;
        const next = threads.map((thread) => {
          if (thread?.aiStatus !== "running") return thread;
          const submissionId = nonEmptyString(thread.aiSubmissionId);
          // A running comment with no live lock is orphaned unless its
          // submission already reached a terminal state without it.
          if (submissionId && !preparing.has(submissionId)) return thread;
          if (submissionId) orphanedSubmissionIds.add(submissionId);
          touched = true;
          return {
            ...thread,
            revision: (Number.isInteger(thread.revision) ? thread.revision : 0) + 1,
            aiStatus: "failed",
            aiError: "AI 修改中断（会话或服务已重启），请重新提交",
          };
        });
        pages[pagePath] = next;
      }
      if (touched) {
        const file = path.join(root, REVIEW_THREADS_REL);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temp, `${JSON.stringify({
          ...record,
          revision: record.revision + 1,
          updatedAt: new Date().toISOString(),
          pages,
        }, null, 2)}\n`, "utf8");
        fs.renameSync(temp, file);
        for (const submissionId of orphanedSubmissionIds) {
          finishCommentSubmission(root, submissionId, "failed", "interrupted before the batch finished");
        }
      }
      // A stale expired guard must not keep blocking the Host-side write gate.
      if (guard || touched) removeReviewAiGuard(key);
      return touched;
    });
  } catch {
    return false;
  }
}

function activeReviewAiLock(root) {
  const key = path.resolve(root);
  const lock = reviewAiLocks.get(key);
  if (!lock) return undefined;
  if (lock.expiresAt <= Date.now()) {
    reviewAiLocks.delete(key);
    removeReviewAiGuard(key);
    return undefined;
  }
  return lock;
}

function reviewAiLockByToken(token) {
  const expected = nonEmptyString(token);
  if (!expected) return undefined;
  for (const root of reviewAiLocks.keys()) {
    const lock = activeReviewAiLock(root);
    if (lock?.token === expected) return lock;
  }
  return undefined;
}

/**
 * Extend a live, root-bound AI-review lease and durably mirror the new expiry
 * into the cross-process guard. The guard write is atomic (`renameSync` in
 * writeReviewAiGuard), so a DSH writer cannot observe a partially-written
 * lease while the browser is waiting for the AI turn to stop.
 */
function renewReviewAiLock(token, { writeGuard = writeReviewAiGuard } = {}) {
  const lock = reviewAiLockByToken(token);
  if (!lock) return undefined;
  // Commit the durable guard before mutating the in-memory lease. If the
  // atomic write fails (for example a full/read-only project volume), keeping
  // the old in-memory expiry avoids claiming a renewal other processes cannot
  // observe on disk.
  const next = { ...lock, expiresAt: Date.now() + REVIEW_AI_LOCK_TTL_MS };
  writeGuard(lock.root, next);
  lock.expiresAt = next.expiresAt;
  return lock;
}

function acquireReviewAiLock(
  root,
  { pagePath, commentId, commentRevision, scope, pageSha256, pageBody, deckState, projectPages, items } = {},
) {
  const key = path.resolve(root);
  const current = activeReviewAiLock(key);
  if (current) return { conflict: true, lock: current };
  const lock = {
    token: crypto.randomUUID(),
    // Bind the entire review transaction to the project that was current when
    // the lock was acquired. Live sessions are per project and can otherwise
    // be advanced by another browser tab before verify/restore.
    root: key,
    pagePath: reviewPageKey(pagePath),
    commentId: nonEmptyString(commentId) || undefined,
    commentRevision: Number.isSafeInteger(commentRevision) ? commentRevision : undefined,
    scope: scope && typeof scope === "object" ? structuredClone(scope) : undefined,
    pageSha256: nonEmptyString(pageSha256) || undefined,
    pageBody: pageBody && typeof pageBody === "object" ? structuredClone(pageBody) : undefined,
    items: Array.isArray(items) && items.length ? structuredClone(items) : undefined,
    deckState: deckState && typeof deckState === "object" ? structuredClone(deckState) : undefined,
    projectPages: Array.isArray(projectPages) ? structuredClone(projectPages) : undefined,
    snapshotVersionId: undefined,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + REVIEW_AI_LOCK_TTL_MS,
  };
  writeReviewAiGuard(key, lock);
  reviewAiLocks.set(key, lock);
  return { conflict: false, lock };
}

function releaseReviewAiLock(root, token) {
  const key = path.resolve(root);
  const current = activeReviewAiLock(key);
  if (!current) return { released: true };
  if (!token || token !== current.token) return { released: false, lock: current };
  reviewAiLocks.delete(key);
  removeReviewAiGuard(key);
  return { released: true };
}

const FONTS_CSS = path.join(PUBLIC, "fonts.css");
const FONTS_DIR = path.join(PUBLIC, "fonts");

/**
 * SSOT family → vendored font faces, parsed from the @font-face blocks.
 * Each family maps to an ordered list of { weight, file } entries (css order,
 * weight defaults to 400) so multi-weight families like 思源宋体 can embed
 * regular + bold faces.
 */
function parseFontsCss() {
  const map = new Map();
  let css = "";
  try {
    css = fs.readFileSync(FONTS_CSS, "utf8");
  } catch {
    return map;
  }
  for (const m of css.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
    const block = m[1];
    const fam = /font-family:\s*(?:"([^"]+)"|'([^']+)'|([^;]+))\s*;/.exec(block);
    const src = /src:\s*url\(["']?([^"')]+)["']?\)/.exec(block);
    if (!fam || !src) continue;
    const family = String(fam[1] ?? fam[2] ?? fam[3] ?? "").trim();
    if (!family) continue;
    const weightMatch = /font-weight:\s*(\d+)/.exec(block);
    const weight = weightMatch ? Number(weightMatch[1]) : 400;
    const file = path.resolve(path.dirname(FONTS_CSS), src[1].trim());
    const list = map.get(family) ?? [];
    list.push({ weight, file });
    map.set(family, list);
  }
  return map;
}
const FONT_FAMILIES = parseFontsCss();

async function loadNative() {
  const pptd = await import(runtimeImport("@open-slidestudio/pptd-v2"));
  const canvas = await import(runtimeImport("@open-slidestudio/canvas-session"));
  const exporter = await import(runtimeImport("@open-slidestudio/exporter-native"));
  const store = await import(runtimeImport("@open-slidestudio/project-store"));
  return { pptd, canvas, exporter, store };
}

const ORACLE_CONTROLS = [
  "element.text.content.set",
  "element.text.toolbar.bold.toggle",
  "element.bounds.set",
  "chrome.pages.navigate",
  "chrome.history.undo",
  "chrome.history.redo",
  "chrome.zoom.in",
  "chrome.zoom.out",
  "chrome.pages.rail.toggle",
  "chrome.pages.add",
  "chrome.pages.delete",
  "chrome.pages.duplicate",
  "chrome.pages.reorder",
  "chrome.zoom.percent",
  "chrome.export.open",
  "chrome.export.pptx",
  "chrome.export.pdf",
  "chrome.export.image",
  "chrome.export.embedfonts",
  "chrome.present.play",
  "chrome.present.fullscreen",
  "chrome.notes.toggle",
  "chrome.comments.retry",
  "chrome.comments.resend",
  "chrome.comments.select",
  "chrome.comments.list",
  "insert.text",
  "insert.shape",
  "insert.image",
  "insert.table",
  "insert.chart",
  "insert.line",
  "insert.icon",
  "insert.smartart",
  "selection.tab",
  "element.smartart.node.add",
  "element.smartart.node.delete",
  "element.smartart.layout.set",
  "selection.clear",
  "element.delete",
  "element.duplicate",
  "element.arrange.forward",
  "element.arrange.backward",
  "element.arrange.align.set",
  "element.arrange.distribute.set",
  "element.arrange.flip.set",
  "element.rotate.set",
  "element.opacity.set",
  "element.text.toolbar.italic.toggle",
  "element.text.toolbar.underline.toggle",
  "element.text.toolbar.fontsize.set",
  "element.text.toolbar.fontfamily.set",
  "element.text.toolbar.color.set",
  "element.text.toolbar.align.set",
  "element.shape.fill.set",
  "element.shape.kind.set",
  "element.shape.border.set",
  "element.shape.adjust.set",
  "element.image.crop.set",
  "element.image.mask.set",
  "element.line.curve.set",
  "element.line.points.set",
  "element.line.label.set",
  "element.image.fit.set",
  "element.image.replace",
  "element.icon.color.set",
  "element.icon.name.set",
  "element.line.arrow.set",
  "element.text.toolbar.lineheight.set",
  "element.text.toolbar.letterspacing.set",
  "element.text.toolbar.highlight.set",
  "element.text.toolbar.list.set",
  "element.text.toolbar.link.set",
  "element.chart.legend.set",
  "element.chart.series.color.set",
  "element.table.cell.set",
  "element.table.row.add",
  "element.table.col.add",
  "element.table.row.delete",
  "element.table.col.delete",
  "element.table.merge",
  "element.table.cell.fill.set",
  "element.chart.data.set",
  "element.chart.type.set",
  "element.chart.title.set",
  "theme.background.set",
  "theme.color.set",
  "chrome.keyboard.help",
  "element.lock.toggle",
  "element.visibility.toggle",
  "element.text.toolbar.wrap.set",
  "element.group.set",
  "element.ungroup.set",
  "element.image.rebuild",
  "element.shadow.set",
  "element.table.cell.align.set",
  "element.chart.axis.set",
  "element.chart.labels.set",
  "notes.content.set",
  "chrome.history.versions.open",
  "chrome.history.versions.snapshot",
  "chrome.history.versions.restore",
  "chrome.history.versions.preview",
  "chrome.comment.pin",
  "chrome.createhub.topic.fill",
  "chrome.createhub.submit.generate",
  "chrome.workspace.refine",
  "chrome.workspace.stop",
  "chrome.workspace.toggle",
  // Live-generation chrome. These have oracle rows and markup, so the
  // session allowlist must carry them too; verify-native-editor enforces it.
  "chrome.generation.resume",
  "chrome.generation.stop",
  // Assistant composer and question cards carry data-control so the oracle can
  // find them; they must stay enabled, so the allowlist carries them as well.
  "chrome.workspace.assistant.send",
  "chrome.workspace.assistant.model",
  "chrome.workspace.assistant.question",
  "chrome.comments.targets",
  "contextmenu.open",
];

// Commands in this set change project content and are persisted to PPTD.
// The first one must also establish the immutable pre-edit V1 baseline.
const PROJECT_MUTATING_COMMANDS = new Set([
  "reorderPage",
  "insert",
  "addPage",
  "deletePage",
  "duplicatePage",
  "setText",
  "setRichText",
  "setTextRangeStyle",
  "setBold",
  "setTextStyle",
  "setFill",
  "setShape",
  "setBorder",
  "setRotation",
  "setOpacity",
  "setImageFit",
  "setImageSrc",
  "setIconName",
  "setLineArrow",
  "setAdjustments",
  "setImageCrop",
  "setImageCropShape",
  "setLineCurve",
  "setLineLabel",
  "setLinePoints",
  "setAnimations",
  "setBounds",
  "deleteSelected",
  "duplicateSelected",
  "pasteClipboard",
  "arrange",
  "align",
  "distribute",
  "flip",
  "setTableCell",
  "tableRow",
  "tableCol",
  "tableMerge",
  "tableFill",
  "setChartType",
  "setChartTitle",
  "setChartData",
  "setChartLegend",
  "setChartSeriesFill",
  "smartArtNode",
  "setSmartArtLayout",
  "setBackground",
  "setThemeColor",
  "setLocked",
  "setHidden",
  "group",
  "ungroup",
  "rebuildImage",
  "setShadow",
  "setTableAlign",
  "setChartLabels",
  "setChartAxis",
  "setNotes",
  "setAnimation",
  "undo",
  "redo",
]);

/**
 * One live editor session per resolved project path, so concurrent browsers
 * (or tabs) edit their own project without switching a shared singleton.
 * Disk writes stay serialized per project via withProjectWriteLock; two
 * editors on the SAME project keep last-writer-wins with a disk-revision
 * conflict, same as before.
 * @type {Map<string, { session: import('@open-slidestudio/canvas-session').CanvasSession | null, diskRevision: string | null }>}
 */
const liveSessions = new Map();
/** Legacy fallback for callers that do not name a project. Updated on every resolved request. */
let lastProjectPath = DEFAULT_PROJECT;
/** Last pageIndex per resolved project path (in-memory; survives /api/open reopen). */
const lastPageByProject = new Map();

/**
 * Browser tab identity for session scoping. Two tabs on the SAME project get
 * separate live sessions so selection/undo never cross-contaminate; writes
 * still serialize through the project write lock and disk revision.
 */
function tabIdFor(url, body) {
  const raw = url?.searchParams?.get("tab") ?? body?.tabId ?? null;
  const s = nonEmptyString(raw);
  return s && /^[\w-]{1,64}$/.test(s) ? s : "default";
}

function liveEntryFor(root, tabId = "default") {
  const key = `${path.resolve(root)}\0${tabId}`;
  let entry = liveSessions.get(key);
  if (!entry) {
    entry = { session: null, diskRevision: null, projectRoot: path.resolve(root) };
    liveSessions.set(key, entry);
  }
  return entry;
}

function projectKey(p = lastProjectPath) {
  return path.resolve(p);
}

/**
 * Resolve the project a request acts on. Explicit `?project=` / body.project
 * wins; otherwise fall back to the most recently resolved project so older
 * callers (and health probes) keep working. With `strict`, an explicit hint
 * that does not resolve is a 404 — a mutating command must never silently
 * land on a different project than the client named.
 */
/** controlId is a server-fixed gate label, never client input: derive it from
 * the patch's first recognized key so a client cannot label a mutation as an
 * unrelated oracle control. */
const TEXT_STYLE_CONTROL_BY_KEY = [
  ["bold", "element.text.toolbar.bold.toggle"],
  ["italic", "element.text.toolbar.italic.toggle"],
  ["underline", "element.text.toolbar.underline.toggle"],
  ["fontSize", "element.text.toolbar.fontsize.set"],
  ["fontFamily", "element.text.toolbar.fontfamily.set"],
  ["color", "element.text.toolbar.color.set"],
  ["align", "element.text.toolbar.align.set"],
  ["lineHeight", "element.text.toolbar.lineheight.set"],
  ["letterSpacing", "element.text.toolbar.letterspacing.set"],
  ["highlight", "element.text.toolbar.highlight.set"],
  ["backgroundColor", "element.text.toolbar.highlight.set"],
  ["list", "element.text.toolbar.list.set"],
  ["href", "element.text.toolbar.link.set"],
  ["wrap", "element.text.toolbar.wrap.set"],
];
function textStyleControlId(patch) {
  if (patch && typeof patch === "object") {
    for (const [key, id] of TEXT_STYLE_CONTROL_BY_KEY) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) return id;
    }
  }
  return "element.text.content.set";
}

function projectForRequest(url, body, { strict = false } = {}) {
  const raw = url?.searchParams?.get("project") ?? body?.project ?? null;
  const hint = nonEmptyString(raw);
  if (hint) {
    try {
      const resolved = resolveProjectPath(hint);
      if (fs.existsSync(resolved)) {
        lastProjectPath = resolved;
        return resolved;
      }
    } catch {
      // fall through to strict handling / last known project below
    }
    if (strict) {
      const err = new Error(`project not found: ${hint}`);
      err.statusCode = 404;
      throw err;
    }
  }
  return path.resolve(lastProjectPath);
}

function rememberPage(s, p = lastProjectPath) {
  if (!s || !p) return;
  if (Number.isInteger(s.pageIndex) && s.pageIndex >= 0) {
    lastPageByProject.set(projectKey(p), s.pageIndex);
  }
}

function rememberedPage(p = lastProjectPath) {
  const n = lastPageByProject.get(projectKey(p));
  return Number.isInteger(n) ? n : undefined;
}

function parsePageHint(url, body) {
  const raw = url?.searchParams?.get("page") ?? body?.page ?? body?.pageIndex;
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

function projectDiskRevision(root) {
  const files = [];
  const visit = (dir, rel = "") => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!rel && (name === ".versions" || name === "_agent")) continue;
      const abs = path.join(dir, name);
      const nextRel = rel ? path.join(rel, name) : name;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        files.push({ rel: nextRel, kind: "symlink", bytes: Buffer.from(fs.readlinkSync(abs)) });
      } else if (st.isDirectory()) {
        visit(abs, nextRel);
      } else if (st.isFile() && (name.endsWith(".pptd") || name.endsWith(".page"))) {
        files.push({ rel: nextRel, kind: "file", bytes: fs.readFileSync(abs) });
      }
    }
  };
  visit(root);
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.kind).update("\0").update(file.rel).update("\0").update(file.bytes).update("\0");
  }
  return hash.digest("hex");
}

function openLiveSession(native, dest, pageHint, tabId = "default") {
  return native.pptd.withProjectWriteLock(dest, () => {
    const s = native.canvas.openSession(dest, {
      allowedControlIds: ORACLE_CONTROLS,
      pageIndex: pageHint ?? rememberedPage(dest),
    });
    // Keep the in-memory project and its revision bound to one locked point
    // in time. Otherwise a writer can land after load but before this hash.
    const entry = liveEntryFor(dest, tabId);
    entry.session = s;
    entry.diskRevision = projectDiskRevision(dest);
    rememberPage(s, dest);
    return s;
  });
}

function spinWaitMs(ms) {
  // Portable bounded spin — Atomics.wait is unavailable in some embedders.
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    // intentional bounded spin
  }
}

function waitForPersistBarrier() {
  const barrierDir = process.env.NATIVE_WEB_PERSIST_BARRIER_DIR;
  const arm = barrierDir ? path.join(barrierDir, "arm") : null;
  if (!arm || !fs.existsSync(arm)) return;
  fs.rmSync(arm, { force: true });
  fs.mkdirSync(barrierDir, { recursive: true });
  fs.writeFileSync(path.join(barrierDir, "checked"), "ready\n", "utf8");
  const release = path.join(barrierDir, "release");
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(release)) {
    if (Date.now() >= deadline) throw new Error("persist barrier timed out");
    spinWaitMs(10);
  }
}

/** Test-only fault injection: pause after the pre-restore snapshot while the
 * outer restore transaction still owns the project lock. */
function waitForRestoreBarrier() {
  const barrierDir = process.env.NATIVE_WEB_RESTORE_BARRIER_DIR;
  const arm = barrierDir ? path.join(barrierDir, "arm") : null;
  if (!arm || !fs.existsSync(arm)) return;
  fs.rmSync(arm, { force: true });
  fs.mkdirSync(barrierDir, { recursive: true });
  fs.writeFileSync(path.join(barrierDir, "pre-snapshot"), "ready\n", "utf8");
  const release = path.join(barrierDir, "release");
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(release)) {
    if (Date.now() >= deadline) throw new Error("restore barrier timed out");
    spinWaitMs(10);
  }
}

/** Optimistic-concurrency conflict — the HTTP layer answers 409. */
function conflictError(message) {
  const err = new Error(message);
  err.statusCode = 409;
  return err;
}

/**
 * Persist a session candidate and promote it to the project's live session.
 * `base` is the live session the candidate was cloned from (the /api/command
 * path clones before mutating); when omitted the candidate itself must still
 * be live. All checks and the multi-file persist share the PPTD lock with DSH
 * writers — checking first and saving later leaves a TOCTOU window in which a
 * generated deck can be silently overwritten.
 */
function persistLiveSession(native, s, projectRoot, base = null, tabId = "default") {
  const root = path.resolve(projectRoot ?? lastProjectPath);
  const entry = liveEntryFor(root, tabId);
  const expected = base ?? s;
  if (entry.session && expected !== entry.session) {
    // Another editor committed first: never silently persist a stale clone
    // over it. The caller retries on the fresh session.
    throw conflictError("editor session changed while command was running; retry the edit");
  }
  if (entry.session) {
    return native.pptd.withProjectWriteLock(root, () => {
      const live = liveEntryFor(root, tabId);
      if (live.session !== expected) {
        throw conflictError("editor session changed while command was running; retry the edit");
      }
      if (live.diskRevision) {
        const current = projectDiskRevision(root);
        if (current !== live.diskRevision) {
          openLiveSession(native, root, s.pageIndex, tabId);
          throw conflictError("project changed on disk; editor refreshed the latest revision, retry the edit");
        }
      }
      waitForPersistBarrier();
      native.canvas.persist(s);
      live.session = s;
      live.diskRevision = projectDiskRevision(root);
    });
    return;
  }
  native.canvas.persist(s);
}

/**
 * Preserve the exact project state before its first content edit. Versions are
 * pre-edit restore points; the live draft is represented separately by the UI.
 */
function ensureInitialVersion(native, s, projectRoot, tabId = "default") {
  const root = path.resolve(projectRoot);
  return native.pptd.withProjectWriteLock(root, () => {
    const existing = native.store.listVersions(root);
    if (existing.length) return existing[0];
    // Persist through the caller's own tab session; the default tab may be
    // held by another client and would reject this session as stale.
    persistLiveSession(native, s, root, null, tabId);
    return native.store.snapshotVersion(root, {
      label: "V1",
      note: "baseline:original",
    });
  });
}

/**
 * PPTD files are the project SSOT. Generation may update them through a
 * separate process while this server still has an editor session in memory,
 * so exports must reopen the on-disk revision instead of serialising a stale
 * session object. Page selection remains a UI concern and is carried across.
 */
function openExportSession(native, projectRoot, pageIndex) {
  const root = path.resolve(projectRoot);
  return native.pptd.withProjectWriteLock(root, () => native.canvas.openSession(root, {
    allowedControlIds: [],
    pageIndex,
  }));
}

function readGenerateReason(root) {
  try {
    const file = path.join(root, "generate-reason.json");
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object") return null;
    const think = data.think && typeof data.think === "object" ? data.think : null;
    const plan = data.plan && typeof data.plan === "object" ? data.plan : null;
    const tools = Array.isArray(data.tools)
      ? data.tools
          .filter((t) => t && typeof t === "object")
          .map((t) => ({
            tool: String(t.tool || ""),
            label: String(t.label || t.tool || ""),
            summary: String(t.summary || ""),
            detail: String(t.detail || ""),
          }))
      : [];
    if (!think && !plan && !tools.length) return null;
    return {
      brief: typeof data.brief === "string" ? data.brief : "",
      think: think
        ? { summary: String(think.summary || ""), detail: String(think.detail || "") }
        : null,
      plan: plan
        ? { summary: String(plan.summary || ""), detail: String(plan.detail || "") }
        : null,
      tools,
    };
  } catch {
    return null;
  }
}

function liveModel(native, s, root = s?.project?.rootDir) {
  if (s.project.pages.length === 0) {
    const presentation = s.project.presentation;
    return {
      title: presentation.title ?? "生成中",
      rootDir: s.project.rootDir,
      size: presentation.size ?? [960, 540],
      pageIndex: 0,
      pageCount: 0,
      pagePaths: [],
      backgroundCss: "#ffffff",
      elements: [],
      selection: { kind: "none" },
      canUndo: false,
      canRedo: false,
      allowedControlIds: [],
      zoomPercent: 100,
      pageRailOpen: false,
      notesOpen: false,
      presenting: false,
      notes: "",
      themeColors: presentation.theme?.colors ?? {},
      animations: [],
      generationPlaceholder: true,
    };
  }
  const model = native.canvas.renderModel(s);
  const page = s.project.pages[s.pageIndex]?.page;
  const layoutRoleById = new Map(
    (page?.elements || []).map((element) => [
      element.elementId,
      native.pptd.effectiveLayoutRole(element),
    ]),
  );
  const withLayoutRoles = {
    ...model,
    elements: model.elements.map((element) => ({
      ...element,
      layoutRole: layoutRoleById.get(element.id),
    })),
  };
  const reason = readGenerateReason(root);
  return reason ? { ...withLayoutRoles, reason } : withLayoutRoles;
}

function requireFinite(value, label) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a finite number`);
  return n;
}

function requireInt(value, label) {
  const n = requireFinite(value, label);
  if (!Number.isInteger(n)) throw new Error(`${label} must be an integer`);
  return n;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

/** Read a project-owned JSON artifact without treating a malformed file as an instruction. */
function readProjectRecord(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

const REVIEW_THREADS_REL = path.join("_agent", "review-threads.v1.json");

function reviewPageKey(value) {
  const key = nonEmptyString(value).slice(0, 512);
  if (!key || key.includes("\0")) throw new Error("pagePath required");
  return key;
}

function reviewProjectPath(value) {
  const requested = nonEmptyString(value);
  if (!requested) {
    throw Object.assign(new Error("review project is required so browser tabs cannot share an implicit project"), {
      code: "REVIEW_PROJECT_REQUIRED",
    });
  }
  const root = resolveProjectPath(requested);
  if (!fs.existsSync(root)) {
    throw Object.assign(new Error(`review project not found: ${root}`), { code: "REVIEW_PROJECT_NOT_FOUND" });
  }
  return root;
}

function reviewCommentRevision(value, fallback = 1) {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 1 ? revision : fallback;
}

function reviewElementIds(value, legacyElementId) {
  const source = Array.isArray(value) ? value : legacyElementId ? [legacyElementId] : [];
  const ids = [...new Set(source.map(nonEmptyString).filter(Boolean))];
  if (ids.length > 100) throw new Error("review scope supports at most 100 elements");
  return ids;
}

function sanitizeReviewScope(raw, legacyElementId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const kind = raw.kind === "page" ? "page" : raw.kind === "elements" ? "elements" : undefined;
  if (!kind) return undefined;
  const elementIds = reviewElementIds(raw.elementIds, legacyElementId);
  return {
    kind,
    pageId: nonEmptyString(raw.pageId),
    elementIds: kind === "elements" ? elementIds : [],
    pageRevision: Number.isSafeInteger(raw.pageRevision) && raw.pageRevision >= 1
      ? raw.pageRevision
      : null,
    pageSha256: nonEmptyString(raw.pageSha256).toLowerCase(),
    capturedAt: nonEmptyString(raw.capturedAt) || undefined,
  };
}

function captureReviewScope(snapshot, rawScope, legacyElementId) {
  if (!rawScope || typeof rawScope !== "object" || Array.isArray(rawScope)) {
    throw Object.assign(new Error("review scope must explicitly be elements or page"), {
      code: "REVIEW_SCOPE_REQUIRED",
    });
  }
  const kind = rawScope.kind;
  if (kind !== "elements" && kind !== "page") {
    throw Object.assign(new Error("review scope kind must be elements or page"), {
      code: "REVIEW_SCOPE_REQUIRED",
    });
  }
  const elementIds = reviewElementIds(rawScope.elementIds, legacyElementId);
  if (kind === "elements" && elementIds.length === 0) {
    throw Object.assign(new Error("element review scope requires at least one elementId"), {
      code: "REVIEW_SCOPE_REQUIRED",
    });
  }
  if (kind === "page" && elementIds.length) {
    throw Object.assign(new Error("page review scope cannot include elementIds"), {
      code: "REVIEW_SCOPE_INVALID",
    });
  }
  const requestedPageId = nonEmptyString(rawScope.pageId);
  if (requestedPageId && requestedPageId !== snapshot.pageId) {
    throw Object.assign(new Error("review scope pageId does not match pagePath"), {
      code: "REVIEW_SCOPE_INVALID",
    });
  }
  const present = new Set(snapshot.pageBody.elements?.map((element) => nonEmptyString(element?.elementId)) ?? []);
  const missingElementIds = elementIds.filter((id) => !present.has(id));
  if (missingElementIds.length) {
    throw Object.assign(new Error(`review target elements no longer exist: ${missingElementIds.join(", ")}; select the current elements and create a new review comment`), {
      code: "REVIEW_TARGET_MISSING",
      missingElementIds,
    });
  }
  return {
    kind,
    pageId: snapshot.pageId,
    elementIds: kind === "elements" ? elementIds : [],
    pageRevision: snapshot.pageRevision ?? null,
    pageSha256: snapshot.pageSha256,
    capturedAt: new Date().toISOString(),
  };
}

function captureWorkspaceEditScope(snapshot, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw Object.assign(new Error("workspaceEdit must be an object"), { code: "WORKSPACE_EDIT_SCOPE_REQUIRED" });
  }
  const authorizationId = nonEmptyString(raw.authorizationId);
  const kind = raw.kind;
  if (!authorizationId || !["elements", "page", "pages", "deck"].includes(kind)) {
    throw Object.assign(new Error("workspaceEdit requires authorizationId and an explicit elements, page, pages, or deck kind"), {
      code: "WORKSPACE_EDIT_SCOPE_REQUIRED",
    });
  }
  if (nonEmptyString(raw.pageId) !== snapshot.pageId) {
    throw Object.assign(new Error("workspaceEdit pageId must match pagePath"), {
      code: "WORKSPACE_EDIT_SCOPE_INVALID",
    });
  }
  const pages = Array.isArray(raw.targetPages) ? raw.targetPages : [];
  const target = pages.find((page) => nonEmptyString(page?.pageId) === snapshot.pageId);
  if (!target || Number(target.revision) !== snapshot.pageRevision ||
    nonEmptyString(target.pageSha256).toLowerCase() !== snapshot.pageSha256) {
    throw Object.assign(new Error("workspace edit page changed before its lock was acquired"), {
      code: "WORKSPACE_EDIT_SCOPE_STALE",
    });
  }
  const elementIds = reviewElementIds(raw.elementIds);
  if (kind === "elements" && elementIds.length === 0) {
    throw Object.assign(new Error("element workspace edit requires at least one elementId"), {
      code: "WORKSPACE_EDIT_SCOPE_REQUIRED",
    });
  }
  if (kind !== "elements" && elementIds.length) {
    throw Object.assign(new Error("non-element workspace edits cannot include elementIds"), {
      code: "WORKSPACE_EDIT_SCOPE_INVALID",
    });
  }
  // A structural edit rides on the deck baseline: every existing page is
  // hash-locked while the page list itself may grow at insertIndex.
  const structureOnly = raw.structureOnly === true;
  if (structureOnly && kind !== "deck") {
    throw Object.assign(new Error("structureOnly workspace edits require the deck kind"), {
      code: "WORKSPACE_EDIT_SCOPE_INVALID",
    });
  }
  // A full rewrite is the strongest lock: a plain deck scope whose turn is
  // judged against the newly committed plan instead of the frozen baseline.
  // It never mixes with structural fields — the plan decides the page list.
  const rewrite = raw.rewrite === true;
  if (rewrite && (structureOnly || kind !== "deck" || raw.insertIndex !== undefined && raw.insertIndex !== null ||
      raw.editablePageIds !== undefined || raw.deletablePageIds !== undefined ||
      raw.reorderPageIds !== undefined || raw.expectedAddCount !== undefined)) {
    throw Object.assign(new Error("a rewrite workspace edit is a plain deck lock without structural fields"), {
      code: "WORKSPACE_EDIT_SCOPE_INVALID",
    });
  }
  // A structural lock may also whitelist baseline pages for content edits and
  // a delete list for removals. Anything outside those lists stays frozen.
  const baselineIds = new Set(pages.map((page) => nonEmptyString(page?.pageId)).filter(Boolean));
  let editablePageIds;
  if (raw.editablePageIds !== undefined) {
    if (!structureOnly || !Array.isArray(raw.editablePageIds) ||
        raw.editablePageIds.some((id) => typeof id !== "string" || !id.trim() || !baselineIds.has(id.trim()))) {
      throw Object.assign(new Error("editablePageIds must be a subset of the deck's existing pages"), {
        code: "WORKSPACE_EDIT_SCOPE_INVALID",
      });
    }
    editablePageIds = [...new Set(raw.editablePageIds.map((id) => id.trim()))];
  }
  let deletablePageIds;
  if (raw.deletablePageIds !== undefined) {
    if (!structureOnly || !Array.isArray(raw.deletablePageIds) ||
        raw.deletablePageIds.some((id) => typeof id !== "string" || !id.trim() || !baselineIds.has(id.trim()))) {
      throw Object.assign(new Error("deletablePageIds must be a subset of the deck's existing pages"), {
        code: "WORKSPACE_EDIT_SCOPE_INVALID",
      });
    }
    deletablePageIds = [...new Set(raw.deletablePageIds.map((id) => id.trim()))];
  }
  if (deletablePageIds?.some((id) => editablePageIds?.includes(id))) {
    throw Object.assign(new Error("a page cannot be both editable and deletable"), {
      code: "WORKSPACE_EDIT_SCOPE_INVALID",
    });
  }
  // reorderPageIds is the desired final manifest order — a permutation of the
  // baseline page ids that differs from the current one. It changes nothing
  // but order, and never mixes with add/remove in one turn.
  let reorderPageIds;
  if (raw.reorderPageIds !== undefined) {
    const baselineOrder = pages.map((page) => nonEmptyString(page?.pageId)).filter(Boolean);
    const sameSet = Array.isArray(raw.reorderPageIds) &&
      raw.reorderPageIds.length === baselineOrder.length &&
      raw.reorderPageIds.every((id) => typeof id === "string" && baselineIds.has(id)) &&
      new Set(raw.reorderPageIds).size === baselineOrder.length;
    if (!structureOnly || !sameSet ||
        raw.reorderPageIds.every((id, index) => id === baselineOrder[index])) {
      throw Object.assign(new Error("reorderPageIds must be a changed permutation of the deck's existing pages"), {
        code: "WORKSPACE_EDIT_SCOPE_INVALID",
      });
    }
    reorderPageIds = raw.reorderPageIds.map((id) => id.trim());
  }
  if (reorderPageIds && (deletablePageIds?.length || raw.insertIndex !== undefined && raw.insertIndex !== null)) {
    throw Object.assign(new Error("a reorder lock cannot also add or remove pages"), {
      code: "WORKSPACE_EDIT_SCOPE_INVALID",
    });
  }
  const insertIndex = structureOnly && raw.insertIndex !== undefined && raw.insertIndex !== null
    ? Number(raw.insertIndex) : undefined;
  if (structureOnly && insertIndex === undefined && !deletablePageIds?.length && !reorderPageIds?.length) {
    throw Object.assign(new Error("structural workspace edits need an insertIndex, deletablePageIds or reorderPageIds"), {
      code: "WORKSPACE_EDIT_SCOPE_INVALID",
    });
  }
  if (insertIndex !== undefined && (!Number.isSafeInteger(insertIndex) || insertIndex < 0 || insertIndex > pages.length)) {
    throw Object.assign(new Error("workspace edit insertIndex is outside the current deck"), {
      code: "WORKSPACE_EDIT_SCOPE_INVALID",
    });
  }
  let expectedAddCount;
  if (raw.expectedAddCount !== undefined && raw.expectedAddCount !== null) {
    if (!structureOnly || !Number.isSafeInteger(Number(raw.expectedAddCount)) ||
        Number(raw.expectedAddCount) < 1 || Number(raw.expectedAddCount) > 99) {
      throw Object.assign(new Error("expectedAddCount must be a positive integer"), {
        code: "WORKSPACE_EDIT_SCOPE_INVALID",
      });
    }
    expectedAddCount = Number(raw.expectedAddCount);
  }
  let editableMeta;
  if (raw.editableMeta !== undefined && raw.editableMeta !== null) {
    if (!Array.isArray(raw.editableMeta) ||
        raw.editableMeta.some((field) => field !== "title" && field !== "theme")) {
      throw Object.assign(new Error("editableMeta must be a subset of [\"title\", \"theme\"]"), {
        code: "WORKSPACE_EDIT_SCOPE_INVALID",
      });
    }
    editableMeta = [...new Set(raw.editableMeta)];
  }
  // A meta-only lock is the least privilege for a deck-metadata request: it
  // anchors on a page like any page lock but freezes every page — only the
  // whitelisted deck fields may move. Without it a title request would need
  // a page edit grant the user never asked for.
  const metaOnly = raw.metaOnly === true;
  if (metaOnly && (kind !== "page" || !editableMeta?.length || structureOnly || rewrite)) {
    throw Object.assign(new Error("a metaOnly workspace edit is a page-kind lock carrying editableMeta and no structural fields"), {
      code: "WORKSPACE_EDIT_SCOPE_INVALID",
    });
  }
  const present = new Set(snapshot.pageBody.elements?.map((element) => nonEmptyString(element?.elementId)) ?? []);
  const missingElementIds = elementIds.filter((id) => !present.has(id));
  if (missingElementIds.length) {
    throw Object.assign(new Error(`workspace edit target elements no longer exist: ${missingElementIds.join(", ")}`), {
      code: "WORKSPACE_EDIT_TARGET_MISSING",
      missingElementIds,
    });
  }
  return {
    kind,
    authorizationId,
    pageId: snapshot.pageId,
    elementIds,
    targetPageIds: pages.map((page) => nonEmptyString(page?.pageId)).filter(Boolean),
    ...(rewrite ? { rewrite: true } : {}),
    ...(metaOnly ? { metaOnly: true } : {}),
    ...(editableMeta?.length ? { editableMeta } : {}),
    ...(structureOnly ? { structureOnly: true, ...(insertIndex !== undefined ? { insertIndex } : {}),
      ...(editablePageIds?.length ? { editablePageIds } : {}),
      ...(deletablePageIds?.length ? { deletablePageIds } : {}),
      ...(reorderPageIds?.length ? { reorderPageIds } : {}),
      ...(expectedAddCount ? { expectedAddCount } : {}) } : {}),
    backgroundColorOverride: kind !== "elements" && workspaceEditRequestsBackgroundColor(raw.requestText),
    pageRevision: snapshot.pageRevision,
    pageSha256: snapshot.pageSha256,
    capturedAt: new Date().toISOString(),
  };
}

function workspaceEditRequestsBackgroundColor(rawText) {
  const text = nonEmptyString(rawText).replace(/\s+/g, "");
  if (!text) return false;
  const hasPositiveMatch = (pattern, source) => {
    let match;
    while ((match = pattern.exec(source))) {
      const prefix = source.slice(Math.max(0, match.index - 10), match.index);
      if (!/(?:(?:不要|别|不用|无需|不必)(?:把|将|只)?(?:修改|改|调整|换)?|不修改|不改)$/.test(prefix)) return true;
    }
    return false;
  };
  if (hasPositiveMatch(/背景(?:色|颜色)/g, text)) return true;
  const withoutBackgroundImages = text.replace(/背景(?:图|图片|照片)/g, "");
  return hasPositiveMatch(/(?:修改|更换|换|改|调整|统一|设置)[^，。；]{0,24}背景|背景[^，。；]{0,24}(?:修改|更换|换|改|调整|统一|设置)/gi, withoutBackgroundImages);
}

function sameReviewScopeIdentity(left, right) {
  return left?.kind === right?.kind &&
    left?.pageId === right?.pageId &&
    JSON.stringify(left?.elementIds ?? []) === JSON.stringify(right?.elementIds ?? []);
}

function sanitizeReviewThread(raw, pagePath) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const finiteOr = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  const createdAt = nonEmptyString(source.createdAt) || new Date().toISOString();
  const scope = sanitizeReviewScope(source.scope, source.elementId);
  return {
    id: nonEmptyString(source.id) || crypto.randomUUID(),
    pagePath,
    scope,
    // Compatibility alias for the old one-element pin renderer. New callers
    // must use scope.elementIds so a multi-selection cannot be truncated.
    elementId: scope?.kind === "elements" ? scope.elementIds[0] : nonEmptyString(source.elementId) || undefined,
    x: Math.max(0, Math.min(1, finiteOr(source.x))),
    y: Math.max(0, Math.min(1, finiteOr(source.y))),
    ox: source.ox == null ? undefined : finiteOr(source.ox),
    oy: source.oy == null ? undefined : finiteOr(source.oy),
    text: String(source.text || "").slice(0, 10_000),
    author: nonEmptyString(source.author) || "我",
    createdAt,
    updatedAt: nonEmptyString(source.updatedAt) || new Date().toISOString(),
    // Legacy review-thread files did not carry a per-comment revision. Treat
    // them as revision 1 so the first current client can update them through
    // the same optimistic-concurrency contract as newly created comments.
    revision: reviewCommentRevision(source.revision),
    resolved: Boolean(source.resolved),
    aiStatus: ["idle", "running", "applied", "failed", "needs-review"].includes(source.aiStatus)
      ? source.aiStatus
      : "idle",
    // A structural turn removed this comment's page; the thread stays
    // readable in history but is no longer actionable.
    pageGone: Boolean(source.pageGone),
    aiSubmissionId: nonEmptyString(source.aiSubmissionId) || undefined,
    aiAppliedAt: nonEmptyString(source.aiAppliedAt) || undefined,
    aiError: String(source.aiError || "").slice(0, 2_000) || undefined,
  };
}

function readReviewThreads(root) {
  const record = readProjectRecord(path.join(root, REVIEW_THREADS_REL));
  const pages = record.pages && typeof record.pages === "object" && !Array.isArray(record.pages)
    ? record.pages
    : {};
  const revision = Number.isInteger(record.revision) && record.revision >= 0 ? record.revision : 0;
  return { version: 1, revision, updatedAt: nonEmptyString(record.updatedAt) || undefined, pages };
}

function markReviewThreadsPageGone(root, pagePaths) {
  const wanted = new Set([...pagePaths].filter((entry) => nonEmptyString(entry)));
  if (!wanted.size) return;
  const record = readReviewThreads(root);
  let touched = false;
  const pages = { ...record.pages };
  for (const pagePath of wanted) {
    const threads = Array.isArray(pages[pagePath]) ? pages[pagePath] : [];
    const marked = threads.map((thread) => ({ ...thread, pageGone: true }));
    if (threads.length) {
      pages[pagePath] = marked;
      touched = true;
    }
  }
  if (!touched) return;
  const next = { ...record, revision: record.revision + 1, updatedAt: new Date().toISOString(), pages };
  const file = path.join(root, REVIEW_THREADS_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function findReviewThread(root, pagePath, commentId) {
  const id = nonEmptyString(commentId);
  if (!id) return undefined;
  const record = readReviewThreads(root);
  const raw = Array.isArray(record.pages[pagePath])
    ? record.pages[pagePath].find((entry) => entry?.id === id)
    : undefined;
  return raw ? sanitizeReviewThread(raw, pagePath) : undefined;
}

function assertReviewScopeCurrent(scope, snapshot) {
  if (!scope) {
    throw Object.assign(new Error("review comment has no durable scope"), { code: "REVIEW_SCOPE_REQUIRED" });
  }
  if (scope.pageId !== snapshot.pageId) {
    throw Object.assign(new Error("review target page identity changed; select the current page and create a new review comment"), { code: "REVIEW_SCOPE_STALE" });
  }
  const present = new Set(snapshot.pageBody.elements?.map((element) => nonEmptyString(element?.elementId)) ?? []);
  const missingElementIds = scope.elementIds.filter((id) => !present.has(id));
  if (missingElementIds.length) {
    throw Object.assign(new Error(`review target elements were deleted: ${missingElementIds.join(", ")}; select the current elements and create a new review comment`), {
      code: "REVIEW_TARGET_MISSING",
      missingElementIds,
    });
  }
  if (scope.pageSha256 !== snapshot.pageSha256 || (
    scope.pageRevision != null && scope.pageRevision !== snapshot.pageRevision
  )) {
    throw Object.assign(new Error("review target page changed after this comment was created; select the current elements and create a new review comment"), {
      code: "REVIEW_SCOPE_STALE",
      expected: { pageRevision: scope.pageRevision, pageSha256: scope.pageSha256 },
      actual: { pageRevision: snapshot.pageRevision, pageSha256: snapshot.pageSha256 },
    });
  }
}

function upsertReviewThread(native, root, pagePath, rawComment, options = {}) {
  return native.pptd.withProjectWriteLock(root, () => {
    const record = readReviewThreads(root);
    const current = Array.isArray(record.pages[pagePath]) ? record.pages[pagePath] : [];
    const incomingId = nonEmptyString(rawComment?.id);
    const previousIndex = incomingId ? current.findIndex((entry) => entry?.id === incomingId) : -1;
    const previous = previousIndex >= 0
      ? sanitizeReviewThread(current[previousIndex], pagePath)
      : undefined;
    const expectedRevision = Number(rawComment?.revision);

    // An existing thread must carry the revision last read by the caller. A
    // missing field is deliberately not treated as "latest": old browser
    // tabs must refresh instead of silently overwriting another user's edit.
    if (previous && (!Number.isInteger(expectedRevision) || expectedRevision < 1 || expectedRevision !== previous.revision)) {
      return {
        conflict: true,
        comment: previous,
        revision: record.revision,
      };
    }
    const requestedScope = sanitizeReviewScope(rawComment?.scope, rawComment?.elementId);
    const scope = options.scope ?? previous?.scope ?? requestedScope;
    if (
      !options.allowScopeChange &&
      previous?.scope && requestedScope &&
      !sameReviewScopeIdentity(previous.scope, requestedScope)
    ) {
      return { conflict: true, code: "REVIEW_SCOPE_IMMUTABLE", comment: previous, revision: record.revision };
    }
    if (rawComment?.aiStatus === "applied" && previous?.aiStatus !== "applied" && !options.allowApplied) {
      return { conflict: true, code: "REVIEW_AI_STATUS_SERVER_OWNED", comment: previous, revision: record.revision };
    }
    const comment = sanitizeReviewThread({
      ...rawComment,
      scope,
      createdAt: nonEmptyString(rawComment?.createdAt) || previous?.createdAt,
      revision: previous ? previous.revision + 1 : 1,
    }, pagePath);
    const merged = previousIndex >= 0
      ? current.map((entry, index) => index === previousIndex ? comment : entry)
      : [...current, comment];
    const next = {
      version: 1,
      revision: record.revision + 1,
      updatedAt: new Date().toISOString(),
      pages: {
        ...record.pages,
        [pagePath]: merged.slice(-200),
      },
    };
    const file = path.join(root, REVIEW_THREADS_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(temp, file);
    return { conflict: false, comment, revision: next.revision };
  });
}

/**
 * The ordered page ids of the newest `todo.committed` ledger fact — the plan
 * a rewrite turn is verified against. `sinceIso` excludes plans committed
 * before this turn's lock: the rewrite must have planned during its own turn,
 * not coast on a stale generation plan.
 */
function latestCommittedPlanPageIds(root, sinceIso) {
  const file = path.join(root, "_agent", "run-ledger.v1.json");
  if (!fs.existsSync(file)) return undefined;
  try {
    const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
    const fact = [...(Array.isArray(ledger?.facts) ? ledger.facts : [])]
      .reverse()
      .find((entry) => entry?.type === "todo.committed");
    if (!fact) return undefined;
    if (sinceIso && !(Date.parse(String(fact.at || "")) >= Date.parse(sinceIso))) return undefined;
    const ids = Array.isArray(fact.pageIds) && fact.pageIds.length
      ? fact.pageIds
      : (Array.isArray(fact.pagePlan) ? fact.pagePlan.map((item) => item?.pageId) : []);
    const normalized = ids.map((id) => nonEmptyString(id)).filter(Boolean);
    return normalized.length ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function projectPageSnapshotWithinLock(native, root, pagePath, presentation) {
  const project = native.pptd.loadProject(root);
  const page = project.pages.find((entry) => entry.path === pagePath);
  if (!page) throw Object.assign(new Error(`page not found: ${pagePath}`), { code: "REVIEW_PAGE_NOT_FOUND" });
  const pageId = path.basename(pagePath, ".page");
  const pageBody = structuredClone(page.page);
  const canonicalPage = { id: pageId, ...pageBody };
  const pageSha256 = presentation.stableSha256(canonicalPage);
  const ledgerRevision = presentation.currentPageRevision(root, pageId);
  const deckState = {
    title: project.presentation.title ?? "",
    theme: structuredClone(project.presentation.theme ?? {}),
    pageOrder: project.pages.map((entry) => entry.path),
  };
  return {
    pageId,
    pageRevision: ledgerRevision?.pageSha256 === pageSha256 ? ledgerRevision.revision : null,
    pageBody,
    canonicalPage,
    pageSha256,
    deckState,
    stableSha256: presentation.stableSha256,
  };
}

async function projectPageSnapshot(native, root, pagePath) {
  const presentation = await import(
    runtimeImport("@open-slidestudio/presentation-run")
  );
  return native.pptd.withProjectWriteLock(root, () =>
    projectPageSnapshotWithinLock(native, root, pagePath, presentation));
}

async function projectVerificationSnapshot(native, root, pagePath, { allowMissingPage = false } = {}) {
  const presentation = await import(
    runtimeImport("@open-slidestudio/presentation-run")
  );
  return native.pptd.withProjectWriteLock(root, () => {
    const project = native.pptd.loadProject(root);
    let page;
    try {
      page = projectPageSnapshotWithinLock(native, root, pagePath, presentation);
    } catch (error) {
      // A page-list lock may legitimately delete the anchor page — the verify
      // judges manifest facts, not the anchor's body.
      if (!allowMissingPage || error?.code !== "REVIEW_PAGE_NOT_FOUND") throw error;
      page = {
        pageId: path.basename(pagePath, ".page"),
        pageRevision: null,
        pageBody: {},
        canonicalPage: null,
        pageSha256: "",
        deckState: {
          title: project.presentation.title ?? "",
          theme: structuredClone(project.presentation.theme ?? {}),
          pageOrder: project.pages.map((entry) => entry.path),
        },
        stableSha256: presentation.stableSha256,
      };
    }
    const pages = project.pages.map((entry) => {
      const pageId = path.basename(entry.path, ".page");
      return {
        pageId,
        pagePath: entry.path,
        pageSha256: presentation.stableSha256({ id: pageId, ...entry.page }),
      };
    });
    return { page, pages };
  });
}

async function acquireCurrentCommentReviewLock(native, root, pagePath, comment, expectedPageSha256) {
  const presentation = await import(
    runtimeImport("@open-slidestudio/presentation-run")
  );
  return native.pptd.withProjectWriteLock(root, () => {
    const currentPage = projectPageSnapshotWithinLock(native, root, pagePath, presentation);
    if (currentPage.pageSha256 !== expectedPageSha256) {
      throw Object.assign(new Error("review target page changed while acquiring its Agent lock"), {
        code: "REVIEW_SCOPE_STALE",
        expected: { pageSha256: expectedPageSha256 },
        actual: { pageSha256: currentPage.pageSha256 },
      });
    }
    // Repeat the durable comment-scope check inside the same project lock that
    // records the human-edited page and creates the AI guard. An old comment
    // therefore cannot be refreshed across a page change, while a new comment
    // on the current page receives an authoritative ledger revision.
    assertReviewScopeCurrent(comment.scope, currentPage);
    let pageRevision = currentPage.pageRevision;
    if (pageRevision == null) {
      const inspection = presentation.inspectRunLedger(root);
      const contextEpochId = nonEmptyString(inspection.contextEpochId);
      if (inspection.initialized && !contextEpochId) {
        throw Object.assign(new Error("current editor page has no active generation ledger revision"), {
          code: "REVIEW_PAGE_REVISION_MISSING",
        });
      }
      // Standalone native-editor fixtures can have no generation ledger. They
      // may still use review storage/snapshots, but the browser will refuse to
      // dispatch an Agent turn until a positive revision is returned.
      if (inspection.initialized) {
        const recorded = presentation.recordPageRevision(
          root,
          {
            contextEpochId,
            commandId: `editor-review:${comment.id}`,
          },
          currentPage.pageId,
          currentPage.canonicalPage,
        );
        pageRevision = recorded.revision;
      }
    }
    const lockScope = {
      ...comment.scope,
      pageRevision,
      pageSha256: currentPage.pageSha256,
      capturedAt: new Date().toISOString(),
    };
    const acquired = acquireReviewAiLock(root, {
      pagePath,
      commentId: comment.id,
      commentRevision: comment.revision,
      scope: lockScope,
      pageSha256: currentPage.pageSha256,
      pageBody: currentPage.pageBody,
      deckState: currentPage.deckState,
    });
    return { currentPage: { ...currentPage, pageRevision }, lockScope, acquired };
  });
}

const REVIEW_BATCH_MAX_ITEMS = 50;

function normalizeReviewBatchItems(rawItems) {
  const seen = new Set();
  const items = [];
  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    const pagePath = nonEmptyString(raw?.pagePath) ? reviewPageKey(raw.pagePath) : "";
    const commentId = nonEmptyString(raw?.commentId);
    if (!pagePath || !commentId) continue;
    const identity = `${pagePath}\u0000${commentId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    items.push({ pagePath, commentId, commentRevision: Number(raw?.commentRevision) });
  }
  return items;
}

/**
 * Read-only validation of a whole comment batch inside one project write lock.
 * Every item must still exist, still match its revision and still point at
 * current page content; nothing is mutated here, which is what makes a stale
 * item refuse the batch before any thread is marked running.
 */
function validateReviewBatchItems(native, root, items, presentation) {
  return native.pptd.withProjectWriteLock(root, () => {
    const snapshots = new Map();
    const prepared = [];
    const stale = [];
    for (const item of items) {
      let snapshot = snapshots.get(item.pagePath);
      if (!snapshot) {
        snapshot = projectPageSnapshotWithinLock(native, root, item.pagePath, presentation);
        snapshots.set(item.pagePath, snapshot);
      }
      const comment = findReviewThread(root, item.pagePath, item.commentId);
      if (!comment) {
        stale.push({ pagePath: item.pagePath, commentId: item.commentId, reason: "REVIEW_COMMENT_NOT_FOUND" });
        continue;
      }
      if (Number(item.commentRevision) !== comment.revision) {
        stale.push({ pagePath: item.pagePath, commentId: item.commentId, reason: "REVIEW_COMMENT_CONFLICT" });
        continue;
      }
      try {
        assertReviewScopeCurrent(comment.scope, snapshot);
      } catch (error) {
        stale.push({
          pagePath: item.pagePath,
          commentId: item.commentId,
          reason: error?.code || "REVIEW_SCOPE_STALE",
        });
        continue;
      }
      prepared.push({
        pagePath: item.pagePath,
        comment,
        scope: comment.scope,
        pageBody: snapshot.pageBody,
        pageSha256: snapshot.pageSha256,
        pageRevision: snapshot.pageRevision,
      });
    }
    return { prepared, stale };
  });
}

/**
 * Acquire the project-level review lock for a cross-page comment batch.
 * All-or-nothing: a single stale item refuses the whole batch and leaves every
 * thread untouched.
 */
async function startReviewBatch(native, root, rawItems, brief = "") {
  const items = normalizeReviewBatchItems(rawItems);
  if (!items.length) return { error: "items must contain at least one pagePath + commentId" };
  if (items.length > REVIEW_BATCH_MAX_ITEMS) {
    return { error: `items must not exceed ${REVIEW_BATCH_MAX_ITEMS} comments` };
  }
  const presentation = await import(
    runtimeImport("@open-slidestudio/presentation-run")
  );
  const first = await validateReviewBatchItems(native, root, items, presentation);
  if (first.stale.length) return { conflict: false, stale: first.stale };
  const head = first.prepared[0];
  const preparedHead = await acquireCurrentCommentReviewLock(
    native,
    root,
    head.pagePath,
    head.comment,
    head.pageSha256,
  );
  if (preparedHead.acquired?.conflict) {
    return { conflict: true, lock: preparedHead.acquired.lock };
  }
  // Re-validate inside the acquired lock so the batch is still coherent at the
  // moment the threads become running.
  const recheck = await validateReviewBatchItems(native, root, items, presentation);
  if (recheck.stale.length) {
    releaseReviewAiLock(root, preparedHead.acquired.lock.token);
    return { conflict: false, stale: recheck.stale };
  }
  const lock = preparedHead.acquired.lock;
  // Any page manually edited since the last AI turn needs a current ledger
  // revision, not only the head comment's page. Promote all locked baselines.
  const inspection = presentation.inspectRunLedger(root);
  for (const entry of recheck.prepared) {
    if (entry.pageRevision == null && inspection.initialized) {
      const contextEpochId = nonEmptyString(inspection.contextEpochId);
      if (!contextEpochId) {
        releaseReviewAiLock(root, lock.token);
        throw Object.assign(new Error("current editor page has no active generation ledger revision"), { code: "REVIEW_PAGE_REVISION_MISSING" });
      }
      const recorded = presentation.recordPageRevision(root, {
        contextEpochId, commandId: `editor-review:${entry.comment.id}`,
      }, entry.scope.pageId, { id: entry.scope.pageId, ...entry.pageBody });
      for (const sibling of recheck.prepared.filter(item => item.pagePath === entry.pagePath)) sibling.pageRevision = recorded.revision;
    }
    entry.scope = { ...entry.scope, pageRevision: entry.pageRevision, pageSha256: entry.pageSha256 };
  }
  lock.items = recheck.prepared.map((entry) => ({
    pagePath: entry.pagePath,
    commentId: entry.comment.id,
    commentRevision: entry.comment.revision,
    scope: entry.scope,
    pageSha256: entry.pageSha256,
    pageRevision: entry.pageRevision,
    pageBody: entry.pageBody,
  }));
  const baselineProject = native.pptd.loadProject(root);
  lock.projectPages = baselineProject.pages.map((entry) => ({
    pageId: path.basename(entry.path, ".page"),
    pagePath: entry.path,
    pageSha256: presentation.stableSha256({ id: path.basename(entry.path, ".page"), ...entry.page }),
  }));
  const submission = createCommentSubmission(root, recheck.prepared, brief);
  lock.submissionId = submission.id;
  writeReviewAiGuard(root, lock);
  for (const entry of recheck.prepared) {
    upsertReviewThread(native, root, entry.pagePath, {
      ...entry.comment,
      revision: entry.comment.revision,
      aiStatus: "running",
      aiSubmissionId: submission.id,
      aiError: undefined,
    }, { scope: entry.scope });
  }
  return {
    ok: true,
    token: lock.token,
    expiresAt: lock.expiresAt,
    submission,
    items: lock.items.map(({ pagePath, commentId, commentRevision, pageRevision, pageSha256, scope }) => ({
      pagePath,
      // The client builds the Host authorization from the locked (verified)
      // values only, never from its own copy of the thread.
      pageId: String(pagePath).split("/").pop().replace(/\.page$/i, ""),
      kind: scope?.kind === "elements" ? "elements" : "page",
      elementIds: Array.isArray(scope?.elementIds) ? [...scope.elementIds] : [],
      commentId,
      commentRevision,
      pageRevision,
      pageSha256,
    })),
  };
}

/** Check actual document deltas for each comment before acknowledging a batch. */
function verifyReviewBatch(native, root, lock, presentation) {
  const project = native.pptd.loadProject(root);
  const hash = presentation.stableSha256;
  const targets = presentation.reviewWriteTargets(lock);
  const currentById = new Map(project.pages.map(entry => [path.basename(entry.path, ".page"), entry]));
  const beforeById = new Map((lock.projectPages || []).map(entry => [entry.pageId, entry]));
  const targetIds = new Set(targets.map(target => target.scope.pageId));
  const changedOutsideTargetPageIds = [...new Set([...beforeById.keys(), ...currentById.keys()])].filter(id =>
    !targetIds.has(id) && beforeById.get(id)?.pageSha256 !== (currentById.has(id) ? hash({ id, ...currentById.get(id).page }) : undefined));
  const pageResults = targets.map(target => {
    const after = currentById.get(target.scope.pageId);
    const delta = reviewPageDelta(hash, target.pageBody, after?.page, target.scope.kind === "elements" ? target.scope.elementIds : []);
    return { pageId: target.scope.pageId, ...delta, scopeViolation: !target.pageBody || !after || delta.scopeViolation };
  });
  const missingCommentIds = lock.items.filter(item => {
    const after = currentById.get(item.scope.pageId);
    return !after || !item.pageBody || !reviewPageDelta(hash, item.pageBody, after.page, item.scope.kind === "elements" ? item.scope.elementIds : []).targetChanged;
  }).map(item => item.commentId);
  const deckDelta = reviewDeckDelta(hash, lock.deckState, {
    title: project.presentation.title ?? "",
    theme: project.presentation.theme ?? {},
    pageOrder: project.pages.map(entry => entry.path),
  });
  return {
    pageResults, missingCommentIds, changedOutsideTargetPageIds,
    ...deckDelta,
    scopeViolation: !targets.length || !beforeById.size || deckDelta.scopeViolation || changedOutsideTargetPageIds.length > 0 || pageResults.some(page => page.scopeViolation),
  };
}

/** Acceptance and state updates share the project write lock, preventing a
 * successful page from hiding an untouched comment on that same page. */
async function finishReviewBatch(native, root, token, outcome, failure) {
  const presentation = await import(runtimeImport("@open-slidestudio/presentation-run"));
  return native.pptd.withProjectWriteLock(root, () => {
    const lock = reviewAiLockByToken(token);
    const batchItems = Array.isArray(lock?.items) ? lock.items : null;
    if (!lock || lock.root !== path.resolve(root) || !batchItems?.length) {
      return { error: "unknown or non-batch review lock", code: "REVIEW_BATCH_LOCK_UNKNOWN" };
    }
    let verification;
    if (outcome === "applied") {
      verification = verifyReviewBatch(native, root, lock, presentation);
      if (verification.scopeViolation) return {
        error: "AI 改动超出了批注范围，正在恢复修改前版本", code: "REVIEW_BATCH_SCOPE_VIOLATION", verification,
      };
      if (verification.missingCommentIds.length) return {
        error: `还有 ${verification.missingCommentIds.length} 条批注没有产生可验证的修改，正在恢复修改前版本`, code: "REVIEW_BATCH_INCOMPLETE", verification,
      };
    }
    const applied = [];
    for (const item of batchItems) {
      const comment = findReviewThread(root, item.pagePath, item.commentId);
      if (!comment) continue;
      upsertReviewThread(native, root, item.pagePath, {
        ...comment,
        revision: comment.revision,
        aiStatus: outcome === "applied" ? "applied" : outcome === "failed" ? "failed" : "idle",
        aiAppliedAt: outcome === "applied" ? new Date().toISOString() : undefined,
        aiError: outcome === "failed" ? failure || "AI 修改失败，可重试" : undefined,
      }, { scope: comment.scope, allowApplied: outcome === "applied" });
      applied.push({ pagePath: item.pagePath, commentId: item.commentId });
    }
    finishCommentSubmission(root, lock.submissionId, outcome === "applied" ? "applied" : outcome === "failed" ? "failed" : "cancelled", failure);
    const released = releaseReviewAiLock(root, token);
    return { ok: released.released !== false, outcome, applied, verification, released: released.released !== false };
  });
}

async function acquireCurrentWorkspaceReviewLock(native, root, pagePath, rawWorkspaceEdit) {
  const presentation = await import(
    runtimeImport("@open-slidestudio/presentation-run")
  );
  return native.pptd.withProjectWriteLock(root, () => {
    const currentPage = projectPageSnapshotWithinLock(native, root, pagePath, presentation);
    const claimedRevision = presentation.currentPageRevision(root, currentPage.pageId);
    if (!claimedRevision) {
      throw Object.assign(new Error("workspace edit target has no generation ledger revision"), {
        code: "WORKSPACE_EDIT_SCOPE_STALE",
      });
    }
    // First prove that the browser's state snapshot names the current ledger
    // fact. A stale tab cannot turn an older authorization into a new one.
    const claimedScope = captureWorkspaceEditScope({
      ...currentPage,
      pageRevision: claimedRevision.revision,
      pageSha256: claimedRevision.pageSha256,
    }, rawWorkspaceEdit);
    const requestedPages = Array.isArray(rawWorkspaceEdit?.targetPages)
      ? rawWorkspaceEdit.targetPages
      : [];
    const project = native.pptd.loadProject(root);
    const projectPageIds = project.pages.map((entry) => path.basename(entry.path, ".page"));
    const requestedPageIds = requestedPages.map((page) => nonEmptyString(page?.pageId));
    if (!requestedPageIds.length || requestedPageIds.some((pageId) => !pageId) || new Set(requestedPageIds).size !== requestedPageIds.length) {
      throw Object.assign(new Error("workspace edit target pages must be a non-empty unique set"), {
        code: "WORKSPACE_EDIT_SCOPE_INVALID",
      });
    }
    // Explicit page lists stay exact even when they happen to cover the deck.
    // Membership, revisions, hashes and document-level mutations are verified below.
    const expectedPageIds = claimedScope.kind === "deck"
      ? projectPageIds
      : claimedScope.kind === "pages"
        ? requestedPageIds
        : [currentPage.pageId];
    if (expectedPageIds.some((pageId) => !projectPageIds.includes(pageId))) {
      throw Object.assign(new Error("workspace edit target includes a page outside the current deck"), {
        code: "WORKSPACE_EDIT_SCOPE_STALE",
      });
    }
    if (
      requestedPageIds.length !== expectedPageIds.length ||
      requestedPageIds.some((pageId, index) => pageId !== expectedPageIds[index])
    ) {
      throw Object.assign(new Error("workspace edit target pages do not match the current deck"), {
        code: "WORKSPACE_EDIT_SCOPE_STALE",
      });
    }
    const verifiedPages = requestedPages.map((claimed, index) => {
      const pageId = expectedPageIds[index];
      const ledgerRevision = presentation.currentPageRevision(root, pageId);
      if (
        !ledgerRevision ||
        Number(claimed?.revision) !== ledgerRevision.revision ||
        nonEmptyString(claimed?.pageSha256).toLowerCase() !== ledgerRevision.pageSha256
      ) {
        throw Object.assign(new Error(`workspace edit page ${pageId} changed before its lock was acquired`), {
          code: "WORKSPACE_EDIT_SCOPE_STALE",
        });
      }
      const pagePathForId = project.pages.find((entry) => path.basename(entry.path, ".page") === pageId)?.path;
      if (!pagePathForId) {
        throw Object.assign(new Error(`workspace edit page not found: ${pageId}`), {
          code: "WORKSPACE_EDIT_SCOPE_STALE",
        });
      }
      const snapshot = projectPageSnapshotWithinLock(native, root, pagePathForId, presentation);
      return { pageId, ledgerRevision, snapshot };
    });
    // Validate every requested page before appending any revision fact. A
    // stale page late in a deck request must leave all earlier pages untouched.
    const authoritativePages = verifiedPages.map(({ pageId, ledgerRevision, snapshot }) => {
      const recorded = snapshot.pageRevision == null
        ? presentation.recordPageRevision(
            root,
            {
              contextEpochId: ledgerRevision.contextEpochId,
              commandId: `editor-workspace:${claimedScope.authorizationId}`,
            },
            pageId,
            snapshot.canonicalPage,
          )
        : ledgerRevision;
      return {
        pageId,
        revision: recorded.revision,
        pageSha256: recorded.pageSha256,
        snapshot,
      };
    });
    const lockedCurrent = authoritativePages.find((page) => page.pageId === currentPage.pageId);
    if (!lockedCurrent) {
      throw Object.assign(new Error("workspace edit current page is outside the authorized target"), {
        code: "WORKSPACE_EDIT_SCOPE_STALE",
      });
    }
    const lockScope = {
      ...claimedScope,
      pageRevision: lockedCurrent.revision,
      pageSha256: lockedCurrent.pageSha256,
      targetPageIds: authoritativePages.map((page) => page.pageId),
      targetPages: authoritativePages.map(({ pageId, revision, pageSha256 }) => ({ pageId, revision, pageSha256 })),
      capturedAt: new Date().toISOString(),
    };
    const projectPages = project.pages.map((entry) => {
      const pageId = path.basename(entry.path, ".page");
      return {
        pageId,
        pagePath: entry.path,
        pageSha256: presentation.stableSha256({ id: pageId, ...entry.page }),
      };
    });
    const acquired = acquireReviewAiLock(root, {
      pagePath,
      scope: lockScope,
      pageSha256: lockedCurrent.pageSha256,
      pageBody: lockedCurrent.snapshot.pageBody,
      deckState: lockedCurrent.snapshot.deckState,
      projectPages,
    });
    return { currentPage: lockedCurrent.snapshot, lockScope, acquired };
  });
}

function reviewPageDelta(stableSha256, beforeBody, afterBody, targetElementIds) {
  const before = beforeBody && typeof beforeBody === "object" ? beforeBody : {};
  const after = afterBody && typeof afterBody === "object" ? afterBody : {};
  const beforeElements = Array.isArray(before.elements) ? before.elements : [];
  const afterElements = Array.isArray(after.elements) ? after.elements : [];
  const elementId = (element) => nonEmptyString(element?.elementId);
  const beforeById = new Map(beforeElements.map((element) => [elementId(element), element]));
  const afterById = new Map(afterElements.map((element) => [elementId(element), element]));
  const changedElementIds = [...new Set([...beforeById.keys(), ...afterById.keys()])]
    .filter(Boolean)
    .filter((id) => stableSha256(beforeById.get(id)) !== stableSha256(afterById.get(id)));
  const elementOrderChanged = stableSha256(beforeElements.map(elementId)) !==
    stableSha256(afterElements.map(elementId));
  const { elements: _beforeElements, ...beforeMeta } = before;
  const { elements: _afterElements, ...afterMeta } = after;
  const metadataChanged = stableSha256(beforeMeta) !== stableSha256(afterMeta);
  const targets = new Set(Array.isArray(targetElementIds)
    ? targetElementIds.map(nonEmptyString).filter(Boolean)
    : nonEmptyString(targetElementIds) ? [nonEmptyString(targetElementIds)] : []);
  const changedTargetElementIds = changedElementIds.filter((id) => targets.has(id));
  const scopeViolation = targets.size > 0 && (
    metadataChanged || elementOrderChanged || changedElementIds.some((id) => !targets.has(id))
  );
  return {
    changedElementIds,
    changedTargetElementIds,
    targetChanged: targets.size ? changedTargetElementIds.length > 0 : stableSha256(before) !== stableSha256(after),
    elementOrderChanged,
    metadataChanged,
    scopeViolation,
  };
}

function reviewDeckDelta(stableSha256, beforeState, afterState) {
  const before = beforeState && typeof beforeState === "object" ? beforeState : {};
  const after = afterState && typeof afterState === "object" ? afterState : {};
  const titleChanged = stableSha256(before.title ?? "") !== stableSha256(after.title ?? "");
  const themeChanged = stableSha256(before.theme ?? {}) !== stableSha256(after.theme ?? {});
  const pageOrderChanged = stableSha256(before.pageOrder ?? []) !== stableSha256(after.pageOrder ?? []);
  return {
    deckTitleChanged: titleChanged,
    deckThemeChanged: themeChanged,
    deckPageOrderChanged: pageOrderChanged,
    scopeViolation: titleChanged || themeChanged || pageOrderChanged,
  };
}

function captureProjectFile(root, relativePath) {
  const file = path.join(root, relativePath);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function restoreProjectFile(root, relativePath, bytes) {
  const file = path.join(root, relativePath);
  if (bytes == null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, file);
}

/**
 * A read-only, restart-safe generation-history snapshot. The browser can poll
 * this while an agent writes pages, then keep the same event log after finish.
 */
function boundGenerationSessionId(root) {
  const agentDir = path.join(root, "_agent");
  const slice = readProjectRecord(path.join(agentDir, "slice-session.v1.json"));
  const run = readProjectRecord(path.join(agentDir, "presentation-run.v1.json"));
  const sliceSessionId = nonEmptyString(slice.dshSessionId);
  const runSessionId = nonEmptyString(run.sessionId);
  if (sliceSessionId && runSessionId && sliceSessionId !== runSessionId) {
    throw new Error("generation activity session bindings disagree");
  }
  return sliceSessionId || runSessionId;
}

async function readGenerationActivity(native, root) {
  const agentDir = path.join(root, "_agent");
  const slice = readProjectRecord(path.join(agentDir, "slice-session.v1.json"));
  const runtime = readProjectRecord(path.join(agentDir, "runtime.json"));
  const dshRuntime = readProjectRecord(path.join(agentDir, "dsh-runtime.json"));
  const run = readProjectRecord(path.join(agentDir, "presentation-run.v1.json"));
  const presentation = await import(
    runtimeImport("@open-slidestudio/presentation-run")
  );
  const snapshot = presentation.inspectGenerationActivitySnapshot(root);
  const inspection = snapshot.inspection;
  let activity = snapshot.activity;
  const boundSessionId = boundGenerationSessionId(root);
  let traceSource = "project-trace";
  if (boundSessionId) {
    try {
      const journalRows = await readProjectSessionTrace({
        productRoot: ROOT,
        dshHome: process.env.DSH_HOME || path.join(ROOT, ".dsh", "home"),
        sessionId: boundSessionId,
      });
      const journalEvents = presentation.generationActivityEventsFromTraceRows(journalRows);
      if (journalEvents.length) {
        activity = { ...activity, events: journalEvents };
        traceSource = "session-journal";
      }
    } catch {
      // Keep the project trace available if the read-only journal is absent,
      // between complete frames, or fails its workspace identity check.
    }
  }
  let pageCount = 0;
  let title = "";
  let pagePaths = [];
  try {
    const project = native.pptd.loadProject(root);
    pageCount = project.pages.length;
    title = project.presentation.title ?? "";
    pagePaths = project.pages.map((page) => page.path);
  } catch {
    // An untouched project may not have a deck yet; the persisted ledger still
    // describes its planning activity.
  }
  const provider = slice.provider && typeof slice.provider === "object"
    ? slice.provider
    : run.provider && typeof run.provider === "object"
      ? run.provider
      : undefined;
  const persistedFault = readProjectRecord(path.join(agentDir, "dsh-agent-error.json"));
  const faultCode = persistedFault.recovering === true ? "" : nonEmptyString(persistedFault.code);
  const faultDetail = nonEmptyString(persistedFault.detail);
  const pauseCodes = new Set([
    "provider-quota",
    "provider-auth",
    "provider-token-plan",
    "provider-rate-limit",
    "provider-unavailable",
    "operator-stop",
    "host-interrupted",
    "tool-invalid-args-loop",
    "repeated-business-rejection",
    "planning-no-progress-budget",
    "production-no-progress-budget",
  ]);
  const waitResumeCodes = new Set(["provider-quota", "provider-token-plan", "provider-rate-limit"]);
  const faultOverridesComplete = activity.phase !== "complete" || waitResumeCodes.has(faultCode);
  const phase = faultCode && faultDetail && faultOverridesComplete
    ? pauseCodes.has(faultCode) ? "paused" : "failed"
    : activity.phase;
  const error = phase === "paused" || phase === "failed"
    ? { code: faultCode, detail: faultDetail }
    : undefined;
  const activeStageIndex = activity.stages.findIndex((stage) => stage.status === "active");
  const attentionIndex = error
    ? activeStageIndex >= 0 ? activeStageIndex : activity.stages.length - 1
    : -1;
  const stages = error
    ? activity.stages.map((stage, index) => index === attentionIndex
      ? { ...stage, status: "needs-attention", detail: `${phase === "paused" ? "已暂停" : "生成失败"}：${error.detail}` }
      : stage)
    : activity.stages;
  return {
    ok: true,
    project: { path: path.relative(DATA_ROOT, root), title, pageCount, pagePaths },
    sessionId:
      boundSessionId ||
      nonEmptyString(inspection.contextEpochId) ||
      undefined,
    brief: nonEmptyString(runtime.brief) || nonEmptyString(dshRuntime.brief) || nonEmptyString(run.brief),
    provider,
    phase,
    stages,
    events: activity.events,
    traceSource,
    conversation: readProjectRecord(path.join(agentDir, "assistant-conversation.v1.json")),
    assistantArtifacts: assistantVersionArtifacts(root, native.store.listVersions(root),
      readProjectRecord(path.join(agentDir, "assistant-conversation.v1.json"))),
    reviewSubmissions: readCommentSubmissions(root),
    inspection,
    execution: snapshot.execution,
    error,
  };
}

async function generationActivityForRequest(
  native,
  url,
  currentRoot,
  readActivity = readGenerationActivity,
) {
  let root;
  try {
    root = url.searchParams.has("project")
      ? resolveProjectPath(url.searchParams.get("project"))
      : currentRoot;
  } catch (error) {
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
      httpStatus: 400,
      code: "GENERATION_PROJECT_INVALID",
    });
  }
  if (!fs.existsSync(root)) {
    throw Object.assign(new Error(`not found: ${root}`), {
      httpStatus: 404,
      code: "GENERATION_PROJECT_NOT_FOUND",
    });
  }
  const requestedSessionId = nonEmptyString(url.searchParams.get("sessionId"));
  if (requestedSessionId && boundGenerationSessionId(root) !== requestedSessionId) {
    throw Object.assign(
      new Error("generation activity session does not belong to the requested project"),
      { httpStatus: 409, code: "GENERATION_SESSION_PROJECT_MISMATCH" },
    );
  }
  return readActivity(native, root);
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".css": "text/css; charset=utf-8",
      ".pptx":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }[ext] || "application/octet-stream"
  );
}

function coverRasterFile(root) {
  const dir = path.join(root, "_agent", "rasters");
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".png"));
  const prefer = names.find((name) => /^(cover|page-0*1)\.png$/i.test(name));
  const pick = prefer || names.sort()[0];
  return pick ? path.join(dir, pick) : null;
}

function resolveOutputProject(root, raw) {
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const output = path.resolve(root, "output");
  const rel = path.relative(output, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("resume path must be under output/");
  }
  if (!fs.existsSync(abs)) throw new Error("没有可继续的生成进度");
  return abs;
}

/** Project dirs may live under the workspace or the OS temp dir (tests). */
// Allowed roots must be canonicalized the same way candidates are (realpath),
// otherwise macOS /var -> /private/var symlinks make tmpdir projects look foreign.
const ALLOWED_PROJECT_ROOTS = [ROOT, DATA_ROOT, os.tmpdir()].map((p) => {
  const resolved = path.resolve(p);
  try {
    return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  } catch {
    return resolved;
  }
});

function projectRootAllowed(candidate) {
  return ALLOWED_PROJECT_ROOTS.some(
    (root) => candidate === root || candidate.startsWith(root + path.sep),
  );
}

function resolveProjectPath(raw, workspaceRoot = DATA_ROOT, defaultProject = DEFAULT_PROJECT) {
  const requested = nonEmptyString(raw);
  if (!requested) return path.resolve(defaultProject);
  const candidates = path.isAbsolute(requested)
    ? [path.resolve(requested)]
    : [
        path.resolve(workspaceRoot, requested),
        path.resolve(workspaceRoot, "fixtures", requested),
        path.resolve(ROOT, "fixtures", requested),
        path.resolve(workspaceRoot, "output", requested),
      ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
  // Canonicalize through realpath so a symlinked dir cannot escape the
  // workspace; anything outside the allowed roots resolves to a path that
  // does not exist, which strict callers turn into a 404.
  let real = resolved;
  try {
    if (fs.existsSync(resolved)) real = fs.realpathSync(resolved);
  } catch {
    real = resolved;
  }
  if (!projectRootAllowed(real)) {
    return path.join(workspaceRoot, "__outside-workspace__");
  }
  // Security decided on the canonical path; keep the caller's spelling so API
  // responses round-trip the path the client supplied (e.g. /var vs /private/var).
  return resolved;
}

// Recursive total for the project row label. Symlinks are never followed so a
// linked cache cannot double-count or escape the project directory.
function dirSizeBytes(root) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(abs);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += fs.statSync(abs).size;
    } catch { /* a file being written or removed mid-scan must not break the list */ }
  }
  return total;
}

function discoverProjects(workspaceRoot = DATA_ROOT) {
  const fixturesDir = path.join(workspaceRoot === DATA_ROOT ? ROOT : workspaceRoot, "fixtures");
  const outputDir = path.join(workspaceRoot, "output");
  const scanRoots = [
    { root: fixturesDir, group: "fixture" },
    { root: outputDir, group: "generated" },
    { root: path.join(outputDir, "dsh-slices"), group: "generated" },
  ];
  const projects = [];
  for (const { root, group } of scanRoots) {
    let entries;
    try {
      if (!fs.lstatSync(root).isDirectory()) continue;
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Dirent checks do not follow a project-directory symlink.
      if (!entry.isDirectory()) continue;
      const projectRoot = path.join(root, entry.name);
      let files;
      try {
        files = fs.readdirSync(projectRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      const manifests = files.filter((file) => file.isFile() && file.name.endsWith(".pptd"));
      if (!manifests.length) continue;
      let updatedAt = 0;
      for (const manifest of manifests) {
        try {
          updatedAt = Math.max(updatedAt, fs.statSync(path.join(projectRoot, manifest.name)).mtimeMs);
        } catch {
          continue;
        }
      }
      if (!updatedAt) {
        try {
          updatedAt = fs.statSync(projectRoot).mtimeMs;
        } catch {
          updatedAt = 0;
        }
      }
      let title = "";
      let pageCount = 0;
      try {
        const manifest = manifests.find((file) => file.name === "deck.pptd") || manifests[0];
        const deck = parseYaml(fs.readFileSync(path.join(projectRoot, manifest.name), "utf8"));
        title = typeof deck?.title === "string" ? deck.title : "";
        pageCount = Array.isArray(deck?.pages) ? deck.pages.length : 0;
        const conversation = path.join(projectRoot, "_agent", "assistant-conversation.v1.json");
        if (fs.existsSync(conversation)) updatedAt = Math.max(updatedAt, fs.statSync(conversation).mtimeMs);
      } catch { /* A malformed manifest remains visible so it can be recovered. */ }
      projects.push({ id: entry.name, title, pageCount, path: projectRoot, group, updatedAt, sizeBytes: dirSizeBytes(projectRoot) });
    }
  }
  return projects;
}

function deleteProject(workspaceRoot = DATA_ROOT, raw) {
  const abs = resolveOutputProject(workspaceRoot, raw);
  const stat = fs.lstatSync(abs);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("只能删除 output/ 下的生成项目目录");
  }
  const files = fs.readdirSync(abs, { withFileTypes: true });
  if (!files.some((file) => file.isFile() && file.name.endsWith(".pptd"))) {
    throw new Error("该目录不是可删除的生成项目");
  }
  fs.rmSync(abs, { recursive: true, force: true });
  return abs;
}

const RETENTION_DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Days to keep generated projects without modification. 0 disables. Default 0: keep user work until explicitly removed. */
function retentionDaysFromEnv(env = process.env) {
  const raw = String(env.SLIDESTUDIO_RETENTION_DAYS ?? "0").trim();
  if (raw === "") return 0;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) {
    throw new Error("SLIDESTUDIO_RETENTION_DAYS must be a non-negative number of days");
  }
  return days;
}

/**
 * Delete generated projects (output/ only, never fixtures) whose newest
 * .pptd/directory mtime is older than `days`. Whole directory goes, including
 * _agent rasters and exported pptx, so server disk stays bounded.
 */
function sweepStaleProjects(workspaceRoot = DATA_ROOT, opts = {}) {
  const days = opts.days ?? retentionDaysFromEnv(opts.env ?? process.env);
  const now = opts.now ?? Date.now();
  const deleted = [];
  const errors = [];
  if (!(days > 0)) return { deleted, errors, skipped: true };
  const cutoff = now - days * RETENTION_DAY_MS;
  const outputDir = path.resolve(workspaceRoot, "output");
  // macOS mounts /tmp under a /var -> /private/var symlink; compare resolved
  // paths on both sides so legitimate output dirs are not rejected.
  let outputReal = outputDir;
  try {
    outputReal = fs.realpathSync(outputDir);
  } catch {
    return { deleted, errors, skipped: false };
  }
  for (const project of discoverProjects(workspaceRoot)) {
    if (project.group !== "generated") continue;
    if (!(project.updatedAt < cutoff)) continue;
    try {
      const abs = path.resolve(project.path);
      const stat = fs.lstatSync(abs);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const real = fs.realpathSync(abs);
      if (real !== outputReal && !real.startsWith(outputReal + path.sep)) continue;
      const files = fs.readdirSync(abs, { withFileTypes: true });
      if (!files.some((file) => file.isFile() && file.name.endsWith(".pptd"))) continue;
      fs.rmSync(abs, { recursive: true, force: true });
      deleted.push(project.id);
    } catch (error) {
      errors.push({ id: project.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { deleted, errors, skipped: false };
}

function startRetentionSweep() {
  let days;
  try {
    days = retentionDaysFromEnv();
  } catch (error) {
    console.error(`Retention disabled: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!(days > 0)) {
    console.log("Project retention off (SLIDESTUDIO_RETENTION_DAYS=0).");
    return;
  }
  const run = () => {
    try {
      const { deleted, errors } = sweepStaleProjects(DATA_ROOT, { days });
      if (deleted.length) {
        console.log(`Retention: deleted ${deleted.length} stale project(s): ${deleted.join(", ")}`);
      }
      for (const err of errors) console.error(`Retention: failed ${err.id}: ${err.error}`);
    } catch (error) {
      console.error(`Retention sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  run();
  const intervalMs = Number(process.env.SLIDESTUDIO_RETENTION_INTERVAL_MS) || RETENTION_INTERVAL_MS;
  setInterval(run, intervalMs).unref?.();
}

function safeMediaPath(rootDir, rel) {
  // Element srcs carry a leading media/ prefix; strip it, then confine to the
  // media/ subtree so deck.pptd, pages/*.page and _agent/ are unreachable.
  const cleaned = String(rel)
    .replace(/^\/+/, "")
    .replace(/\0/g, "")
    .replace(/^media\/+/, "");
  const mediaRoot = path.resolve(rootDir, "media");
  const full = path.resolve(mediaRoot, cleaned);
  if (!full.startsWith(mediaRoot + path.sep) && full !== mediaRoot) return null;
  return full;
}

function ensureSession(native, projectRoot, pageHint, tabId = "default") {
  const root = path.resolve(projectRoot ?? lastProjectPath);
  const entry = liveEntryFor(root, tabId);
  if (!entry.session) {
    openLiveSession(native, root, pageHint, tabId);
  } else if (entry.diskRevision !== native.pptd.withProjectWriteLock(root, () => projectDiskRevision(root))) {
    openLiveSession(native, root, pageHint ?? entry.session.pageIndex, tabId);
  } else if (pageHint != null && pageHint !== entry.session.pageIndex) {
    native.canvas.goToPage(entry.session, pageHint);
    rememberPage(entry.session, root);
  }
  return entry.session;
}

/** Sidecar proxy: forward only what the kernel needs — ambient auth and
 * browser hop-by-hop headers never cross to the upstream listener. The
 * browser session cookie must pass: its host-scoped name/port ignores the
 * sidecar port, and without it every kernel route answers 401 — which is
 * exactly the dead-editor shape users reported. */
const PROXY_HEADER_WHITELIST = new Set([
  "accept",
  "accept-language",
  "content-type",
  "content-length",
  "cookie",
  "x-requested-with",
]);
function proxyHeaders(req, kernelPort) {
  const out = { host: `127.0.0.1:${kernelPort}` };
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (PROXY_HEADER_WHITELIST.has(lower) || lower.startsWith("x-openslides-") || lower.startsWith("x-dsh-")) {
      out[lower] = value;
    }
  }
  return out;
}

// Without a ceiling a wedged or absent kernel leaves the browser request
// pending forever (no finish/fail event), which stalls page loads and any
// networkidle wait. Bound the upstream and answer 502 on timeout.
const KERNEL_PROXY_TIMEOUT_MS = Number(process.env.SLIDES_KERNEL_PROXY_TIMEOUT_MS || 15000);
function proxyToKernel(req, res) {
  const kernelPort = Number(process.env.SLIDES_DSH_PORT || 13080);
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: kernelPort,
      path: req.url,
      method: req.method,
      headers: proxyHeaders(req, kernelPort),
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.setTimeout(KERNEL_PROXY_TIMEOUT_MS, () => {
    upstream.destroy(new Error(`DSH kernel on ${kernelPort} timed out after ${KERNEL_PROXY_TIMEOUT_MS}ms`));
  });
  upstream.on("error", () => {
    if (!res.headersSent) json(res, 502, { error: `DSH kernel on ${kernelPort} is unreachable` });
    else res.end();
  });
  req.pipe(upstream);
}

const MAX_BODY_BYTES = 12 * 1024 * 1024; // media uploads ride JSON base64
async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error("request body too large");
      err.statusCode = 413;
      req.destroy();
      throw err;
    }
    chunks.push(c);
  }
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const nativePromise = loadNative();

function harnessLlmConfig() {
  const baseUrl = process.env.SLIDESTUDIO_LLM_BASE_URL?.trim();
  if (!baseUrl) return undefined;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: process.env.SLIDESTUDIO_LLM_API_KEY,
    model: process.env.SLIDESTUDIO_LLM_MODEL?.trim() || "local",
    timeoutMs: Number(process.env.SLIDESTUDIO_LLM_TIMEOUT_MS) || 120_000,
    image: process.env.SLIDESTUDIO_LLM_IMAGE === "0" ? false : undefined,
  };
}

function harnessResearchConfig() {
  const url = process.env.SLIDESTUDIO_RESEARCH_URL?.trim();
  if (!url) return undefined;
  return {
    url,
    apiKey: process.env.SLIDESTUDIO_RESEARCH_API_KEY?.trim() || undefined,
    timeoutMs: Number(process.env.SLIDESTUDIO_RESEARCH_TIMEOUT_MS) || 20_000,
  };
}

/** Image generate is optional. LLM chat URL alone is not a generate API. */
function harnessImageConfigured() {
  if (process.env.SLIDESTUDIO_IMAGE === "0") return false;
  if (process.env.SLIDESTUDIO_IMAGE_BASE_URL?.trim()) return true;
  return process.env.SLIDESTUDIO_IMAGE === "1" && Boolean(process.env.SLIDESTUDIO_LLM_BASE_URL?.trim());
}

const HUB_CATEGORY = {
  All: "analysis-decision",
  Consulting: "analysis-decision",
  Finance: "analysis-decision",
  "Work Report": "management-report",
  Promotion: "brand-creative",
  Academic: "academic-research",
};

function mapHubCategory(raw) {
  const value = String(raw || "").trim();
  if (!value || value === "All") return "analysis-decision";
  return HUB_CATEGORY[value] || value;
}

function resolveHubCategory(body) {
  const kind = String(body?.kind || "").trim();
  if (kind === "Report") return "management-report";
  return mapHubCategory(body?.category);
}

const attachmentStore = new AttachmentStore(path.join(DATA_ROOT, "output", "attachments"));
const storeAttachment = (name, bytes) => attachmentStore.store(name, bytes);

const DEMO_BRAND_FILES = [
  {
    name: "brand-voice.md",
    text: [
      "# 品牌语气",
      "松绿主色贯穿封面与证据页",
      "标题必须是完整断言句",
      "禁止编造客户案例与外部统计",
      "",
    ].join("\n"),
  },
  {
    name: "brand-palette.md",
    text: [
      "# 品牌色板",
      "背景留白，强调只用松绿与石墨灰",
      "证据页必须标注资料来源",
      "色值未给出时不要发明百分比",
      "",
    ].join("\n"),
  },
];


function wantsPi(model) {
  const value = String(model || "Pi").trim();
  return !value || /^pi$/i.test(value);
}

function editorBaseUrl() {
  return (process.env.SLIDESTUDIO_EDITOR_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
}

/** Last rebuild path: "llm" (multimodal) or "prompt" (fallback). */
let lastRebuildMode = "prompt";

// Loopback-only service: any Host that is not this port's loopback (or an
// explicit allowlist) is DNS-rebinding noise — answer nothing for it.
function requestHostAllowed(req) {
  const host = String(req.headers?.host || "").split(",")[0].trim().toLowerCase();
  if (!host) return false;
  const extra = (process.env.SLIDESTUDIO_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const name = host.replace(/:\d+$/, "");
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"];
  return loopback.includes(name) || extra.includes(host) || extra.includes(name);
}

// A mutating request that carries an Origin or Sec-Fetch-Site header must come
// from this same origin — a cross-site form/fetch POST gets no mutation.
function requestOriginAllowed(req, url) {
  const origin = String(req.headers?.origin || "").trim();
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const host = String(req.headers?.host || "");
      if (originUrl.host !== host) return false;
    } catch {
      return false;
    }
  }
  const fetchSite = String(req.headers?.["sec-fetch-site"] || "").trim().toLowerCase();
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) return false;
  return true;
}

function requestContentTypeAllowed(req) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "")) return true;
  // Only a request that actually carries a body must speak JSON — bodyless
  // POSTs (e.g. attachment demos, session stop) have nothing to type.
  const length = Number(req.headers?.["content-length"] || 0);
  const chunked = /chunked/i.test(String(req.headers?.["transfer-encoding"] || ""));
  if (!chunked && !(length > 0)) return true;
  const type = String(req.headers?.["content-type"] || "").toLowerCase();
  return type.includes("application/json");
}

const server = http.createServer(async (req, res) => {
  try {
    const native = await nativePromise;
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

    if (!requestHostAllowed(req)) return json(res, 421, { error: "unrecognized host" });
    const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "");
    if (isMutating && !requestOriginAllowed(req, url)) {
      return json(res, 403, { error: "cross-site mutation rejected" });
    }
    // Bodies on mutating routes are JSON; anything else is not our API shape.
    // The kernel proxies below carry their own payload rules.
    if (isMutating && !url.pathname.startsWith("/slides") && !url.pathname.startsWith("/plugins/") && !requestContentTypeAllowed(req)) {
      return json(res, 415, { error: "mutating requests require application/json" });
    }

    if (url.pathname === "/slides" || url.pathname.startsWith("/slides/")) {
      proxyToKernel(req, res);
      return;
    }

    // Kernel plugin routes (dsh-oauth-login etc.). Without this the static
    // fallback answers HTML, and hub's r.json() dies on "<!doctype".
    if (url.pathname.startsWith("/plugins/")) {
      proxyToKernel(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      let title;
      let pageCount;
      let size;
      const healthRoot = projectForRequest(url, null);
      try {
        const s = await ensureSession(native, healthRoot);
        const model = native.canvas.renderModel(s);
        title = model.title;
        pageCount = model.pageCount;
        size = model.size;
      } catch {
        title = undefined;
        pageCount = undefined;
        size = undefined;
      }
      // Capability card in DSH vocabulary — same shape the hub capability
      // view-model reads, computed from env config without the harness.
      const llmCfg = harnessLlmConfig();
      const researchCfg = harnessResearchConfig();
      const imageGenerateOn = harnessImageConfigured();
      const imageSearchOn = Boolean(process.env.SLIDESTUDIO_IMAGE_SEARCH_URL?.trim());
      const visionOn = Boolean(llmCfg) && process.env.SLIDESTUDIO_LLM_IMAGE !== "0";
      const capability = {
        research: researchCfg
          ? { mode: "http", configured: true }
          : { mode: "attachments-gap", configured: false },
        imageSearch: { configured: imageSearchOn, via: imageSearchOn ? "http" : "none" },
        imageGenerate: { configured: imageGenerateOn, via: imageGenerateOn ? "http" : "none" },
        vision: visionOn
          ? { mode: "main-model", note: "Main chat may accept image_url parts. If it cannot, admit you did not see the slide." }
          : { mode: "none", note: "No vision. Structural QA only. Do not pretend you saw the page." },
        pageRaster: { mode: "native-slide", note: "render_page screenshots native #slide." },
        render: true,
        runtime: { kind: "dsh", piAvailable: false, piNote: "Pi is not the product kernel. Use MiniMax China via DSH." },
        mediaPolicy: "optional",
      };
      return json(res, 200, {
        ok: true,
        product: "DSH SlideStudio",
        kimiRuntime: false,
        kernel: "dsh",
        checkoutRoot: ROOT,
        dataRoot: DATA_ROOT,
        project: healthRoot,
        connected: Boolean(liveSessions.get(path.resolve(healthRoot))?.session),
        title,
        pageCount,
        size,
        llmConfigured: Boolean(harnessLlmConfig()),
        agentRuntime: true,
        researchConfigured: Boolean(harnessResearchConfig()),
        imageConfigured: harnessImageConfigured(),
        imageSearchConfigured: Boolean(process.env.SLIDESTUDIO_IMAGE_SEARCH_URL?.trim()),
        piAvailable: false,
        piNote: "Pi is not the product kernel. Use MiniMax China via DSH.",
        piModel: "",
        minimaxReady: Boolean(
          process.env.MINIMAX_CN_API_KEY?.trim() ||
            process.env.MINIMAXCN_API_KEY?.trim() ||
            process.env.MINIMAX_API_KEY?.trim() ||
            process.env.OPENROUTER_ONLYUSE_FREEMODEL_API_KEY?.trim(),
        ),
        capability,
        lastRebuildMode,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/generation-activity") {
      try {
        return json(res, 200, await generationActivityForRequest(native, url, projectForRequest(url, null)));
      } catch (error) {
        return json(res, Number(error?.httpStatus) || 500, {
          error: "generation activity artifacts could not be read",
          ...(error?.code ? { code: error.code } : {}),
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/reviews") {
      try {
        const reviewRoot = reviewProjectPath(url.searchParams.get("project"));
        reconcileOrphanedAiReviews(native, reviewRoot);
        // Cross-page inbox: the batch submit needs every page's open comments.
        if (url.searchParams.get("all") === "1") {
          const record = readReviewThreads(reviewRoot);
          const pages = {};
          for (const [key, list] of Object.entries(record.pages || {})) {
            if (!Array.isArray(list) || !list.length) continue;
            pages[key] = list.map((comment) => sanitizeReviewThread(comment, key));
          }
          return json(res, 200, { ok: true, all: true, revision: record.revision, pages });
        }
        const pagePath = reviewPageKey(url.searchParams.get("pagePath"));
        const record = readReviewThreads(reviewRoot);
        const comments = Array.isArray(record.pages[pagePath])
          ? record.pages[pagePath].map((comment) => sanitizeReviewThread(comment, pagePath))
          : [];
        const pagePresent = Object.prototype.hasOwnProperty.call(record.pages, pagePath);
        return json(res, 200, { ok: true, pagePath, pagePresent, revision: record.revision, comments });
      } catch (error) {
        return json(res, error?.code ? 400 : 400, {
          error: error instanceof Error ? error.message : String(error),
          ...(error?.code ? { code: error.code } : {}),
        });
      }
    }

    if (req.method === "PUT" && url.pathname === "/api/reviews") {
      return json(res, 410, {
        error: "bulk review replacement was removed; update one comment with PATCH /api/reviews",
        code: "REVIEW_PUT_REMOVED",
      });
    }

    if (req.method === "PATCH" && url.pathname === "/api/reviews") {
      try {
        const body = await readBody(req);
        const reviewRoot = reviewProjectPath(body?.project);
        const pagePath = reviewPageKey(body?.pagePath);
        if (!body?.comment || typeof body.comment !== "object" || Array.isArray(body.comment)) {
          return json(res, 400, { error: "comment must be an object" });
        }
        const previous = findReviewThread(reviewRoot, pagePath, body.comment.id);
        let scope = previous?.scope;
        if (body.rebind === true) {
          // An explicit re-bind: a comment whose target elements were regenerated
          // away must be re-pointable at whatever is on the page now, otherwise it
          // is a dead end the user cannot act on.
          const snapshot = await projectPageSnapshot(native, reviewRoot, pagePath);
          scope = captureReviewScope(snapshot, body.comment.scope, body.comment.elementId);
        } else if (!scope) {
          const snapshot = await projectPageSnapshot(native, reviewRoot, pagePath);
          scope = captureReviewScope(snapshot, body.comment.scope, body.comment.elementId);
        }
        const written = upsertReviewThread(native, reviewRoot, pagePath, body.comment, {
          scope,
          allowScopeChange: body.rebind === true,
        });
        if (written.conflict) {
          return json(res, 409, {
            error: written.code === "REVIEW_SCOPE_IMMUTABLE"
              ? "review comment scope is immutable"
              : written.code === "REVIEW_AI_STATUS_SERVER_OWNED"
                ? "AI applied status must be committed by review verification"
                : "review comment revision conflict",
            code: written.code || "REVIEW_COMMENT_CONFLICT",
            pagePath,
            comment: written.comment,
            revision: written.revision,
          });
        }
        return json(res, 200, { ok: true, pagePath, ...written });
      } catch (error) {
        return json(res, error?.code ? 409 : 400, {
          error: error instanceof Error ? error.message : String(error),
          ...(error?.code ? { code: error.code } : {}),
          ...(error?.missingElementIds ? { missingElementIds: error.missingElementIds } : {}),
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/reviews/ai-lock") {
      try {
        const body = await readBody(req);
        const reviewRoot = reviewProjectPath(body?.project);
        reconcileOrphanedAiReviews(native, reviewRoot);
        const pagePath = reviewPageKey(body?.pagePath);
        let currentPage = await projectPageSnapshot(native, reviewRoot, pagePath);
        if (body?.workspaceEdit !== undefined && nonEmptyString(body?.commentId)) {
          return json(res, 400, {
            error: "review comments and direct workspace edits use separate lock contracts",
            code: "AI_REVIEW_LOCK_MODE_CONFLICT",
          });
        }
        const workspaceRequested = body?.workspaceEdit !== undefined;
        const comment = workspaceRequested ? undefined : findReviewThread(reviewRoot, pagePath, body?.commentId);
        if (!workspaceRequested && !comment) {
          return json(res, 404, { error: "review comment not found", code: "REVIEW_COMMENT_NOT_FOUND" });
        }
        if (comment && Number(body?.commentRevision) !== comment.revision) {
          return json(res, 409, {
            error: "review comment revision conflict",
            code: "REVIEW_COMMENT_CONFLICT",
            comment,
          });
        }
        if (comment) assertReviewScopeCurrent(comment.scope, currentPage);
        let lockScope;
        let acquired;
        if (comment) {
          const prepared = await acquireCurrentCommentReviewLock(
            native,
            reviewRoot,
            pagePath,
            comment,
            currentPage.pageSha256,
          );
          currentPage = prepared.currentPage;
          lockScope = prepared.lockScope;
          acquired = prepared.acquired;
        } else {
          const prepared = await acquireCurrentWorkspaceReviewLock(
            native,
            reviewRoot,
            pagePath,
            body.workspaceEdit,
          );
          currentPage = prepared.currentPage;
          lockScope = prepared.lockScope;
          acquired = prepared.acquired;
        }
        if (acquired.conflict) {
          return json(res, 409, {
            error: "another AI review is already editing this project",
            code: "AI_REVIEW_LOCKED",
            lock: {
              pagePath: acquired.lock.pagePath,
              createdAt: acquired.lock.createdAt,
            },
          });
        }
        let running;
        if (comment) {
          running = upsertReviewThread(native, reviewRoot, pagePath, {
            ...comment,
            revision: comment.revision,
            aiStatus: "running",
            aiError: undefined,
          }, { scope: lockScope });
          if (running.conflict) {
            releaseReviewAiLock(reviewRoot, acquired.lock.token);
            return json(res, 409, {
              error: "review comment changed while acquiring its Agent lock",
              code: running.code || "REVIEW_COMMENT_CONFLICT",
              comment: running.comment,
            });
          }
          acquired.lock.commentRevision = running.comment.revision;
          writeReviewAiGuard(reviewRoot, acquired.lock);
        }
        return json(res, 200, {
          ok: true,
          ...(running ? { comment: running.comment } : {}),
          lock: {
            token: acquired.lock.token,
            pagePath: acquired.lock.pagePath,
            scope: acquired.lock.scope,
            commentRevision: acquired.lock.commentRevision,
            pageSha256: acquired.lock.pageSha256,
            createdAt: acquired.lock.createdAt,
            expiresAt: acquired.lock.expiresAt,
          },
        });
      } catch (error) {
        return json(res, error?.code ? 409 : 400, {
          error: error instanceof Error ? error.message : String(error),
          ...(error?.code ? { code: error.code } : {}),
          ...(error?.missingElementIds ? { missingElementIds: error.missingElementIds } : {}),
          ...(error?.expected ? { expected: error.expected, actual: error.actual } : {}),
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/reviews/ai-lock/batch") {
      try {
        const body = await readBody(req);
        const reviewRoot = reviewProjectPath(body?.project);
        reconcileOrphanedAiReviews(native, reviewRoot);
        const started = await startReviewBatch(native, reviewRoot, body?.items, body?.brief);
        if (started.error) return json(res, 400, { error: started.error });
        if (started.stale?.length) {
          return json(res, 409, {
            error: "review batch targets changed content",
            code: "REVIEW_BATCH_CONFLICT",
            stale: started.stale,
          });
        }
        if (started.conflict) {
          return json(res, 409, {
            error: "another AI review is already editing this project",
            code: "AI_REVIEW_LOCKED",
            lock: {
              pagePath: started.lock.pagePath,
              createdAt: started.lock.createdAt,
            },
          });
        }
        return json(res, 200, {
          ok: true,
          token: started.token,
          expiresAt: started.expiresAt,
          items: started.items,
          submission: started.submission,
        });
      } catch (error) {
        return json(res, 400, {
          error: error instanceof Error ? error.message : String(error),
          ...(error?.code ? { code: error.code } : {}),
          ...(error?.expected ? { expected: error.expected, actual: error.actual } : {}),
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/reviews/ai-lock/batch/apply") {
      try {
        const body = await readBody(req);
        const reviewRoot = reviewProjectPath(body?.project);
        const finished = await finishReviewBatch(native, reviewRoot, body?.token, "applied");
        if (finished.error) return json(res, 409, finished);
        return json(res, 200, finished);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/reviews/ai-lock/batch/cancel") {
      try {
        const body = await readBody(req);
        const reviewRoot = reviewProjectPath(body?.project);
        const failed = typeof body?.error === "string" && body.error.trim() ? body.error.trim() : "";
        const finished = await finishReviewBatch(
          native,
          reviewRoot,
          body?.token,
          failed ? "failed" : "cancelled",
          failed,
        );
        if (finished.error) return json(res, 409, finished);
        return json(res, 200, finished);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/reviews/ai-lock/renew") {
      const body = await readBody(req).catch(() => ({}));
      const renewed = renewReviewAiLock(body?.token);
      if (!renewed) {
        return json(res, 409, {
          error: "AI review lock is no longer active",
          code: "AI_REVIEW_LOCK_MISMATCH",
        });
      }
      return json(res, 200, {
        ok: true,
        lock: {
          pagePath: renewed.pagePath,
          expiresAt: renewed.expiresAt,
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/api/reviews/ai-lock/verify") {
      const body = await readBody(req).catch(() => ({}));
      // Verification is the last safety gate before accepting an AI write.
      // Renew first so the following acknowledgement cannot race a near-expiry
      // lease while the browser is deciding whether to restore.
      const current = renewReviewAiLock(body?.token);
      if (!current) {
        return json(res, 409, {
          error: "AI review lock is no longer active",
          code: "AI_REVIEW_LOCK_MISMATCH",
        });
      }
      try {
        const verification = await projectVerificationSnapshot(native, current.root, current.pagePath, {
          // A structural or rewrite lock may delete the anchor page itself.
          allowMissingPage: current.scope?.kind === "deck" &&
            (current.scope?.structureOnly === true || current.scope?.rewrite === true),
        });
        const page = verification.page;
        const targetElementIds = current.scope?.kind === "elements" ? current.scope.elementIds : [];
        const delta = reviewPageDelta(
          page.stableSha256,
          current.pageBody,
          page.pageBody,
          targetElementIds,
        );
        const deckDelta = reviewDeckDelta(
          page.stableSha256,
          current.deckState,
          page.deckState,
        );
        const baselineProjectPages = Array.isArray(current.projectPages)
          ? current.projectPages
          : [{
              pageId: current.scope?.pageId,
              pagePath: current.pagePath,
              pageSha256: current.pageSha256,
            }];
        const beforeById = new Map(baselineProjectPages.map((entry) => [entry.pageId, entry]));
        const afterById = new Map(verification.pages.map((entry) => [entry.pageId, entry]));
        const isWorkspaceEdit = !current.commentId;
        const structural = isWorkspaceEdit && current.scope?.kind === "deck" && current.scope?.structureOnly === true;
        // A rewrite lock inverts the contract: the baseline is disposable and
        // the committed plan decides what the deck must become.
        const rewrite = isWorkspaceEdit && current.scope?.kind === "deck" &&
          current.scope?.rewrite === true && current.scope?.structureOnly !== true;
        const targetPageIds = Array.isArray(current.scope?.targetPageIds) && current.scope.targetPageIds.length
          ? current.scope.targetPageIds
          : [current.scope?.pageId].filter(Boolean);
        const targetSet = new Set(targetPageIds);
        const changedTargetPageIds = targetPageIds.filter((pageId) =>
          beforeById.get(pageId)?.pageSha256 !== afterById.get(pageId)?.pageSha256);
        const deletableScopeIds = structural && Array.isArray(current.scope?.deletablePageIds)
          ? new Set(current.scope.deletablePageIds)
          : rewrite ? new Set(targetPageIds) : new Set();
        const missingTargetPageIds = targetPageIds.filter((pageId) => !afterById.has(pageId) && !deletableScopeIds.has(pageId));
        const allPageIds = new Set([...beforeById.keys(), ...afterById.keys()]);
        // Structural edits are judged on the page list itself: new pages must
        // land contiguously at insertIndex, every baseline page must keep its
        // hash and relative order, and nothing may be removed.
        let addedPageIds = [];
        let removedPageIds = [];
        let modifiedBaselinePageIds = [];
        let allowedModifiedPageIds = [];
        let orderViolation = false;
        let positionViolation = false;
        let countViolation = false;
        let removalViolation = false;
        let reorderApplied = false;
        let reorderScopeIds = [];
        let rewritePlanPageIds;
        let rewriteMismatch = false;
        if (rewrite) {
          addedPageIds = [...afterById.keys()].filter((pageId) => !beforeById.has(pageId));
          removedPageIds = [...beforeById.keys()].filter((pageId) => !afterById.has(pageId));
          // Under a rewrite every baseline page may change or disappear — the
          // "modified" list is informational, not a violation.
          modifiedBaselinePageIds = [...beforeById.keys()].filter((pageId) =>
            afterById.has(pageId) && beforeById.get(pageId)?.pageSha256 !== afterById.get(pageId)?.pageSha256);
          allowedModifiedPageIds = modifiedBaselinePageIds;
          // The contract: the final manifest equals this turn's committed plan
          // exactly — same ids, same order, no leftovers.
          rewritePlanPageIds = latestCommittedPlanPageIds(current.root, current.createdAt);
          const manifestOrder = verification.pages.map((entry) => entry.pageId);
          rewriteMismatch = !rewritePlanPageIds || !manifestOrder.length ||
            manifestOrder.length !== rewritePlanPageIds.length ||
            manifestOrder.some((pageId, index) => pageId !== rewritePlanPageIds[index]);
        } else if (structural) {
          // Baseline pages listed in editablePageIds may change content; every
          // other baseline page must keep its semantic hash.
          const editableSet = new Set(
            Array.isArray(current.scope?.editablePageIds) ? current.scope.editablePageIds : [],
          );
          const deletableSet = deletableScopeIds;
          addedPageIds = [...afterById.keys()].filter((pageId) => !beforeById.has(pageId));
          removedPageIds = [...beforeById.keys()].filter((pageId) => !afterById.has(pageId));
          modifiedBaselinePageIds = [...beforeById.keys()].filter((pageId) =>
            afterById.has(pageId) && beforeById.get(pageId)?.pageSha256 !== afterById.get(pageId)?.pageSha256);
          allowedModifiedPageIds = modifiedBaselinePageIds.filter((pageId) => editableSet.has(pageId));
          const illegalModified = modifiedBaselinePageIds.filter((pageId) => !editableSet.has(pageId));
          modifiedBaselinePageIds = illegalModified;
          // Removals are exact: every deletable page must be gone and nothing
          // else may disappear. A partial delete is as much a failure as an
          // unauthorized one.
          removalViolation = removedPageIds.length !== deletableSet.size ||
            removedPageIds.some((pageId) => !deletableSet.has(pageId));
          const beforeSurvivors = baselineProjectPages.map((entry) => entry.pageId).filter((pageId) => afterById.has(pageId));
          const afterSurvivors = verification.pages.map((entry) => entry.pageId).filter((pageId) => beforeById.has(pageId));
          reorderScopeIds = Array.isArray(current.scope?.reorderPageIds) ? current.scope.reorderPageIds : [];
          if (reorderScopeIds.length) {
            // A reorder lock judges order exactly: the after-order must equal
            // the authorized permutation — anything else is a violation.
            const manifestOrder = verification.pages.map((entry) => entry.pageId);
            orderViolation = manifestOrder.length !== reorderScopeIds.length ||
              manifestOrder.some((pageId, index) => pageId !== reorderScopeIds[index]);
            reorderApplied = !orderViolation;
          } else {
            orderViolation = page.stableSha256(beforeSurvivors) !== page.stableSha256(afterSurvivors);
          }
          const hasInsert = Number.isSafeInteger(Number(current.scope?.insertIndex));
          const insertIndex = hasInsert ? Number(current.scope.insertIndex) : beforeSurvivors.length;
          const afterOrder = verification.pages.map((entry) => entry.pageId);
          positionViolation = addedPageIds.length > 0 &&
            (!hasInsert ||
              afterOrder.slice(insertIndex, insertIndex + addedPageIds.length).some((pageId, index) => pageId !== addedPageIds[index]));
          const expectedAddCount = Number(current.scope?.expectedAddCount);
          // An add-authorized lock requires its pages: exact count when the
          // request named one, at least one otherwise. A lock without an
          // insertIndex (pure delete/merge) forbids additions outright.
          countViolation = !hasInsert
            ? addedPageIds.length > 0
            : Number.isSafeInteger(expectedAddCount) && expectedAddCount >= 1
              ? addedPageIds.length !== expectedAddCount
              : addedPageIds.length < 1;
        }
        const changedOutsideTargetPageIds = structural
          // For a structural lock, the pages outside the add-authorization are
          // exactly the baseline pages that moved without an editable grant.
          ? modifiedBaselinePageIds
          : rewrite
            // Every baseline page is inside the rewrite's target set already.
            ? []
            : [...allPageIds].filter((pageId) =>
                !targetSet.has(pageId) && beforeById.get(pageId)?.pageSha256 !== afterById.get(pageId)?.pageSha256);
        const workspaceScopeViolation = changedOutsideTargetPageIds.length > 0 || missingTargetPageIds.length > 0;
        // Deck metadata is a per-field grant: editableMeta whitelists title
        // and/or theme; a rewrite lock covers both implicitly. Any other
        // metadata movement is a violation exactly as before.
        const metaAllowed = new Set(
          Array.isArray(current.scope?.editableMeta) ? current.scope.editableMeta : [],
        );
        const titleViolation = deckDelta.deckTitleChanged && !(metaAllowed.has("title") || rewrite);
        const themeViolation = deckDelta.deckThemeChanged && !(metaAllowed.has("theme") || rewrite);
        const changedMetaFields = [
          deckDelta.deckTitleChanged && metaAllowed.has("title") ? "title" : "",
          deckDelta.deckThemeChanged && metaAllowed.has("theme") ? "theme" : "",
        ].filter(Boolean);
        // A metaOnly lock authorizes deck fields and nothing else: every page
        // — including the anchor — must stay byte-identical and the manifest
        // must not move. A page delta here is a violation, not progress.
        const metaOnly = isWorkspaceEdit && current.scope?.metaOnly === true;
        const structuralChanged = addedPageIds.length > 0 || allowedModifiedPageIds.length > 0 ||
          removedPageIds.length > 0 || reorderApplied || changedMetaFields.length > 0;
        const structuralViolation = removalViolation || modifiedBaselinePageIds.length > 0 ||
          orderViolation || positionViolation || countViolation || titleViolation || themeViolation;
        // A rewrite changed something when any page delta or the deck-level
        // metadata moved; its violation is the plan/manifest mismatch alone —
        // title and theme are allowed to move with the new plan.
        const rewriteChanged = addedPageIds.length > 0 || removedPageIds.length > 0 ||
          allowedModifiedPageIds.length > 0 ||
          JSON.stringify(verification.pages.map((entry) => entry.pageId)) !==
            JSON.stringify(baselineProjectPages.map((entry) => entry.pageId)) ||
          deckDelta.deckTitleChanged || deckDelta.deckThemeChanged;
        const result = {
          ok: true,
          pagePath: current.pagePath,
          pageSha256: page.pageSha256,
          changed: isWorkspaceEdit
            ? (metaOnly ? changedMetaFields.length > 0 : structural ? structuralChanged : rewrite ? rewriteChanged : changedTargetPageIds.length > 0 || changedMetaFields.length > 0)
            : Boolean(current.pageSha256 && current.pageSha256 !== page.pageSha256),
          scope: current.scope,
          targetElementIds,
          ...delta,
          ...deckDelta,
          ...(isWorkspaceEdit ? {
            targetChanged: metaOnly ? changedMetaFields.length > 0 : structural ? structuralChanged : rewrite ? rewriteChanged : changedTargetPageIds.length > 0 || changedMetaFields.length > 0,
            targetPageIds,
            changedTargetPageIds: structural
              ? [...addedPageIds, ...allowedModifiedPageIds, ...removedPageIds, ...(reorderApplied ? reorderScopeIds : [])]
              : rewrite
                ? [...addedPageIds, ...modifiedBaselinePageIds, ...removedPageIds]
                : changedTargetPageIds,
            missingTargetPageIds,
            changedOutsideTargetPageIds,
            changedMetaFields,
            ...(structural ? {
              addedPageIds,
              removedPageIds,
              modifiedBaselinePageIds,
              allowedModifiedPageIds,
              orderViolation,
              positionViolation,
              countViolation,
              removalViolation,
            } : {}),
            ...(rewrite ? {
              rewriteMismatch,
              rewritePlanPageIds,
              addedPageIds,
              removedPageIds,
              modifiedBaselinePageIds,
            } : {}),
          } : {}),
          scopeViolation: metaOnly
            // Under a meta lock every page must stay frozen — the anchor
            // page moving is as much a violation as any other page.
            ? changedTargetPageIds.length > 0 || workspaceScopeViolation ||
              titleViolation || themeViolation || deckDelta.deckPageOrderChanged
            : structural
            ? structuralViolation
            : rewrite
              ? rewriteMismatch
              : (isWorkspaceEdit
                ? workspaceScopeViolation || (current.scope?.kind === "elements" && delta.scopeViolation)
                : delta.scopeViolation) || titleViolation || themeViolation || deckDelta.deckPageOrderChanged,
        };
        if (isWorkspaceEdit) {
          current.workspaceVerified = result.changed && !result.scopeViolation;
          // Verified page removals orphan their comment threads: keep the
          // record but mark it so the UI can show "page deleted" instead of a
          // live pin.
          if (current.workspaceVerified && (structural || rewrite) && removedPageIds.length) {
            const gonePaths = new Set(
              removedPageIds
                .map((pageId) => beforeById.get(pageId)?.pagePath)
                .filter(Boolean),
            );
            markReviewThreadsPageGone(current.root, gonePaths);
          }
        }
        if (body?.accept === true) {
          if (!(isWorkspaceEdit ? result.targetChanged : delta.targetChanged)) {
            return json(res, 409, {
              ...result,
              ok: false,
              error: "Agent finished without changing the review target",
              code: "AI_REVIEW_NO_TARGET_CHANGE",
            });
          }
          if (result.scopeViolation) {
            return json(res, 409, {
              ...result,
              ok: false,
              error: "Agent changed content outside the review target",
              code: "AI_REVIEW_SCOPE_VIOLATION",
            });
          }
          const comment = findReviewThread(current.root, current.pagePath, current.commentId);
          if (!comment || comment.revision !== current.commentRevision || Number(body?.commentRevision) !== comment.revision) {
            return json(res, 409, {
              ...result,
              ok: false,
              error: "review comment changed before Agent completion was recorded",
              code: "REVIEW_COMMENT_CONFLICT",
              ...(comment ? { comment } : {}),
            });
          }
          const applied = upsertReviewThread(native, current.root, current.pagePath, {
            ...comment,
            revision: comment.revision,
            aiStatus: "applied",
            aiAppliedAt: new Date().toISOString(),
            aiError: undefined,
          }, { scope: current.scope, allowApplied: true });
          if (applied.conflict) {
            return json(res, 409, {
              ...result,
              ok: false,
              error: "review comment changed before Agent completion was recorded",
              code: applied.code || "REVIEW_COMMENT_CONFLICT",
              comment: applied.comment,
            });
          }
          return json(res, 200, { ...result, comment: applied.comment });
        }
        return json(res, 200, result);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "DELETE" && url.pathname === "/api/reviews/ai-lock") {
      const body = await readBody(req).catch(() => ({}));
      const current = reviewAiLockByToken(body?.token);
      if (current?.snapshotVersionId && !current.commentId && !current.items?.length) {
        native.store.recordAssistantVersionOutcome(current.root, current.snapshotVersionId,
          current.restored ? "restored" : current.workspaceVerified ? "applied" : "unchanged");
      }
      const released = current
        ? releaseReviewAiLock(current.root, String(body?.token || ""))
        : { released: false };
      if (!released.released) {
        return json(res, 409, {
          error: "AI review lock token mismatch",
          code: "AI_REVIEW_LOCK_MISMATCH",
        });
      }
      return json(res, 200, { ok: true, released: true });
    }

    if (url.pathname.startsWith("/api/pi/")) {
      return json(res, 410, {
        error: "Pi login routes are not on the product path. Use /slides/providers.",
        kernel: "dsh",
      });
    }

    if (req.method === "GET" && url.pathname === "/api/versions") {
      const projectRoot = projectForRequest(url, null);
      await ensureSession(native, projectRoot);
      const liveRevision = projectDiskRevision(projectRoot);
      const versionList = native.store.listVersions(projectRoot);
      const versions = versionList.map((v) => {
        try {
          const versionRoot = native.store.versionDir(projectRoot, v.id);
          const preview = native.canvas.openSession(versionRoot, {
            allowedControlIds: [],
          });
          return {
            ...v,
            thumbs: native.canvas.renderAllPages(preview),
            revision: projectDiskRevision(versionRoot),
          };
        } catch {
          return v;
        }
      });
      const latest = versions.at(-1);
      const currentVersionId = latest?.revision === liveRevision ? latest.id : undefined;
      return json(res, 200, { versions, currentVersionId });
    }

    const versionPreview = url.pathname.match(/^\/api\/versions\/([^/]+)$/);
    if (req.method === "GET" && versionPreview) {
      const projectRoot = projectForRequest(url, null);
      const live = await ensureSession(native, projectRoot);
      const id = decodeURIComponent(versionPreview[1] || "");
      const meta = native.store.listVersions(projectRoot).find((v) => v.id === id);
      if (!meta) return json(res, 404, { error: `version not found: ${id}` });
      const vdir = native.store.versionDir(projectRoot, id);
      const preview = native.canvas.openSession(vdir, { allowedControlIds: [] });
      preview.pageIndex = live?.pageIndex ?? 0;
      if (preview.pageIndex >= preview.project.pages.length) preview.pageIndex = 0;
      return json(res, 200, {
        version: meta,
        model: native.canvas.renderModel(preview),
        thumbs: native.canvas.renderAllPages(preview),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/versions") {
      const body = await readBody(req).catch(() => null);
      // `aiLockToken` was emitted by an earlier browser build. Keep accepting
      // it during rolling upgrades, while `lockToken` remains the canonical
      // request field and the only value used by current clients/tests.
      const lockToken = nonEmptyString(body?.lockToken || body?.aiLockToken);
      // A snapshot is part of the same AI review transaction; refresh the
      // lease before persisting its version id and re-writing the guard.
      const reviewLock = lockToken ? renewReviewAiLock(lockToken) : undefined;
      const projectRoot = projectForRequest(url, body, { strict: true });
      const currentLock = activeReviewAiLock(projectRoot);
      if (lockToken && !reviewLock) {
        return json(res, 409, { error: "AI review lock token mismatch", code: "AI_REVIEW_LOCK_MISMATCH" });
      }
      if (!lockToken && currentLock) {
        return json(res, 423, { error: "AI review snapshot requires its lock token", code: "AI_REVIEW_LOCKED" });
      }
      const snapshotRoot = reviewLock?.root ?? projectRoot;
      const meta = native.pptd.withProjectWriteLock(snapshotRoot, () => {
        if (path.resolve(projectRoot) === snapshotRoot) {
          const s = ensureSession(native, projectRoot);
          persistLiveSession(native, s, projectRoot);
        }
        // The cross-process guard is coordination state, not version content.
        // Keep it live around the snapshot while omitting it from the archive.
        if (reviewLock) removeReviewAiGuard(snapshotRoot);
        try {
          return native.store.snapshotVersion(snapshotRoot, {
            label: String(body?.label || "").trim() || undefined,
            note: body?.note ? String(body.note) : undefined,
            assistantRequestId: reviewLock && !reviewLock.commentId ? body?.assistantRequestId : undefined,
          });
        } finally {
          if (reviewLock) writeReviewAiGuard(snapshotRoot, reviewLock);
        }
      });
      if (reviewLock) reviewLock.snapshotVersionId = meta.id;
      return json(res, 200, {
        ok: true,
        version: meta,
        versions: native.store.listVersions(snapshotRoot),
        lockRoot: reviewLock?.root,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/versions/restore") {
      const body = await readBody(req);
      const id = String(body?.id || "");
      if (!id) return json(res, 400, { error: "missing version id" });
      const lockToken = nonEmptyString(body?.lockToken || body?.aiLockToken);
      // Restore can follow a slow model stop. Renew immediately before the
      // destructive transaction so its guard remains valid throughout it.
      const reviewLock = lockToken ? renewReviewAiLock(lockToken) : undefined;
      const projectRoot = projectForRequest(url, body, { strict: true });
      const currentLock = activeReviewAiLock(projectRoot);
      if (lockToken && !reviewLock) {
        return json(res, 409, { error: "AI review lock token mismatch", code: "AI_REVIEW_LOCK_MISMATCH" });
      }
      if (!lockToken && currentLock) {
        return json(res, 423, { error: "AI review restore requires its lock token", code: "AI_REVIEW_LOCKED" });
      }
      if (reviewLock && reviewLock.snapshotVersionId !== id) {
        return json(res, 409, {
          error: "version does not belong to this AI review lock",
          code: "AI_REVIEW_SNAPSHOT_MISMATCH",
        });
      }
      const restoreRoot = reviewLock?.root ?? projectRoot;
      try {
        native.store.versionDir(restoreRoot, id);
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      let transaction;
      try {
        transaction = native.pptd.withProjectWriteLock(restoreRoot, () => {
          // This is one read/persist/snapshot/restore/reopen transaction. The
          // nested PPTD/store operations are reentrant, so a DSH writer can
          // only run before it starts or after it finishes—not between the
          // automatic pre-restore backup and the destructive restore.
          const sourceVersion = native.store.listVersions(restoreRoot).find((version) => version.id === id);
          if (!sourceVersion) return { missing: true };
          if (!reviewLock && path.resolve(projectRoot) === restoreRoot) {
            const s = ensureSession(native, projectRoot);
            persistLiveSession(native, s, projectRoot);
          }
          try {
            const latestReviews = captureProjectFile(restoreRoot, REVIEW_THREADS_REL);
            // A document version restores pages and their validation ledger.
            // Conversation, provider binding and live turn history stay current.
            const conversationFiles = ["comment-submissions.v1.json", "assistant-conversation.v1.json", "assistant-questions.v1.json", "agent-trace.jsonl", "attempt.v1.json", "dsh-agent-error.json", "dsh-rate-limit-wait.json", "slice-session.v1.json", "presentation-run.v1.json", "runtime.json", "dsh-runtime.json"];
            const latestConversation = conversationFiles.map((name) => [`_agent/${name}`, captureProjectFile(restoreRoot, `_agent/${name}`)]);
            if (reviewLock) removeReviewAiGuard(restoreRoot);
            let beforeRestore;
            try {
              beforeRestore = native.store.snapshotVersion(restoreRoot, { label: "恢复前" });
            } finally {
              if (reviewLock) writeReviewAiGuard(restoreRoot, reviewLock);
            }
            waitForRestoreBarrier();
            native.store.restoreVersion(restoreRoot, id);
            // The restored AI baseline deliberately omits the coordination
            // guard. Recreate it immediately, before any later file operation
            // can fail, so an in-flight DSH process never sees an unlocked
            // project while the server still owns the review transaction.
            if (reviewLock) writeReviewAiGuard(restoreRoot, reviewLock);
            restoreProjectFile(restoreRoot, REVIEW_THREADS_REL, latestReviews);
            for (const [name, bytes] of latestConversation) restoreProjectFile(restoreRoot, name, bytes);
            if (reviewLock) removeReviewAiGuard(restoreRoot);
            let restored;
            try {
              restored = native.store.snapshotVersion(restoreRoot, { label: `从 ${id} 恢复` });
            } finally {
              if (reviewLock) writeReviewAiGuard(restoreRoot, reviewLock);
            }
            const restoredSession = openLiveSession(native, restoreRoot);
            return {
              beforeRestore,
              restored,
              versions: native.store.listVersions(restoreRoot),
              session: restoredSession,
            };
          } finally {
            // Keep the cross-process guard present for every failure path.
            // Only DELETE /api/reviews/ai-lock is allowed to remove it after
            // the client has settled the AI turn and its review revision.
            if (reviewLock) writeReviewAiGuard(restoreRoot, reviewLock);
          }
        });
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      if (transaction.missing) return json(res, 404, { error: `version not found: ${id}` });
      if (reviewLock) reviewLock.restored = true;
      return json(res, 200, {
        ok: true,
        version: transaction.restored,
        versions: transaction.versions,
        model: liveModel(native, transaction.session),
        thumbs: native.canvas.renderAllPages(transaction.session),
        reviewsPreserved: true,
        lockRoot: reviewLock?.root,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/catalog/shapes") {
      const shapes = native.pptd.SHAPE_CATALOG.map((s) => {
        const g = native.pptd.shapeGeometry(s.name, s.defaults);
        return { ...s, pathD: g.fill || "", pathStroke: g.stroke || "" };
      });
      return json(res, 200, { shapes });
    }

    if (req.method === "GET" && url.pathname === "/api/shape-geometry") {
      const name = String(url.searchParams.get("name") || "").trim();
      if (!name) return json(res, 400, { error: "name required" });
      const adjRaw = String(url.searchParams.get("adj") || "").trim();
      const adj = adjRaw
        ? adjRaw.split(",").map((n) => Number(n)).filter((n) => Number.isFinite(n))
        : undefined;
      const g = native.pptd.shapeGeometry(name, adj);
      return json(res, 200, {
        name,
        pathD: g.fill || "",
        pathStroke: g.stroke || "",
        handles: g.handles || [],
      });
    }

    if (req.method === "GET" && url.pathname === "/api/projects") {
      return json(res, 200, { projects: discoverProjects() });
    }

    if (req.method === "DELETE" && url.pathname === "/api/projects") {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: "invalid JSON body" });
      }
      const target = body?.path ?? body?.id;
      if (!target || typeof target !== "string") {
        return json(res, 400, { error: "path required" });
      }
      try {
        deleteProject(DATA_ROOT, target);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "无法删除该项目" });
      }
      return json(res, 200, { ok: true, projects: discoverProjects() });
    }

    if (req.method === "POST" && url.pathname === "/api/attachments/demo") {
      const created = DEMO_BRAND_FILES.map((file) =>
        storeAttachment(file.name, Buffer.from(file.text, "utf8")),
      );
      return json(res, 200, { attachments: created.map(attachmentPublic) });
    }

    if (req.method === "POST" && url.pathname === "/api/attachments") {
      const body = await readBody(req);
      const name = String(body?.name || "").trim();
      if (!name) return json(res, 400, { error: "name required" });
      const data = String(body?.data || "");
      if (!data) return json(res, 400, { error: "data required" });
      let buf;
      try {
        buf = decodeDataUrl(data);
      } catch {
        return json(res, 400, { error: "invalid data URL" });
      }
      if (!buf.length) return json(res, 400, { error: "empty file" });
      if (buf.length > 20 * 1024 * 1024) {
        return json(res, 413, { error: "file larger than 20MB" });
      }
      const parsed = parseAttachmentBuffer(name, buf);
      if (!parsed.parsed) {
        return json(res, 415, {
          error: parsed.note || "attachment format is not readable by the Agent",
          code: "UNSUPPORTED_AGENT_ATTACHMENT",
        });
      }
      const rec = storeAttachment(name, buf);
      return json(res, 200, attachmentPublic(rec));
    }

    const attachGet = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
    if (req.method === "GET" && attachGet) {
      const id = decodeURIComponent(attachGet[1] || "");
      try {
        const rec = attachmentStore.read(id);
        if (!rec) return json(res, 404, { error: `attachment not found: ${id}` });
        return json(res, 200, rec);
      } catch (error) {
        return json(res, 400, { error: error.message, code: "invalid_attachment" });
      }
    }

    if (req.method === "DELETE" && attachGet) {
      const id = decodeURIComponent(attachGet[1] || "");
      try {
        if (!attachmentStore.delete(id)) return json(res, 404, { error: `attachment not found: ${id}` });
        return json(res, 200, { ok: true, id });
      } catch (error) {
        return json(res, 400, { error: error.message, code: "invalid_attachment" });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/generate") {
      return json(res, 410, {
        error: "Hub generate uses DSH. POST /slides/sessions. createPiBrain is not the product path.",
        kernel: "dsh",
      });
    }

    if (req.method === "POST" && url.pathname === "/api/load-image") {
      // load-image creates a brand-new project, so it never disturbs another
      // project's live session. Locks still guard their own project below.
      const body = await readBody(req);
      const src = String(body?.src || "").trim();
      if (!src || !/\.(png|jpe?g|gif|webp)$/i.test(src)) {
        return json(res, 400, { error: "src must be a png/jpg/gif/webp path" });
      }
      const abs = path.isAbsolute(src) ? path.resolve(src) : path.resolve(ROOT, src);
      // The source must live under an allowed project root — otherwise this
      // endpoint is a local-file exfiltration channel via /media.
      let realAbs = abs;
      try {
        if (fs.existsSync(abs)) realAbs = fs.realpathSync(abs);
      } catch {
        realAbs = abs;
      }
      if (!projectRootAllowed(realAbs)) {
        return json(res, 403, { error: "src must be inside the workspace" });
      }
      if (!fs.existsSync(realAbs)) return json(res, 404, { error: `not found: ${src}` });
      const dest = path.join(DATA_ROOT, "output", `img-${Date.now()}`);
      fs.mkdirSync(path.join(dest, "media"), { recursive: true });
      const file = path.join(dest, "media", path.basename(realAbs));
      fs.copyFileSync(realAbs, file);
      native.pptd.createEmptyProject(dest, { title: path.basename(abs, path.extname(abs)) });
      lastProjectPath = dest;
      const session = openLiveSession(native, dest, 0);
      native.canvas.addBlankPage(session, "chrome.pages.add");
      native.canvas.insertImage(session, "insert.image", `media/${path.basename(abs)}`);
      persistLiveSession(native, session, dest);
      return json(res, 200, {
        ok: true,
        path: dest,
        model: liveModel(native, session),
        thumbs: native.canvas.renderAllPages(session),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/refine") {
      return json(res, 410, {
        error: "旧的规则式 Refine 已移除；编辑器修改必须交给 DSH Agent。",
        code: "LEGACY_REFINE_REMOVED",
        kernel: "dsh",
      });
    }

    if (req.method === "GET" && url.pathname === "/api/export/formats") {
      return json(res, 200, {
        formats: [
          { id: "pptx", label: "PPTX", enabled: true, controlId: "chrome.export.pptx" },
          { id: "pdf", label: "PDF 全稿", enabled: true, controlId: "chrome.export.pdf" },
          { id: "png", label: "PNG 当前页", enabled: true, controlId: "chrome.export.image" },
        ],
      });
    }

    if (req.method === "POST" && url.pathname === "/api/open") {
      const body = await readBody(req);
      const p = resolveProjectPath(body?.path);
      if (!fs.existsSync(p)) return json(res, 404, { error: `not found: ${p}` });
      if (String(req.headers["x-openslides-project-view"] || "").toLowerCase() === "isolated") {
        const isolatedSession = native.pptd.withProjectWriteLock(p, () =>
          native.canvas.openSession(p, {
            allowedControlIds: ORACLE_CONTROLS,
            pageIndex: parsePageHint(url, body) ?? 0,
          })
        );
        return json(res, 200, {
          ok: true,
          isolated: true,
          model: liveModel(native, isolatedSession),
          thumbs: native.canvas.renderAllPages(isolatedSession),
          llmConfigured: Boolean(harnessLlmConfig()),
        });
      }
      // Sessions are per project: opening another project no longer disturbs
      // a locked review elsewhere. Mutating the locked project itself still
      // requires its lock token (see /api/command and /api/versions).
      lastProjectPath = p;
      const session = openLiveSession(native, p, parsePageHint(url, body));
      return json(res, 200, {
        ok: true,
        model: liveModel(native, session),
        thumbs: native.canvas.renderAllPages(session),
        llmConfigured: Boolean(harnessLlmConfig()),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/generate-status") {
      return json(res, 410, {
        error: "Use GET /slides/state/:sessionId. createPiBrain provenance is not the product path.",
        kernel: "dsh",
      });
    }

    if (req.method === "GET" && url.pathname === "/api/cover-raster") {
      let root = path.resolve(lastProjectPath);
      const raw = String(url.searchParams.get("path") || "").trim();
      if (raw) {
        try {
          root = resolveOutputProject(DATA_ROOT, raw);
        } catch (e) {
          return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      const file = coverRasterFile(root);
      if (!file) return json(res, 404, { error: "no cover raster" });
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/model") {
      const projectRoot = projectForRequest(url, null);
      const tabId = tabIdFor(url, null);
      const s = await ensureSession(native, projectRoot, parsePageHint(url, null), tabId);
      rememberPage(s, projectRoot);
      return json(res, 200, {
        model: liveModel(native, s),
        thumbs: native.canvas.renderAllPages(s),
        revision: liveEntryFor(projectRoot, tabId).diskRevision,
        llmConfigured: Boolean(harnessLlmConfig()),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/command") {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: "invalid JSON body" });
      }
      const projectRoot = projectForRequest(url, body, { strict: true });
      const tabId = tabIdFor(url, body);
      const baseSession = await ensureSession(native, projectRoot, undefined, tabId);
      let s = baseSession;
      const cmd = body && typeof body === "object" ? body.cmd : undefined;
      const mutatesProject = PROJECT_MUTATING_COMMANDS.has(cmd);
      const reviewLock = activeReviewAiLock(projectRoot);
      const reviewSafeCommands = new Set(["goToPage", "zoom", "pageRail", "notes", "present", "select", "tabSelect"]);
      if (reviewLock && !reviewSafeCommands.has(cmd)) {
        return json(res, 423, {
          error: "AI 正在按批注修改文稿；当前版本已受保护。",
          code: "AI_REVIEW_LOCKED",
          pagePath: reviewLock.pagePath,
        });
      }
      try {
        // Optimistic concurrency: a mutating command may pin the disk
        // revision it was issued against; a stale base answers 409.
        if (mutatesProject) {
          const expected = nonEmptyString(body.baseRevision);
          const current = liveEntryFor(projectRoot, tabId).diskRevision;
          if (expected && current && expected !== current) {
            return json(res, 409, {
              error: "base revision mismatch — reload the deck and retry",
              code: "BASE_REVISION_STALE",
              revision: current,
            });
          }
        }
        if (mutatesProject) ensureInitialVersion(native, baseSession, projectRoot, tabId);
        // Mutate a private candidate so validation or persistence failures do
        // not leak half-applied project, history, selection, or chrome state
        // into the live editor session.
        s = structuredClone(baseSession);
        switch (cmd) {
          case "goToPage":
            native.canvas.goToPage(s, requireInt(body.index, "index"));
            break;
          case "zoom":
            if (body.percent != null && body.percent !== "") {
              native.canvas.setZoomPercent(
                s,
                "chrome.zoom.percent",
                requireFinite(body.percent, "percent"),
              );
            } else {
              native.canvas.zoomBy(
                s,
                body.direction === "out" ? "chrome.zoom.out" : "chrome.zoom.in",
                body.direction === "out" ? "out" : "in",
              );
            }
            break;
          case "reorderPage":
            native.canvas.reorderPages(
              s,
              "chrome.pages.reorder",
              requireInt(body.fromIndex, "fromIndex"),
              requireInt(body.toIndex, "toIndex"),
            );
            break;
          case "insert": {
            const kind = String(body.kind || "");
            if (kind === "text" && Object.prototype.hasOwnProperty.call(body, "text")) {
              if (typeof body.text !== "string") {
                return json(res, 400, {
                  error: "insert text must be a string",
                  code: "INVALID_INSERT_TEXT",
                });
              }
              if (body.text.length > native.canvas.MAX_INSERT_TEXT_LENGTH) {
                return json(res, 400, {
                  error: `insert text exceeds ${native.canvas.MAX_INSERT_TEXT_LENGTH} characters`,
                  code: "INSERT_TEXT_TOO_LONG",
                  maxLength: native.canvas.MAX_INSERT_TEXT_LENGTH,
                });
              }
            }
            const map = {
              text: () => native.canvas.insertText(s, "insert.text", body.text),
              shape: () =>
                native.canvas.insertShape(
                  s,
                  "insert.shape",
                  String(body.shapeName || "roundRect"),
                ),
              image: () =>
                native.canvas.insertImage(
                  s,
                  "insert.image",
                  body.src ? String(body.src) : undefined,
                ),
              table: () => native.canvas.insertTable(
                s,
                "insert.table",
                body.rows == null ? 2 : requireInt(body.rows, "rows"),
                body.columns == null ? 2 : requireInt(body.columns, "columns"),
              ),
              chart: () => native.canvas.insertChart(s, "insert.chart"),
              line: () => native.canvas.insertLine(s, "insert.line"),
              icon: () =>
                native.canvas.insertIcon(
                  s,
                  "insert.icon",
                  String(body.iconName || "fas:star"),
                ),
              smartart: () =>
                native.canvas.insertSmartArt(
                  s,
                  "insert.smartart",
                  body.layout === "cycle" || body.layout === "hierarchy"
                    ? body.layout
                    : "process",
                  Array.isArray(body.labels) ? body.labels.map(String) : undefined,
                ),
            };
            const fn = map[kind];
            if (!fn) return json(res, 400, { error: `unknown insert kind: ${kind}` });
            fn();
            break;
          }
          case "pageRail":
            native.canvas.setPageRailOpen(
              s,
              "chrome.pages.rail.toggle",
              Boolean(body.open),
            );
            break;
          case "notes":
            native.canvas.setNotesOpen(
              s,
              "chrome.notes.toggle",
              Boolean(body.open),
            );
            break;
          case "present":
            native.canvas.setPresenting(
              s,
              "chrome.present.play",
              Boolean(body.on),
            );
            break;
          case "addPage":
            native.canvas.addBlankPage(s, "chrome.pages.add");
            break;
          case "deletePage":
            native.canvas.deletePage(
              s,
              "chrome.pages.delete",
              body.index == null ? s.pageIndex : requireInt(body.index, "index"),
            );
            break;
          case "duplicatePage":
            native.canvas.duplicatePage(
              s,
              "chrome.pages.duplicate",
              body.index == null ? s.pageIndex : requireInt(body.index, "index"),
            );
            break;
          case "select":
            if (Array.isArray(body.elementIds)) {
              native.canvas.selectMany(s, body.elementIds.map(String));
            } else if (body.elementId) {
              native.canvas.selectElement(s, String(body.elementId));
            } else {
              native.canvas.clearSelection(s);
            }
            break;
          case "setText":
            native.canvas.setSelectedText(
              s,
              "element.text.content.set",
              String(body.text ?? ""),
            );
            break;
          case "setRichText":
            native.canvas.setSelectedRichText(
              s,
              "element.text.content.set",
              String(body.html ?? ""),
            );
            break;
          case "setTextRangeStyle":
            native.canvas.setSelectedTextRangeStyle(
              s,
              textStyleControlId(body.patch),
              Number(body.start ?? 0),
              Number(body.end ?? 0),
              body.patch || {},
            );
            break;
          case "setBold":
            native.canvas.setSelectedBold(
              s,
              "element.text.toolbar.bold.toggle",
              Boolean(body.bold),
            );
            break;
          case "setTextStyle":
            native.canvas.setSelectedTextStyle(
              s,
              textStyleControlId(body.patch),
              body.patch || {},
            );
            break;
          case "setFill":
            native.canvas.setSelectedFill(
              s,
              body.icon ? "element.icon.color.set" : "element.shape.fill.set",
              body.fill && typeof body.fill === "object"
                ? body.fill
                : String(body.color ?? "#2563EB"),
            );
            break;
          case "setShape":
            native.canvas.setSelectedShapeName(
              s,
              "element.shape.kind.set",
              String(body.shapeName || "roundRect"),
            );
            break;
          case "setBorder":
            native.canvas.setSelectedBorder(s, "element.shape.border.set", body.border || {});
            break;
          case "setRotation":
            native.canvas.setSelectedRotation(
              s,
              "element.rotate.set",
              body.degrees == null ? 0 : requireFinite(body.degrees, "degrees"),
            );
            break;
          case "setOpacity":
            native.canvas.setSelectedOpacity(
              s,
              "element.opacity.set",
              body.opacity == null ? 1 : requireFinite(body.opacity, "opacity"),
            );
            break;
          case "setImageFit":
            native.canvas.setImageFit(s, "element.image.fit.set", String(body.mode || "cover"));
            break;
          case "setImageSrc":
            native.canvas.setImageSrc(s, "element.image.replace", String(body.src || ""));
            break;
          case "setIconName":
            native.canvas.setIconName(s, "element.icon.name.set", String(body.iconName || "fas:star"));
            break;
          case "setLineArrow":
            native.canvas.setLineArrow(
              s,
              "element.line.arrow.set",
              Array.isArray(body.arrow) ? body.arrow : [null, null],
            );
            break;
          case "setAdjustments":
            native.canvas.setSelectedAdjustments(
              s,
              "element.shape.adjust.set",
              Array.isArray(body.adjustments) ? body.adjustments.map(Number) : [],
            );
            break;
          case "setImageCrop":
            native.canvas.setImageCrop(s, "element.image.crop.set", body.crop || {});
            break;
          case "setImageCropShape":
            native.canvas.setImageCropShape(
              s,
              "element.image.mask.set",
              body.cropShape || undefined,
            );
            break;
          case "setLineCurve":
            native.canvas.setLineCurve(s, "element.line.curve.set", String(body.curve || "round"));
            break;
          case "setLineLabel":
            native.canvas.setLineLabel(
              s,
              "element.line.label.set",
              body.label == null ? null : String(body.label),
            );
            break;
          case "setLinePoints":
            native.canvas.setLinePoints(s, "element.line.points.set", String(body.points || ""));
            break;
          case "setAnimations":
            native.canvas.setPageAnimations(
              s,
              "element.animation.timeline.set",
              Array.isArray(body.animations) ? body.animations : [],
            );
            break;
          case "setBounds": {
            const bounds = body.bounds;
            if (!Array.isArray(bounds) || bounds.length !== 4) {
              throw new Error("bounds must be [x,y,w,h] numbers");
            }
            native.canvas.setSelectedBounds(
              s,
              "element.bounds.set",
              bounds.map((n, i) => requireFinite(n, `bounds[${i}]`)),
              typeof body.elementId === "string" && body.elementId ? body.elementId : undefined,
            );
            break;
          }
          case "deleteSelected":
            native.canvas.deleteSelected(s, "element.delete");
            break;
          case "duplicateSelected":
            native.canvas.duplicateSelected(s, "element.duplicate");
            break;
          case "copySelected":
            native.canvas.copySelected(s);
            break;
          case "pasteClipboard":
            native.canvas.pasteClipboard(s, "element.duplicate");
            break;
          case "tabSelect":
            native.canvas.tabSelect(
              s,
              "selection.tab",
              Number(body.dir) === -1 ? -1 : 1,
            );
            break;
          case "arrange": {
            const raw = String(body.dir || "forward");
            const dir =
              raw === "back" || raw === "backward" || raw === "front" || raw === "forward"
                ? raw
                : "forward";
            native.canvas.arrangeSelected(
              s,
              dir === "back" || dir === "backward"
                ? "element.arrange.backward"
                : "element.arrange.forward",
              dir,
            );
            break;
          }
          case "align":
            native.canvas.alignSelected(s, "element.arrange.align.set", String(body.edge || "left"));
            break;
          case "distribute":
            native.canvas.distributeSelected(s, "element.arrange.distribute.set", body.axis === "v" ? "v" : "h");
            break;
          case "flip":
            native.canvas.flipSelected(s, "element.arrange.flip.set", body.axis === "v" ? "v" : "h");
            break;
          case "setTableCell":
            native.canvas.setTableCellText(
              s,
              "element.table.cell.set",
              Number(body.row),
              Number(body.col),
              String(body.text ?? ""),
            );
            break;
          case "tableRow":
            if (body.op === "delete") {
              native.canvas.deleteTableRow(
                s,
                "element.table.row.delete",
                Number.isFinite(Number(body.row)) ? Number(body.row) : -1,
              );
            } else {
              native.canvas.addTableRow(
                s,
                "element.table.row.add",
                Number.isFinite(Number(body.row)) ? Number(body.row) : -1,
              );
            }
            break;
          case "tableCol":
            if (body.op === "delete") {
              native.canvas.deleteTableCol(
                s,
                "element.table.col.delete",
                Number.isFinite(Number(body.col)) ? Number(body.col) : -1,
              );
            } else {
              native.canvas.addTableCol(
                s,
                "element.table.col.add",
                Number.isFinite(Number(body.col)) ? Number(body.col) : -1,
              );
            }
            break;
          case "tableMerge":
            native.canvas.mergeTableCells(
              s,
              "element.table.merge",
              Number(body.r1 ?? 0),
              Number(body.c1 ?? 0),
              Number(body.r2 ?? 0),
              Number(body.c2 ?? 1),
            );
            break;
          case "tableFill":
            native.canvas.setTableCellFill(
              s,
              "element.table.cell.fill.set",
              Number(body.row ?? 0),
              Number(body.col ?? 0),
              String(body.color ?? "#FEF3C7"),
            );
            break;
          case "setChartType":
            native.canvas.setChartType(s, "element.chart.type.set", String(body.type || "bar"));
            break;
          case "setChartTitle":
            native.canvas.setChartTitle(s, "element.chart.title.set", String(body.title ?? ""));
            break;
          case "setChartData":
            native.canvas.setChartData(s, "element.chart.data.set", body.data);
            break;
          case "setChartLegend":
            native.canvas.setChartLegend(s, "element.chart.legend.set", Boolean(body.legend));
            break;
          case "setChartSeriesFill":
            native.canvas.setChartSeriesFill(
              s,
              "element.chart.series.color.set",
              Number(body.index ?? 0),
              String(body.color ?? "#2563EB"),
            );
            break;
          case "smartArtNode":
            if (body.op === "delete") native.canvas.deleteSmartArtNode(s, "element.smartart.node.delete");
            else native.canvas.addSmartArtNode(s, "element.smartart.node.add", body.label ? String(body.label) : undefined);
            break;
          case "setSmartArtLayout":
            native.canvas.setSmartArtLayout(
              s,
              "element.smartart.layout.set",
              body.layout === "cycle" || body.layout === "hierarchy" ? body.layout : "process",
            );
            break;
          case "setBackground":
            native.canvas.setPageBackground(
              s,
              "theme.background.set",
              body.fill && typeof body.fill === "object"
                ? body.fill
                : String(body.color ?? "#FFFFFF"),
            );
            break;
          case "setThemeColor":
            native.canvas.setThemeColor(
              s,
              "theme.color.set",
              String(body.key || "primary"),
              String(body.color ?? "#2563EB"),
            );
            break;
          case "setLocked":
            native.canvas.setSelectedLocked(s, "element.lock.toggle", Boolean(body.locked));
            break;
          case "setHidden":
            native.canvas.setSelectedHidden(s, "element.visibility.toggle", Boolean(body.hidden));
            break;
          case "group":
            native.canvas.groupSelected(s, "element.group.set");
            break;
          case "ungroup":
            native.canvas.ungroupSelected(s, "element.ungroup.set");
            break;
          case "rebuildImage": {
            // Multimodal LLM reads the image when configured; otherwise the
            // prompt-label path stays. No separate OCR/VLM service.
            let labels;
            let mode = "prompt";
            const cfg = harnessLlmConfig();
            const el = native.canvas.getSelectedElement(s);
            if (cfg && el?.src && !el.src.startsWith("data:")) {
              try {
                const presentation = await import(
                  runtimeImport("@open-slidestudio/presentation-run"),
                );
                const nodes = await presentation.rebuildNodesFromImage(
                  cfg,
                  path.join(s.project.rootDir, el.src),
                  body.prompt ? String(body.prompt) : undefined,
                );
                labels = nodes.map((n) => n.text);
                mode = "llm";
              } catch (e) {
                mode = "prompt";
                console.warn("[rebuild] LLM image read failed, prompt fallback:", e instanceof Error ? e.message : e);
              }
            }
            native.canvas.rebuildSelectedImage(
              s,
              "element.image.rebuild",
              labels?.length ? labels.join(", ") : body.prompt ? String(body.prompt) : undefined,
            );
            lastRebuildMode = mode;
            break;
          }
          case "setShadow":
            native.canvas.setSelectedShadow(
              s,
              "element.shadow.set",
              body.shadow === null
                ? null
                : {
                    blur: Number(body.shadow?.blur ?? 12),
                    color: String(body.shadow?.color ?? "#00000055"),
                    offsetX: Number(body.shadow?.offsetX ?? 0),
                    offsetY: Number(body.shadow?.offsetY ?? 4),
                  },
            );
            break;
          case "setTableAlign":
            native.canvas.setTableCellAlign(
              s,
              "element.table.cell.align.set",
              Number(body.row ?? 0),
              Number(body.col ?? 0),
              Array.isArray(body.align) ? body.align : ["center", "middle"],
            );
            break;
          case "setChartLabels":
            native.canvas.setChartLabels(s, "element.chart.labels.set", Boolean(body.labels));
            break;
          case "setChartAxis":
            native.canvas.setChartAxis(s, "element.chart.axis.set", body.axis || {});
            break;
          case "setNotes":
            native.canvas.setPageNotesAt(
              s,
              "notes.content.set",
              body.pageIndex == null ? s.pageIndex : requireInt(body.pageIndex, "pageIndex"),
              String(body.notes ?? ""),
            );
            break;
          case "setAnimation":
            native.canvas.setElementAnimation(
              s,
              "element.animation.set",
              String(body.kind || "none"),
            );
            break;
          case "undo":
            native.canvas.undo(s);
            break;
          case "redo":
            native.canvas.redo(s);
            break;
          case "persist":
            break;
          default:
            return json(res, 400, { error: `unknown cmd: ${cmd}` });
        }
        if (mutatesProject || cmd === "persist") {
          persistLiveSession(native, s, projectRoot, baseSession, tabId);
        } else if (liveEntryFor(projectRoot, tabId).session !== baseSession) {
          throw conflictError("editor session changed while command was running; retry the edit");
        } else {
          liveEntryFor(projectRoot, tabId).session = s;
        }
        rememberPage(s, projectRoot);
        return json(res, 200, {
          ok: true,
          revision: liveEntryFor(projectRoot, tabId).diskRevision,
          model: liveModel(native, s),
          thumbs: native.canvas.renderAllPages(s),
        });
      } catch (e) {
        const errorSession = liveEntryFor(projectRoot, tabId).session ?? baseSession;
        const status = Number(e?.statusCode) === 409 ? 409 : 400;
        return json(res, status, {
          error: e instanceof Error ? e.message : String(e),
          revision: liveEntryFor(projectRoot, tabId).diskRevision,
          model: liveModel(native, errorSession),
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/export") {
      const body = await readBody(req).catch(() => null);
      const projectRoot = projectForRequest(url, body);
      // PNG exports "the current page", which lives on the browser tab's own session.
      const s = await ensureSession(native, projectRoot, undefined, tabIdFor(url, body));
      const exportSession = openExportSession(native, projectRoot, s.pageIndex);
      const format = String(body?.format || url.searchParams.get("format") || "pptx");
      if (format === "pdf") {
        // Whole-deck PDF: every page as a native editor screenshot, assembled
        // losslessly into one PDF. What you saw is what exports — no font
        // substitution on the viewing machine.
        const rasterModule = await import(
          pathToFileURL(
            fileURLToPath(runtimeImport("@open-slidestudio/presentation-run", "dist/domain/page-raster.js")),
          ).href
        );
        const raster = rasterModule.createPageRasterPort({
          editorBaseUrl: `http://127.0.0.1:${PORT}`,
          nativeSlideSize: true,
        });
        const shots = [];
        try {
          for (let pageIndex = 0; pageIndex < exportSession.project.pages.length; pageIndex += 1) {
            const shot = await raster.render({ projectRoot, pageIndex });
            if (shot.kind !== "native-slide" || !shot.bytes) {
              return json(res, 503, {
                error: `PDF visual render unavailable on page ${pageIndex + 1}: ${shot.note || shot.kind}`,
              });
            }
            shots.push({ bytes: shot.bytes, width: shot.width, height: shot.height });
          }
        } finally {
          await raster.close?.();
        }
        let pdf;
        try {
          pdf = buildPdfFromPngs(shots);
        } catch (e) {
          return json(res, 500, {
            error: e instanceof Error ? e.message : String(e),
          });
        }
        const title = String(exportSession.project.presentation.title || "slides")
          .replace(/[^\w\u4e00-\u9fff-]+/g, "_")
          .replace(/^_+|_+$/g, "") || "slides";
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${title}.pdf`)}`,
          "X-Export-Report": Buffer.from(
            JSON.stringify({
              ok: true,
              slideCount: shots.length,
              bytes: pdf.length,
            }),
          ).toString("base64url"),
        });
        return res.end(pdf);
      }
      if (format === "png") {
        const rasterModule = await import(
          pathToFileURL(
            fileURLToPath(runtimeImport("@open-slidestudio/presentation-run", "dist/domain/page-raster.js")),
          ).href
        );
        const raster = rasterModule.createPageRasterPort({
          editorBaseUrl: `http://127.0.0.1:${PORT}`,
          nativeSlideSize: true,
        });
        let shot;
        try {
          shot = await raster.render({
            projectRoot,
            pageIndex: exportSession.pageIndex,
          });
        } finally {
          await raster.close?.();
        }
        if (shot.kind !== "native-slide" || !shot.bytes) {
          return json(res, 503, {
            error: `PNG visual render unavailable: ${shot.note || shot.kind}`,
          });
        }
        const title = String(exportSession.project.presentation.title || "slide")
          .replace(/[^\w\u4e00-\u9fff-]+/g, "_")
          .replace(/^_+|_+$/g, "") || "slide";
        const filename = `${title}-p${exportSession.pageIndex + 1}.png`;
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "X-Export-Report": Buffer.from(
            JSON.stringify({
              ok: true,
              slideCount: 1,
              bytes: shot.bytes.length,
              kind: shot.kind,
              layoutOk: shot.layout?.ok ?? null,
            }),
          ).toString("base64url"),
        });
        return res.end(shot.bytes);
      }
      if (format !== "pptx") {
        return json(res, 400, { error: `unsupported export format: ${format}` });
      }
      const result = await native.exporter.exportProjectToPptx(exportSession.project, {
        embedFonts: body?.embedFonts
          ? { fontsDir: FONTS_DIR, families: FONT_FAMILIES }
          : undefined,
      });
      res.writeHead(200, {
        "Content-Type": contentType(".pptx"),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        "X-Export-Report": Buffer.from(
          JSON.stringify({
            ok: result.report.ok,
            slideCount: result.report.slideCount,
            coverage: result.report.nativeCoverage,
            degradations: result.report.degradations.length,
            bytes: result.report.bytes,
            ...(result.report.embeddedFonts
              ? { embeddedFonts: result.report.embeddedFonts }
              : {}),
            ...(result.report.skippedFonts
              ? { skippedFonts: result.report.skippedFonts }
              : {}),
          }),
        ).toString("base64url"),
      });
      return res.end(result.data);
    }

    if (req.method === "POST" && url.pathname === "/api/media") {
      const body = await readBody(req);
      const projectRoot = projectForRequest(url, body);
      const s = await ensureSession(native, projectRoot);
      const rawName = String(body?.name || "upload.png");
      const ext = path.extname(rawName).toLowerCase();
      // .svg is rejected: an SVG under our origin is a stored-script container.
      const allowed = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
      if (!allowed.has(ext)) {
        return json(res, 400, { error: `unsupported image type: ${ext || "(none)"}` });
      }
      const data = String(body?.data || "");
      const b64 = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
      let buf;
      try {
        buf = Buffer.from(b64, "base64");
      } catch {
        return json(res, 400, { error: "invalid base64" });
      }
      if (!buf.length) return json(res, 400, { error: "empty file" });
      if (buf.length > 8 * 1024 * 1024) {
        return json(res, 413, { error: "image larger than 8MB" });
      }
      const mediaDir = path.join(s.project.rootDir, "media");
      fs.mkdirSync(mediaDir, { recursive: true });
      const stem = path
        .basename(rawName, ext)
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .slice(0, 48) || "upload";
      const file = `${stem}-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(mediaDir, file), buf);
      return json(res, 200, { ok: true, src: `media/${file}` });
    }

    if (req.method === "GET" && url.pathname.startsWith("/media/")) {
      const projectRoot = projectForRequest(url, null);
      await ensureSession(native, projectRoot);
      const rel = decodeURIComponent(url.pathname.slice("/media/".length));
      const versionId = url.searchParams.get("version");
      let full = null;
      if (versionId) {
        const vdir = native.store.versionDir(projectRoot, versionId);
        const candidate = path.resolve(vdir, rel.replace(/^\/+/, ""));
        if (candidate.startsWith(path.resolve(vdir) + path.sep) && fs.existsSync(candidate)) {
          full = candidate;
        }
      }
      if (!full) full = safeMediaPath(projectRoot, rel);
      if (!full || !fs.existsSync(full)) {
        res.writeHead(404);
        return res.end("not found");
      }
      const headers = {
        "Content-Type": contentType(full),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };
      // Legacy decks may still carry svg media — serve it inert.
      if (full.endsWith(".svg")) {
        headers["Content-Security-Policy"] = "sandbox; default-src 'none'";
      }
      res.writeHead(200, headers);
      return fs.createReadStream(full).pipe(res);
    }

    if (req.method === "GET" && url.pathname === "/runtime/chart-semantics.js") {
      const runtimeFile = path.join(
        ROOT,
        "packages/pptd-v2/dist/chart-semantics.js",
      );
      if (!fs.existsSync(runtimeFile)) {
        return json(res, 503, {
          error: "chart semantics runtime missing; run npm run build:native",
        });
      }
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return fs.createReadStream(runtimeFile).pipe(res);
    }

    if (req.method === "GET" && url.pathname === "/runtime/chart-layout.js") {
      const runtimeFile = path.join(
        ROOT,
        "packages/pptd-v2/dist/chart-layout.js",
      );
      if (!fs.existsSync(runtimeFile)) {
        return json(res, 503, {
          error: "chart layout runtime missing; run npm run build:native",
        });
      }
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return fs.createReadStream(runtimeFile).pipe(res);
    }

    // static — bare `/` is Create Hub; `/?project=` / `/?workspace=` / `/?generate=` stay the editor
    const editorQuery =
      url.searchParams.has("project") ||
      url.searchParams.has("workspace") ||
      url.searchParams.has("generate");
    const hubPath =
      url.pathname === "/hub" || (url.pathname === "/" && !editorQuery);
    let filePath = path.join(PUBLIC, hubPath ? "hub.html" : url.pathname === "/" ? "index.html" : url.pathname);
    if (!filePath.startsWith(PUBLIC)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC, "index.html");
    }
    const headers = {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    // Editor/hub pages: same-origin scripts only. Styles need inline for the
    // canvas's dynamic style attributes; scripts do not — index/hub carry
    // none inline.
    if (filePath.endsWith(".html")) {
      headers["Content-Security-Policy"] =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; " +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'self'";
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error(e);
    const status = Number(e?.statusCode);
    json(res, status >= 400 && status < 600 ? status : 500, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`DSH SlideStudio  http://127.0.0.1:${PORT}/`);
    console.log(`创建 Hub 是默认首页。编辑器: http://127.0.0.1:${PORT}/index.html`);
    console.log(`Default project: ${DEFAULT_PROJECT}`);
    console.log(`Zero Kimi iframe/CDN in this shell.`);
    startRetentionSweep();
  });
}

// Kept intentionally small for node:test coverage of project-file behaviour.
// The HTTP endpoint itself delegates to upsertReviewThread under the same
// project write lock.
export {
  acquireReviewAiLock,
  startReviewBatch,
  finishReviewBatch,
  normalizeReviewBatchItems,
  captureWorkspaceEditScope,
  deleteProject,
  discoverProjects,
  generationActivityForRequest,
  readReviewThreads,
  resolveProjectPath,
  releaseReviewAiLock,
  retentionDaysFromEnv,
  reviewAiLockByToken,
  renewReviewAiLock,
  reviewDeckDelta,
  reviewPageDelta,
  sanitizeReviewThread,
  server,
  sweepStaleProjects,
  upsertReviewThread,
};
