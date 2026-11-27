import { t } from "./i18n.js";

export function conversationMessageKey(message) {
  return `user:${message.clientRequestId || message.id}`;
}

/** Only a persisted Host user message proves that a prepared batch was sent. */
export function acceptedReviewSubmissions(activity = {}) {
  const accepted = new Set(
    (activity?.conversation?.messages || []).map((message) => message.reviewSubmissionId).filter(Boolean),
  );
  return (activity?.reviewSubmissions || [])
    .filter((item) => accepted.has(item.id))
    .map((item) => ({ ...item, status: item.status === "preparing" ? "running" : item.status }));
}

export function commentIsDraft(comment, activity = {}) {
  if (comment.resolved || comment.aiStatus === "applied") return false;
  return !acceptedReviewSubmissions(activity).some(
    (submission) =>
      comment.aiSubmissionId === submission.id ||
      submission.items.some(
        (item) =>
          item.commentId === comment.id &&
          item.pagePath === comment.pagePath &&
          Number(comment.revision) <= Number(item.commentRevision) + 1,
      ),
  );
}

/** User text is project metadata; model replies remain the DSH journal's truth. */
export function conversationEvents(activity = {}) {
  const events = [...(activity.events || [])];
  const submissions = acceptedReviewSubmissions(activity);
  const lastSubmissionByComment = new Map();
  for (const submission of submissions)
    for (const item of submission.items) {
      lastSubmissionByComment.set(item.pagePath + ":" + item.commentId, submission.id);
    }
  for (const [index, message] of (activity.conversation?.messages || []).entries()) {
    if (index === 0 && message.text === activity.brief) continue;
    if (!message.id || !message.text) continue;
    const submission = submissions.find((item) => item.id === message.reviewSubmissionId);
    const reviewSubmission = submission && {
      ...submission,
      retryable:
        ["failed", "cancelled"].includes(submission.status) &&
        submission.items.every(
          (item) => lastSubmissionByComment.get(item.pagePath + ":" + item.commentId) === submission.id,
        ),
    };
    events.push({
      id: conversationMessageKey(message),
      at: message.at,
      kind: "user",
      detail: message.text,
      status: "complete",
      label: t("你"),
      reviewSubmission,
    });
  }
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const delta = Date.parse(a.event.at) - Date.parse(b.event.at);
      return Number.isFinite(delta) && delta !== 0 ? delta : a.index - b.index;
    })
    .map(({ event }) => event);
}

/** @param {any[]} events @param {any} latestUser */
function eventsAfterLatestTurn(events, latestUser) {
  if (!events.length) return [];
  const since = Date.parse(latestUser?.at);
  if (Number.isFinite(since)) {
    return events.filter((row) => Date.parse(row.at) >= since);
  }
  const isTurnEnd = (row) => row?.kind === "turn" && row?.name === "turn";
  const lastIdx = events.length - 1;
  const searchFrom = isTurnEnd(events[lastIdx]) ? lastIdx - 1 : lastIdx;
  for (let i = searchFrom; i >= 0; i -= 1) {
    const row = events[i];
    if (row?.kind === "user" || row?.kind === "turn") {
      return events.slice(i + 1);
    }
  }
  return events.slice();
}

/** @param {string} mode @param {boolean} busy @param {{status?: string, detail?: string} | undefined} end */
function resolveDiscussEditPhase(mode, busy, end) {
  if (busy) return mode === "discuss" ? "discussing" : "reviewing";
  const status = end?.status;
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "paused") return "paused";
  return mode === "discuss" ? "discussion" : "edited";
}

/** @param {{status?: string, detail?: string} | undefined} end */
function resolveDiscussEditError(end) {
  const status = end?.status;
  if (status === "failed") return { detail: end?.detail };
  if (status && ["paused", "cancelled", "canceled"].includes(status) && end?.detail) return { detail: end.detail };
  return undefined;
}

/** @param {string} phase @param {{status?: string, detail?: string} | undefined} end @param {any[]} after */
function resolveGeneratePhase(phase, end, after) {
  if (["complete", "failed", "paused", "cancelled", "canceled"].includes(phase)) return phase;
  const status = end?.status;
  if (status === "complete") {
    if (after.some((row) => row.kind === "message") && !after.some((row) => row.kind === "tool")) return "discussion";
    if (after.some((row) => row.kind === "tool")) return "paused";
    return phase;
  }
  if (status === "needs-attention" || status === "paused") return "paused";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  return phase;
}

/** A reply-only turn is idle even if an earlier generation ledger is unfinished. */
export function settledAssistantActivity(activity, agentStatus) {
  const mode = activity.conversation?.mode;
  if (!mode) return { ...activity, agentStatus };
  const latestUser = activity.conversation.messages?.at(-1);
  const after = eventsAfterLatestTurn(activity.events || [], latestUser);
  const end = [...after].reverse().find((row) => row.kind === "turn" && row.name === "turn");
  const busy = agentStatus !== "idle";
  let phase = activity.phase;
  const isDiscussOrEdit = mode === "discuss" || mode === "edit";
  let errorPatch = {};
  if (isDiscussOrEdit) {
    phase = resolveDiscussEditPhase(mode, busy, end);
    errorPatch = { error: resolveDiscussEditError(end) };
  } else if (!busy) {
    phase = resolveGeneratePhase(phase, end, after);
    if (
      !activity.error &&
      (phase === "paused" || phase === "failed") &&
      ["needs-attention", "paused", "failed"].includes(end?.status) &&
      end?.detail
    ) {
      errorPatch = { error: { detail: end.detail } };
    }
  }
  return {
    ...activity,
    agentStatus,
    phase,
    ...errorPatch,
  };
}
