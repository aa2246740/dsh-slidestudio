import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeGenerateTool, executeGenerateToolAsync, loadPlaybook } from "./index.js";
import type { AgentToolState } from "./agent-tools.js";
import { createImagePort } from "./image-port.js";
import { createImageSearchPort } from "./image-search-port.js";
import { createPageRasterPort } from "./page-raster.js";
import { reviewSkillPages } from "./layout-qa.js";
import { listMedia } from "./media-store.js";

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
  it("loads the complete original OpenKimi skill without a host-written substitute", () => {
    assert.match(playbook.skillExcerpt, /Image priority/);
    // The vendored skill is native now: the visual review renders through the
    // product's own render_page instead of a desktop export script.
    assert.match(playbook.skillExcerpt, /Visual review with rendered page images/);
    assert.match(playbook.skillExcerpt, /render_page/);
    assert.match(playbook.skillExcerpt, /Read \*\*all files uploaded by the user\*\*/);
    assert.doesNotMatch(playbook.skillExcerpt, /\[truncated\]|HOST CONTRACT/);
  });

  it("compose_deck accepts a deck with zero images and empty media/", () => {
    const exec = executeGenerateTool(
      "compose_deck",
      {
        title: "东京三日",
        pages: [
          textPage,
          {
            id: "page-02",
            pageType: "content",
            elements: [
              {
                elementId: "title",
                elementType: "text",
                bounds: [40, 36, 880, 48],
                content: { text: "第一天看什么", bold: true, fontSize: 22 },
              },
              {
                elementId: "body",
                elementType: "text",
                bounds: [40, 100, 880, 360],
                content: { text: "浅草 → 隅田川。人均与门票标占位，不编造。", fontSize: 16 },
              },
            ],
          },
          {
            id: "page-03",
            pageType: "content",
            elements: [
              {
                elementId: "title",
                elementType: "text",
                bounds: [40, 36, 880, 48],
                content: { text: "第二天", bold: true, fontSize: 22 },
              },
              {
                elementId: "body",
                elementType: "text",
                bounds: [40, 100, 880, 360],
                content: { text: "原宿与代代木公园。停留时长占位。", fontSize: 16 },
              },
            ],
          },
          {
            id: "page-04",
            pageType: "close",
            elements: [
              {
                elementId: "title",
                elementType: "text",
                bounds: [80, 200, 800, 80],
                content: { text: "带走路线，不带走假数", fontSize: 24 },
              },
            ],
          },
        ],
      },
      state(),
    );
    assert.equal(exec.ok, true, exec.detail);
    assert.match(exec.summary, /PPTD/);
    assert.equal(exec.payload && typeof exec.payload === "object" && "pages" in exec.payload, true);
  });

  it("generate_image writes media/ only when the agent asks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-opt-"));
    const before = listMedia(dir);
    assert.deepEqual(before, []);
    const exec = await executeGenerateToolAsync(
      "generate_image",
      { id: "sensoji", prompt: "浅草寺门前白天，占位氛围", aspect: "16:9" },
      state(dir),
    );
    assert.equal(exec.ok, true, exec.detail);
    assert.match(String((exec.payload as { src?: string }).src), /media\/sensoji\.png/);
    assert.deepEqual(listMedia(dir), ["media/sensoji.png"]);
    assert.ok(fs.existsSync(path.join(dir, "media", "sensoji.png")));
  });

  it("review does not fail a text-only body page for missing media", () => {
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
              content: { text: "没有图也可以", bold: true, fontSize: 22 },
            },
            {
              elementId: "body",
              elementType: "text",
              bounds: [40, 100, 880, 360],
              content: { text: "正文、表格、形状都可以，不必有 media。", fontSize: 16 },
            },
          ],
        },
      ],
      { mode: "compose" },
    );
    assert.equal(
      review.issues.some((i) => i.code === "missing_media"),
      false,
    );
    assert.equal(
      review.issues.some((i) => i.code === "no_exhibit"),
      false,
    );
    assert.equal(review.ok, true, JSON.stringify(review.issues));
  });

  it("review_pages tool does not require media on written text pages", () => {
    const s = state();
    const written = executeGenerateTool(
      "write_page",
      {
        id: "page-01",
        pageType: "cover",
        elements: textPage.elements,
      },
      s,
    );
    assert.equal(written.ok, true, written.detail);
    const body = executeGenerateTool(
      "write_page",
      {
        id: "page-02",
        pageType: "content",
        elements: [
          {
            elementId: "title",
            elementType: "text",
            bounds: [40, 36, 880, 48],
            content: { text: "路线", bold: true, fontSize: 22 },
          },
          {
            elementId: "body",
            elementType: "text",
            bounds: [40, 100, 880, 360],
            content: { text: "浅草到隅田川。门票标占位。", fontSize: 16 },
          },
        ],
      },
      s,
    );
    assert.equal(body.ok, true, body.detail);
    const review = executeGenerateTool("review_pages", {}, s);
    assert.equal(review.ok, true, review.detail);
    assert.doesNotMatch(review.detail, /missing_media|no_exhibit/);
  });

  it("search_image writes media/ from a configured port", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "search-img-"));
    const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(80, 9)]);
    const s = state(dir);
    s.imageSearch = createImageSearchPort(
      { url: "https://search.test/images" },
      {
        fetch: async () =>
          new Response(JSON.stringify({ images: [{ b64_json: bytes.toString("base64") }] }), {
            status: 200,
          }),
      },
    );
    const exec = await executeGenerateToolAsync("search_image", { id: "sensoji", query: "浅草寺" }, s);
    assert.equal(exec.ok, true, exec.detail);
    assert.equal((exec.payload as { kind?: string }).kind, "search");
    assert.ok(fs.existsSync(path.join(dir, "media", "sensoji.png")));
  });

  it("search_image without a port does not write src", async () => {
    const exec = await executeGenerateToolAsync("search_image", { id: "x", query: "浅草寺" }, state());
    assert.equal(exec.ok, true);
    assert.equal((exec.payload as { kind?: string }).kind, "none");
  });

  it("classroom write_page keeps agent box+text and does not apply a host recipe", () => {
    const s = state();
    s.brief = "给二年级讲一讲种子怎么发芽";
    const written = executeGenerateTool(
      "write_page",
      {
        id: "page-1",
        pageType: "cover",
        elements: [
          { type: "slide", background: { fill: "#FDFAF5" } },
          {
            type: "text",
            text: "种子怎么发芽？",
            fontSize: 52,
            fontWeight: 700,
            color: "#44712E",
            position: { x: 50, y: 80, w: 900, h: 100 },
          },
          {
            type: "box",
            position: { x: 70, y: 260, w: 860, h: 180 },
            background: { fill: "#D7EBCE" },
          },
        ],
      },
      s,
    );
    assert.equal(written.ok, true, written.detail);
    assert.match(written.detail, /did not restamp/);
    const payload = written.payload as {
      restamped?: boolean;
      painted?: boolean;
      applied?: boolean;
      page?: {
        elements?: { elementId?: string; elementType?: string; content?: { text?: string } }[];
      };
    };
    assert.equal(payload.restamped, false);
    assert.equal(payload.painted, false);
    assert.equal(payload.applied, false);
    assert.ok(payload.page?.elements?.some((el) => el.elementType === "shape"));
    assert.match(JSON.stringify(payload.page), /种子怎么发芽/);
    assert.equal(
      payload.page?.elements?.some((el) => el.elementId === "circle"),
      false,
    );
    assert.equal(
      payload.page?.elements?.some((el) => el.elementId === "title-band"),
      false,
    );
  });

  it("classroom write_page accepts official header/circle/band and keeps that chrome", () => {
    const s = state();
    s.brief = "给二年级讲一讲种子怎么发芽";
    const written = executeGenerateTool(
      "write_page",
      {
        id: "page-1",
        pageType: "cover",
        elements: [
          {
            type: "header",
            size: "hero",
            content: "让我们一起探究小小的种子是如何破土而出",
            tag: "二年级科学自然课",
            color: "#44712E",
          },
          { type: "circle", size: "giant", background: "#F9DED8" },
          { type: "band", size: "medium", background: "#D7EBCE" },
        ],
      },
      s,
    );
    assert.equal(written.ok, true, written.detail);
    const page = (
      written.payload as {
        page?: { elements?: { elementId?: string; content?: { text?: string } }[] };
      }
    ).page;
    assert.ok(page?.elements?.some((el) => el.elementId === "circle"));
    assert.ok(page?.elements?.some((el) => el.elementId === "title-band"));
    assert.equal(
      page?.elements?.some((el) => el.elementId === "cover-stem"),
      false,
    );
    assert.equal((written.payload as { restamped?: boolean }).restamped, false);
    const title = page?.elements?.find((el) => el.elementId === "title");
    assert.match(title?.content?.text ?? "", /种子/);
    assert.equal((written.payload as { restamped?: boolean }).restamped, false);
    assert.equal((written.payload as { applied?: boolean }).applied, false);
  });

  it("classroom write_page accepts RGB circle/band fills without restamping", () => {
    const s = state();
    s.brief = "给二年级讲一讲种子怎么发芽";
    const written = executeGenerateTool(
      "write_page",
      {
        id: "page-1",
        pageType: "cover",
        elements: [
          { type: "circle", bounds: [60, 80, 400, 400], color: [249, 222, 216] },
          { type: "band", bounds: [36, 348, 560, 156], color: [215, 235, 206] },
          { type: "header", text: "种子怎么发芽" },
        ],
      },
      s,
    );
    assert.equal(written.ok, true, written.detail);
    const payload = written.payload as {
      restamped?: boolean;
      painted?: boolean;
      page?: { elements?: { elementId?: string; fill?: { color?: string } }[] };
    };
    assert.equal(payload.restamped, false);
    assert.equal(payload.painted, false);
    assert.ok(payload.page?.elements?.some((el) => el.elementId === "circle"));
    assert.ok(payload.page?.elements?.some((el) => el.elementId === "title-band"));
    assert.equal(
      payload.page?.elements?.some((el) => el.elementId === "cover-stem"),
      false,
    );
    const blush = payload.page?.elements?.find((el) => el.elementId === "circle");
    assert.equal(blush?.fill?.color?.toUpperCase(), "#F9DED8");
  });

  it("classroom write_page keeps title+body copy and does not stamp a host recipe", () => {
    const s = state();
    s.brief = "给二年级讲一讲种子怎么发芽";
    const written = executeGenerateTool(
      "write_page",
      {
        id: "page-02",
        pageType: "concept",
        title: "种子里面有什么？",
        body: "种皮、胚、子叶。这是一堵奶油色的字墙。",
      },
      s,
    );
    assert.equal(written.ok, true, written.detail);
    assert.match(written.detail, /did not restamp/);
    const page = (
      written.payload as {
        page?: { elements?: { elementType: string; elementId?: string }[] };
        restamped?: boolean;
        applied?: boolean;
      }
    ).page;
    assert.equal((written.payload as { restamped?: boolean }).restamped, false);
    assert.equal((written.payload as { applied?: boolean }).applied, false);
    assert.match(JSON.stringify(page), /种子里面有什么/);
    assert.match(JSON.stringify(page), /种皮、胚、子叶/);
    assert.equal(
      page?.elements?.some((el) => el.elementId === "aside"),
      false,
    );
    assert.equal(
      page?.elements?.some((el) => el.elementId === "ring-outer"),
      false,
    );
  });

  it("classroom write_page keeps a full-bleed bg element and does not rename it to background", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-bg-"));
    const s = state(dir);
    s.brief = "种子怎么发芽";
    const written = executeGenerateTool(
      "write_page",
      {
        id: "page-01",
        pageType: "cover",
        elements: [
          {
            elementId: "bg",
            elementType: "shape",
            shapeName: "rect",
            bounds: [0, 0, 960, 540],
            fill: { type: "solid", color: "#FDFAF5" },
          },
          {
            elementId: "circle",
            elementType: "shape",
            shapeName: "ellipse",
            bounds: [-80, -60, 420, 420],
            fill: { type: "solid", color: "#F9DED8" },
          },
          {
            elementId: "title",
            elementType: "text",
            bounds: [68, 378, 480, 56],
            content: { text: "种子怎么发芽", bold: true, fontSize: 36, color: "#44712E" },
          },
        ],
      },
      s,
    );
    assert.equal(written.ok, true, written.detail);
    const payload = written.payload as {
      restamped?: boolean;
      page?: { background?: unknown; elements?: { elementId?: string }[] };
    };
    assert.equal(payload.restamped, false);
    assert.equal(payload.page?.background, undefined);
    const ids = (payload.page?.elements ?? []).map((el) => el.elementId);
    assert.deepEqual(ids, ["bg", "circle", "title"]);
    const yaml = fs.readFileSync(path.join(dir, "pages", "01_cover.page"), "utf8");
    assert.match(yaml, /elementId: bg/);
    assert.doesNotMatch(yaml, /^background:/m);
  });

  it("classroom write_page keeps cover leaves the agent drew", () => {
    const s = state();
    s.brief = "种子怎么发芽";
    const written = executeGenerateTool(
      "write_page",
      {
        id: "page-1",
        pageType: "cover",
        elements: [
          {
            elementId: "circle",
            elementType: "shape",
            shapeName: "ellipse",
            bounds: [-80, -60, 420, 420],
            fill: { type: "solid", color: "#F9DED8" },
          },
          {
            elementId: "leaf1",
            elementType: "shape",
            shapeName: "ellipse",
            bounds: [120, 200, 90, 48],
            fill: { type: "solid", color: "#D7EBCE" },
          },
          {
            elementId: "title",
            elementType: "text",
            bounds: [64, 404, 480, 56],
            content: { text: "种子怎么发芽", bold: true, fontSize: 40, color: "#44712E" },
          },
        ],
      },
      s,
    );
    assert.equal(written.ok, true, written.detail);
    const payload = written.payload as {
      restamped?: boolean;
      painted?: boolean;
      applied?: boolean;
      page?: { elements?: { elementId?: string }[] };
    };
    assert.equal(payload.restamped, false);
    assert.equal(payload.painted, false);
    assert.equal(payload.applied, false);
    const ids = (payload.page?.elements ?? []).map((el) => el.elementId);
    assert.deepEqual(ids, ["circle", "leaf1", "title"]);
  });

  it("render_page is honest when raster is unavailable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "render-miss-"));
    const s = state(dir);
    s.raster = createPageRasterPort();
    const written = executeGenerateTool(
      "write_page",
      { id: "page-01", pageType: "cover", elements: textPage.elements },
      s,
    );
    assert.equal(written.ok, true, written.detail);
    const render = await executeGenerateToolAsync("render_page", { pageId: "page-01" }, s);
    assert.equal((render.payload as { kind?: string }).kind, "unavailable");
    assert.match(render.detail, /did not see the slide|unavailable/i);
  });
});
