import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aspectFromSlot, createImagePort, grokImageConfigFromEnv, imageConfigured, GROK_IMAGINE_MODEL } from "./image-port.js";
import { XAI_API_BASE } from "./grok-hosted.js";

const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

describe("Grok hosted image generate", () => {
  it("maps a planned photo frame to the nearest API aspect", () => {
    assert.equal(aspectFromSlot(258, 344), "3:4");
    assert.equal(aspectFromSlot(960, 540), "16:9");
    assert.equal(aspectFromSlot(400, 400), "1:1");
    assert.equal(aspectFromSlot(800, 600), "4:3");
  });

  it("POSTs grok-imagine-image-2.0 with aspect_ratio, not OpenAI size", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const port = createImagePort(
      {
        enabled: true,
        baseUrl: XAI_API_BASE,
        apiKey: "test-xai-key",
        model: GROK_IMAGINE_MODEL,
      },
      {
        fetch: async (url, init) => {
          calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
          return new Response(
            JSON.stringify({ data: [{ b64_json: TINY_PNG.toString("base64") }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      },
    );
    const image = await port.generate("navy cover background for a 2026 briefing", "16:9");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, `${XAI_API_BASE}/images/generations`);
    const body = calls[0]?.body as {
      model: string;
      prompt: string;
      aspect_ratio?: string;
      size?: string;
      response_format?: string;
    };
    assert.equal(body.model, GROK_IMAGINE_MODEL);
    assert.match(body.prompt, /navy cover/);
    assert.equal(body.aspect_ratio, "16:9");
    assert.equal(body.size, undefined);
    assert.equal(body.response_format, "b64_json");
    assert.equal(image.kind, "generated");
    assert.ok(image.bytes.length >= 64);
  });

  it("binds grok imagine config to api.x.ai even when only the oauth token is set", () => {
    const cfg = grokImageConfigFromEnv({
      SLIDESTUDIO_IMAGE_API_KEY: "oauth-access",
    });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.baseUrl, XAI_API_BASE);
    assert.equal(cfg.model, GROK_IMAGINE_MODEL);
    assert.equal(cfg.apiKey, "oauth-access");
  });

  it("fail-closes without writing bytes when generate is not configured", async () => {
    let called = 0;
    const port = createImagePort(
      { enabled: false },
      {
        fetch: async () => {
          called += 1;
          return new Response("nope", { status: 500 });
        },
      },
    );
    await assert.rejects(
      () => port.generate("should not write a placeholder"),
      /not configured/,
    );
    assert.equal(called, 0);
  });

  it("fail-closes on HTTP error instead of returning a placeholder PNG", async () => {
    const port = createImagePort(
      {
        enabled: true,
        baseUrl: XAI_API_BASE,
        apiKey: "test-xai-key",
        model: GROK_IMAGINE_MODEL,
      },
      {
        fetch: async () => new Response("image API unavailable", { status: 503 }),
      },
    );
    await assert.rejects(() => port.generate("cover"), /image HTTP 503/);
  });

  it("fail-closes when the oauth token is missing", async () => {
    const port = createImagePort({
      enabled: true,
      baseUrl: XAI_API_BASE,
      model: GROK_IMAGINE_MODEL,
    });
    await assert.rejects(() => port.generate("cover"), /no API key/);
  });
});

describe("vendor presets", () => {
  it("dashscope-sync posts multimodal-generation and downloads the image url", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const port = createImagePort(
      {
        enabled: true,
        baseUrl: "https://dashscope.aliyuncs.com",
        apiKey: "sk-test",
        model: "qwen-image-3.0",
        preset: "dashscope-sync",
      },
      {
        fetch: async (url, init) => {
          calls.push({ url: String(url), init });
          if (calls.length === 1) {
            return new Response(
              JSON.stringify({
                output: {
                  choices: [
                    { message: { content: [{ image: "https://oss.example/img.png" }] } },
                  ],
                },
              }),
              { status: 200 },
            );
          }
          return new Response(TINY_PNG, { status: 200, headers: { "Content-Type": "image/png" } });
        },
      },
    );
    const image = await port.generate("松鼠水彩", "4:3");
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0]?.url,
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    const body = JSON.parse(String(calls[0]?.init?.body ?? "{}")) as {
      model: string;
      input: { messages: Array<{ content: Array<{ text: string }> }> };
      parameters: { size: string; n: number };
    };
    assert.equal(body.model, "qwen-image-3.0");
    assert.equal(body.input.messages[0]?.content[0]?.text, "松鼠水彩");
    assert.equal(body.parameters.size, "1472*1140");
    assert.match(
      String((calls[0]?.init?.headers as Record<string, string>).Authorization),
      /Bearer sk-test/,
    );
    assert.equal(image.bytes.equals(TINY_PNG), true);
  });

  it("dashscope-task creates an async task then polls to SUCCEEDED", async () => {
    const calls: string[] = [];
    const port = createImagePort(
      {
        enabled: true,
        baseUrl: "https://dashscope.aliyuncs.com",
        apiKey: "sk-test",
        model: "wanx2.1-t2i-turbo",
        preset: "dashscope-task",
      },
      {
        fetch: async (url, init) => {
          calls.push(String(url));
          const u = String(url);
          if (u.includes("image-synthesis")) {
            assert.equal(
              (init?.headers as Record<string, string>)["X-DashScope-Async"],
              "enable",
            );
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              parameters: { size: string };
            };
            assert.equal(body.parameters.size, "1440*960");
            return new Response(
              JSON.stringify({ output: { task_id: "task-1", task_status: "PENDING" } }),
              { status: 200 },
            );
          }
          if (u.includes("/api/v1/tasks/")) {
            return new Response(
              JSON.stringify({
                output: {
                  task_status: "SUCCEEDED",
                  results: [{ url: "https://oss.example/result.png" }],
                },
              }),
              { status: 200 },
            );
          }
          return new Response(TINY_PNG, { status: 200 });
        },
      },
    );
    const image = await port.generate("cat", "16:9");
    assert.deepEqual(calls.slice(0, 2), [
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis",
      "https://dashscope.aliyuncs.com/api/v1/tasks/task-1",
    ]);
    assert.equal(image.bytes.equals(TINY_PNG), true);
  });

  it("gemini-imagen calls :predict with key query param", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const port = createImagePort(
      {
        enabled: true,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gkey",
        model: "imagen-3.0-generate-002",
        preset: "gemini-imagen",
      },
      {
        fetch: async (url, init) => {
          calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
          return new Response(
            JSON.stringify({
              predictions: [{ bytesBase64Encoded: TINY_PNG.toString("base64") }],
            }),
            { status: 200 },
          );
        },
      },
    );
    const image = await port.generate("cover", "3:4");
    assert.equal(
      calls[0]?.url,
      "https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=gkey",
    );
    const body = calls[0]?.body as { parameters: { aspectRatio: string } };
    assert.equal(body.parameters.aspectRatio, "3:4");
    assert.equal(image.bytes.equals(TINY_PNG), true);
  });

  it("stability posts multipart form data", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const port = createImagePort(
      {
        enabled: true,
        baseUrl: "https://api.stability.ai",
        apiKey: "sk-stab",
        preset: "stability",
      },
      {
        fetch: async (url, init) => {
          calls.push({ url: String(url), init });
          return new Response(
            JSON.stringify({ image: TINY_PNG.toString("base64"), finish_reason: "SUCCESS" }),
            { status: 200 },
          );
        },
      },
    );
    const image = await port.generate("cover", "16:9");
    assert.equal(calls[0]?.url, "https://api.stability.ai/v2beta/stable-image/generate/sd3");
    const form = calls[0]?.init?.body as FormData;
    assert.ok(form instanceof FormData);
    assert.equal(form.get("prompt"), "cover");
    assert.equal(form.get("aspect_ratio"), "16:9");
    assert.equal(image.bytes.equals(TINY_PNG), true);
  });

  it("template preset interpolates {{vars}} and reads imagePath", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const port = createImagePort(
      {
        enabled: true,
        baseUrl: "https://intranet.corp/img",
        preset: "template",
        template: {
          method: "POST",
          headers: { "X-Api-Key": "{{key}}" },
          body: '{"scene":"{{prompt}}","wh":"{{size}}","ver":"{{model}}"}',
          imagePath: "payload.result.0.img",
        },
        model: "corp-diffusion",
      },
      {
        fetch: async (url, init) => {
          calls.push({ url: String(url), init });
          return new Response(
            JSON.stringify({ payload: { result: [{ img: TINY_PNG.toString("base64") }] } }),
            { status: 200 },
          );
        },
      },
    );
    const image = await port.generate("封面", "1:1");
    assert.equal(calls[0]?.url, "https://intranet.corp/img");
    const body = JSON.parse(String(calls[0]?.init?.body ?? "{}")) as Record<string, string>;
    assert.equal(body.scene, "封面");
    assert.equal(body.wh, "1024x1024");
    assert.equal(body.ver, "corp-diffusion");
    assert.equal(image.bytes.equals(TINY_PNG), true);
  });

  it("template without a key counts as configured; named presets still require one", () => {
    assert.equal(
      imageConfigured({ enabled: true, baseUrl: "http://x", preset: "template" }),
      true,
    );
    assert.equal(
      imageConfigured({ enabled: true, baseUrl: "http://x", preset: "stability" }),
      false,
    );
    assert.equal(
      imageConfigured({ enabled: true, baseUrl: "http://x", preset: "openai", apiKey: "k" }),
      true,
    );
  });
});
