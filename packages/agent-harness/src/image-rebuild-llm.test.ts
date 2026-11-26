import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { imageToDataUrl, rebuildNodesFromImage } from "./image-rebuild-llm.js";
import type { LlmPort } from "./llm-port.js";

function tmpPng(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-img-"));
  const file = path.join(dir, "frame.png");
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return file;
}

describe("image rebuild via multimodal LLM", () => {
  it("imageToDataUrl returns a data URL", () => {
    assert.match(imageToDataUrl(tmpPng()), /^data:image\/png;base64,/);
  });

  it("multimodal LLM nodes drive the rebuild", async () => {
    const llm: LlmPort = {
      async completeJson() {
        throw new Error("unused");
      },
      async completeJsonWithImages(_s, _u, images) {
        assert.equal(images.length, 1);
        assert.match(images[0]!.url, /^data:image\//);
        return {
          title: "SMART CONNECTIONS",
          nodes: [
            { text: "感知", role: "node" },
            { text: "路由", role: "node" },
            { text: "决策", role: "node" },
          ],
        };
      },
    };
    const nodes = await rebuildNodesFromImage(llm, tmpPng());
    assert.deepEqual(
      nodes.map((n) => n.text),
      ["感知", "路由", "决策"],
    );
  });

  it("text-only backend throws so the caller falls back", async () => {
    const llm: LlmPort = {
      async completeJson() {
        throw new Error("unused");
      },
      async completeJsonWithImages() {
        throw new Error("LLM backend is text-only (image disabled)");
      },
    };
    await assert.rejects(() => rebuildNodesFromImage(llm, tmpPng()));
  });

  it("LLM with no nodes is treated as a failure", async () => {
    const llm: LlmPort = {
      async completeJson() {
        throw new Error("unused");
      },
      async completeJsonWithImages() {
        return { nodes: [] };
      },
    };
    await assert.rejects(() => rebuildNodesFromImage(llm, tmpPng()), /no nodes/);
  });
});
