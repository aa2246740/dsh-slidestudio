import fs from "node:fs";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import type { AgentToolState, ToolExecution } from "./agent-tools.js";
import { layoutUsage } from "./delivery-layouts.js";
import { persistPageKey } from "./page-identity.js";
import { parseCanonicalPagePlan } from "./page-plan.js";
import type { DeckComposedFact } from "./run-ledger.js";
import type { SkillDeckInput, SkillPageInput } from "./skill-pages.js";

/** Explicit compose payloads may add/revise pages, but unchanged historical
 * hands-state pages are observations, not permission to overwrite editor work. */
export function explicitComposeMutations(state: AgentToolState, result: ToolExecution): SkillPageInput[] {
  const payload = result.payload as Partial<SkillDeckInput> | undefined;
  if (!payload || !Array.isArray(payload.pages)) return [];
  const historical = state.writtenPages ?? [];
  return payload.pages.filter((page): page is SkillPageInput => {
    if (!page || typeof page.id !== "string") return false;
    const prior = historical.find((item) => item.id === page.id);
    // A compose after write_page is not an implicit edit permission for a
    // historical page: Native may have changed it after hands-state was read.
    // Compose may still append pages which this run has never written.
    return !prior;
  });
}

function outlineTitles(root: string): Map<string, string> {
  try {
    const outline = JSON.parse(fs.readFileSync(path.join(root, "_agent", "outline.json"), "utf8")) as {
      items?: unknown;
    };
    return new Map(parseCanonicalPagePlan(outline.items).map((page) => [page.pageId, page.title]));
  } catch {
    // Legacy ledgers can seal without an outline cache. Metadata is not a new
    // execution gate; use page IDs rather than infer titles from page content.
    return new Map();
  }
}

function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let prefix = "";
  for (const character of value) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > maxBytes) break;
    prefix += character;
  }
  return prefix;
}

/** The optional provenance summary and non-blocking hints attached to a slim compose receipt. */
export type ComposeProvenance = Readonly<{ summary: string; warnings?: readonly string[] }>;

/** Only project the model response after full pages have been persisted and sealed. */
export function slimComposeResult(
  root: string,
  result: ToolExecution,
  fact: DeckComposedFact,
  provenance?: ComposeProvenance,
): ToolExecution {
  const titles = outlineTitles(root);
  const project = loadProject(root);
  const pages = project.pages.map((entry) => {
    const id = persistPageKey(entry.path);
    return {
      id,
      title: Array.from(titles.get(id) ?? id)
        .slice(0, 40)
        .join(""),
    };
  });
  // Only layouts a page uses are named; a deck without layouts keeps the receipt unchanged.
  const layouts = layoutUsage(project).map((layout) => ({
    id: layout.id,
    name: layout.name,
    pages: layout.pages.length,
  }));
  const summary = typeof provenance?.summary === "string" ? provenance.summary : "";
  const warnings = provenance?.warnings?.filter((line) => line.length > 0) ?? [];
  const payload = {
    title: fact.title,
    pageCount: pages.length,
    pages,
    ...(layouts.length ? { layouts } : {}),
    deckSha256: fact.deckSha256,
    composedFactId: fact.factId,
    ...(summary ? { provenanceSummary: summary } : {}),
    ...(warnings.length ? { warnings } : {}),
    next: "deliver",
  };
  const receipt = {
    ...result,
    payload,
  };
  const completePages = pages.map((page) => ({ ...page }));
  const fields = [
    { text: receipt.detail, set: (text: string) => (receipt.detail = text) },
    { text: receipt.summary, set: (text: string) => (receipt.summary = text) },
    { text: payload.title, set: (text: string) => (payload.title = text) },
    ...pages.map((page) => ({
      text: page.title,
      set: (text: string) => (page.title = text),
    })),
  ];
  // Measure the complete serialized ToolExecution, including escaped detail,
  // not just titles. Work on display-only copies after the seal is persisted.
  // A provenance summary widens the M1 budget to its 4.2 KiB bound (VAL-PROV-010).
  const summaryAttached = summary.length > 0;
  const targetBytes = summaryAttached ? 4300 : 3.5 * 1024;
  const hardCapBytes = summaryAttached ? 4300 : 4096;
  let bytes = Buffer.byteLength(JSON.stringify(receipt), "utf8");
  while (bytes > targetBytes) {
    const field = fields
      .filter((field) => field.text.length > 0)
      .sort((a, b) => Buffer.byteLength(b.text) - Buffer.byteLength(a.text))[0];
    if (!field) break; // Identity fields and hashes must never be shortened.
    const fieldBytes = Buffer.byteLength(field.text, "utf8");
    const cut = Math.min(bytes - targetBytes, Math.max(1, Math.ceil(fieldBytes / 4)));
    field.text = utf8Prefix(field.text, fieldBytes - cut);
    field.set(field.text);
    bytes = Buffer.byteLength(JSON.stringify(receipt), "utf8");
  }
  if (bytes > hardCapBytes) {
    // IDs alone can exceed the cap. Omit whole rows, never abbreviate identities
    // or persist this projection. Retained rows keep their full display titles.
    const omittedPayload = {
      ...payload,
      title: utf8Prefix(fact.title, 120),
      pages: [] as typeof pages,
      omittedPageCount: pages.length,
      recoveryHint: "Read the full ordered page IDs from the deck.pptd manifest; use read_page for page content.",
    };
    const omittedReceipt = {
      ...receipt,
      summary: `${pages.length} 页 PPTD`,
      payload: omittedPayload,
    };
    for (const page of completePages) {
      omittedPayload.pages.push(page);
      omittedPayload.omittedPageCount -= 1;
      if (Buffer.byteLength(JSON.stringify(omittedReceipt), "utf8") > hardCapBytes) {
        omittedPayload.pages.pop();
        omittedPayload.omittedPageCount += 1;
        break;
      }
    }
    return omittedReceipt;
  }
  return receipt;
}
