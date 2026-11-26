import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { listMaterialsResult } from "./material-hands.js";
import { materialChunkCount, materialPartText, readMaterialChunk } from "./material-content.js";
import { verifyMaterial } from "./material-pack.js";
import { imageFixture, tempProject, writeMaterialFixture } from "./material-testkit.js";
import { paletteSourceHexes, paletteThemeAccents, paletteUnavailableReason } from "./palette-source.js";
import { packColorWriteContext } from "./theme-pack.js";
import { writePageColorIssues } from "./layout-qa.js";
import { writeDomainRuntime } from "./domain-hands.js";

const IMAGE_PROFILE = {
  schema: "style-profile/v1",
  source: "image-pixels",
  accentColors: [
    { hex: "#C00000", share: 0.3 },
    { hex: "#7A1F1F", share: 0.08 },
  ],
  neutralColors: [{ hex: "#FFFFFF" }, { hex: "#F2F2F2" }],
  background: "#FFFFFF",
  contrastPairs: [{ fg: "#C00000", bg: "#FFFFFF", ratio: 6.5 }],
};

const PDF_VECTOR = {
  schema: "style-profile/v1",
  source: "pdf-vector-ops",
  pagesScanned: 5,
  accentColors: [{ hex: "#C00000", share: 0.85, roles: ["fill"] }],
  neutralColors: [{ hex: "#000000" }],
  fonts: [],
};
const PDF_PIXELS = {
  schema: "style-profile/v1",
  source: "pdf-page-pixels",
  pagesScanned: 3,
  accentColors: [
    { hex: "#B40606", share: 0.6 },
    { hex: "#2F5597", share: 0.1 },
  ],
  neutralColors: [{ hex: "#FFFFFF" }],
  background: "#FFFFFF",
};

function imageProject(profile: unknown = IMAGE_PROFILE, extra: Record<string, unknown> = {}) {
  const root = tempProject();
  const base = imageFixture("img-brand", "brand-redwhite.png", 1200, 800);
  writeMaterialFixture(root, {
    ...base,
    derivative: {
      image: {
        ...(base.derivative!.image as Record<string, unknown>),
        format: "png",
        ...(profile === null ? {} : { styleProfile: profile }),
        ...extra,
      },
    },
  });
  return root;
}

function pdfProject(styleProfile: unknown, rendered: number[] = [1, 2]) {
  const root = tempProject();
  writeMaterialFixture(root, {
    id: "pdf-brand",
    name: "品牌手册.pdf",
    kind: "document",
    parser: "pdf-unpdf-v4",
    originalBytes: Buffer.from("%PDF synthetic"),
    parts: [{ part: "document", label: "5 页", pages: 5 }],
    derivative: {
      document: {
        pageCount: 5,
        pages: [{ index: 1, chars: 4, lowText: false, text: "封面" }],
        ...(styleProfile ? { styleProfile } : {}),
        renderedPages: rendered.map((index) => ({
          index,
          file: `page-${index}.jpg`,
          sha256: "a".repeat(64),
          px: { width: 960, height: 1360 },
        })),
      },
    },
    ...(rendered.length ? { pageImages: { pages: rendered } } : {}),
  });
  return root;
}

describe("palette part for images, logos and screenshots", () => {
  it("renders accents with share, neutrals, background, contrast pairs and the documented variants", () => {
    const root = imageProject();
    const material = verifyMaterial(root, "img-brand");
    const text = materialPartText(material, "palette");
    assert.match(text, /#C00000.*30(\.0)?%/);
    assert.match(text, /#7A1F1F/);
    assert.match(text, /中性色[\s\S]*#F2F2F2/);
    assert.match(text, /背景色[\s\S]*#FFFFFF/);
    assert.match(text, /#C00000.*#FFFFFF.*6\.5/);
    assert.match(text, /20%、40%、60%/);
    // 20% tint and 20% shade of #C00000
    assert.match(text, /#CD3333/);
    assert.match(text, /#9A0000/);
    assert.equal(materialChunkCount(material, "palette"), 1);
  });

  it("reads the palette as the image's default part and keeps the old part id as an alias", () => {
    const root = imageProject();
    const material = verifyMaterial(root, "img-brand");
    const vision = { modelAcceptsImages: true };
    const byDefault = readMaterialChunk({ material, ...vision });
    const explicit = readMaterialChunk({ material, part: "palette", ...vision });
    const alias = readMaterialChunk({ material, part: "image", ...vision });
    assert.equal(byDefault.part, "palette");
    assert.equal(alias.part, "palette");
    assert.equal(byDefault.chunkSha256, explicit.chunkSha256);
    assert.equal(alias.chunkSha256, explicit.chunkSha256);
    assert.match(explicit.text, /view_material/);
    // Without the vision flag the same part names no view tool.
    assert.doesNotMatch(readMaterialChunk({ material }).text, /view_material/);
  });

  it("states plainly when no usable accent was extracted", () => {
    const root = imageProject({ ...IMAGE_PROFILE, accentColors: [] });
    const material = verifyMaterial(root, "img-brand");
    assert.match(paletteUnavailableReason(material) ?? "", /没有提取到可用的强调色/);
    assert.match(materialPartText(material, "palette"), /没有提取到/);
    const none = verifyMaterial(imageProject(null), "img-brand");
    assert.match(paletteUnavailableReason(none) ?? "", /没有提取到可用的强调色/);
  });

  it("lists palette as the image part", () => {
    const root = imageProject();
    const listed = listMaterialsResult(root);
    const entry = (listed.payload as { materials: { parts: { part: string }[] }[] }).materials[0]!;
    assert.deepEqual(
      entry.parts.map((part) => part.part),
      ["palette"],
    );
    assert.match(listed.detail, /palette/);
  });
});

describe("palette part for PDFs", () => {
  it("merges vector and page-pixel colours and names both sources", () => {
    const root = pdfProject({ ...PDF_VECTOR, pagePixels: PDF_PIXELS });
    const material = verifyMaterial(root, "pdf-brand");
    const text = materialPartText(material, "palette");
    assert.match(text, /矢量图形/);
    assert.match(text, /页面图片/);
    assert.match(text, /#C00000/);
    assert.match(text, /#B40606/);
    assert.doesNotMatch(text, /未取到页面图片里的颜色/);
    assert.deepEqual(paletteThemeAccents(material).slice(0, 2), ["#C00000", "#2F5597"]);
    assert.equal(paletteSourceHexes(material)?.has("#B40606"), true);
  });

  it("without page pixels says so and keeps the vector colours only", () => {
    const root = pdfProject(PDF_VECTOR, []);
    const material = verifyMaterial(root, "pdf-brand");
    const text = materialPartText(material, "palette");
    assert.match(text, /未取到页面图片里的颜色/);
    assert.match(text, /#C00000/);
    assert.equal(paletteSourceHexes(material)?.has("#B40606"), false);
  });

  it("lists palette beside the text part and reports rendered page images", () => {
    const withPages = listMaterialsResult(pdfProject({ ...PDF_VECTOR, pagePixels: PDF_PIXELS }));
    const entry = (withPages.payload as { materials: { parts: { part: string }[] }[] }).materials[0]!;
    assert.deepEqual(
      entry.parts.map((part) => part.part),
      ["document", "palette"],
    );
    assert.match(withPages.detail, /页面图 2 页/);
    const without = listMaterialsResult(pdfProject(PDF_VECTOR, []));
    assert.match(without.detail, /页面图不可用/);
    assert.doesNotMatch(without.detail, /view_material/);
  });

  it("rejects a palette part on a Word document", () => {
    const root = tempProject();
    writeMaterialFixture(root, {
      id: "doc-word",
      name: "说明.docx",
      kind: "document",
      parser: "docx-ooxml-v1",
      originalBytes: Buffer.from("docx"),
      derivative: { document: { blocks: [{ type: "paragraph", text: "说明" }], chars: 2 } },
    });
    assert.throws(
      () => readMaterialChunk({ material: verifyMaterial(root, "doc-word"), part: "palette" }),
      /没有 palette 分段/,
    );
  });
});

describe("pack_color for palette sources", () => {
  function adopted(root: string, id: string, aspects = ["palette"]) {
    writeDomainRuntime(root, {
      brief: "季度工作汇报",
      designAspects: [{ source: `material:${id}`, aspects }],
    });
    return packColorWriteContext([`material:${id}`], root);
  }
  const page = (color: string) => ({
    id: "p1",
    pageType: "content",
    elements: [
      {
        elementId: "t",
        elementType: "shape",
        bounds: [0, 0, 100, 100],
        content: { fill: color },
      },
    ],
  });

  it("accepts the source accents and their tints and shades, and refuses other colours", () => {
    const root = imageProject();
    const context = adopted(root, "img-brand");
    assert.equal(context.materialError, undefined);
    for (const hex of ["#C00000", "#7A1F1F", "#FFFFFF", "#CD3333", "#9A0000", "#E69999", "#4D0000"]) {
      assert.equal(context.adoptedPackHexes?.has(hex), true, hex);
    }
    assert.equal(context.adoptedPackHexes?.has("#3366FF"), false);
    assert.deepEqual(context.adoptedDesignSourceIds, ["material:img-brand"]);
    const refused = writePageColorIssues(page("#3366FF") as never, undefined, context);
    assert.equal(refused[0]?.code, "pack_color");
    assert.match(refused[0]?.message ?? "", /已采用的设计源/);
    assert.deepEqual(writePageColorIssues(page("#C00000") as never, undefined, context), []);
    assert.deepEqual(writePageColorIssues(page("#CD3333") as never, undefined, context), []);
  });

  it("grants nothing when the palette was not declared", () => {
    const root = imageProject();
    const context = adopted(root, "img-brand", ["content"]);
    assert.equal(context.adoptedPackHexes, undefined);
  });

  it("fails closed with a Chinese error when the stored profile no longer matches its receipt", () => {
    const root = imageProject();
    const file = path.join(root, "_agent", "materials", "img-brand", "derivative.json");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("#C00000", "#3366FF"));
    const context = adopted(root, "img-brand");
    assert.match(context.materialError ?? "", /已采用的设计源.*解析结果已变化/);
    assert.equal(context.adoptedPackHexes?.has("#3366FF") ?? false, false);
  });

  it("fails closed when the source has no usable accent", () => {
    const root = imageProject({ ...IMAGE_PROFILE, accentColors: [] });
    const context = adopted(root, "img-brand");
    assert.match(context.materialError ?? "", /没有提取到可用的强调色/);
  });

  it("accepts PDF vector and page-pixel colours in Freestyle and nothing under a style pack", () => {
    const root = pdfProject({ ...PDF_VECTOR, pagePixels: PDF_PIXELS });
    const context = adopted(root, "pdf-brand");
    assert.equal(context.adoptedPackHexes?.has("#C00000"), true);
    assert.equal(context.adoptedPackHexes?.has("#B40606"), true);
    assert.equal(context.adoptedPackHexes?.has("#3366FF"), false);
    writeDomainRuntime(root, {
      brief: "季度工作汇报",
      designSystemId: "finance/honey-orange-memo",
      designAspects: [{ source: "material:pdf-brand", aspects: ["palette"] }],
    });
    const packed = packColorWriteContext(["material:pdf-brand"], root);
    assert.equal(packed.adoptedDesignSourceIds, undefined);
    assert.equal(packed.adoptedPackHexes?.has("#B40606") ?? false, false);
  });
});
