import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  backgroundBlock,
  cSldName,
  elementBlock,
  embedOf,
  fixtureDir,
  fixtureZip,
  layoutOfSlide,
  lintXml,
  partText,
  partsMatching,
  referencesTo,
  relationships,
  resolveTarget,
  spTreeOf,
} from "./export-layouts-support.js";

describe("export-native masters and layouts on the committed fixture", () => {
  it("exports 24 slides, three named layouts, and no carrier slide left in the package", async () => {
    const zip = await fixtureZip();
    assert.equal(partsMatching(zip, /^ppt\/slides\/slide\d+\.xml$/).length, 24);
    assert.equal(partsMatching(zip, /^ppt\/notesSlides\/notesSlide\d+\.xml$/).length, 24);
    assert.equal(partsMatching(zip, /^ppt\/slideLayouts\/slideLayout\d+\.xml$/).length, 3);
    assert.equal(cSldName(await partText(zip, "ppt/slideLayouts/slideLayout1.xml")), "DEFAULT");
    assert.equal(cSldName(await partText(zip, "ppt/slideLayouts/slideLayout2.xml")), "封面");
    assert.equal(cSldName(await partText(zip, "ppt/slideLayouts/slideLayout3.xml")), "正文");
    assert.match(await partText(zip, "docProps/app.xml"), /<Slides>24<\/Slides>/);
    const contentTypes = await partText(zip, "[Content_Types].xml");
    assert.equal((contentTypes.match(/PartName="\/ppt\/slides\/slide\d+\.xml"/g) ?? []).length, 24);
    const presentation = await partText(zip, "ppt/presentation.xml");
    assert.equal((presentation.match(/<p:sldId /g) ?? []).length, 24);
  });

  it("points each page at its layout: the cover, the body pages, then the default layout", async () => {
    const zip = await fixtureZip();
    for (let page = 1; page <= 24; page++) {
      const expected =
        page === 1
          ? "ppt/slideLayouts/slideLayout2.xml"
          : page === 24
            ? "ppt/slideLayouts/slideLayout1.xml"
            : "ppt/slideLayouts/slideLayout3.xml";
      assert.equal(await layoutOfSlide(zip, `ppt/slides/slide${page}.xml`), expected, `page ${page}`);
    }
  });

  it("references each logo once, from the body layout rels, with the project's bytes", async () => {
    const zip = await fixtureZip();
    const layoutXml = await partText(zip, "ppt/slideLayouts/slideLayout3.xml");
    const layoutRels = relationships(await partText(zip, "ppt/slideLayouts/_rels/slideLayout3.xml.rels"));
    for (const logo of ["logo-a", "logo-b"]) {
      const rel = layoutRels.find((item) => item.id === embedOf(layoutXml, logo));
      assert.ok(rel, `${logo} resolves in slideLayout3.xml.rels`);
      const media = resolveTarget("ppt/slideLayouts", rel.target);
      assert.deepEqual(
        await referencesTo(zip, media),
        ["ppt/slideLayouts/_rels/slideLayout3.xml.rels"],
        `${logo} is referenced from the layout only`,
      );
      const exported = await zip.file(media)?.async("nodebuffer");
      const source = fs.readFileSync(path.join(fixtureDir, "media", `${logo}.png`));
      assert.ok(exported?.equals(source), `${logo} bytes equal the project media`);
    }
  });

  it("keeps inherited copies, header art and page-number boxes off the slides, and no placeholders in layouts", async () => {
    const zip = await fixtureZip();
    for (const slide of partsMatching(zip, /^ppt\/slides\/slide\d+\.xml$/)) {
      const xml = await partText(zip, slide);
      assert.doesNotMatch(xml, /name="(mst|lyt)-/, slide);
      assert.doesNotMatch(xml, /name="(header-rule|logo-a|logo-b|footer|pageno|arc)"/, slide);
      assert.doesNotMatch(xml, /type="slidenum"/, slide);
    }
    for (const part of [
      "ppt/slideLayouts/slideLayout2.xml",
      "ppt/slideLayouts/slideLayout3.xml",
      "ppt/slideMasters/slideMaster1.xml",
    ]) {
      assert.doesNotMatch(await partText(zip, part), /<p:ph\b/, part);
    }
  });

  it("passes xmllint for every XML and rels part of the package", async () => {
    const zip = await fixtureZip();
    const parts = Object.keys(zip.files).filter((name) => /\.(xml|rels)$/.test(name));
    assert.ok(parts.length > 80, "the package holds the slides, layouts, master and rels");
    for (const name of parts) {
      lintXml(await partText(zip, name), name);
    }
  });

  it("exports the page number as a slidenum field and hides master elements on the cover and the default layout", async () => {
    const zip = await fixtureZip();
    const master = await partText(zip, "ppt/slideMasters/slideMaster1.xml");
    assert.match(master, /<a:fld [^>]*type="slidenum"/);
    assert.doesNotMatch(master, /\{page\}/);
    assert.match(await partText(zip, "ppt/slideLayouts/slideLayout2.xml"), /<p:sldLayout [^>]*showMasterSp="0"/);
    assert.match(await partText(zip, "ppt/slideLayouts/slideLayout1.xml"), /<p:sldLayout [^>]*showMasterSp="0"/);
    assert.doesNotMatch(await partText(zip, "ppt/slideLayouts/slideLayout3.xml"), /showMasterSp="0"/);
  });

  it("keeps the cover arc's custom path, gradient and shadow on the layout, and the cover background there", async () => {
    const zip = await fixtureZip();
    const layout = await partText(zip, "ppt/slideLayouts/slideLayout2.xml");
    const arc = elementBlock(layout, "arc");
    assert.equal((arc.match(/<a:custGeom>/g) ?? []).length, 1);
    assert.equal((arc.match(/<a:cubicBezTo>/g) ?? []).length, 4);
    assert.match(arc, /<a:gradFill/);
    assert.match(arc, /<a:outerShdw/);
    assert.match(backgroundBlock(layout), /<a:gradFill/);
    const cover = await partText(zip, "ppt/slides/slide1.xml");
    assert.doesNotMatch(cover, /<p:bg>/, "the cover takes its background from the layout");
    assert.doesNotMatch(cover, /name="arc"/);
  });

  it("writes layout and master element colours as literal srgbClr with no schemeClr in the shape tree", async () => {
    const zip = await fixtureZip();
    const body = spTreeOf(await partText(zip, "ppt/slideLayouts/slideLayout3.xml"));
    assert.match(body, /srgbClr val="1D4ED8"/);
    assert.doesNotMatch(body, /schemeClr/);
    const master = spTreeOf(await partText(zip, "ppt/slideMasters/slideMaster1.xml"));
    assert.match(master, /srgbClr val="6B7280"/);
    assert.doesNotMatch(master, /schemeClr/);
  });

  it("carries only the deck's own text on layouts and the master, and names each layout after a deck layout", async () => {
    const zip = await fixtureZip();
    const ownText = new Set(["版式结构检查 · 正文", "‹#›"]);
    const layoutNames = new Set<string>();
    const layoutParts = partsMatching(zip, /^ppt\/slideLayouts\/slideLayout\d+\.xml$/);
    for (const part of [...layoutParts, "ppt/slideMasters/slideMaster1.xml"]) {
      const xml = await partText(zip, part);
      for (const [, text] of xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)) {
        assert.ok(ownText.has(text ?? ""), `${part} carries only deck text, found "${text}"`);
      }
      if (part.includes("slideLayout")) layoutNames.add(cSldName(xml) ?? "");
    }
    assert.deepEqual([...layoutNames].sort(), ["DEFAULT", "正文", "封面"].sort());
  });
});
