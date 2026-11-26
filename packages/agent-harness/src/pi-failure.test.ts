import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyPiEvents, classifyPiFailure, piModelCandidates, summarizePiError } from "./pi-failure.js";

const DAILY_429 = `{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 429,\\n    \\"message\\": \\"You exceeded your current quota... model: gemini-3.5-flash\\\\nPlease retry in 38s.\\",\\n    \\"status\\": \\"RESOURCE_EXHAUSTED\\",\\n    \\"details\\": [{\\"@type\\":\\"type.googleapis.com/google.rpc.QuotaFailure\\",\\"violations\\":[{\\"quotaId\\":\\"GenerateRequestsPerDayPerProjectPerModel-FreeTier\\",\\"quotaValue\\":\\"20\\"}]}]\\n  }\\n}\\n","code":429,"status":"Too Many Requests"}}`;

const RPM_429 = 'RESOURCE_EXHAUSTED 429 {"retryDelay":"8s"}';

describe("pi failure classification", () => {
  it("treats Gemini daily free-tier as a model switch, not a wait", () => {
    const hit = classifyPiFailure(DAILY_429);
    assert.equal(hit.kind, "rate_limit");
    assert.equal(hit.status, 429);
    assert.equal(hit.dailyQuota, true);
    assert.equal(hit.retryable, false);
    assert.equal(hit.retryAfterMs, undefined);
    assert.match(hit.message, /gemini-3.5-flash|免费次数/);
  });

  it("treats Gemini 503 UNAVAILABLE as a short retry, not a hard fail", () => {
    const hit = classifyPiFailure(
      '{"error":{"message":"{\\n \\"error\\": {\\n \\"code\\": 503,\\n \\"message\\": \\"The service is currently unavailable.\\",\\n \\"status\\": \\"UNAVAILABLE\\"\\n }\\n}\\n","code":503,"status":"Service Unavailable"}}',
    );
    assert.equal(hit.kind, "rate_limit");
    assert.equal(hit.status, 503);
    assert.equal(hit.retryable, true);
    assert.match(hit.message, /503/);
  });

  it("treats a retryDelay 429 without PerDay as wait-and-retry", () => {
    const hit = classifyPiFailure(RPM_429);
    assert.equal(hit.kind, "rate_limit");
    assert.equal(hit.dailyQuota, false);
    assert.equal(hit.retryable, true);
    assert.equal(hit.retryAfterMs, 8_000);
  });

  it("pauses an xAI credit 403 so the same durable run can resume", () => {
    const hit = classifyPiFailure(
      'OpenAI API error (403): 403 "You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage"',
    );
    assert.equal(hit.kind, "rate_limit");
    assert.equal(hit.status, 403);
    assert.equal(hit.retryable, false);
    assert.match(hit.message, /进度已保留/);
  });

  it("reads stopReason=error off Pi RPC events", () => {
    const hit = classifyPiEvents([
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: DAILY_429,
        },
      },
    ]);
    assert.ok(hit);
    assert.equal(hit?.dailyQuota, true);
  });

  it("does not invent a Google fallback list for other providers", () => {
    assert.deepEqual(piModelCandidates("claude-sonnet-4", "anthropic"), ["claude-sonnet-4"]);
    const grok = piModelCandidates("grok-4.5", "xai-auth");
    assert.equal(grok[0], "grok-4.5");
    assert.ok(grok.includes("grok-4.20-0309-reasoning"));
    const google = piModelCandidates("gemini-3.5-flash", "google");
    assert.equal(google[0], "gemini-3.5-flash");
    assert.ok(google.includes("gemini-3.5-flash-lite"));
    assert.ok(google.includes("gemini-3.6-flash"));
  });

  it("treats Codex overload as a retryable switch away from Codex", () => {
    const hit = classifyPiFailure("Codex error: Our servers are currently overloaded. Please try again later.");
    assert.equal(hit.kind, "rate_limit");
    assert.equal(hit.retryable, true);
    assert.match(hit.message, /Grok|过载/);
  });

  it("switches off a retired Gemini model id", () => {
    const hit = classifyPiFailure(
      "This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.6-flash",
    );
    assert.equal(hit.retiredModel, true);
    assert.equal(hit.status, 404);
    assert.match(hit.message, /gemini-3.6-flash|下线/);
  });

  it("keeps Hub-facing text short and secret-free", () => {
    const text = summarizePiError(DAILY_429);
    assert.doesNotMatch(text, /AQ\./);
    assert.ok(text.length < 120);
  });
});
