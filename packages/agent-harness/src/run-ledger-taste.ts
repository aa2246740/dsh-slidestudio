import type {
  CurrentDeckSnapshot,
  DeckOverviewEmittedFact,
  DeckTasteAxis,
  DeckTasteAxisReview,
  DeckTasteReviewFact,
  RecordDeckTasteReviewInput,
  RunLedgerV1,
  RunToolContext,
} from "./run-ledger.js";

type Dependencies = {
  readRunLedger: (root: string) => RunLedgerV1 | undefined;
  currentDeckSnapshot: (root: string, contextEpochId: string) => CurrentDeckSnapshot;
  appendFact: (root: string, fact: DeckTasteReviewFact) => unknown;
  factId: (type: DeckTasteReviewFact["type"], payload: unknown) => string;
  nowIso: () => string;
  axes: readonly DeckTasteAxis[];
  reviewGateVersion: string;
};

export function recordDeckTasteReview(
  root: string,
  context: RunToolContext,
  input: RecordDeckTasteReviewInput,
  dependencies: Dependencies,
): DeckTasteReviewFact {
  const ledger = dependencies.readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const overview = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is DeckOverviewEmittedFact =>
        fact.type === "deck.overview-emitted" &&
        fact.contextEpochId === context.contextEpochId &&
        fact.deliveryToken === input.deliveryToken,
    );
  if (!overview) throw new Error("deck overview was not emitted in this Pi context");
  const current = dependencies.currentDeckSnapshot(root, context.contextEpochId);
  if (current.deckSnapshotSha256 !== overview.deckSnapshotSha256) {
    throw new Error("deck taste review targets a stale deck snapshot");
  }
  const pageIds = new Set(current.pageSnapshot.map((page) => page.pageId));
  const axes = parseDeckTasteAxes(input.axes, pageIds, dependencies.axes);
  const strongestPageId = requireCurrentPageId(input.strongestPageId, pageIds, "strongestPageId");
  const weakestPageId = requireCurrentPageId(input.weakestPageId, pageIds, "weakestPageId");
  const visualMemoryObserved = nonEmpty(input.visualMemoryObserved, "visualMemoryObserved");
  const summary = nonEmpty(input.summary, "summary");
  const remainingAiDefaults = textList(input.remainingAiDefaults, "remainingAiDefaults", true);
  const revisionActions = input.revisionActions.map((action, index) => ({
    pageId: requireCurrentPageId(action.pageId, pageIds, `revisionActions[${index}].pageId`),
    action: nonEmpty(action.action, `revisionActions[${index}].action`),
  }));
  if (input.verdict === "pass") {
    if (axes.some((axis) => axis.verdict !== "pass")) {
      throw new Error("deck pass requires every taste axis to pass");
    }
    if (remainingAiDefaults.length || revisionActions.length) {
      throw new Error("deck pass cannot retain AI defaults or revision actions");
    }
  } else if (!revisionActions.length) {
    throw new Error("deck revise requires at least one page repair action");
  }
  const payload = {
    contextEpochId: context.contextEpochId,
    reviewGateVersion: dependencies.reviewGateVersion,
    contractSha256: current.contractSha256,
    deckSnapshotSha256: current.deckSnapshotSha256,
    overviewSha256: overview.overviewSha256,
    deliveryToken: input.deliveryToken,
    verdict: input.verdict,
    axes,
    strongestPageId,
    weakestPageId,
    visualMemoryObserved,
    summary,
    remainingAiDefaults,
    revisionActions,
  };
  const fact: DeckTasteReviewFact = {
    type: "deck.taste-review-recorded",
    factId: dependencies.factId("deck.taste-review-recorded", payload),
    at: dependencies.nowIso(),
    ...payload,
  };
  dependencies.appendFact(root, fact);
  return fact;
}

function parseDeckTasteAxes(
  raw: readonly DeckTasteAxisReview[],
  currentPageIds: ReadonlySet<string>,
  axes: readonly DeckTasteAxis[],
): DeckTasteAxisReview[] {
  if (!Array.isArray(raw)) throw new Error("review_deck.axes must be an array");
  const byAxis = new Map<DeckTasteAxis, DeckTasteAxisReview>();
  for (const [index, item] of raw.entries()) {
    if (!item || !axes.includes(item.axis)) {
      throw new Error(`review_deck.axes[${index}] has an unknown axis`);
    }
    if (byAxis.has(item.axis)) throw new Error(`duplicate deck taste axis: ${item.axis}`);
    if (item.verdict !== "pass" && item.verdict !== "revise") {
      throw new Error(`invalid verdict for deck taste axis ${item.axis}`);
    }
    const observations = textList(item.observations, `${item.axis}.observations`);
    const contractRules = textList(item.contractRules, `${item.axis}.contractRules`);
    const pageIds = textList(item.pageIds, `${item.axis}.pageIds`).map((pageId) =>
      requireCurrentPageId(pageId, currentPageIds, `${item.axis}.pageIds`),
    );
    byAxis.set(item.axis, {
      axis: item.axis,
      verdict: item.verdict,
      observations,
      pageIds,
      contractRules,
    });
  }
  const missing = axes.filter((axis) => !byAxis.has(axis));
  if (missing.length) throw new Error(`review_deck missing axes: ${missing.join(", ")}`);
  return axes.map((axis) => byAxis.get(axis)!);
}

function nonEmpty(value: string, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} must be non-empty`);
  return text;
}

function textList(values: readonly string[], label: string, allowEmpty = false): string[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const result = values.map((value, index) => nonEmpty(value, `${label}[${index}]`));
  if (!allowEmpty && !result.length) throw new Error(`${label} must be non-empty`);
  return result;
}

function requireCurrentPageId(value: string, currentPageIds: ReadonlySet<string>, label: string): string {
  const pageId = nonEmpty(value, label);
  if (!currentPageIds.has(pageId)) throw new Error(`${label} is not a current page: ${pageId}`);
  return pageId;
}
