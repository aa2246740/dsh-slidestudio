import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  briefNeedsLiveWebSearch,
  grok46WouldCallWebSearch,
  hostedResearchNeedsWebSearchReceipt,
  hostedWebSearchHasEvidence,
  queriesFromUserBrief,
  webSearchQueriesFromArgs,
} from "./hosted-web-search.js";

const FACTS_BRIEF = "封面需要今年航天新闻和一张封面底图";
const FICTION_BRIEF = "闸门复现灯开关\n两页即可：封面 + 结束页。不要做成经营月报。虚构车间灯开关验收。";

const QUERY_ONLY = {
  name: "web_search",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const QUERIES_ARRAY = {
  name: "web_search",
  parameters: {
    type: "object",
    properties: { queries: { type: "array", items: { type: "string" } } },
    required: ["queries"],
  },
};

describe("hosted web_search schema grok-4.6 will call", () => {
  it("treats 今年航天新闻 as a live-facts brief and the fiction harness as not", () => {
    assert.equal(briefNeedsLiveWebSearch(FACTS_BRIEF), true);
    assert.equal(briefNeedsLiveWebSearch(FICTION_BRIEF), false);
  });

  it("does not emit tool/call web_search when the schema is query-only", () => {
    assert.equal(grok46WouldCallWebSearch([QUERY_ONLY], FACTS_BRIEF), undefined);
  });

  it("emits tool/call web_search with queries[] when the official schema is listed", () => {
    const call = grok46WouldCallWebSearch(
      [
        QUERIES_ARRAY,
        {
          name: "search_image",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
      FACTS_BRIEF,
    );
    assert.ok(call);
    assert.equal(call.name, "web_search");
    assert.ok(Array.isArray(call.args.queries) && call.args.queries.length >= 1);
    assert.match(call.args.queries[0] ?? "", /航天新闻|封面需要/);
  });

  it("reads both queries[] and query from tool args", () => {
    assert.deepEqual(webSearchQueriesFromArgs({ queries: ["Starship 2026", ""] }), ["Starship 2026"]);
    assert.deepEqual(webSearchQueriesFromArgs({ query: "Starship 2026" }), ["Starship 2026"]);
    assert.deepEqual(webSearchQueriesFromArgs({}), []);
  });

  it("turns the user brief into queries[] when a product tool is called", () => {
    const queries = queriesFromUserBrief(FACTS_BRIEF);
    assert.equal(queries.length, 1);
    assert.equal(queries[0], FACTS_BRIEF);
    assert.deepEqual(queriesFromUserBrief("  "), ["current events for this briefing"]);
    assert.equal(hostedWebSearchHasEvidence({ facts: ["Starship Flight 11"], citations: [] }), true);
    assert.equal(hostedWebSearchHasEvidence({ facts: [], citations: [] }), false);
  });

  it("does not require a function-call receipt for dsh-oauth native hosted search", () => {
    assert.equal(hostedResearchNeedsWebSearchReceipt({ configured: true, via: "pi-xai-hosted" }), false);
    assert.equal(hostedResearchNeedsWebSearchReceipt({ configured: true, via: "env" }), false);
    assert.equal(hostedResearchNeedsWebSearchReceipt({ configured: false, via: "pi-xai-hosted" }), false);
  });
});
