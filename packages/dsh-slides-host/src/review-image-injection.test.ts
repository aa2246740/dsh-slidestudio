import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { persistPresentationRunProvider, savePageRaster } from "@open-slidestudio/presentation-run";
import { registerSliceTools } from "./tools.js";
import { SliceSessionStore } from "./slice-session.js";
import { AgentFaults } from "./agent-fault.js";
import { writeSliceRuntime } from "./runtime.js";
import { PNG, asJsonValue, stubPlaywrightRuntime, fakeTools, stubPresentation } from "./tool-test-fixtures.js";

describe("review_page image-part inject", () => {
  it("saves the on-disk PNG and renders an image part for grok-4.6", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "review-inject-"));
    const runtimeFile = stubPlaywrightRuntime();
    const prevEditor = process.env.SLIDESTUDIO_EDITOR_URL;
    const prevPw = process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
    process.env.SLIDESTUDIO_EDITOR_URL = "http://127.0.0.1:55200";
    process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = runtimeFile;
    const saved: Array<{ bytes: number; name?: string }> = [];
    try {
      const store = new SliceSessionStore(workspace);
      const sessionId = "4ffffa83-b32e-42de-b12a-891caa23b608";
      const opened = store.openProject({
        dshSessionId: sessionId,
        title: "Vision inject",
        design: { kind: "self-directed" },
        provider: { providerId: "pi-xai", modelId: "grok-4.6" },
      });
      const projectRoot = store.resolveRoot(opened.binding);
      writeSliceRuntime(projectRoot, {
        brief: "cover",
        design: { kind: "self-directed" },
        editorBaseUrl: "http://127.0.0.1:55200",
        strictExecution: true,
      });
      fs.mkdirSync(path.join(projectRoot, "_agent"), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, "_agent", "presentation-run.v1.json"),
        `${JSON.stringify({
          sessionId,
          projectRoot,
          brief: "cover",
          design: { kind: "self-directed" },
          provider: { providerId: "pi-xai", modelId: "grok-4.6" },
        })}\n`,
      );
      persistPresentationRunProvider(projectRoot, {
        providerId: "pi-xai",
        modelId: "grok-4.6",
        ready: true,
        modelInputModalities: ["text", "image"],
      });
      savePageRaster(projectRoot, "1_cover", PNG);

      const { defs, runtime } = fakeTools();
      registerSliceTools(runtime, {
        store,
        presentation: stubPresentation(),
        workspaceRoot: workspace,
        editorBaseUrl: "http://127.0.0.1:55200",
        faults: new AgentFaults(),
        provider: {
          providerId: "pi-xai",
          modelId: "grok-4.6",
          ready: true,
          modelInputModalities: ["text", "image"],
        },
        attachments: {
          saveImage: async (input) => {
            saved.push({ bytes: input.data.byteLength, name: input.name });
            return {
              attachmentId: "sha256:review-raster",
              mediaType: "image/png",
              bytes: input.data.byteLength,
              width: 960,
              height: 540,
              name: input.name,
            };
          },
        },
      });
      const review = defs.find((def) => def.name === "review_page");
      assert.ok(review);
      const exec = {
        agent: { id: sessionId },
        callId: "review-1",
        signal: new AbortController().signal,
      } as unknown as ToolRunContext;
      const value = await review.execute(
        {
          pageId: "1_cover",
          revision: 1,
          deliveryToken: "tok",
          verdict: "pass",
          issues: ["none"],
        },
        exec,
      );
      const rec = asJsonValue(value);
      assert.ok(rec && typeof rec === "object" && rec !== null && !Array.isArray(rec));
      assert.ok("image" in rec);
      const blocks = review.output.render({}, rec);
      assert.equal(
        blocks.some((block) => block.type === "image"),
        true,
        JSON.stringify(blocks),
      );
      const image = blocks.find((block) => block.type === "image");
      assert.ok(image && image.type === "image" && "attachment" in image);
      assert.equal(image.attachment.attachmentId, "sha256:review-raster");
      assert.equal(saved.length, 1);
      assert.equal(saved[0]?.bytes, PNG.length);
    } finally {
      if (prevEditor === undefined) delete process.env.SLIDESTUDIO_EDITOR_URL;
      else process.env.SLIDESTUDIO_EDITOR_URL = prevEditor;
      if (prevPw === undefined) delete process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
      else process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = prevPw;
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
