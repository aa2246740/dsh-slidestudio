import fs from "node:fs";
import path from "node:path";
import {
  minimumPageCount,
  pageCountRequirementFromBrief,
  type PageCountRequirement,
} from "./page-count-requirement.js";
import {
  clarificationRecordTime,
  currentAnsweredClarifications,
  readClarificationRecords,
} from "./report-authority.js";

type TimedText = Readonly<{ text: string; time: number }>;

const INCREMENTAL_PAGES = /(?:增加|新增|追加|补充|再加|加上|加|减|删|去掉)\s*[0-9零〇一二两三四五六七八九十百]+\s*页/;

function acceptedGenerationTexts(root: string): TimedText[] {
  const file = path.join(root, "_agent", "assistant-conversation.v1.json");
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as {
    version?: unknown;
    messages?: unknown;
  };
  if (value.version !== 1 || !Array.isArray(value.messages)) throw new Error("Invalid assistant conversation record");
  return value.messages
    .filter((message) => message?.mode === "generate" && typeof message.text === "string")
    .map((message) => {
      const time = Date.parse(message.at);
      return { text: message.text.trim(), time: Number.isFinite(time) ? time : -Infinity };
    });
}

/**
 * Answers of the native question tool that are still current: answered (not
 * cancelled, interrupted or pending), asked in this context epoch and not
 * retired by a later record of the same question. Without an epoch the answer
 * cannot be proven current, so it grants nothing.
 */
function currentAnswerTexts(root: string, contextEpochId: string | undefined): TimedText[] {
  if (!contextEpochId) return [];
  return currentAnsweredClarifications(readClarificationRecords(root), contextEpochId).map((row) => ({
    text: (row.answerText ?? "").trim(),
    time: clarificationRecordTime(row),
  }));
}

/**
 * The page-count semantic of the latest user decision: an accepted creation
 * turn or a current answer to a native question, whichever came last. Edits
 * and discussion can mention page numbers without changing the generation
 * contract. A lone digit is ambiguous (a plan choice) and is not a total.
 */
export function conversationPageCountRequirement(root: string, contextEpochId?: string): PageCountRequirement {
  const decisions = [...acceptedGenerationTexts(root), ...currentAnswerTexts(root, contextEpochId)]
    .map((entry, order) => ({ ...entry, order }))
    .sort((a, b) => (a.time === b.time ? a.order - b.order : a.time < b.time ? -1 : 1));
  for (const { text } of decisions.reverse()) {
    // Incremental additions are not a new total; the canonical page plan handles them.
    if (INCREMENTAL_PAGES.test(text)) continue;
    const requirement = pageCountRequirementFromBrief(text);
    if (requirement.kind !== "unspecified") return requirement;
  }
  return { kind: "unspecified" };
}

/** Only accepted creation turns and current answers may update the deck's requested total. */
export function conversationPageCount(root: string, contextEpochId?: string): number | undefined {
  return minimumPageCount(conversationPageCountRequirement(root, contextEpochId));
}

/**
 * The one page-count authority used by planning, compose and delivery: the
 * latest accepted creation turn or current question answer wins, and the
 * current brief is the fallback when neither names a total.
 */
export function effectivePageCountRequirement(
  root: string,
  brief: string,
  contextEpochId?: string,
): PageCountRequirement {
  const conversation = conversationPageCountRequirement(root, contextEpochId);
  return conversation.kind === "unspecified" ? pageCountRequirementFromBrief(brief) : conversation;
}
