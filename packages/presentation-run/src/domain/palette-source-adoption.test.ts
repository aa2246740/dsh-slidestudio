import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createEmptyProject,
  listComposedPage,
  loadProject,
  saveProject,
  titleOnlyCoverPage,
} from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "@open-slidestudio/exporter-native";
import { createPresentationRun } from "../run.js";
import { writeDomainRuntime } from "./domain-hands.js";
import { imageFixture, writeMaterialFixture } from "./material-testkit.js";
import { kindThemePackIssue, parseThemePackId } from "./theme-pack.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const BRIEF = "给董事会做一份上半年经营汇报。";
const PLAN = [{ pageId: "cover", title: "上半年经营汇报", layoutFamily: "cover", exhibits: [] }];
const PACK = "finance/honey-orange-memo";

const imageProfile = (hex: string, source = "image-pixels") => ({
  schema: "style-profile/v1",
  source,
  accentColors: [
    { hex, share: 0.3 },
    { hex: "#7A1F1F", share: 0.08 },
  ],
  neutralColors: [{ hex: "#FFFFFF" }],
  background: "#FFFFFF",
  contrastPairs: [],
});
const pdfProfile = {
  schema: "style-profile/v1",
  source: "pdf-vector-ops",
  pagesScanned: 4,
  accentColors: [{ hex: "#C00000", share: 0.9, roles: ["fill"] }],
  neutralColors: [{ hex: "#000000" }],
  fonts: [],
  pagePixels: {
    schema: "style-profile/v1",
    source: "pdf-page-pixels",
    pagesScanned: 2,
    accentColors: [
      { hex: "#B40606", share: 0.7 },
      { hex: "#2F5597", share: 0.1 },
    ],
    neutralColors: [{ hex: "#FFFFFF" }],
    background: "#FFFFFF",
  },
};

function addImage(root: string, id: string, name: string, profile: unknown) {
  const base = imageFixture(id, name, 1200, 800);
  writeMaterialFixture(root, {
    ...base,
    derivative: {
      image: {
        ...(base.derivative!.image as Record<string, unknown>),
        format: "png",
        styleProfile: profile,
      },
    },
  });
}

function addPdf(root: string, id: string, name: string, styleProfile: unknown) {
  writeMaterialFixture(root, {
    id,
    name,
    kind: "document",
    parser: "pdf-unpdf-v4",
    originalBytes: Buffer.from(`%PDF ${id}`),
    derivative: {
      document: {
        pageCount: 4,
        pages: [{ index: 1, chars: 4, lowText: false, text: "封面" }],
        styleProfile,
      },
    },
  });
}

async function session(t: { after(fn: () => void): void }, prepare: (root: string) => void, designSystemId?: string) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "palette-adopt-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "project");
  createEmptyProject(root, { title: "经营汇报" });
  fs.mkdirSync(path.join(root, "_agent", "materials"), { recursive: true });
  prepare(root);
  writeDomainRuntime(root, {
    brief: BRIEF,
    designDirection: designSystemId ? "preset" : "self-directed",
    strictExecution: true,
    ...(designSystemId ? { designSystemId } : {}),
  });
  const run = createPresentationRun({ repoRoot: REPO_ROOT });
  const handle = await run.open({
    projectRoot: root,
    sessionId: "palette-adopt",
    brief: BRIEF,
    editorBaseUrl: "http://127.0.0.1:55200",
    design: designSystemId ? { kind: "explicit-style", designSystemId } : { kind: "self-directed" },
    provider: { providerId: "test", modelId: "offline" },
  });
  let serial = 0;
  const call = (name: string, args: Record<string, unknown>) =>
    run.execute(
      { name, args },
      {
        runId: handle.runId,
        sessionId: handle.sessionId,
        projectRoot: root,
        abortSignal: new AbortController().signal,
        toolCallId: `palette-${name}-${++serial}`,
      },
    );
  // The catalog references are a separate requirement; read them so only the palette part is open.
  const references = await call("list_references", {});
  for (const chunk of references.payload.missingReferenceChunks as {
    sourceId: string;
    chunkIndex: number;
  }[]) {
    const read = await call("read_reference", chunk);
    assert.equal(read.ok, true, read.detail);
  }
  return { root, call, theme: () => loadProject(root).presentation.theme };
}

const commit = (extra: Record<string, unknown>) => ({ slidePlan: PLAN, ...extra });

describe("commit_design with image and PDF palette sources", () => {
  it("VAL-IMG-009: requires the palette part, then seeds the theme from the first accent", async (t) => {
    const s = await session(t, (root) => addImage(root, "img-brand", "brand-redwhite.png", imageProfile("#C00000")));
    const args = commit({
      adoptedSourceIds: ["material:img-brand"],
      designAspects: [{ source: "material:img-brand", aspects: ["palette"] }],
    });
    const before = await s.call("commit_design", args);
    assert.equal(before.ok, false);
    assert.match(before.detail, /material:img-brand#palette/);
    const missing = before.payload.missingMaterialChunks as { part?: string; materialId: string }[];
    assert.deepEqual(
      missing.map((chunk) => [chunk.materialId, chunk.part]),
      [["img-brand", "palette"]],
    );
    assert.equal(s.theme()?.colors?.accent1, undefined);

    // Reading the old `image` part or the wrong part does not satisfy the preflight.
    const other = await s.call("read_material", { materialId: "img-brand", part: "palette" });
    assert.equal(other.ok, true, other.detail);
    const after = await s.call("commit_design", args);
    assert.equal(after.ok, true, after.detail);
    assert.equal(s.theme()?.colors?.accent1, "#C00000");
    assert.equal(s.theme()?.colors?.accent2, "#7A1F1F");
    assert.equal(s.theme()?.colors?.dk1, undefined, "values are copied, never invented");
    assert.equal(
      s.theme()?.colors?.primary,
      "#C00000",
      "the first adopted accent is the primary colour that unstyled lines use",
    );
    assert.equal(s.theme()?.neutralChrome, true, "an adopted image palette turns on neutral chrome");
  });

  it("VAL-IMG-009: layouts on an image are refused and an undeclared image is not adopted by default", async (t) => {
    const s = await session(t, (root) => addImage(root, "img-brand", "brand-redwhite.png", imageProfile("#C00000")));
    await s.call("read_material", { materialId: "img-brand", part: "palette" });
    const layouts = await s.call(
      "commit_design",
      commit({
        adoptedSourceIds: ["material:img-brand"],
        designAspects: [{ source: "material:img-brand", aspects: ["layouts"] }],
      }),
    );
    assert.equal(layouts.ok, false);
    assert.match(layouts.detail, /图片「brand-redwhite\.png」只能作为配色来源（palette）/);
    const bare = await s.call("commit_design", commit({ adoptedSourceIds: ["material:img-brand"] }));
    assert.equal(bare.ok, false);
    assert.match(bare.detail, /designAspects/);
    assert.match(bare.detail, /palette/);
    assert.equal(s.theme()?.colors?.accent1, undefined);
    assert.equal(s.theme()?.neutralChrome, undefined, "a refused palette leaves the flag unset");
  });

  it("refuses a palette source without a usable accent before asking for a read", async (t) => {
    const s = await session(t, (root) =>
      addImage(root, "img-grey", "grey.png", { ...imageProfile("#C00000"), accentColors: [] }),
    );
    const result = await s.call(
      "commit_design",
      commit({
        adoptedSourceIds: ["material:img-grey"],
        designAspects: [{ source: "material:img-grey", aspects: ["palette"] }],
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.detail, /没有提取到可用的强调色/);
    assert.notEqual(result.payload.error, "required_source_chunks_unread");
  });

  it("VAL-PDF-006: a PDF palette is adopted in Freestyle, seeds the theme and satisfies kind_theme_pack", async (t) => {
    const s = await session(t, (root) => addPdf(root, "pdf-brand", "品牌手册.pdf", pdfProfile));
    const args = commit({
      adoptedSourceIds: ["material:pdf-brand"],
      designAspects: [{ source: "material:pdf-brand", aspects: ["palette"] }],
    });
    const before = await s.call("commit_design", args);
    assert.equal(before.ok, false);
    assert.match(before.detail, /material:pdf-brand#palette/);
    const read = await s.call("read_material", { materialId: "pdf-brand", part: "palette" });
    assert.equal(read.ok, true, read.detail);
    const done = await s.call("commit_design", args);
    assert.equal(done.ok, true, done.detail);
    assert.notEqual(done.payload.error, "missing_theme_pack");
    assert.equal(s.theme()?.colors?.accent1, "#C00000");
    assert.equal(s.theme()?.colors?.accent2, "#2F5597", "the near-identical page-pixel red adds no slot");
    assert.equal(s.theme()?.neutralChrome, true, "an adopted PDF palette turns on neutral chrome");

    for (const aspect of ["layouts", "decorations", "fonts", "logo"]) {
      const refused = await s.call(
        "commit_design",
        commit({
          adoptedSourceIds: ["material:pdf-brand"],
          designAspects: [{ source: "material:pdf-brand", aspects: [aspect] }],
        }),
      );
      assert.equal(refused.ok, false, aspect);
      assert.match(refused.detail, /PDF「品牌手册\.pdf」不支持/, aspect);
    }
  });

  it("VAL-PDF-006: with a style pack the PDF and image palette are refused with the controlled authority path", async (t) => {
    const s = await session(
      t,
      (root) => {
        addPdf(root, "pdf-brand", "品牌手册.pdf", pdfProfile);
        addImage(root, "img-brand", "brand-redwhite.png", imageProfile("#C00000"));
      },
      PACK,
    );
    for (const id of ["pdf-brand", "img-brand"]) {
      await s.call("read_material", { materialId: id, part: "palette" });
      const result = await s.call("commit_design", {
        slidePlan: PLAN,
        adoptedSourceIds: [`material:${id}`],
        designAspects: [{ source: `material:${id}`, aspects: ["palette"] }],
      });
      assert.equal(result.ok, false, id);
      assert.match(result.detail, /蜜橙备忘/, id);
      assert.match(result.detail, /designAuthority: material:<id>/, id);
    }
    assert.equal(s.theme()?.colors?.accent1, undefined);
    assert.equal(s.theme()?.neutralChrome, undefined);
  });

  it("VAL-ASPECT-005: the first palette source wins each theme key and hints never seed the theme", async (t) => {
    const prepare = (root: string) => {
      addImage(root, "img-a", "a.png", imageProfile("#C00000"));
      addImage(root, "img-b", "b.png", imageProfile("#1F4E9A"));
      addPdf(root, "pdf-unadopted", "线索.pdf", pdfProfile);
    };
    for (const [order, expected] of [
      [["img-a", "img-b"], "#C00000"],
      [["img-b", "img-a"], "#1F4E9A"],
    ] as const) {
      const s = await session(t, prepare);
      for (const id of order) await s.call("read_material", { materialId: id, part: "palette" });
      const result = await s.call(
        "commit_design",
        commit({
          adoptedSourceIds: order.map((id) => `material:${id}`),
          designAspects: order.map((id) => ({ source: `material:${id}`, aspects: ["palette"] })),
        }),
      );
      assert.equal(result.ok, true, result.detail);
      assert.equal(s.theme()?.colors?.accent1, expected, order.join());
      assert.equal(s.theme()?.colors?.accent2, "#7A1F1F", "later source fills only gaps");
      assert.equal(s.theme()?.neutralChrome, true, order.join());
      assert.notEqual(s.theme()?.colors?.accent1, "#B40606", "an unadopted PDF never seeds the theme");
    }
  });

  it("VAL-TPL-007: material ids of every adoptable kind resolve to the user pack family", () => {
    for (const id of ["tpl", "img", "logo", "screenshot", "pdf"]) {
      assert.equal(parseThemePackId(`material:${id}`), `material:${id}`);
    }
    assert.equal(
      kindThemePackIssue({
        brief: BRIEF,
        adoptedSourceIds: ["material:img"],
        designAspects: [{ source: "material:img", aspects: ["palette"] }],
      }),
      undefined,
    );
  });
});

describe("exported theme carries the adopted palette", () => {
  it("VAL-IMG-010: theme1.xml accent1 equals the image's first accent, and an unstyled rule uses it", async (t) => {
    const s = await session(t, (root) => addImage(root, "img-brand", "brand-redwhite.png", imageProfile("#C00000")));
    await s.call("read_material", { materialId: "img-brand", part: "palette" });
    const done = await s.call(
      "commit_design",
      commit({
        adoptedSourceIds: ["material:img-brand"],
        designAspects: [{ source: "material:img-brand", aspects: ["palette"] }],
      }),
    );
    assert.equal(done.ok, true, done.detail);
    const project = loadProject(s.root);
    const cover = titleOnlyCoverPage("上半年经营汇报");
    // A rule without its own colour falls back to the theme primary, which must come from the palette.
    cover.elements.push({
      elementId: "rule",
      elementType: "line",
      bounds: [80, 300, 800, 4],
      viewBox: [800, 4],
      points: "0 2 800 2",
      border: { style: "solid", width: 2 },
    });
    listComposedPage(project, "pages/cover.page", cover);
    saveProject(project);
    const exported = await exportProjectToPptx(loadProject(s.root));
    assert.equal(exported.report.ok, true);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(exported.data);
    const xml = await zip.file("ppt/theme/theme1.xml")!.async("string");
    assert.match(xml, /<a:accent1>\s*<a:srgbClr val="C00000"\/>/);
    assert.match(xml, /<a:accent2>\s*<a:srgbClr val="7A1F1F"\/>/);
    const slide = await zip.file("ppt/slides/slide1.xml")!.async("string");
    assert.doesNotMatch(slide, /2563EB/i, "the product default primary must not reach the slide");
    assert.match(slide, /<a:ln[^>]*>\s*<a:solidFill>\s*<a:srgbClr val="C00000"\/>/);
  });
});
