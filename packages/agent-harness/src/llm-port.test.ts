import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chatCompletionsUrl,
  classifyLlmFailure,
  computeBackoffMs,
  createLlmPort,
  formatLlmWaitMessage,
  LlmHttpError,
  normalizeToolCalls,
  parseGoogleRetryDelayMs,
  parseLlmConfig,
  parseRetryAfterMs,
} from "./llm-port.js";

describe("llm-port URL + config", () => {
  it("appends /v1/chat/completions for a bare host", () => {
    assert.equal(chatCompletionsUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434/v1/chat/completions");
  });

  it("does not double /v1 when the base already ends with /v1", () => {
    assert.equal(chatCompletionsUrl("https://gateway.example/v1/"), "https://gateway.example/v1/chat/completions");
  });

  it("uses /openai/chat/completions for Gemini-style compat bases", () => {
    assert.equal(
      chatCompletionsUrl("https://generativelanguage.googleapis.com/v1beta/openai/"),
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
  });

  it("keeps a full chat/completions URL", () => {
    assert.equal(chatCompletionsUrl("https://x.example/v1/chat/completions"), "https://x.example/v1/chat/completions");
  });

  it("normalizeToolCalls accepts OpenAI and legacy function_call shapes", () => {
    const openai = normalizeToolCalls([
      {
        id: "call_1",
        type: "function",
        extra_content: { google: { thought_signature: "sig" } },
        function: { name: "read_playbook", arguments: '{"section":"category"}' },
      },
    ]);
    assert.equal(openai[0]?.function.name, "read_playbook");
    assert.equal(
      (openai[0]?.extra_content as { google?: { thought_signature?: string } })?.google?.thought_signature,
      "sig",
    );
    const legacy = normalizeToolCalls({ name: "think", arguments: "{}" });
    assert.equal(legacy[0]?.function.name, "think");
    assert.equal(normalizeToolCalls(undefined).length, 0);
  });

  it("parseLlmConfig requires a baseUrl", () => {
    assert.equal(parseLlmConfig({ apiKey: "k" }), undefined);
    const cfg = parseLlmConfig({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      apiKey: " k ",
      model: "gemini-2.5-flash",
    });
    assert.ok(cfg);
    assert.equal(cfg.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
    assert.equal(cfg.apiKey, "k");
    assert.equal(cfg.model, "gemini-2.5-flash");
  });

  it("completeTurn posts tools and reads tool_calls", async () => {
    const prev = globalThis.fetch;
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "think", arguments: '{"summary":"x","detail":"y"}' },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const port = createLlmPort({
        baseUrl: "http://127.0.0.1:9",
        model: "local",
      });
      const turn = await port.completeTurn?.(
        [{ role: "user", content: "hi" }],
        [
          {
            type: "function",
            function: { name: "think", description: "d", parameters: { type: "object" } },
          },
        ],
      );
      assert.ok(Array.isArray(body?.tools));
      assert.equal(turn?.toolCalls[0]?.function.name, "think");
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("classifies 429 as a retryable rate limit", () => {
    const info = classifyLlmFailure(new LlmHttpError("LLM HTTP 429: quota", 429, true, 8000));
    assert.equal(info.retryable, true);
    assert.equal(info.kind, "rate_limit");
    assert.equal(info.retryAfterMs, 8000);
    assert.equal(classifyLlmFailure(new Error("LLM HTTP 400: bad")).retryable, false);
  });

  it("honors Retry-After seconds and Google retryDelay", () => {
    assert.equal(parseRetryAfterMs("8"), 8000);
    assert.equal(parseGoogleRetryDelayMs('{"retryDelay":"12s"}'), 12_000);
    assert.equal(
      computeBackoffMs({
        attempt: 0,
        initialDelayMs: 1000,
        maxDelayMs: 60_000,
        retryAfterMs: 5000,
        jitterUnit: 0.5,
      }),
      5000,
    );
  });

  it("retries 429 then succeeds", async () => {
    const waits: number[] = [];
    const retries: number[] = [];
    let hits = 0;
    const port = createLlmPort(
      {
        baseUrl: "http://127.0.0.1:9",
        model: "local",
        retry: { maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 60_000 },
        onRetry: (info) => {
          retries.push(info.attempt);
        },
      },
      {
        random: () => 0.5,
        sleep: async (ms) => {
          waits.push(ms);
        },
        fetch: (async () => {
          hits += 1;
          if (hits === 1) {
            return new Response(JSON.stringify({ error: { message: "quota", retryDelay: "2s" } }), {
              status: 429,
              headers: { "retry-after": "2", "content-type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: "",
                    tool_calls: [{ id: "c1", function: { name: "think", arguments: "{}" } }],
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as typeof fetch,
      },
    );
    const turn = await port.completeTurn?.([{ role: "user", content: "hi" }]);
    assert.equal(hits, 2);
    assert.equal(retries[0], 1);
    assert.ok(waits[0]! >= 1000);
    assert.equal(turn?.toolCalls[0]?.function.name, "think");
  });

  it("does not retry HTTP 400", async () => {
    let hits = 0;
    const port = createLlmPort(
      { baseUrl: "http://127.0.0.1:9", model: "local", retry: { maxRetries: 3 } },
      {
        sleep: async () => {
          throw new Error("should not wait on 400");
        },
        fetch: (async () => {
          hits += 1;
          return new Response("bad tools", { status: 400 });
        }) as typeof fetch,
      },
    );
    await assert.rejects(() => port.completeTurn!([{ role: "user", content: "hi" }]), /LLM HTTP 400/);
    assert.equal(hits, 1);
  });

  it("exhausts 429 retries then throws", async () => {
    let hits = 0;
    const port = createLlmPort(
      {
        baseUrl: "http://127.0.0.1:9",
        model: "local",
        retry: { maxRetries: 2, initialDelayMs: 10 },
      },
      {
        random: () => 0,
        sleep: async () => undefined,
        fetch: (async () => {
          hits += 1;
          return new Response("quota", { status: 429 });
        }) as typeof fetch,
      },
    );
    await assert.rejects(
      () => port.completeTurn!([{ role: "user", content: "hi" }]),
      (e: unknown) => e instanceof LlmHttpError && e.status === 429 && e.retryable,
    );
    assert.equal(hits, 3);
  });

  it("formats a wait line without leaking secrets", () => {
    const line = formatLlmWaitMessage({
      kind: "rate_limit",
      attempt: 2,
      maxRetries: 4,
      waitMs: 8000,
    });
    assert.match(line, /用量超了/);
    assert.match(line, /2\/4/);
    assert.doesNotMatch(line, /AIza|sk-/);
  });
});
