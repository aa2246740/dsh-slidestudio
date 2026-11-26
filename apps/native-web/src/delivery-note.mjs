/**
 * The system delivery note: an ephemeral card shown under the Agent's final
 * reply, built only from the project's own records. It reads no page bodies and
 * is never written into the assistant conversation.
 */
import path from "node:path";
import { designLine, materialReadLines } from "./delivery-note-ledger.mjs";
import { provenanceLines } from "./delivery-note-provenance.mjs";
import { array, boundedText, readJson, record, text } from "./delivery-note-shared.mjs";

import { projectDeliveryIssue } from "./delivery-note-issue.mjs";

export { projectDeliveryIssue };

const NOTE_TITLE = "系统整理的交付摘要（根据生成记录自动整理，不是智能助手写的说明）";
const USAGE_TITLE = "资料使用情况（系统根据生成记录整理）";
const NO_DELIVERY_LINE = "总结说明没有生成";
const PROVENANCE_HINT_LINE = "说明：需要智能助手逐页解释内容和数字的来源时，可以在下方输入「请补写交付说明」。";
const LEDGER_ONLY_HINT_LINE =
  "说明：系统无法判断页面上的数字和结论来自资料还是智能助手编写；需要逐页说明来源时，可以在下方输入「请补写交付说明」。";
const MAX_PAGE_TITLES = 32;
const PROVENANCE_SCHEMA = "delivery-provenance/v1";

/** @typedef {{title: string, lines: string[]}} SystemDeliveryNote */

/**
 * The delivery fields of the generation activity response: the delivery issue
 * of a completed run and the system card shown under the Agent's last reply.
 * @param {{projectRoot: string, activityPhase: string, fault?: unknown, inspection?: unknown}} input
 */
export function deliveryActivityFields({ projectRoot, activityPhase, fault, inspection }) {
  const deliveryIssue = projectDeliveryIssue({ activityPhase, fault, inspection });
  return { deliveryIssue, systemDeliveryNote: buildSystemDeliveryNote({ projectRoot, deliveryIssue }) };
}

/**
 * Build the system card. Completed runs always carry the 「资料使用情况」 card
 * built from `_agent/delivery-provenance.v1.json`; when the Agent wrote no
 * delivery message after sealing (`deliveryIssue.sealed`), the same card
 * becomes the sealed delivery summary, and projects without the file keep the
 * ledger-only summary.
 * @param {{projectRoot: string, deliveryIssue?: unknown}} input
 * @returns {SystemDeliveryNote | undefined}
 */
export function buildSystemDeliveryNote({ projectRoot, deliveryIssue }) {
  const provenance = readDeliveryProvenance(projectRoot);
  if (record(deliveryIssue).sealed !== true) {
    return provenance ? { title: USAGE_TITLE, lines: provenanceLines(provenance) } : undefined;
  }
  const sealed = sealedComposedFacts(projectRoot);
  if (!sealed) return undefined;
  if (!provenance) {
    const manifest = readJson(path.join(sealed.agentDir, "materials", "manifest.json"));
    return {
      title: NOTE_TITLE,
      lines: [
        sealed.pageLine,
        sealed.sealLine,
        designLine(sealed.agentDir, manifest),
        ...materialReadLines(sealed.facts, manifest),
        sealed.titlesLine,
        LEDGER_ONLY_HINT_LINE,
      ],
    };
  }
  return {
    title: NOTE_TITLE,
    lines: [
      NO_DELIVERY_LINE,
      sealed.pageLine,
      sealed.sealLine,
      sealed.titlesLine,
      ...provenanceLines(provenance),
      PROVENANCE_HINT_LINE,
    ],
  };
}

/** @param {unknown} outline @returns {{pageId: string, title: string}[]} */
function outlinePages(outline) {
  return array(record(outline).items).flatMap((value) => {
    const page = record(value);
    const pageId = text(page.pageId || page.id);
    const title = boundedText(page.title, 80);
    return pageId ? [{ pageId, title: title || pageId }] : [];
  });
}

/** @param {string} projectRoot @returns {{agentDir: string, facts: unknown[], pageLine: string, sealLine: string, titlesLine: string} | undefined} */
function sealedComposedFacts(projectRoot) {
  const agentDir = path.join(projectRoot, "_agent");
  const ledger = readJson(path.join(agentDir, "run-ledger.v1.json"));
  const facts = array(ledger.facts);
  const composed = [...facts].reverse().find((fact) => record(fact).type === "deck.composed");
  if (!composed) return undefined;
  const compose = record(composed);
  const revisions = record(compose.pageRevisions);
  const sealedPageIds = Object.keys(revisions);
  const pages = outlinePages(readJson(path.join(agentDir, "outline.json")));
  const pageCount = Math.max(sealedPageIds.length, pages.length);
  const writtenCount = sealedPageIds.length;
  const passedCount = latestPassingPageReviews(facts, new Set(sealedPageIds), revisions);
  const written = writtenCount === pageCount ? "全部写入" : `已写入 ${writtenCount} 页`;
  return {
    agentDir,
    facts,
    pageLine: `页数：${pageCount} 页，${written}；${passedCount} 页通过页面检查。`,
    sealLine: `封版：已合成封版，标题「${boundedText(compose.title, 100) || "未记录"}」。`,
    titlesLine: pageTitleLine(pages, pageCount),
  };
}

/** @param {string} projectRoot @returns {Record<string, unknown> | undefined} */
function readDeliveryProvenance(projectRoot) {
  const provenance = readJson(path.join(projectRoot, "_agent", "delivery-provenance.v1.json"));
  return text(provenance.schema) === PROVENANCE_SCHEMA ? provenance : undefined;
}

/**
 * Pages whose latest visual review passed on the sealed revision.
 * @param {unknown[]} facts @param {Set<string>} pageIds @param {Record<string, unknown>} revisions
 */
function latestPassingPageReviews(facts, pageIds, revisions) {
  /** @type {Map<string, Record<string, unknown>>} */
  const latest = new Map();
  for (const value of facts) {
    const fact = record(value);
    if (fact.type !== "page.visual-review-recorded") continue;
    const pageId = text(fact.pageId);
    if (pageId && pageIds.has(pageId)) latest.set(pageId, fact);
  }
  let count = 0;
  for (const [pageId, fact] of latest) {
    if (fact.verdict === "pass" && text(fact.pageSha256) === text(revisions[pageId])) count += 1;
  }
  return count;
}

/** @param {{pageId: string, title: string}[]} pages @param {number} pageCount */
function pageTitleLine(pages, pageCount) {
  const visible = pages.slice(0, MAX_PAGE_TITLES).map((page) => page.title);
  const suffix = pageCount > MAX_PAGE_TITLES ? `等 ${pageCount} 页` : "";
  return `页面：${visible.join("、")}${suffix}`;
}
