import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { commentSubmissionStatus, decodeCommentSubmission, record } from "../public/comment-submission-data.js";

/** @typedef {import("../public/comment-submission-data.js").CommentSubmission} CommentSubmission */
/** @typedef {import("../public/comment-submission-data.js").CommentSubmissionStatus} CommentSubmissionStatus */
/** @typedef {"applied" | "failed" | "cancelled"} BatchOutcome */
/** @typedef {{ id: string, status: string, [key: string]: any }} StoredSubmission */

const FILE = "comment-submissions.v1.json";

/** @param {string} root */
const submissionsFile = (root) => path.join(root, "_agent", FILE);

// Native server is the sole writer; Host conversation messages are the durable
// acceptance receipt. Preparing batches are never presented as sent on their own.
/** @param {string} root @returns {StoredSubmission[]} */
export function readCommentSubmissions(root) {
  const file = submissionsFile(root);
  if (!fs.existsSync(file)) return [];
  const value = record(JSON.parse(fs.readFileSync(file, "utf8")));
  if (value.version !== 1 || !Array.isArray(value.submissions)) throw new Error("Invalid comment submission record");
  return value.submissions;
}

/** Only the receipts that decode completely; older or partial rows are left out rather than
 * guessed at. For projections that hand receipts to the browser.
 * @param {string} root @returns {CommentSubmission[]} */
export function readDecodedCommentSubmissions(root) {
  return readCommentSubmissions(root).flatMap((entry) => {
    const decoded = decodeCommentSubmission(entry);
    return decoded ? [decoded] : [];
  });
}

/** @param {string} root @param {unknown[]} submissions */
function write(root, submissions) {
  const file = submissionsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + crypto.randomUUID() + ".tmp";
  fs.writeFileSync(temp, JSON.stringify({ version: 1, submissions }, null, 2));
  fs.renameSync(temp, file);
}

/** @param {unknown} entry */
function submissionItem(entry) {
  const source = record(entry);
  const comment = record(source.comment);
  return {
    pagePath: source.pagePath,
    commentId: comment.id,
    commentRevision: comment.revision,
    text: comment.text,
    scope: comment.scope,
  };
}

/** @param {string} root @param {unknown} prepared @param {unknown} [brief] */
export function createCommentSubmission(root, prepared, brief) {
  if (!Array.isArray(prepared)) throw new Error("Invalid comment submission arguments");
  const submission = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    status: "preparing",
    brief: String(brief || "").slice(0, 10000),
    items: /** @type {unknown[]} */ (prepared).map(submissionItem),
  };
  write(root, [...readCommentSubmissions(root), submission]);
  return submission;
}

/** An unknown status or a non-text error is refused before the store is touched.
 * @param {string} root @param {unknown} id @param {unknown} status @param {unknown} [error] */
export function finishCommentSubmission(root, id, status, error) {
  if (!id) return; // Older single-comment locks have no conversation receipt.
  const decodedStatus = commentSubmissionStatus(status);
  if (typeof id !== "string" || !decodedStatus || (error != null && typeof error !== "string"))
    throw new Error("Invalid comment submission arguments");
  write(
    root,
    readCommentSubmissions(root).map((item) =>
      item.id === id
        ? {
            ...item,
            status: decodedStatus,
            error: String(error || "").slice(0, 2000) || undefined,
            finishedAt: new Date().toISOString(),
          }
        : item,
    ),
  );
}

/** The receipt status a finished batch outcome records.
 * @param {BatchOutcome} outcome @returns {CommentSubmissionStatus} */
export function submissionStatusForOutcome(outcome) {
  return outcome === "applied" ? "applied" : outcome === "failed" ? "failed" : "cancelled";
}

/** What ties a comment to the message that last carried it. Lock items store it as
 * `previous` so an unaccepted retry can hand the comment back.
 * @param {unknown} comment */
export function commentAssociation(comment) {
  const source = record(comment);
  return {
    aiSubmissionId: source.aiSubmissionId,
    aiStatus: source.aiStatus,
    aiError: source.aiError,
  };
}

/** A retry opens its own preparing batch, which rewrites each comment's association. If the Host
 * never took that batch, the comment goes back to the message that really carried it; otherwise
 * the original message would lose its retry and the comment would return to the draft.
 * @param {unknown} comment @param {unknown} item @param {unknown} submissionId */
export function unacceptedBatchRollback(comment, item, submissionId) {
  const previous = record(record(item).previous);
  return record(comment).aiSubmissionId === submissionId && previous.aiSubmissionId ? previous : {};
}

/**
 * The thread fields one batch outcome writes on each of its comments, including the hand-back
 * of an unaccepted retry. Spread it over the stored comment before upserting.
 * @param {unknown} comment the stored thread
 * @param {unknown} item the lock item that owned it
 * @param {{ outcome: BatchOutcome, failure?: string, unaccepted?: boolean, submissionId?: string, now?: () => number }} options
 */
export function batchThreadUpdate(
  comment,
  item,
  { outcome, failure, unaccepted = false, submissionId, now = Date.now },
) {
  return {
    aiStatus: outcome === "applied" ? "applied" : outcome === "failed" ? "failed" : "idle",
    aiAppliedAt: outcome === "applied" ? new Date(now()).toISOString() : undefined,
    aiError: outcome === "failed" ? failure || "AI 修改失败，可重试" : undefined,
    ...(unaccepted ? unacceptedBatchRollback(comment, item, submissionId) : {}),
  };
}
