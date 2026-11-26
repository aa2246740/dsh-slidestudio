/**
 * Grok hosted `web_search` is a real produce tool/call, not assistant prose.
 * Official dsh-tool-web (and grok-4.6) take `queries: string[]`, not `query`.
 */

export const MISSING_HOSTED_WEB_SEARCH_RECEIPT = "web_search receipt missing; research.via is pi-xai-hosted";

export const EMPTY_HOSTED_WEB_SEARCH = "web_search returned no facts or citations";

/** User brief as `queries[]` for host-forced search. Not the director addendum. */
export const USER_BRIEF_QUERY_MAX_CHARS = 400;

const LIVE_FACTS_BRIEF =
  /今年|最新|新闻|实时|近日|刚刚|\btoday\b|\blatest\b|\bcurrent\b|\brecent\b|\bnews\b|\bflight\b|航天|starship|行情|股价|20(?:2[4-9]|[3-9]\d)/i;

export function briefNeedsLiveWebSearch(brief: string): boolean {
  return LIVE_FACTS_BRIEF.test(brief.trim());
}

export function webSearchQueriesFromArgs(args: Record<string, unknown>): string[] {
  if (Array.isArray(args.queries)) {
    return [...new Set(args.queries.map((item) => String(item ?? "").trim()).filter(Boolean))].slice(0, 4);
  }
  const query = String(args.query ?? "").trim();
  return query ? [query] : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function parameterProperties(parameters: unknown): Record<string, unknown> | undefined {
  const rec = asRecord(parameters);
  if (!rec) return undefined;
  const props = asRecord(rec.properties);
  return props ?? rec;
}

/** grok-4.6 calls official `web_search` when the schema has `queries[]`. */
export function toolSchemaHasQueriesArray(parameters: unknown): boolean {
  const props = parameterProperties(parameters);
  return Boolean(props && "queries" in props);
}

export type GrokFacingTool = {
  readonly name?: string;
  readonly parameters?: unknown;
};

export type HostedWebSearchCall = {
  readonly name: "web_search";
  readonly args: { readonly queries: string[] };
};

export function liveWebSearchQueryForBrief(brief: string): string {
  const line =
    brief
      .split(/\n/)
      .map((row) => row.trim())
      .find((row) => row.length > 0) ?? "";
  return line.slice(0, 200) || "recent facts for this briefing";
}

/** One-item `queries[]` from the user generate prompt. */
export function queriesFromUserBrief(brief: string): string[] {
  const trimmed = brief.trim();
  if (!trimmed) return ["current events for this briefing"];
  return [trimmed.slice(0, USER_BRIEF_QUERY_MAX_CHARS)];
}

export function hostedWebSearchHasEvidence(payload: {
  readonly facts?: unknown;
  readonly citations?: unknown;
}): boolean {
  const facts = Array.isArray(payload.facts)
    ? payload.facts.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  const citations = Array.isArray(payload.citations)
    ? payload.citations.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  return facts.length > 0 || citations.length > 0;
}

/**
 * What grok-4.6 issues as a first tool/call for a hosted-research facts brief.
 * A `query`-only schema returns undefined — that is the 7ea4f151 miss.
 */
export function grok46WouldCallWebSearch(
  tools: readonly GrokFacingTool[],
  brief: string,
): HostedWebSearchCall | undefined {
  if (!briefNeedsLiveWebSearch(brief)) return undefined;
  const web = tools.find((tool) => tool.name === "web_search");
  if (!web || !toolSchemaHasQueriesArray(web.parameters)) return undefined;
  return {
    name: "web_search",
    args: { queries: [liveWebSearchQueryForBrief(brief)] },
  };
}

export function ledgerHasSuccessfulWebSearch(
  ledger: { readonly facts: readonly { readonly type?: string; readonly ok?: boolean }[] } | undefined,
): boolean {
  if (!ledger) return false;
  return ledger.facts.some((fact) => fact.type === "web-search.executed" && fact.ok === true);
}

/**
 * Grok research is dsh-oauth native hosted search on the produce request,
 * not a function-call receipt. A missing `web_search` tool/call must not
 * block write_page or compose_deck (session 3612938f).
 */
export function hostedResearchNeedsWebSearchReceipt(_research: {
  readonly configured: boolean;
  readonly via: string;
}): boolean {
  return false;
}
