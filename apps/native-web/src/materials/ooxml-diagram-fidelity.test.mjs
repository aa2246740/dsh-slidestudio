import assert from "node:assert/strict";
import { test } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { runParseJob } from "./parse-worker.mjs";
import { smartartFixture } from "./test-fixtures/smartart.mjs";

/**
 * Parsed sections such as "deck-template" are open JSON that the assertions
 * walk dynamically, so they are typed loosely on top of the derivative envelope.
 * @typedef {import("./derivative.mjs").Derivative & {[section: string]: any}} ParsedDerivative
 */

/**
 * @param {string | undefined} variant
 * @param {Record<string, (xml: string) => string>} replacements
 * @returns {Promise<ParsedDerivative>}
 */
async function changed(variant, replacements) {
  const entries = unzipSync(smartartFixture(variant));
  for (const [part, replace] of Object.entries(replacements))
    entries[part] = strToU8(replace(strFromU8(entries[part])));
  const result = await runParseJob({
    materialId: "smartart-fidelity",
    name: variant === "docx" ? "synthetic.docx" : "synthetic.pptx",
    bytes: zipSync(entries, { level: 6 }),
  });
  assert.equal(result.status, "ok");
  assert.doesNotMatch(JSON.stringify(result), /<a:|<p:|<dgm:|<dsp:/);
  return result;
}

/**
 * @param {ArrayLike<number> | undefined} actual
 * @param {number[]} expected
 */
function closeBox(actual, expected) {
  assert.ok(actual);
  expected.forEach((value, i) => assert.ok(Math.abs(actual[i] - value) < 0.0001));
}

test("M3-SCR-011 PPTX and DOCX node text retain explicit breaks like cached paragraph runs", async () => {
  const withBreak = (/** @type {string} */ xml) =>
    xml.replace("<a:t>调研</a:t>", "<a:t>12</a:t></a:r><a:br/><a:br/><a:r><a:t>34</a:t>");
  for (const variant of ["process", "nocache", "docx"]) {
    const base = variant === "docx" ? "word" : "ppt";
    const replacements = { [`${base}/diagrams/data1.xml`]: withBreak };
    if (variant === "process") replacements["ppt/diagrams/drawing1.xml"] = withBreak;
    const result = await changed(variant, replacements);
    const diagram =
      variant === "docx"
        ? result.document.blocks.find((/** @type {{ type: string; }} */ block) => block.type === "smartart")
        : result["deck-template"].templateDetail.smartArts[0];
    assert.equal(diagram.nodes[0].text, "12\n\n34");
    const text = variant === "docx" ? diagram.text : result["deck-template"].slides[0].text;
    assert.ok(text.includes("- 12\n\n34"));
    if (variant === "process")
      assert.equal(
        diagram.shapes[0].text.paras[0].runs.map((/** @type {{ text: any; }} */ run) => run.text).join(""),
        "12\n\n34",
      );
  }
});

test("M3-SCR-009 fillRef theme gradients preserve stops, placeholder colours and modifiers", async () => {
  const gradient = `<a:gradFill><a:gsLst>
    <a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="50000"/><a:alphaMod val="50000"/></a:schemeClr></a:gs>
    <a:gs pos="60000"><a:schemeClr val="phClr"><a:tint val="50000"/><a:alphaOff val="10000"/></a:schemeClr></a:gs>
    <a:gs pos="100000"><a:srgbClr val="FFFFFF"><a:alpha val="80000"/></a:srgbClr></a:gs>
    </a:gsLst><a:lin ang="1800000"/></a:gradFill>`;
  const reference = (/** @type {string} */ xml) =>
    xml.replaceAll(
      '<a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>',
      '<a:fillRef idx="2"><a:schemeClr val="accent1"><a:alpha val="40000"/><a:shade val="50000"/></a:schemeClr></a:fillRef>',
    );
  for (const quickStyle of [false, true]) {
    const result = await changed("style-ref-fill", {
      "ppt/theme/theme1.xml": (/** @type {string} */ xml) =>
        xml.replace("</a:fillStyleLst>", `${gradient}</a:fillStyleLst>`),
      "ppt/diagrams/drawing1.xml": (/** @type {string} */ xml) =>
        quickStyle ? xml.replaceAll(/<dsp:style>.*?<\/dsp:style>/g, "") : reference(xml),
      "ppt/diagrams/quickStyle1.xml": reference,
    });
    const shape = result["deck-template"].templateDetail.smartArts[0].shapes[0];
    assert.ok(shape.gradients?.length === 1, "the referenced gradient must not become a solid fill");
    assert.equal(shape.fill, null);
    assert.equal(shape.gradients[0].angle, 30);
    assert.deepEqual(shape.gradients[0].stops, [
      {
        position: 0,
        hex: "#300000",
        alpha: 0.2,
        scheme: "accent1",
        mods: [
          { name: "alpha", value: 40000 },
          { name: "shade", value: 50000 },
          { name: "lumMod", value: 50000 },
          { name: "alphaMod", value: 50000 },
        ],
      },
      {
        position: 0.6,
        hex: "#B08080",
        alpha: 0.5,
        scheme: "accent1",
        mods: [
          { name: "alpha", value: 40000 },
          { name: "shade", value: 50000 },
          { name: "tint", value: 50000 },
          { name: "alphaOff", value: 10000 },
        ],
      },
      { position: 1, hex: "#FFFFFF", alpha: 0.8, mods: [{ name: "alpha", value: 80000 }] },
    ]);
  }
});

test("M3-SCR-010 placeholder colours retain reference alpha and apply ordered theme alpha modifiers", async () => {
  for (const [mods, expected] of /** @type {[string, number][]} */ ([
    ["", 0.4],
    ['<a:alphaMod val="50000"/><a:alphaOff val="10000"/>', 0.3],
    ['<a:alphaOff val="10000"/><a:alphaMod val="50000"/>', 0.25],
    ['<a:alpha val="75000"/>', 0.75],
    ['<a:alphaOff val="90000"/>', 1],
    ['<a:alphaMod val="0"/>', 0],
  ])) {
    const result = await changed("style-ref-fill", {
      "ppt/diagrams/drawing1.xml": (/** @type {string} */ xml) =>
        xml.replaceAll(
          '<a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>',
          '<a:fillRef idx="1"><a:schemeClr val="accent1"><a:alpha val="40000"/><a:shade val="50000"/></a:schemeClr></a:fillRef>',
        ),
      "ppt/theme/theme1.xml": (/** @type {string} */ xml) =>
        xml.replace(
          '<a:schemeClr val="phClr"/>',
          `<a:schemeClr val="phClr"><a:tint val="50000"/>${mods}</a:schemeClr>`,
        ),
    });
    const fill = result["deck-template"].templateDetail.smartArts[0].shapes[0].fill;
    assert.ok(Math.abs(fill.alpha - expected) < 1e-9, `expected alpha ${expected}`);
    assert.equal(fill.hex, "#B08080");
    assert.equal(fill.scheme, "accent1");
    assert.deepEqual(fill.mods.slice(0, 3), [
      { name: "alpha", value: 40000 },
      { name: "shade", value: 50000 },
      { name: "tint", value: 50000 },
    ]);
  }
});

test("M3-SCR-008 nested host groups transform SmartArt frames, cached shapes and text boxes", async () => {
  // Outer: (.5x + 700000, .5y + 550000); inner: (2x + 200000, 3y - 300000).
  // Their chain is (x + 800000, 1.5y + 400000), including child-origin offsets.
  const outer = `<p:grpSp><p:grpSpPr><a:xfrm>
    <a:off x="800000" y="600000"/><a:ext cx="4000000" cy="3000000"/>
    <a:chOff x="200000" y="100000"/><a:chExt cx="8000000" cy="6000000"/>
    </a:xfrm></p:grpSpPr>`;
  const inner = `<p:grpSp><p:grpSpPr><a:xfrm>
    <a:off x="400000" y="300000"/><a:ext cx="12000000" cy="6000000"/>
    <a:chOff x="100000" y="200000"/><a:chExt cx="6000000" cy="2000000"/>
    </a:xfrm></p:grpSpPr>`;
  for (const variant of ["process", "nocache"]) {
    const result = await changed(variant, {
      "ppt/slides/slide1.xml": (/** @type {string} */ xml) =>
        xml
          .replace("<p:graphicFrame>", `${outer}${inner}<p:graphicFrame>`)
          .replace("</p:graphicFrame>", "</p:graphicFrame></p:grpSp></p:grpSp>"),
    });
    const deck = result["deck-template"];
    closeBox(deck.smartArts[0].box, [0.225, 0.44166667, 0.75, 0.75]);
    const diagram = deck.templateDetail.smartArts[0];
    closeBox(diagram.box, [0.225, 0.44166667, 0.75, 0.75]);
    if (variant === "process") {
      closeBox(diagram.shapes[0].box, [0.225, 0.58716667, 0.1969, 0.315]);
      closeBox(diagram.shapes[0].text.box, [0.22625, 0.58966667, 0.1875, 0.3]);
      closeBox(diagram.shapes[3].box, [0.45, 0.58716667, 0.0375, 0.315]);
    } else assert.equal(diagram.shapes, undefined);
  }
});
