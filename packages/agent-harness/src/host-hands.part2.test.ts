import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeGenerateTool, executeGenerateToolAsync, loadPlaybook } from "./index.js";
import type { AgentToolState } from "./agent-tools.js";
import { createImagePort } from "./image-port.js";
import { createPageRasterPort } from "./page-raster.js";
import { reviewSkillPages } from "./layout-qa.js";

const playbook = loadPlaybook();

function state(root?: string): AgentToolState {
  return {
    brief: "东京三日旅游攻略，不要编造人均消费",
    playbook,
    todos: [],
    researchNotes: [],
    writtenPages: [],
    projectRoot: root,
    image: createImagePort({ enabled: false }),
  };
}

const textPage = {
  id: "page-01",
  pageType: "cover",
  elements: [
    {
      elementId: "title",
      elementType: "text",
      bounds: [60, 80, 840, 120],
      content: { text: "东京三日", bold: true, fontSize: 36 },
    },
    {
      elementId: "sub",
      elementType: "text",
      bounds: [60, 220, 840, 80],
      content: { text: "路线与节奏，数字标占位", fontSize: 16 },
    },
  ],
};

describe("host hands — media is optional", () => {
  it("render_page saves a native-slide raster from an injected shot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "render-ok-"));
    const s = state(dir);
    s.raster = createPageRasterPort({
      editorBaseUrl: "http://127.0.0.1:55200",
      screenshot: async () => ({
        bytes: Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(80, 5)]),
        width: 960,
        height: 540,
      }),
    });
    executeGenerateTool("write_page", { id: "page-01", pageType: "cover", elements: textPage.elements }, s);
    const render = await executeGenerateToolAsync("render_page", { pageId: "page-01" }, s);
    assert.equal(render.ok, true, render.detail);
    assert.equal((render.payload as { kind?: string }).kind, "native-slide");
    assert.ok(fs.existsSync(path.join(dir, "_agent", "rasters", "page-01.png")));
  });

  it("dangling image src fails even though media itself is optional", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-miss-"));
    const review = reviewSkillPages(
      [
        {
          id: "page-02",
          pageType: "content",
          elements: [
            {
              elementId: "title",
              elementType: "text",
              bounds: [40, 36, 880, 48],
              content: { text: "浅草", bold: true, fontSize: 22 },
            },
            {
              elementId: "photo",
              elementType: "image",
              bounds: [80, 100, 800, 360],
              src: "media/sensoji.png",
            },
          ],
        },
      ],
      { projectRoot: dir, mode: "compose" },
    );
    assert.equal(review.ok, false);
    assert.ok(review.issues.some((i) => i.code === "missing_media"));
  });
});
