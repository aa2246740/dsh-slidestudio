import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_TEMPLATE_ASPECTS,
  defaultTemplateAspects,
  designAspectRefusal,
  resolveDesignAspects,
} from "./design-aspects.js";
import { MaterialPackError, verifyMaterial } from "./material-pack.js";
import {
  templateMaterialChunks,
  templateMaterialPartDescriptors,
  templateMaterialPartText,
} from "./material-template-text.js";

const THEME_ID = "22222222-2222-2222-2222-222222222222-brand.thmx";
const SVG_ID = "33333333-3333-3333-3333-333333333333-logo.svg";
const THEME_SOURCE = `material:${THEME_ID}`;

const sha = (bytes: Uint8Array | string): string => crypto.createHash("sha256").update(bytes).digest("hex");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oss-theme-file-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "_agent", "materials"), { recursive: true });
  return root;
}

function writeManifest(root: string, entries: Record<string, unknown>[]): void {
  fs.writeFileSync(
    path.join(root, "_agent", "materials", "manifest.json"),
    `${JSON.stringify({ version: 1, materials: entries })}\n`,
  );
}

/** A materialized .thmx exactly as the host writes it: design source only. */
function themeProject(): string {
  const root = project();
  const dir = path.join(root, "_agent", "materials", THEME_ID);
  fs.mkdirSync(dir, { recursive: true });
  const original = Buffer.from("zip bytes of a theme file");
  fs.writeFileSync(path.join(dir, "original.thmx"), original);
  const derivative = Buffer.from(
    JSON.stringify({
      schema: "material-derivative/v1",
      materialId: THEME_ID,
      kind: "deck-template",
      status: "ok",
      source: { sha256: sha(original), detectedMime: "application/vnd.ms-officetheme" },
      parser: { id: "thmx-theme-v1" },
      "deck-template": {
        theme: { colors: { accent1: "#00589C" } },
        masters: [],
        slides: [],
        media: [],
      },
    }),
  );
  fs.writeFileSync(path.join(dir, "derivative.json"), derivative);
  const markdown = Buffer.from(
    ["【Color Palette】", "- accent1: #00589C", "", "【Typography】", "- major: Georgia", ""].join("\n"),
  );
  const json = Buffer.from(
    `${JSON.stringify({ version: 1, themeColors: { accent1: "#00589C" }, colors: {}, layouts: [], logos: [] })}\n`,
  );
  fs.writeFileSync(path.join(dir, "design-source.md"), markdown);
  fs.writeFileSync(path.join(dir, "design-source.json"), json);
  fs.writeFileSync(
    path.join(dir, "receipt.json"),
    `${JSON.stringify({
      version: 1,
      id: THEME_ID,
      name: "brand.thmx",
      kind: "deck-template",
      parser: "thmx-theme-v1",
      originalSha256: sha(original),
      derivativeSha256: sha(derivative),
      designSourceMdSha256: sha(markdown),
      designSourceJsonSha256: sha(json),
    })}\n`,
  );
  writeManifest(root, [
    {
      id: THEME_ID,
      name: "brand.thmx",
      kind: "deck-template",
      summaryZh: "主题文件",
      parser: "thmx-theme-v1",
      sha256: sha(original),
      parts: [{ part: "design" }],
    },
  ]);
  return root;
}

describe("a .thmx theme file is a palette and fonts source only", () => {
  const theme = { kind: "deck-template", parser: "thmx-theme-v1", name: "brand.thmx" } as const;

  it("accepts palette and fonts", () => {
    assert.equal(designAspectRefusal(theme, ["palette", "fonts"]), undefined);
  });

  it("refuses every other aspect in Chinese, naming the file and what it does provide", () => {
    for (const aspect of ["logo", "layouts", "decorations", "photos", "content", "data"] as const) {
      const refusal = designAspectRefusal(theme, [aspect]) ?? "";
      assert.match(refusal, /主题文件「brand\.thmx」只提供配色和字体（palette、fonts）/, aspect);
      assert.ok(refusal.includes(`（${aspect}）`), aspect);
    }
  });

  it("defaults to palette and fonts, where a PPTX template also defaults to a logo", () => {
    assert.deepEqual(defaultTemplateAspects(theme), ["palette", "fonts"]);
    assert.deepEqual(defaultTemplateAspects({ parser: "pptx-ooxml-v2" }), DEFAULT_TEMPLATE_ASPECTS);
  });

  it("is limited the same way when it is selected without any declaration", () => {
    const root = themeProject();
    assert.deepEqual(resolveDesignAspects(root, [THEME_SOURCE], undefined), [
      { source: THEME_SOURCE, aspects: ["palette", "fonts"] },
    ]);
  });

  it("refuses a declared layout use before anything is adopted", () => {
    const root = themeProject();
    assert.throws(
      () => resolveDesignAspects(root, [THEME_SOURCE], [{ source: THEME_SOURCE, aspects: ["palette", "layouts"] }]),
      /主题文件「brand\.thmx」只提供配色和字体.*版式（layouts）/,
    );
    assert.deepEqual(
      resolveDesignAspects(root, [THEME_SOURCE], [{ source: THEME_SOURCE, aspects: ["palette", "fonts"] }]),
      [{ source: THEME_SOURCE, aspects: ["palette", "fonts"] }],
    );
  });

  it("lists and reads only the design part", () => {
    const material = verifyMaterial(themeProject(), THEME_ID);
    assert.deepEqual(
      templateMaterialPartDescriptors(material).map((entry) => entry.part),
      ["design"],
    );
    assert.match(templateMaterialPartText(material, "design"), /accent1: #00589C/);
    for (const part of ["layouts", "slides", "tables", "charts"]) {
      assert.throws(
        () => templateMaterialChunks(material, part),
        (error) =>
          error instanceof MaterialPackError &&
          error.message.includes("可用 part：design") &&
          !error.message.includes("layouts、"),
        part,
      );
    }
  });
});

describe("an SVG material is verified against the PNG that was written, never the markup", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  function svgProject(receiptExtra: Record<string, unknown>, written: Buffer = png): string {
    const root = project();
    const dir = path.join(root, "_agent", "materials", SVG_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "original.png"), written);
    const derivative = Buffer.from(
      JSON.stringify({
        schema: "material-derivative/v1",
        materialId: SVG_ID,
        kind: "image",
        status: "ok",
        source: { sha256: sha(svg), detectedMime: "image/svg+xml" },
        parser: { id: "svg-raster-v1" },
        image: { format: "svg" },
      }),
    );
    fs.writeFileSync(path.join(dir, "derivative.json"), derivative);
    fs.writeFileSync(
      path.join(dir, "receipt.json"),
      `${JSON.stringify({
        version: 1,
        id: SVG_ID,
        name: "logo.svg",
        kind: "image",
        parser: "svg-raster-v1",
        originalSha256: sha(svg),
        derivativeSha256: sha(derivative),
        ...receiptExtra,
      })}\n`,
    );
    writeManifest(root, [
      {
        id: SVG_ID,
        name: "logo.svg",
        kind: "image",
        summaryZh: "SVG 矢量图",
        parser: "svg-raster-v1",
        sha256: sha(svg),
        needsVision: true,
        parts: [],
      },
    ]);
    return root;
  }

  it("accepts the PNG whose hash the receipt records", () => {
    const material = verifyMaterial(svgProject({ rasterSha256: sha(png) }), SVG_ID);
    assert.equal(material.originalExtension, ".png");
    assert.deepEqual(material.originalBytes, png);
    assert.equal(material.sha256, sha(svg));
  });

  it("rejects a PNG that is not the recorded one", () => {
    const root = svgProject({ rasterSha256: sha(png) }, Buffer.concat([png, Buffer.from([9])]));
    assert.throws(() => verifyMaterial(root, SVG_ID), /原文件已变化/);
  });

  it("still rejects a changed original when no raster hash is recorded", () => {
    assert.throws(() => verifyMaterial(svgProject({}), SVG_ID), /原文件已变化/);
  });
});
