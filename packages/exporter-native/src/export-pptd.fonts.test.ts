import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyProject, listComposedPage, saveProject, titleOnlyCoverPage } from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "./export-pptd.js";
import { buildEmbeddedFonts, collectUsedText, fsTypeRestricted, sfntFsType } from "./font-embed.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FONTS_CSS = path.join(repoRoot, "apps/native-web/public/fonts.css");
const FONTS_DIR = path.join(repoRoot, "apps/native-web/public/fonts");

/** Same @font-face parsing the server uses at startup: family → ordered
 * { weight, file } entries (weight defaults to 400). */
function fontFamilies(): Map<string, { weight: number; file: string }[]> {
  const css = fs.readFileSync(FONTS_CSS, "utf8");
  const map = new Map<string, { weight: number; file: string }[]>();
  for (const m of css.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
    const block = m[1] ?? "";
    const fam = /font-family:\s*(?:"([^"]+)"|'([^']+)'|([^;]+))\s*;/.exec(block);
    const src = /src:\s*url\(["']?([^"')]+)["']?\)/.exec(block);
    if (!fam || !src || !src[1]) continue;
    const family = String(fam[1] ?? fam[2] ?? fam[3] ?? "").trim();
    if (!family) continue;
    const weightMatch = /font-weight:\s*(\d+)/.exec(block);
    const list = map.get(family) ?? [];
    list.push({
      weight: weightMatch ? Number(weightMatch[1]) : 400,
      file: path.resolve(path.dirname(FONTS_CSS), src[1].trim()),
    });
    map.set(family, list);
  }
  return map;
}

function projectWithCover(dir: string, title: string) {
  const project = createEmptyProject(dir, { title });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage(title));
  saveProject(project);
  return project;
}

function fontEmbedOpts() {
  return { embedFonts: { fontsDir: FONTS_DIR, families: fontFamilies() } };
}

describe("export-native embedded fonts", () => {
  it("leaves the zip untouched when embedFonts is off", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-fonts-off-"));
    const project = projectWithCover(dir, "无嵌入");
    project.pages[0]!.page.elements = [
      {
        elementId: "t1",
        elementType: "text",
        bounds: [60, 60, 400, 60],
        content: { text: "门店深度复盘", fontSize: 28 },
      },
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    assert.deepEqual(
      Object.keys(zip.files).filter((n) => n.startsWith("ppt/fonts/")),
      [],
    );
    const pres = await zip.file("ppt/presentation.xml")?.async("string");
    assert.ok(pres);
    assert.doesNotMatch(pres, /embeddedFontLst/);
    assert.doesNotMatch(pres, /embedTrueTypeFonts/);
    assert.equal(result.report.embeddedFonts, undefined);
    assert.equal(result.report.skippedFonts, undefined);
  });

  it("embeds a subsetted TTF and wires content types, rels, and embeddedFontLst", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-fonts-on-"));
    const project = projectWithCover(dir, "嵌入字体");
    project.pages[0]!.page.elements = [
      {
        elementId: "t1",
        elementType: "text",
        bounds: [60, 60, 500, 80],
        content: { text: "门店深度复盘报告", fontSize: 32, fontFamily: "MiSans" },
      },
      {
        elementId: "t2",
        elementType: "text",
        bounds: [60, 160, 500, 60],
        content: { text: "Latin Unna 标题", fontSize: 24, fontFamily: "Unna" },
      },
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project, fontEmbedOpts());
    const embedded = result.report.embeddedFonts ?? [];
    const faces = embedded.map((f) => f.typeface);
    assert.ok(faces.includes("MiSans"), `MiSans embedded: ${faces}`);
    assert.ok(faces.includes("Unna"), `Unna embedded: ${faces}`);

    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);

    const contentTypes = await zip.file("[Content_Types].xml")?.async("string");
    assert.ok(contentTypes);
    assert.match(contentTypes, /<Default Extension="fntdata" ContentType="application\/x-fontdata"\/>/);

    const parts = Object.keys(zip.files).filter((n) => /^ppt\/fonts\/font\d+\.fntdata$/.test(n));
    assert.equal(parts.length, embedded.length);
    const first = await zip.file("ppt/fonts/font1.fntdata")?.async("uint8array");
    assert.ok(first);
    const magic = Buffer.from(first.slice(0, 4)).toString("hex").toUpperCase();
    assert.ok(
      magic === "00010000" || Buffer.from(first.slice(0, 4)).toString("ascii") === "OTTO",
      `fntdata starts with a sfnt magic, got ${magic}`,
    );

    const pres = await zip.file("ppt/presentation.xml")?.async("string");
    assert.ok(pres);
    assert.match(pres, /embedTrueTypeFonts="1"/);
    const lstPos = pres.indexOf("<p:embeddedFontLst>");
    const defaultStylePos = pres.indexOf("<p:defaultTextStyle");
    assert.ok(lstPos >= 0, "embeddedFontLst present");
    assert.ok(lstPos < defaultStylePos, "embeddedFontLst must precede p:defaultTextStyle");
    for (const face of faces) {
      assert.match(pres, new RegExp(`<p:font typeface="${face}"/>`));
    }

    const rels = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string");
    assert.ok(rels);
    const fontRels = rels.match(/relationships\/font/g) ?? [];
    assert.equal(fontRels.length, embedded.length);

    // The embedded subset reparses and still covers the deck's CJK text.
    const { Font } = await import("fonteditor-core");
    const fontIndex = faces.indexOf("MiSans");
    const misans = await zip.file(`ppt/fonts/font${fontIndex + 1}.fntdata`)!.async("uint8array");
    const reparsed = Font.create(Buffer.from(misans), { type: "ttf" }).get();
    for (const ch of "门店深度复盘报告") {
      assert.ok(reparsed.cmap[ch.codePointAt(0)!], `cmap covers U+${ch.codePointAt(0)!.toString(16)} (${ch})`);
    }

    // A CJK source is megabytes of woff2; the subset must be tiny.
    const misansWoff2 = fs.statSync(path.join(FONTS_DIR, "MiSans.woff2")).size;
    assert.ok(
      misans.byteLength < misansWoff2 / 10,
      `subset ${misans.byteLength} should be far below source ${misansWoff2}`,
    );
  });

  it("reports families missing from fonts.css as skipped, without aborting", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-fonts-skip-"));
    const project = projectWithCover(dir, "缺字体");
    project.pages[0]!.page.elements = [
      {
        elementId: "t1",
        elementType: "text",
        bounds: [60, 60, 400, 60],
        content: { text: "Hello", fontSize: 24, fontFamily: "Arial" },
      },
      {
        elementId: "t2",
        elementType: "text",
        bounds: [60, 140, 400, 60],
        content: { text: "副标题", fontSize: 20, fontFamily: "MiSans" },
      },
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project, fontEmbedOpts());
    const skipped = result.report.skippedFonts ?? [];
    const arial = skipped.find((s) => s.typeface === "Arial");
    assert.ok(arial, `Arial should be skipped: ${JSON.stringify(skipped)}`);
    assert.match(arial.reason, /fonts\.css/);
    assert.ok(
      (result.report.embeddedFonts ?? []).some((f) => f.typeface === "MiSans"),
      "MiSans still embeds alongside the skip",
    );
  });

  it("embeds regular+bold faces of one family under a single embeddedFont entry", async () => {
    // fonts.css no longer ships a multi-weight slide face, so drive
    // buildEmbeddedFonts directly with the two Maple Mono weights on disk.
    // Old decks may still name such a family; the embed path must pair them.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-fonts-pair-"));
    const project = projectWithCover(dir, "双面嵌入");
    project.pages[0]!.page.elements = [
      {
        elementId: "t1",
        elementType: "text",
        bounds: [60, 60, 500, 80],
        content: { text: "Regular face", fontSize: 28, fontFamily: "PairDemo" },
      },
      {
        elementId: "t2",
        elementType: "text",
        bounds: [60, 160, 500, 60],
        content: {
          text: "Bold face",
          fontSize: 24,
          fontFamily: "PairDemo",
          bold: true,
        },
      },
    ];
    saveProject(project);

    const families = new Map([
      [
        "PairDemo",
        [
          { weight: 400, file: path.join(FONTS_DIR, "MapleMono-Latin-400.woff2") },
          { weight: 700, file: path.join(FONTS_DIR, "MapleMono-Latin-700.woff2") },
        ],
      ],
    ]);
    const result = await exportProjectToPptx(project, {
      embedFonts: { fontsDir: FONTS_DIR, families },
    });
    const embedded = result.report.embeddedFonts ?? [];
    const faces = embedded.filter((f) => f.typeface === "PairDemo");
    assert.equal(faces.length, 2, `PairDemo embeds a regular and a bold face: ${JSON.stringify(embedded)}`);
    assert.ok(
      faces.some((f) => f.weight === 400),
      "regular face listed",
    );
    assert.ok(
      faces.some((f) => f.weight === 700),
      "bold face listed",
    );

    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const pres = await zip.file("ppt/presentation.xml")?.async("string");
    assert.ok(pres);
    const entry =
      /<p:embeddedFont><p:font typeface="PairDemo"\/><p:regular r:id="(rId\d+)"\/><p:bold r:id="(rId\d+)"\/><\/p:embeddedFont>/.exec(
        pres,
      );
    assert.ok(entry, "one <p:embeddedFont> for PairDemo carries both regular and bold r:ids");
    const [, regularRid, boldRid] = entry;
    assert.notEqual(regularRid, boldRid);

    const rels = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string");
    assert.ok(rels);
    const ridTarget = (rid: string) => new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
    const regularTarget = ridTarget(regularRid!);
    const boldTarget = ridTarget(boldRid!);
    assert.ok(regularTarget && boldTarget, "both r:ids resolve in rels");
    assert.notEqual(regularTarget, boldTarget, "regular and bold point at distinct fntdata parts");
    // Both r:ids resolve to real fntdata parts in the zip.
    for (const target of [regularTarget!, boldTarget!]) {
      const bytes = await zip.file(`ppt/${target}`)?.async("uint8array");
      assert.ok(bytes?.length, `${target} present in zip`);
    }
  });

  it("refuses fonts whose fsType marks Restricted License embedding", async () => {
    const { woff2 } = await import("fonteditor-core");
    await woff2.init();
    const src = fs.readFileSync(path.join(FONTS_DIR, "MiSans.woff2"));
    const ttf = Buffer.from(woff2.decode(src));
    // Patch OS/2 fsType (offset +8 inside the table) to Restricted License.
    const numTables = ttf.readUInt16BE(4);
    let patched = false;
    for (let i = 0; i < numTables; i += 1) {
      const off = 12 + i * 16;
      if (ttf.toString("ascii", off, off + 4) === "OS/2") {
        const tableOff = ttf.readUInt32BE(off + 8);
        ttf.writeUInt16BE(0x0002, tableOff + 8);
        patched = true;
      }
    }
    assert.ok(patched, "OS/2 table found and patched");
    assert.ok(fsTypeRestricted(sfntFsType(ttf)), "gate reads patched fsType");

    const tmpFonts = fs.mkdtempSync(path.join(os.tmpdir(), "exp-fonts-restricted-"));
    // A raw sfnt passes the decoder unchanged, so the patched fsType reaches
    // the license gate without a slow woff2 re-encode.
    const patchedTtf = path.join(tmpFonts, "MiSans.ttf");
    fs.writeFileSync(patchedTtf, ttf);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-fonts-restricted-proj-"));
    const project = projectWithCover(dir, "受限字体");
    project.pages[0]!.page.elements = [
      {
        elementId: "t1",
        elementType: "text",
        bounds: [60, 60, 400, 60],
        content: { text: "受限嵌入", fontSize: 24, fontFamily: "MiSans" },
      },
    ];
    saveProject(project);

    const plan = await buildEmbeddedFonts(
      project,
      new Map([["MiSans", [{ weight: 400, file: patchedTtf }]]]),
      tmpFonts,
    );
    assert.equal(plan.fonts.length, 0);
    const skip = plan.skipped.find((s) => s.typeface === "MiSans");
    assert.ok(skip, "MiSans skipped");
    assert.match(skip.reason, /license/i);
  });

  it("collects used families and the union charset from a project", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-fonts-collect-"));
    const project = projectWithCover(dir, "收集");
    project.presentation.theme = {
      textStyles: {
        heading: { fontFamily: { latin: "Oranienbaum", ea: "思源宋体" } },
      },
    };
    project.pages[0]!.page.elements = [
      {
        elementId: "t1",
        elementType: "text",
        bounds: [60, 60, 400, 60],
        content: { text: "中文字符", fontSize: 24, style: "$heading" },
      },
      {
        elementId: "t2",
        elementType: "text",
        bounds: [60, 140, 400, 60],
        content: { text: "plain", fontSize: 20 },
      },
    ];
    project.pages[0]!.page.notes = "备注文字";
    saveProject(project);

    const { families, charset } = collectUsedText(project);
    assert.ok(families.has("Oranienbaum"));
    assert.ok(families.has("思源宋体"), "saved decks keep the named face; only Agent writes get rewritten");
    assert.ok(families.has("微软雅黑") && families.has("Arial"), "unnamed text resolves to the default pair");
    for (const ch of "中文字符备注") {
      assert.ok(charset.has(ch.codePointAt(0)!));
    }
    assert.ok(charset.has(0x41), "ASCII seeded");
  });
});
