/** Comment-batch receipt DTO, shared by its sole native writer (src/comment-submissions.mjs)
 * and the browser that renders and retries it. No DOM, no network: safe in both runtimes. */

/** @typedef {"preparing" | "running" | "applied" | "failed" | "cancelled"} CommentSubmissionStatus */
/** @typedef {Record<string, unknown> & {
 *  pagePath: string, commentId: string, commentRevision: number, text?: string, scope?: unknown }} CommentSubmissionItem */
/** Native receipt DTO shared by its sole writer and the conversation projection.
 * Optional descriptive fields retain compatibility with older receipts.
 * @typedef {Record<string, unknown> & {
 *  id: string, status: CommentSubmissionStatus, items: CommentSubmissionItem[], at?: string, brief?: string,
 *  error?: string, finishedAt?: string }} CommentSubmission */

export const COMMENT_SUBMISSION_MAX_ITEMS = 50;

/** Property lookup over unknown JSON without trusting any field.
 * @param {unknown} value @returns {Record<string, unknown>} */
export function record(value) {
  return value && typeof value === "object" ? /** @type {Record<string, unknown>} */ (value) : {};
}

/** @param {unknown} value @returns {value is number} */
export function isCommentRevision(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** @param {unknown} value @returns {CommentSubmissionStatus | undefined} */
export function commentSubmissionStatus(value) {
  switch (value) {
    case "preparing":
    case "running":
    case "applied":
    case "failed":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

/** @param {unknown} value */
const optionalText = (value) => value === undefined || typeof value === "string";
/** @param {unknown} value */
const optionalInstant = (value) =>
  value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value)));
/** @param {unknown} value */
const filled = (value) => typeof value === "string" && value.trim() !== "";

/** @param {unknown} value @returns {CommentSubmissionItem | null} */
function decodeItem(value) {
  const source = { ...record(value) };
  const { pagePath, commentId, commentRevision, text } = source;
  if (!filled(pagePath) || !filled(commentId) || !isCommentRevision(commentRevision) || !optionalText(text))
    return null;
  return {
    ...source,
    pagePath: String(pagePath),
    commentId: String(commentId),
    commentRevision,
    text: /** @type {string | undefined} */ (text),
  };
}

/** @param {unknown} raw @returns {CommentSubmissionItem[] | null} */
function decodeItems(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > COMMENT_SUBMISSION_MAX_ITEMS) return null;
  /** @type {CommentSubmissionItem[]} */
  const items = [];
  const identities = new Set();
  for (const entry of /** @type {unknown[]} */ (raw)) {
    const decoded = decodeItem(entry);
    if (!decoded) return null;
    const identity = JSON.stringify([decoded.pagePath, decoded.commentId]);
    if (identities.has(identity)) return null;
    identities.add(identity);
    items.push(decoded);
  }
  return items;
}

/** Decode the whole receipt, never a partial subset of its authorized targets.
 * @param {unknown} value @returns {CommentSubmission | null} */
export function decodeCommentSubmission(value) {
  const source = { ...record(value) };
  const { id, at, brief, error, finishedAt } = source;
  const status = commentSubmissionStatus(source.status);
  if (!filled(id) || !status) return null;
  if (!optionalInstant(at) || !optionalText(brief) || !optionalText(error) || !optionalInstant(finishedAt)) return null;
  const items = decodeItems(source.items);
  if (!items) return null;
  return {
    ...source,
    id: String(id),
    status,
    items,
    at: /** @type {string | undefined} */ (at),
    brief: /** @type {string | undefined} */ (brief),
    error: /** @type {string | undefined} */ (error),
    finishedAt: /** @type {string | undefined} */ (finishedAt),
  };
}

/** A receipt the user can resend: the batch ended without being applied. */
/** @param {CommentSubmission | null | undefined} submission */
export function commentSubmissionRetryable(submission) {
  return submission?.status === "failed" || submission?.status === "cancelled";
}
