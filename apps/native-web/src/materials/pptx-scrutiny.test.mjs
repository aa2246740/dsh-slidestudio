import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOptionalNative } from "../optional-native.mjs";
import { eachTest } from "./test-fixtures/each.mjs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { buildPptx, solidPng } from "../testlib/pptx-fixture.mjs";
import { runParseJob } from "./parse-worker.mjs";

const NO_SHARP = (await loadOptionalNative("sharp")) ? false : "sharp is not installed";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const part = (/** @type {string} */ tag, /** @type {string} */ shapes, tail = "") =>
  `<p:${tag} xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld>${tail}</p:${tag}>`;
const relationships = (/** @type {string[][] | [any, any, any][]} */ entries) =>
  `<Relationships xmlns="${RELS}">${entries
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`)
    .join("")}</Relationships>`;
const placeholder = (
  /** @type {number} */ idx,
  /** @type {{x?: number, text?: string, body?: string}} */ { x, text = "", body = "" } = {},
) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${idx}" name="Body ${idx}"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="${idx}"/></p:nvPr></p:nvSpPr>` +
  (x === undefined
    ? "<p:spPr/>"
    : `<p:spPr><a:xfrm><a:off x="${x}" y="1371600"/><a:ext cx="2438400" cy="2057400"/></a:xfrm></p:spPr>`) +
  `<p:txBody><a:bodyPr/>${body || `<a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p>`}</p:txBody></p:sp>`;
/**
 * Parsed sections such as "deck-template" are open JSON that the assertions
 * walk dynamically, so they are typed loosely on top of the derivative envelope.
 * @typedef {import("./derivative.mjs").Derivative & {[section: string]: any}} ParsedDerivative
 */
const parse = (/** @type {import("fflate").Zippable} */ files) =>
  /** @type {Promise<ParsedDerivative>} */ (
    runParseJob({ materialId: "public-scrutiny", name: "synthetic.pptx", bytes: zipSync(files) })
  );
const withLayout = () => {
  const files = unzipSync(buildPptx());
  files["ppt/slides/_rels/slide1.xml.rels"] = strToU8(
    relationships([["layout", "slideLayout", "../slideLayouts/slideLayout1.xml"]]),
  );
  return files;
};

test("placeholder boxes select the exact index before a same-type fallback", async () => {
  const files = withLayout();
  files["ppt/slideLayouts/slideLayout1.xml"] = strToU8(
    part("sldLayout", placeholder(1, { x: 1219200 }) + placeholder(2, { x: 7315200 })),
  );
  files["ppt/slides/slide1.xml"] = strToU8(
    part(
      "sld",
      placeholder(2, { text: "Right body" }) +
        placeholder(1, { text: "Left body" }) +
        placeholder(3, { text: "Type fallback" }),
    ),
  );
  const deck = (await parse(files))["deck-template"];
  assert.deepEqual(
    deck.templateDetail.slides[0].shapes.map(
      (/** @type {{placeholder: {idx: string}, box: number[] | null}} */ { placeholder, box }) => [
        placeholder.idx,
        box,
      ],
    ),
    [
      ["2", [0.6, 0.2, 0.2, 0.3]],
      ["1", [0.1, 0.2, 0.2, 0.3]],
      ["3", [0.1, 0.2, 0.2, 0.3]],
    ],
  );
});

eachTest(
  ["layout", "slide"],
  "two-column geometry follows the exact layout/master chain with the left box on the %s",
  async (leftOwner) => {
    const files = withLayout();
    files["ppt/slideMasters/slideMaster1.xml"] = strToU8(
      strFromU8(files["ppt/slideMasters/slideMaster1.xml"]).replace(
        "</p:spTree>",
        `${placeholder(1, { x: 3657600 })}${placeholder(2, { x: 7315200 })}</p:spTree>`,
      ),
    );
    files["ppt/slideLayouts/slideLayout1.xml"] = strToU8(
      part("sldLayout", placeholder(1, { x: 1219200 }) + placeholder(2)),
    );
    files["ppt/slides/slide1.xml"] = strToU8(
      part(
        "sld",
        placeholder(1, {
          ...(leftOwner === "slide" ? { x: 2438400 } : {}),
          text: "Left column",
        }) + placeholder(2, { text: "Right column" }),
      ),
    );
    const result = await parse(files);
    assert.equal(result.status, "ok");
    const deck = result["deck-template"];
    const expected = [
      [leftOwner === "slide" ? 0.2 : 0.1, 0.2, 0.2, 0.3],
      [0.6, 0.2, 0.2, 0.3],
    ];
    assert.deepEqual(
      deck.templateDetail.slides[0].shapes.map((/** @type {{ box: any; }} */ shape) => shape.box),
      expected,
    );
    assert.deepEqual(
      deck.archetypes
        .find((/** @type {{ slides: number[]; }} */ archetype) => archetype.slides.includes(1))
        .slots.map((/** @type {{ box: any; }} */ slot) => slot.box),
      expected,
    );
  },
);

test("an exact master identity wins over a layout's unrelated same-type box", async () => {
  const files = withLayout();
  files["ppt/slideMasters/slideMaster1.xml"] = strToU8(
    strFromU8(files["ppt/slideMasters/slideMaster1.xml"]).replace(
      "</p:spTree>",
      `${placeholder(2, { x: 7315200 })}</p:spTree>`,
    ),
  );
  files["ppt/slideLayouts/slideLayout1.xml"] = strToU8(part("sldLayout", placeholder(1, { x: 1219200 })));
  files["ppt/slides/slide1.xml"] = strToU8(part("sld", placeholder(2, { text: "Master identity" })));
  const deck = (await parse(files))["deck-template"];
  assert.deepEqual(deck.templateDetail.slides[0].shapes[0].box, [0.6, 0.2, 0.2, 0.3]);
});

test("an exact identity with no resolvable box never borrows its sibling's geometry", async () => {
  const files = withLayout();
  files["ppt/slideMasters/slideMaster1.xml"] = strToU8(
    strFromU8(files["ppt/slideMasters/slideMaster1.xml"]).replace(
      "</p:spTree>",
      `${placeholder(1, { x: 1219200 })}${placeholder(2)}</p:spTree>`,
    ),
  );
  files["ppt/slideLayouts/slideLayout1.xml"] = strToU8(
    part("sldLayout", placeholder(1, { x: 1219200 }) + placeholder(2)),
  );
  files["ppt/slides/slide1.xml"] = strToU8(part("sld", placeholder(2, { text: "Unresolved identity" })));
  const deck = (await parse(files))["deck-template"];
  assert.equal(deck.templateDetail.slides[0].shapes[0].box, null);
  assert.deepEqual(
    deck.archetypes.find((/** @type {{ slides: number[]; }} */ archetype) => archetype.slides.includes(1)).slots,
    [],
  );
});

test("level-2 paragraphs inherit matching layout and master fonts without losing local overrides", async () => {
  const files = withLayout();
  const defaults = (/** @type {string} */ latin, /** @type {string} */ ea, size = "") =>
    `<a:defRPr${size ? ` sz="${size}"` : ""}><a:latin typeface="${latin}"/>${ea ? `<a:ea typeface="${ea}"/>` : ""}</a:defRPr>`;
  const list = (/** @type {string} */ second) =>
    `<a:lstStyle><a:lvl1pPr>${defaults("Verdana", "微软雅黑", "4200")}</a:lvl1pPr><a:lvl2pPr>${second}</a:lvl2pPr></a:lstStyle>`;
  const paragraph = (/** @type {string} */ text, props = "", runProps = "") =>
    `<a:p><a:pPr lvl="1">${props}</a:pPr><a:r>${runProps}<a:t>${text}</a:t></a:r></a:p>`;
  files["ppt/slideLayouts/slideLayout1.xml"] = strToU8(
    part(
      "sldLayout",
      placeholder(1, { body: list(defaults("Arial", "微软雅黑", "2800")) }) +
        placeholder(2, { x: 1219200, body: list(defaults("Georgia", "宋体", "2200")) }) +
        placeholder(3, { x: 1219200, body: list(defaults("Tahoma", "")) }) +
        placeholder(4, { x: 1219200, body: list(defaults("Georgia", "宋体", "2200")) }) +
        placeholder(5, { x: 1219200, body: list(defaults("Georgia", "宋体", "2200")) }),
    ),
  );
  files["ppt/slideMasters/slideMaster1.xml"] = strToU8(
    strFromU8(files["ppt/slideMasters/slideMaster1.xml"]).replace(
      "</p:sldMaster>",
      `<p:txStyles><p:bodyStyle><a:lvl1pPr>${defaults("Verdana", "微软雅黑", "3600")}</a:lvl1pPr><a:lvl2pPr>${defaults("Times New Roman", "黑体", "1800")}</a:lvl2pPr></p:bodyStyle></p:txStyles></p:sldMaster>`,
    ),
  );
  files["ppt/slides/slide2.xml"] = strToU8(
    part(
      "sld",
      placeholder(2, { body: `<a:lstStyle/>${paragraph("Layout level two")}` }) +
        placeholder(3, { body: `<a:lstStyle/>${paragraph("Master level two")}` }) +
        placeholder(4, {
          body: `<a:lstStyle/>${paragraph("Local overrides", defaults("Arial", "楷体", "1600"), '<a:rPr sz="1400"><a:latin typeface="Courier New"/></a:rPr>')}`,
        }) +
        placeholder(5, {
          body: `${list(defaults("Verdana", "仿宋", "2000"))}${paragraph("Local list style")}`,
        }),
    ),
  );
  files["ppt/slides/_rels/slide2.xml.rels"] = files["ppt/slides/_rels/slide1.xml.rels"];
  const deck = (await parse(files))["deck-template"];
  const runs = deck.templateDetail.slides[1].shapes.flatMap((/** @type {{ runs: any; }} */ shape) => shape.runs);
  assert.deepEqual(
    runs.map((/** @type {{ level: any; }} */ run) => run.level),
    [2, 2, 2, 2],
  );
  assert.deepEqual(
    runs.map((/** @type {{latin: string, ea: string, pt: number}} */ { latin, ea, pt }) => [latin, ea, pt]),
    [
      ["Georgia", "宋体", 22],
      ["Tahoma", "黑体", 18],
      ["Courier New", "楷体", 14],
      ["Verdana", "仿宋", 20],
    ],
  );
  for (const [latin, ea] of [
    ["Georgia", "宋体"],
    ["Tahoma", "黑体"],
    ["Courier New", "楷体"],
    ["Verdana", "仿宋"],
  ]) {
    assert.ok(
      deck.fontsUsed
        .flatMap((/** @type {{ sourceFonts: any; }} */ font) => font.sourceFonts)
        .some(
          (/** @type {{ latin: string; ea: string; chars: number; }} */ font) =>
            font.latin === latin && font.ea === ea && font.chars > 0,
        ),
    );
  }
  assert.deepEqual(
    deck.fontSizeTiers.find((/** @type {{ role: string; }} */ tier) => tier.role === "body").pt,
    [22, 20, 18, 14],
  );
});

test("primary logo ranks used-layout count before slide coverage, then pixel area", { skip: NO_SHARP }, async () => {
  const files = withLayout();
  const picture = (/** @type {number} */ id) =>
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Mark ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="mark${id}"/></p:blipFill><p:spPr><a:xfrm><a:off x="121920" y="68580"/><a:ext cx="1219200" cy="685800"/></a:xfrm></p:spPr></p:pic>`;
  files["ppt/slideMasters/slideMaster1.xml"] = strToU8(
    part(
      "sldMaster",
      "",
      `<p:sldLayoutIdLst>${[1, 2, 3].map((n) => `<p:sldLayoutId id="${2147483648 + n}" r:id="layout${n}"/>`).join("")}</p:sldLayoutIdLst>`,
    ),
  );
  files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = strToU8(
    relationships([
      ["theme", "theme", "../theme/theme1.xml"],
      ...[1, 2, 3].map((n) => [`layout${n}`, "slideLayout", `../slideLayouts/slideLayout${n}.xml`]),
    ]),
  );
  for (const n of [1, 2, 3]) {
    files[`ppt/slideLayouts/slideLayout${n}.xml`] = strToU8(
      part("sldLayout", n === 1 ? picture(1) : picture(2) + picture(3)),
    );
    files[`ppt/slideLayouts/_rels/slideLayout${n}.xml.rels`] = strToU8(
      relationships((n === 1 ? [1] : [2, 3]).map((id) => [`mark${id}`, "image", `../media/mark${id}.png`])),
    );
  }
  files["ppt/presentation.xml"] = strToU8(
    strFromU8(files["ppt/presentation.xml"]).replace(
      "</p:sldIdLst>",
      `${[3, 4, 5].map((n) => `<p:sldId id="${255 + n}" r:id="rIdS${n}"/>`).join("")}</p:sldIdLst>`,
    ),
  );
  files["ppt/_rels/presentation.xml.rels"] = strToU8(
    relationships([
      ["rIdM", "slideMaster", "slideMasters/slideMaster1.xml"],
      ...[1, 2, 3, 4, 5].map((n) => [`rIdS${n}`, "slide", `slides/slide${n}.xml`]),
    ]),
  );
  for (const [index, layout] of [1, 1, 1, 2, 3].entries()) {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(part("sld", ""));
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = strToU8(
      relationships([["layout", "slideLayout", `../slideLayouts/slideLayout${layout}.xml`]]),
    );
  }
  for (const [id, width, height] of [
    [1, 40, 10],
    [2, 12, 4],
    [3, 6, 2],
  ]) {
    files[`ppt/media/mark${id}.png`] = solidPng({ width, height });
  }
  const deck = (await parse(files))["deck-template"];
  assert.deepEqual(
    deck.logos.map(
      (
        /** @type {{mediaId: string, usedOnLayouts: unknown[], slidesCovered: number}} */ {
          mediaId,
          usedOnLayouts,
          slidesCovered,
        },
      ) => [mediaId, usedOnLayouts.length, slidesCovered],
    ),
    [
      ["mark2.png", 2, 2],
      ["mark3.png", 2, 2],
      ["mark1.png", 1, 3],
    ],
  );
  assert.equal(deck.logo.mediaId, "mark2.png");
  assert.equal(
    deck.templateDetail.logos.find((/** @type {{ primary: any; }} */ logo) => logo.primary).mediaId,
    "mark2.png",
  );
  assert.equal(deck.media.find((/** @type {{ logoCandidate: any; }} */ media) => media.logoCandidate).id, "mark2.png");
});

test("public summary presents the actual main font before secondary theme declarations", async () => {
  const files = unzipSync(buildPptx());
  for (const n of [1, 2]) {
    const key = `ppt/slides/slide${n}.xml`;
    files[key] = strToU8(
      strFromU8(files[key]).replace(
        '<a:rPr lang="zh-CN"/>',
        '<a:rPr sz="2400"><a:latin typeface="Arial"/><a:ea typeface="黑体"/></a:rPr>',
      ),
    );
  }
  const result = await parse(files);
  const summary = /** @type {{zh: string}} */ (result.summary).zh;
  assert.match(summary, /实际使用主字体 Arial \/ 黑体/);
  assert.match(summary, /主题声明标题字体（次要参考）/);
  assert.match(summary, /主题声明正文字体（次要参考）/);
  assert.ok(summary.indexOf("Arial") < summary.indexOf("思源宋体"));
  assert.ok(summary.indexOf("实际使用字体") < summary.indexOf("主题声明标题字体"));
});
