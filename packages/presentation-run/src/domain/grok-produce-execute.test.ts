import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPresentationRun } from "../run.js";
import {
  GROK_PROVIDER_ID,
  hostedProduceToolNames,
  inspectProjectCapabilities,
  persistPresentationRunProvider,
} from "../capabilities.js";
import { XAI_API_BASE, XAI_RESPONSES_PATH } from "./grok-hosted.js";
import { GENERATE_TOOLS } from "./generate-tool-specs.js";
import { writeDomainRuntime } from "./domain-hands.js";
import {
  EMPTY_HOSTED_WEB_SEARCH,
  MISSING_HOSTED_WEB_SEARCH_RECEIPT,
  grok46WouldCallWebSearch,
  ledgerHasSuccessfulWebSearch,
} from "./hosted-web-search.js";
import { inspectRunLedger, readRunLedger } from "./run-ledger.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = path.resolve(PKG, "../..");

const PNG = Buffer.alloc(80, 7);

function stubPlaywrightRuntime(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-runtime-"));
  const file = path.join(dir, "runtime.mjs");
  fs.writeFileSync(
    file,
    `export function verifyPinnedRuntime() { return true; }
export async function launchPinnedChromium() { throw new Error("stub runtime"); }
`,
  );
  return file;
}

function bindEnv(values: Record<string, string | undefined>): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function acceptGrokRoute(root: string): void {
  assert.equal(
    persistPresentationRunProvider(root, {
      providerId: GROK_PROVIDER_ID,
      modelId: "grok-4.6",
      ready: true,
      modelInputModalities: ["text", "image"],
    }),
    true,
  );
}

describe("Grok produce execute path", () => {
  it("inspect_capabilities matches hosted tools and execute writes search + image media", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-produce-exec-"));
    const restore = bindEnv({
      SLIDESTUDIO_EDITOR_URL: "http://127.0.0.1:55200",
      SLIDESTUDIO_PLAYWRIGHT_RUNTIME: stubPlaywrightRuntime(),
      SLIDESTUDIO_IMAGE_API_KEY: "test-xai-key",
      SLIDESTUDIO_IMAGE_BASE_URL: XAI_API_BASE,
      SLIDESTUDIO_IMAGE_MODEL: "grok-imagine-image-2.0",
      SLIDESTUDIO_IMAGE: "1",
    });
    const origFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url, init) => {
      const href = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: href, body });
      if (href.includes(XAI_RESPONSES_PATH)) {
        const tools = (body as { tools?: Array<{ type?: string; enable_image_search?: boolean }> }).tools ?? [];
        if (tools[0]?.enable_image_search) {
          return new Response(
            JSON.stringify({
              output_text: "Cover texture: ![bg](https://cdn.example.test/cover.png)",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            output_text: "- Starship Flight 11 flew in 2026.\nSee [NASA](https://www.nasa.gov/starship).",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (href.includes("/images/generations")) {
        return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (href.includes("cover.png")) {
        return new Response(PNG, { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }) as typeof fetch;
    try {
      const run = createPresentationRun({ repoRoot: REPO });
      const handle = await run.open({
        projectRoot: root,
        sessionId: "cc4bece0-c193-4d0e-af81-da00459921e5",
        brief: "封面需要今年航天新闻和一张封面底图",
        editorBaseUrl: "http://127.0.0.1:55200",
        design: { kind: "self-directed" },
        provider: { providerId: GROK_PROVIDER_ID, modelId: "grok-4.6" },
      });
      acceptGrokRoute(root);
      const ctx = (toolCallId: string) => ({
        runId: handle.runId,
        sessionId: handle.sessionId,
        toolCallId,
        projectRoot: root,
        abortSignal: new AbortController().signal,
      });
      const inspect = await run.execute({ name: "inspect_capabilities", args: {} }, ctx("caps-1"));
      assert.equal(inspect.ok, true);
      const caps = inspect.payload as {
        research: { configured: boolean; via: string };
        imageSearch: { configured: boolean; via: string };
        imageGenerate: { configured: boolean; via: string };
        web: boolean;
      };
      assert.equal(caps.web, true);
      assert.equal(caps.research.configured, true);
      assert.equal(caps.imageSearch.configured, true);
      assert.equal(caps.imageGenerate.configured, true);
      assert.equal(caps.research.via, "pi-xai-hosted");
      assert.deepEqual(hostedProduceToolNames(inspectProjectCapabilities(root)), ["search_image", "generate_image"]);

      const search = await run.execute(
        { name: "web_search", args: { query: "Starship latest flight 2026" } },
        ctx("web-1"),
      );
      assert.equal(search.ok, true, search.detail);
      assert.equal(search.payload.source, "pi-xai-hosted");
      assert.ok(Array.isArray(search.payload.facts) && (search.payload.facts as string[]).length > 0);
      const webCall = calls.find((row) => String(row.url).includes(XAI_RESPONSES_PATH));
      assert.ok(webCall);
      assert.deepEqual((webCall.body as { tools: unknown }).tools, [{ type: "web_search" }]);

      const found = await run.execute(
        { name: "search_image", args: { id: "cover-ref", query: "navy aerospace cover" } },
        ctx("img-search-1"),
      );
      assert.equal(found.ok, true, found.detail);
      assert.equal(found.payload.src, "media/cover-ref.png");
      assert.equal(fs.existsSync(path.join(root, "media", "cover-ref.png")), true);

      const generated = await run.execute(
        {
          name: "generate_image",
          args: {
            id: "cover-bg",
            prompt: "navy cover background for a 2026 briefing",
            aspect: "16:9",
          },
        },
        ctx("img-gen-1"),
      );
      assert.equal(generated.ok, true, generated.detail);
      assert.equal(generated.payload.kind, "generated");
      assert.equal(generated.payload.src, "media/cover-bg.png");
      assert.equal(fs.existsSync(path.join(root, "media", "cover-bg.png")), true);
      assert.ok(fs.statSync(path.join(root, "media", "cover-bg.png")).size >= 64);
      const imagine = calls.find((row) => String(row.url).includes("/images/generations"));
      assert.ok(imagine);
      const imagineBody = imagine.body as { model: string; aspect_ratio?: string; size?: string };
      assert.equal(imagineBody.model, "grok-imagine-image-2.0");
      assert.equal(imagineBody.aspect_ratio, "16:9");
      assert.equal(imagineBody.size, undefined);
    } finally {
      globalThis.fetch = origFetch;
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not call xAI web_search for MiniMax without research URLs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-produce-exec-"));
    const restore = bindEnv({
      MINIMAX_CN_API_KEY: "sk-test-cn",
      SLIDESTUDIO_IMAGE_API_KEY: undefined,
      SLIDESTUDIO_IMAGE_BASE_URL: undefined,
      SLIDESTUDIO_RESEARCH_URL: undefined,
      SLIDESTUDIO_IMAGE_SEARCH_URL: undefined,
    });
    let called = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    try {
      const run = createPresentationRun({ repoRoot: REPO });
      const handle = await run.open({
        projectRoot: root,
        sessionId: "mini-sess",
        brief: "两页即可",
        editorBaseUrl: "http://127.0.0.1:55200",
        design: { kind: "self-directed" },
        provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
      });
      const blocked = await run.execute(
        { name: "web_search", args: { query: "should not search" } },
        {
          runId: handle.runId,
          sessionId: handle.sessionId,
          toolCallId: "web-blocked",
          projectRoot: root,
          abortSignal: new AbortController().signal,
        },
      );
      assert.equal(blocked.ok, false);
      assert.match(blocked.detail, /not configured/);
      assert.equal(called, 0);
    } finally {
      globalThis.fetch = origFetch;
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fail-closes generate_image without writing a placeholder PNG", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-gen-fail-"));
    const restore = bindEnv({
      SLIDESTUDIO_EDITOR_URL: "http://127.0.0.1:55200",
      SLIDESTUDIO_PLAYWRIGHT_RUNTIME: stubPlaywrightRuntime(),
      SLIDESTUDIO_IMAGE_API_KEY: "test-xai-key",
      SLIDESTUDIO_IMAGE_BASE_URL: XAI_API_BASE,
      SLIDESTUDIO_IMAGE_MODEL: "grok-imagine-image-2.0",
      SLIDESTUDIO_IMAGE: "1",
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("image API unavailable", { status: 503 })) as typeof fetch;
    try {
      const run = createPresentationRun({ repoRoot: REPO });
      const handle = await run.open({
        projectRoot: root,
        sessionId: "gen-fail",
        brief: "封面需要一张生成底图",
        editorBaseUrl: "http://127.0.0.1:55200",
        design: { kind: "self-directed" },
        provider: { providerId: GROK_PROVIDER_ID, modelId: "grok-4.6" },
      });
      acceptGrokRoute(root);
      const generated = await run.execute(
        {
          name: "generate_image",
          args: { id: "cover-xai-lab-gen", prompt: "navy cover", aspect: "16:9" },
        },
        {
          runId: handle.runId,
          sessionId: handle.sessionId,
          toolCallId: "img-gen-fail",
          projectRoot: root,
          abortSignal: new AbortController().signal,
        },
      );
      assert.equal(generated.ok, false);
      assert.match(generated.detail, /image HTTP 503|unavailable/);
      assert.equal(fs.existsSync(path.join(root, "media", "cover-xai-lab-gen.png")), false);
      assert.equal(generated.payload.kind, undefined);
    } finally {
      globalThis.fetch = origFetch;
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("Grok native hosted search does not block compose on a missing function-call receipt", async () => {
    const factsBrief = "封面需要今年航天新闻和一张封面底图";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-search-receipt-"));
    const restore = bindEnv({
      SLIDESTUDIO_EDITOR_URL: "http://127.0.0.1:55200",
      SLIDESTUDIO_PLAYWRIGHT_RUNTIME: stubPlaywrightRuntime(),
      SLIDESTUDIO_IMAGE_API_KEY: "test-xai-key",
      SLIDESTUDIO_IMAGE_BASE_URL: XAI_API_BASE,
      SLIDESTUDIO_IMAGE_MODEL: "grok-imagine-image-2.0",
      SLIDESTUDIO_IMAGE: "1",
    });
    const origFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url, init) => {
      const href = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: href, body });
      if (href.includes(XAI_RESPONSES_PATH)) {
        return new Response(
          JSON.stringify({
            output_text: "- Starship Flight 11 flew in 2026.\nSee [NASA](https://www.nasa.gov/starship).",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${href}`);
    }) as typeof fetch;
    try {
      const run = createPresentationRun({ repoRoot: REPO });
      const handle = await run.open({
        projectRoot: root,
        sessionId: "hosted-search-receipt",
        brief: factsBrief,
        editorBaseUrl: "http://127.0.0.1:55200",
        design: { kind: "self-directed" },
        provider: { providerId: GROK_PROVIDER_ID, modelId: "grok-4.6" },
      });
      acceptGrokRoute(root);
      writeDomainRuntime(root, {
        brief: factsBrief,
        editorBaseUrl: "http://127.0.0.1:55200",
        designDirection: "self-directed",
        strictExecution: true,
      });
      const ctx = (toolCallId: string) => ({
        runId: handle.runId,
        sessionId: handle.sessionId,
        toolCallId,
        projectRoot: root,
        abortSignal: new AbortController().signal,
      });

      const grokTools = GENERATE_TOOLS.map((spec) => ({
        name: spec.function.name,
        parameters: spec.function.parameters,
      }));
      const webSpec = grokTools.find((tool) => tool.name === "web_search");
      const webParams = webSpec?.parameters as {
        properties?: { queries?: unknown; query?: unknown };
      };
      assert.ok(webParams?.properties?.queries);
      assert.equal("query" in (webParams.properties ?? {}), false);
      const searchImageAt = grokTools.findIndex((tool) => tool.name === "search_image");
      const webAt = grokTools.findIndex((tool) => tool.name === "web_search");
      assert.equal(webAt, searchImageAt - 1);

      const queryOnly = [
        {
          name: "web_search",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ];
      assert.equal(grok46WouldCallWebSearch(queryOnly, factsBrief), undefined);

      const call = grok46WouldCallWebSearch(grokTools, factsBrief);
      assert.ok(call, "grok-4.6 must emit tool/call web_search for a hosted facts brief");
      assert.equal(call.name, "web_search");
      assert.ok(Array.isArray(call.args.queries) && call.args.queries.length >= 1);

      const before = inspectRunLedger(root);
      assert.equal(before.initialized, true);
      assert.equal(
        before.composeBlockers.includes(MISSING_HOSTED_WEB_SEARCH_RECEIPT),
        false,
        before.composeBlockers.join("; "),
      );

      const search = await run.execute({ name: "web_search", args: call.args }, ctx("web-call-1"));
      assert.equal(search.ok, true, search.detail);
      assert.equal(search.name, "web_search");
      assert.equal(search.payload.source, "pi-xai-hosted");
      assert.ok(Array.isArray(search.payload.queries));
      assert.ok(calls.some((row) => String(row.url).includes(XAI_RESPONSES_PATH)));
      assert.equal(ledgerHasSuccessfulWebSearch(readRunLedger(root)), true);

      const after = inspectRunLedger(root);
      assert.equal(
        after.composeBlockers.includes(MISSING_HOSTED_WEB_SEARCH_RECEIPT),
        false,
        after.composeBlockers.join("; "),
      );
    } finally {
      globalThis.fetch = origFetch;
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when hosted web_search returns no facts or citations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-search-empty-"));
    const restore = bindEnv({
      SLIDESTUDIO_EDITOR_URL: "http://127.0.0.1:55200",
      SLIDESTUDIO_PLAYWRIGHT_RUNTIME: stubPlaywrightRuntime(),
      SLIDESTUDIO_IMAGE_API_KEY: "test-xai-key",
      SLIDESTUDIO_IMAGE_BASE_URL: XAI_API_BASE,
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      if (String(url).includes(XAI_RESPONSES_PATH)) {
        return new Response(JSON.stringify({ output_text: "   " }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as typeof fetch;
    try {
      const run = createPresentationRun({ repoRoot: REPO });
      const handle = await run.open({
        projectRoot: root,
        sessionId: "hosted-search-empty",
        brief: "封面需要今年航天新闻和一张封面底图",
        editorBaseUrl: "http://127.0.0.1:55200",
        design: { kind: "self-directed" },
        provider: { providerId: GROK_PROVIDER_ID, modelId: "grok-4.6" },
      });
      acceptGrokRoute(root);
      const empty = await run.execute(
        { name: "web_search", args: { queries: ["今年航天新闻"] } },
        {
          runId: handle.runId,
          sessionId: handle.sessionId,
          toolCallId: "web-empty",
          projectRoot: root,
          abortSignal: new AbortController().signal,
        },
      );
      assert.equal(empty.ok, false);
      assert.match(empty.detail, new RegExp(EMPTY_HOSTED_WEB_SEARCH));
      assert.equal(ledgerHasSuccessfulWebSearch(readRunLedger(root)), false);
    } finally {
      globalThis.fetch = origFetch;
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not demand a web_search receipt when MiniMax research is off", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-no-search-receipt-"));
    const restore = bindEnv({
      MINIMAX_CN_API_KEY: "sk-test-cn",
      SLIDESTUDIO_IMAGE_API_KEY: undefined,
      SLIDESTUDIO_IMAGE_BASE_URL: undefined,
      SLIDESTUDIO_RESEARCH_URL: undefined,
      SLIDESTUDIO_IMAGE_SEARCH_URL: undefined,
    });
    try {
      const run = createPresentationRun({ repoRoot: REPO });
      await run.open({
        projectRoot: root,
        sessionId: "mini-no-receipt",
        brief: "封面需要今年航天新闻和一张封面底图",
        editorBaseUrl: "http://127.0.0.1:55200",
        design: { kind: "self-directed" },
        provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
      });
      writeDomainRuntime(root, {
        brief: "封面需要今年航天新闻和一张封面底图",
        editorBaseUrl: "http://127.0.0.1:55200",
        designDirection: "self-directed",
        strictExecution: true,
      });
      const caps = inspectProjectCapabilities(root);
      assert.equal(caps.research.via, "env");
      assert.equal(caps.research.configured, false);
      const inspection = inspectRunLedger(root);
      assert.equal(inspection.initialized, true);
      assert.equal(inspection.composeBlockers.includes(MISSING_HOSTED_WEB_SEARCH_RECEIPT), false);
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
