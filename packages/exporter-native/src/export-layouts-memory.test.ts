import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import JSZip from "jszip";
import type { PptdElement } from "@open-slidestudio/pptd-v2";
import { layoutExportOf } from "./export-layouts.js";
import { exportProjectToPptx, validateExportReport } from "./export-pptd.js";
import {
  GRADIENT_BACKGROUND,
  arcElement,
  backgroundBlock,
  cSldName,
  deckOf,
  elementBlock,
  embedOf,
  exportAndClean,
  imageElement,
  layoutOfSlide,
  logoPath,
  partText,
  partsMatching,
  referencesTo,
  relationships,
  resolveTarget,
  spTreeOf,
  textElement,
  withoutIdentity,
} from "./export-layouts-support.js";

describe("export-native masters and layouts on in-memory decks", () => {
  it("keeps exactly one slide layout and no carrier slide for a deck without layouts", async () => {
    const project = deckOf({ pages: [{ elements: [textElement("title", "无版式")] }] });
    const zip = await exportAndClean(project);
    assert.equal(partsMatching(zip, /^ppt\/slideLayouts\/slideLayout\d+\.xml$/).length, 1);
    assert.equal(partsMatching(zip, /^ppt\/slides\/slide\d+\.xml$/).length, 1);
    assert.doesNotMatch(await partText(zip, "ppt/slideLayouts/slideLayout1.xml"), /showMasterSp/);
  });

  it("references a layout image only from the layout rels and a page image only from its slide rels (VAL-RUN-019)", async () => {
    const project = deckOf({
      layouts: [{ id: "hero", name: "主视觉", elements: [imageElement("photo", "media/photo.png")] }],
      pages: [{ layoutId: "hero", elements: [imageElement("own-photo", "media/photo.png")] }],
    });
    const zip = await exportAndClean(project);
    const slideImages = relationships(await partText(zip, "ppt/slides/_rels/slide1.xml.rels")).filter((rel) =>
      rel.type.endsWith("/image"),
    );
    const layoutImages = relationships(await partText(zip, "ppt/slideLayouts/_rels/slideLayout2.xml.rels")).filter(
      (rel) => rel.type.endsWith("/image"),
    );
    assert.equal(slideImages.length, 1, "the page keeps its own picture only");
    assert.equal(layoutImages.length, 1, "the layout keeps its picture");
    const pageMedia = resolveTarget("ppt/slides", slideImages[0]!.target);
    const layoutMedia = resolveTarget("ppt/slideLayouts", layoutImages[0]!.target);
    assert.notEqual(pageMedia, layoutMedia);
    assert.deepEqual(await referencesTo(zip, layoutMedia), ["ppt/slideLayouts/_rels/slideLayout2.xml.rels"]);
    assert.deepEqual(await referencesTo(zip, pageMedia), ["ppt/slides/_rels/slide1.xml.rels"]);
    const source = fs.readFileSync(logoPath);
    assert.ok((await zip.file(pageMedia)?.async("nodebuffer"))?.equals(source));
    assert.ok((await zip.file(layoutMedia)?.async("nodebuffer"))?.equals(source));
    const layoutXml = await partText(zip, "ppt/slideLayouts/slideLayout2.xml");
    assert.equal(embedOf(layoutXml, "photo"), layoutImages[0]!.id);
  });

  it("gives a custom arc, its gradient and shadow, and a gradient background one XPath structure on a page and on a layout", async () => {
    const project = deckOf({
      layouts: [
        {
          id: "hero",
          name: "主视觉",
          background: GRADIENT_BACKGROUND,
          elements: [arcElement("arc")],
        },
      ],
      pages: [
        { layoutId: "hero", elements: [] },
        { elements: [arcElement("arc")], background: GRADIENT_BACKGROUND },
      ],
    });
    const zip = await exportAndClean(project);
    const pageXml = await partText(zip, "ppt/slides/slide2.xml");
    const layoutXml = await partText(zip, "ppt/slideLayouts/slideLayout2.xml");
    assert.match(elementBlock(layoutXml, "arc"), /<a:custGeom>/);
    assert.match(elementBlock(layoutXml, "arc"), /<a:outerShdw/);
    assert.deepEqual(
      withoutIdentity(elementBlock(layoutXml, "arc")),
      withoutIdentity(elementBlock(pageXml, "arc")),
      "the arc is the same XML on a page and on a layout",
    );
    assert.match(backgroundBlock(pageXml), /<a:gradFill/);
    assert.deepEqual(
      withoutIdentity(backgroundBlock(layoutXml)),
      withoutIdentity(backgroundBlock(pageXml)),
      "the background is the same XML on a page and on a layout",
    );
  });

  it("exports {pages} as the static page count and reports the change with a Chinese note", async () => {
    const project = deckOf({
      masters: [{ id: "main", name: "母版", elements: [textElement("count", "共 {pages} 页")] }],
      layouts: [{ id: "body", name: "正文", masterId: "main", elements: [] }],
      pages: [
        { layoutId: "body", elements: [] },
        { layoutId: "body", elements: [] },
        { layoutId: "body", elements: [] },
      ],
    });
    const result = await exportProjectToPptx(project);
    fs.rmSync(project.rootDir, { recursive: true, force: true });
    const zip = await JSZip.loadAsync(result.data);
    assert.match(await partText(zip, "ppt/slideMasters/slideMaster1.xml"), /<a:t>共 3 页<\/a:t>/);
    const note = result.report.degradations.find((item) => item.kind === "static-page-count");
    assert.ok(note, "the static page count is reported");
    assert.match(note.reason, /固定/);
  });

  it("splits {page} out of its run so the text before and after stay as separate runs", async () => {
    const project = deckOf({
      masters: [{ id: "main", name: "母版", elements: [textElement("pageno", "第 {page} 页")] }],
      layouts: [{ id: "body", name: "正文", masterId: "main", elements: [] }],
      pages: [{ layoutId: "body", elements: [] }],
    });
    const zip = await exportAndClean(project);
    const master = await partText(zip, "ppt/slideMasters/slideMaster1.xml");
    const before = master.indexOf("<a:t>第 </a:t>");
    const field = master.indexOf('type="slidenum"');
    const after = master.indexOf("<a:t> 页</a:t>");
    assert.ok(before >= 0, "the text before the number is its own run");
    assert.ok(field > before, "the slide number field follows that run");
    assert.ok(after > field, "the text after the number is its own run");
  });

  it("leaves the layout export out of a deck with no master and no layout", async () => {
    const project = deckOf({ pages: [{ elements: [textElement("title", "无版式")] }] });
    assert.equal(layoutExportOf(project), undefined);
    const zip = await exportAndClean(project);
    const master = await partText(zip, "ppt/slideMasters/slideMaster1.xml");
    assert.doesNotMatch(spTreeOf(master), /<p:sp>/, "the master holds no custom shape");
    assert.equal(partsMatching(zip, /^ppt\/slideLayouts\/slideLayout\d+\.xml$/).length, 1);
  });

  it("hides the master on a layout that names no master or turns its elements off", async () => {
    const project = deckOf({
      masters: [{ id: "main", name: "母版", elements: [textElement("chrome", "页眉")] }],
      layouts: [
        { id: "body", name: "正文", masterId: "main", elements: [] },
        { id: "loose", name: "独立", elements: [] },
        { id: "cover", name: "封面", masterId: "main", showMasterElements: false, elements: [] },
      ],
      pages: [{ layoutId: "body", elements: [] }],
    });
    const zip = await exportAndClean(project);
    assert.doesNotMatch(await partText(zip, "ppt/slideLayouts/slideLayout2.xml"), /showMasterSp/);
    assert.match(await partText(zip, "ppt/slideLayouts/slideLayout3.xml"), /<p:sldLayout [^>]*showMasterSp="0"/);
    assert.match(await partText(zip, "ppt/slideLayouts/slideLayout4.xml"), /<p:sldLayout [^>]*showMasterSp="0"/);
  });

  it("writes a master background as its own p:bg, and a layout with no master gets white", async () => {
    const project = deckOf({
      masters: [{ id: "main", name: "母版", background: GRADIENT_BACKGROUND, elements: [] }],
      layouts: [
        { id: "body", name: "正文", masterId: "main", elements: [] },
        { id: "loose", name: "独立", elements: [] },
      ],
      pages: [{ layoutId: "body", elements: [] }],
    });
    const zip = await exportAndClean(project);
    assert.match(backgroundBlock(await partText(zip, "ppt/slideMasters/slideMaster1.xml")), /<a:gradFill/);
    assert.equal(
      backgroundBlock(await partText(zip, "ppt/slideLayouts/slideLayout2.xml")),
      "",
      "the body layout takes the master's background",
    );
    assert.match(
      backgroundBlock(await partText(zip, "ppt/slideLayouts/slideLayout3.xml")),
      /<a:srgbClr val="FFFFFF"\/>/,
    );
  });

  it("replaces an unresolvable colour on a layout once, on its carrier, and names the layout", async () => {
    const note = {
      elementId: "note",
      elementType: "text",
      bounds: [40, 500, 300, 24],
      content: { text: "版式注记", fontSize: 12, color: "$missing", align: ["left", "middle"] },
    } as unknown as PptdElement;
    const project = deckOf({
      layouts: [{ id: "body", name: "正文", elements: [note] }],
      pages: [
        { layoutId: "body", elements: [] },
        { layoutId: "body", elements: [] },
      ],
    });
    const result = await exportProjectToPptx(project);
    fs.rmSync(project.rootDir, { recursive: true, force: true });
    assert.equal(validateExportReport(result.report).ok, true);
    const fallbacks = result.report.degradations.filter((item) => item.kind === "color-fallback");
    assert.equal(fallbacks.length, 1, "the layout's colour is reported once, not once per page");
    assert.equal(fallbacks[0]?.slideIndex, 2, "the carrier comes after the two pages");
    assert.equal(fallbacks[0]?.elementId, "note");
    assert.match(fallbacks[0]?.reason ?? "", /版式「正文」/);
  });

  it("draws a chart that a layout holds on each page that copies it, and reports the layout once", async () => {
    const chart = {
      elementId: "chart",
      elementType: "chart",
      bounds: [40, 40, 420, 200],
      data: {
        cols: ["类别", "值"],
        rows: [
          ["甲", 3],
          ["乙", 5],
        ],
      },
      series: [{ type: "bar", encode: { x: "类别", y: "值" } }],
      legend: false,
    } as unknown as PptdElement;
    // The loader refuses a chart on a layout, so the layout and its page copy are set after the save.
    const project = deckOf({ pages: [{ elements: [] }, { elements: [] }] });
    project.presentation.layouts = [{ id: "body", name: "正文", elements: [chart] }];
    project.pages[0]!.page.layoutId = "body";
    project.pages[0]!.page.elements.push({
      ...chart,
      elementId: "lyt-body-chart",
      inherited: { scope: "layout", ownerId: "body", elementId: "chart" },
    } as PptdElement);
    const result = await exportProjectToPptx(project);
    fs.rmSync(project.rootDir, { recursive: true, force: true });
    const zip = await JSZip.loadAsync(result.data);
    assert.match(await partText(zip, "ppt/slides/slide1.xml"), /<c:chart\b/, "the copy is drawn");
    assert.doesNotMatch(await partText(zip, "ppt/slides/slide2.xml"), /<c:chart\b/);
    assert.doesNotMatch(await partText(zip, "ppt/slideLayouts/slideLayout2.xml"), /<c:chart\b/);
    const notes = result.report.degradations.filter((item) => item.kind === "layout-unsupported-element");
    assert.equal(notes.length, 1, "the layout's chart is reported once");
    assert.equal(notes[0]?.slideIndex, 2);
    assert.match(notes[0]?.reason ?? "", /版式「正文」/);
  });

  it("keeps page text off the master and the layouts (VAL-TPL-017 exporter half)", async () => {
    const project = deckOf({
      masters: [{ id: "main", name: "母版", elements: [textElement("chrome", "母版页眉")] }],
      layouts: [
        {
          id: "body",
          name: "正文",
          masterId: "main",
          elements: [textElement("rule", "版式说明")],
        },
      ],
      pages: [{ layoutId: "body", elements: [textElement("own", "T1-SAMPLE-SENTINEL-文字")] }],
    });
    const zip = await exportAndClean(project);
    assert.match(await partText(zip, "ppt/slides/slide1.xml"), /T1-SAMPLE-SENTINEL-文字/);
    assert.equal(partsMatching(zip, /^ppt\/slides\/slide\d+\.xml$/).length, 1);
    for (const part of ["ppt/slideLayouts/slideLayout2.xml", "ppt/slideMasters/slideMaster1.xml"]) {
      const xml = await partText(zip, part);
      assert.doesNotMatch(xml, /T1-SAMPLE-SENTINEL/, part);
      assert.doesNotMatch(xml, /<p:ph\b/, part);
    }
  });

  it("writes the deck's palette into theme1.xml and keeps layout and master colours literal", async () => {
    const project = deckOf({
      masters: [{ id: "main", name: "母版", elements: [textElement("chrome", "母版页眉")] }],
      layouts: [
        {
          id: "body",
          name: "正文",
          masterId: "main",
          elements: [textElement("rule", "版式说明")],
        },
      ],
      pages: [{ layoutId: "body", elements: [] }],
    });
    project.presentation.theme = {
      ...project.presentation.theme,
      colors: { ...project.presentation.theme?.colors, accent1: "#C8102E" },
    };
    const zip = await exportAndClean(project);
    assert.match(await partText(zip, "ppt/theme/theme1.xml"), /<a:accent1>\s*<a:srgbClr val="C8102E"/);
    for (const part of ["ppt/slideLayouts/slideLayout2.xml", "ppt/slideMasters/slideMaster1.xml"]) {
      const body = spTreeOf(await partText(zip, part));
      assert.match(body, /srgbClr val="6B7280"/, part);
      assert.doesNotMatch(body, /schemeClr/, part);
    }
  });

  it("exports a page whose layout is missing on the default layout, with no master copy", async () => {
    const project = deckOf({
      masters: [{ id: "main", name: "母版", elements: [textElement("chrome", "母版页眉")] }],
      layouts: [{ id: "body", name: "正文", masterId: "main", elements: [] }],
      pages: [{ elements: [] }],
    });
    project.pages[0]!.page.layoutId = "nope";
    const zip = await exportAndClean(project);
    assert.equal(await layoutOfSlide(zip, "ppt/slides/slide1.xml"), "ppt/slideLayouts/slideLayout1.xml");
    assert.doesNotMatch(await partText(zip, "ppt/slides/slide1.xml"), /type="slidenum"/);
  });

  it("gives a custom-clipped picture one XPath structure on a page and on a layout", async () => {
    const clipped = {
      elementId: "clip",
      elementType: "image",
      bounds: [40, 40, 200, 200],
      src: "media/photo.png",
      fit: { mode: "fill" },
      cropShape: {
        shapeName: "custom",
        geometry: { viewBox: [100, 100], path: "M 50 0 L 100 50 L 50 100 L 0 50 Z" },
      },
    } as unknown as PptdElement;
    const project = deckOf({
      layouts: [{ id: "body", name: "正文", elements: [clipped] }],
      pages: [{ layoutId: "body", elements: [clipped] }],
    });
    const zip = await exportAndClean(project);
    const pageXml = await partText(zip, "ppt/slides/slide1.xml");
    const layoutXml = await partText(zip, "ppt/slideLayouts/slideLayout2.xml");
    assert.match(elementBlock(layoutXml, "clip"), /<a:custGeom>/);
    assert.match(elementBlock(layoutXml, "clip"), /<a:blipFill/);
    // The relationship ids differ by design: a layout renumbers its own. Everything else matches.
    const shape = (xml: string) => withoutIdentity(elementBlock(xml, "clip")).replace(/r:embed="[^"]*"/g, 'r:embed=""');
    assert.equal(shape(layoutXml), shape(pageXml), "the clipped picture is the same XML");
    const layoutRels = relationships(await partText(zip, "ppt/slideLayouts/_rels/slideLayout2.xml.rels"));
    assert.ok(
      layoutRels.some((rel) => rel.id === embedOf(layoutXml, "clip") && /\/image$/.test(rel.type)),
      "the layout's blip resolves in slideLayout2.xml.rels",
    );
  });
});
