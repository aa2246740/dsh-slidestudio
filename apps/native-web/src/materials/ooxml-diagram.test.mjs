import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, mock } from "node:test";
import { eachTest } from "./test-fixtures/each.mjs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { runParseJob } from "./parse-worker.mjs";
import { smartartFixture } from "./test-fixtures/smartart.mjs";
import { diagramTreeText } from "./parsers/ooxml-diagram.mjs";
import { generateSamples, readSample, SAMPLES_SKIP } from "./sample-fixtures.mjs";
import { ParsePool, PARSE_RESOURCE_LIMITS, PARSE_TIMEOUT_MS } from "./parse-pool.mjs";

/**
 * Parsers type their payloads as `object`; these tests walk the stored JSON
 * (`deck-template`, `document`) directly, so payload keys stay loose (`any`).
 * @typedef {import("./derivative.mjs").Derivative & {summary: {zh: string, facts?: object}} & Record<string, any>} ParsedDerivative
 * @typedef {import("./parsers/ooxml-diagram.mjs").DiagramNode} DiagramNode
 */

async function samples() {
  return generateSamples();
}

/**
 * @param {string | undefined} variant
 * @param {{ diagrams?: number; nodes?: number; text?: string; chain?: boolean; } | undefined} [options]
 * @returns {Promise<ParsedDerivative>}
 */
async function parse(variant, options) {
  return /** @type {Promise<ParsedDerivative>} */ (
    runParseJob({
      materialId: "synthetic-smartart",
      name: variant === "docx" ? "smartart.docx" : "smartart.pptx",
      bytes: smartartFixture(variant, options),
    })
  );
}

/**
 * @param {string | undefined} variant
 * @param {Record<string, ((xml: string) => string) | null>} replacements
 * @returns {Promise<ParsedDerivative>}
 */
async function changed(variant, replacements) {
  const entries = unzipSync(smartartFixture(variant));
  for (const [part, replace] of Object.entries(replacements)) {
    if (replace === null) delete entries[part];
    else entries[part] = strToU8(replace(strFromU8(entries[part])));
  }
  return /** @type {Promise<ParsedDerivative>} */ (
    runParseJob({
      materialId: "synthetic-mutated",
      name: variant === "docx" ? "smartart.docx" : "smartart.pptx",
      bytes: zipSync(entries, { level: 6 }),
    })
  );
}

test("text matching follows invalid presentation associations; unmatched shapes are decoration", async () => {
  const result = await changed("process", {
    "ppt/diagrams/data1.xml": (/** @type {string} */ xml) => xml.replace('presAssocID="n1"', 'presAssocID="absent"'),
    "ppt/diagrams/drawing1.xml": (/** @type {string} */ xml) =>
      xml.replace('modelId="pres2"', 'modelId="unknown"').replace("<a:t>落地</a:t>", "<a:t>装饰</a:t>"),
  });
  const shapes = result["deck-template"].templateDetail.smartArts[0].shapes;
  assert.equal(shapes[1].nodeId, "n1");
  assert.equal(shapes[1].role, "node");
  assert.equal(shapes[2].role, "decoration");
  assert.equal(shapes[2].nodeId, null);
});

test("explicit no-fill survives style colour defaults", async () => {
  const result = await changed("process", {
    "ppt/diagrams/drawing1.xml": (/** @type {string} */ xml) =>
      xml.replace('<a:solidFill><a:schemeClr val="accent1"></a:schemeClr></a:solidFill>', "<a:noFill/>"),
  });
  assert.equal(result["deck-template"].templateDetail.smartArts[0].shapes[0].fill, null);
});

test("a missing drawing relationship warns and keeps the text-only tree", async () => {
  const result = await changed("process", {
    "ppt/slides/_rels/slide1.xml.rels": (/** @type {string} */ xml) =>
      xml.replace(/<Relationship Id="draw1"[^>]*\/>/, ""),
  });
  assert.equal(result["deck-template"].smartArts[0].cache, "none");
  assert.match(result["deck-template"].slides[0].text, /访谈 12 家网点/);
  assert.ok(result.warnings.some((w) => /预览图形关系缺失/.test(w.message)));
});

test("direct data identity wins when its presentation association is absent", async () => {
  const result = await changed("modelid-direct", {
    "ppt/diagrams/data1.xml": (/** @type {string} */ xml) =>
      xml.replace(
        '<dgm:pt modelId="n0" type="node"><dgm:prSet />',
        '<dgm:pt modelId="n0" type="node"><dgm:prSet presAssocID="absent"/>',
      ),
  });
  const shape = result["deck-template"].templateDetail.smartArts[0].shapes[0];
  assert.equal(shape.role, "node");
  assert.equal(shape.nodeId, "n0");
});

test("missing or malformed diagram parts do not suppress the rest of the slide", async () => {
  for (const part of ["data1", "layout1", "drawing1", "quickStyle1", "colors1"]) {
    const result = await changed("process", { [`ppt/diagrams/${part}.xml`]: null });
    assert.equal(result.status, "ok");
    assert.match(result["deck-template"].slides[0].text, /普通页面文字/);
    assert.ok(result.warnings.some((w) => /缺少部件/.test(w.message)));
  }
  const malformed = await changed("process", { "ppt/diagrams/data1.xml": () => "<broken" });
  assert.equal(malformed.status, "ok");
  assert.ok(malformed.warnings.some((w) => /部件损坏/.test(w.message)));
});

test("DOCX inline SmartArt splits a paragraph in document order", async () => {
  const result = await changed("docx", {
    "word/document.xml": (/** @type {string} */ xml) =>
      xml
        .replace("<w:drawing>", "<w:t>同行之前</w:t><w:drawing>")
        .replace("</w:drawing>", "</w:drawing><w:t>同行之后</w:t>"),
  });
  assert.deepEqual(
    result.document.blocks.map((/** @type {{ type: any; }} */ block) => block.type),
    ["paragraph", "paragraph", "smartart", "paragraph", "paragraph"],
  );
  assert.equal(result.document.blocks[1].text, "同行之前");
  assert.equal(result.document.blocks[3].text, "同行之后");
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(/** @type {Record<string, unknown>} */ (value)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

test("SmartArt process preserves ordered text hierarchy, frame box and summary without XML", async () => {
  const result = await parse("process");
  assert.equal(result.status, "ok");
  const deck = result["deck-template"];
  assert.match(
    deck.slides[0].text,
    /普通页面文字\nSmartArt（流程，3 项）：\n- 调研\n {2}- 访谈 12 家网点\n- 方案\n- 落地/,
  );
  assert.equal(deck.smartArts.length, 1);
  assert.deepEqual(deck.smartArts[0], {
    id: "s1-1",
    slide: 1,
    name: "图示 1",
    box: [0.125, 0.25, 0.75, 0.5],
    layout: "process",
    nodeCount: 3,
    chars: 15,
    cache: "drawing",
  });
  assert.match(result.summary.zh, /含 1 个 SmartArt（文字和层级可读取）/);
  assert.doesNotMatch(JSON.stringify(result), /<a:|<p:|<dgm:|<dsp:/);
});

/** @param {DiagramNode[]} nodes @returns {DiagramNode[]} */
const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children)]);

test("SmartArt limits cap data nodes, cache shapes, UTF-8 tree text and depth with Chinese warnings", async () => {
  const huge = await parse("huge");
  assert.equal(huge.status, "ok");
  const diagram = huge["deck-template"].templateDetail.smartArts[0];
  assert.equal(flatten(diagram.nodes).length, 200);
  assert.equal(diagram.shapes.length, 300);
  assert.match(huge.warnings.map((w) => w.message).join("\n"), /SmartArt 节点过多，只读取了前 200 个/);
  assert.equal(huge.truncated.applied, true);
  const long = await parse("nocache", { nodes: 200, text: "长文字".repeat(1000) });
  const nodes = long["deck-template"].templateDetail.smartArts[0].nodes;
  assert.ok(Buffer.byteLength(diagramTreeText(nodes)) <= 8192);
  assert.ok(long.warnings.some((w) => /文字过长/.test(w.message)));
  const deep = await parse("nocache", { nodes: 25, chain: true });
  const deepNodes = flatten(deep["deck-template"].templateDetail.smartArts[0].nodes);
  assert.equal(deepNodes.length, 8);
  assert.ok(deepNodes.every((/** @type {{ level: number; }} */ node) => node.level < 8));
  assert.ok(deep.warnings.some((w) => /层级过深/.test(w.message)));
});

test("SmartArt file budget keeps 50 of 51 diagrams in PPTX and DOCX", async () => {
  for (const variant of ["nocache", "docx"]) {
    const result = await parse(variant, { diagrams: 51 });
    assert.equal(result.status, "ok");
    assert.equal(variant === "docx" ? result.document.counts.smartArts : result["deck-template"].smartArts.length, 50);
    assert.equal(result.truncated.applied, true);
    assert.ok(result.warnings.some((w) => /50 个/.test(w.message)));
  }
});

eachTest(
  [
    "process",
    "nocache",
    "hierarchy",
    "rel-type-only",
    "modelid-direct",
    "style-ref-fill",
    "lummod",
    "huge",
    "cycle-cxn",
    "two-diagrams",
    "missing-data-part",
  ],
  "%s synthetic diagram stays readable with no source XML",
  async (variant) => {
    const result = await parse(variant);
    assert.equal(result.status, "ok");
    assert.match(result["deck-template"].slides[0].text, /普通页面文字/);
    assert.doesNotMatch(JSON.stringify(result), /<a:|<p:|<dgm:|<dsp:/);
  },
);

test("missing cache retains tree text and honestly identifies text-only SmartArt", async () => {
  const result = await parse("nocache");
  assert.equal(result["deck-template"].smartArts[0].cache, "none");
  assert.match(result["deck-template"].slides[0].text, /访谈 12 家网点/);
  assert.match(result.summary.zh, /含 1 个 SmartArt（文字和层级可读取）.*其中 1 个只能读取文字/);
});

test("hierarchy preserves assistant nodes and describes custom paths without XML", async () => {
  const diagram = (await parse("hierarchy"))["deck-template"].templateDetail.smartArts[0];
  assert.equal(diagram.layout, "hierarchy");
  assert.equal(diagram.nodes[0].text, "分行");
  assert.equal(diagram.nodes[0].children.length, 3);
  assert.equal(diagram.nodes[0].children[2].type, "asst");
  assert.deepEqual(diagram.shapes[0].geom, {
    viewBox: [100, 100],
    path: "M0 0 L100 0 L100 80 Q50 100 0 80 Z",
  });
});

eachTest(
  [
    ["modelid-direct", "#C00000"],
    ["style-ref-fill", "#C00000"],
    ["lummod", "#900000"],
  ],
  "%s resolves node identity and theme paints",
  async (variant, hex) => {
    const shape = (await parse(variant))["deck-template"].templateDetail.smartArts[0].shapes[0];
    assert.equal(shape.nodeId, "n0");
    assert.equal(shape.role, "node");
    assert.equal(shape.fill.hex, hex);
  },
);

test("relationship-type-only cache discovery warns in Chinese and keeps frame order", async () => {
  const fallback = await parse("rel-type-only");
  assert.equal(fallback["deck-template"].smartArts[0].cache, "drawing");
  assert.ok(fallback.warnings.some((w) => /通过关系类型/.test(w.message)));
  const two = (await parse("two-diagrams"))["deck-template"];
  assert.deepEqual(
    two.smartArts.map((/** @type {{ id: any; }} */ d) => d.id),
    ["s1-1", "s1-2"],
  );
  assert.ok(two.slides[0].text.indexOf("- 调研") < two.slides[0].text.indexOf("- 第二图 调研"));
});

test("cycles and missing data warn without discarding unrelated slide text", async () => {
  const cycle = await parse("cycle-cxn");
  assert.ok(cycle.warnings.some((w) => /循环/.test(w.message)));
  assert.ok(flatten(cycle["deck-template"].templateDetail.smartArts[0].nodes).length <= 4);
  const missing = await parse("missing-data-part");
  assert.equal(missing["deck-template"].smartArts[0].nodeCount, 0);
  assert.match(missing.warnings.map((w) => w.message).join("\n"), /第 1 页.*缺少部件/);
  assert.match(missing["deck-template"].slides[0].text, /普通页面文字/);
});

test("DOCX SmartArt is a text-bearing block between surrounding paragraphs without geometry", async () => {
  const result = await parse("docx");
  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.document.blocks.map((/** @type {{ type: any; }} */ b) => b.type),
    ["paragraph", "smartart", "paragraph"],
  );
  assert.equal(result.document.counts.smartArts, 1);
  const block = result.document.blocks[1];
  assert.equal(block.layout, "process");
  assert.equal(block.nodes[0].children[0].text, "访谈 12 家网点");
  assert.match(
    result.document.blocks.map((/** @type {{ text: any; }} */ b) => b.text).join("\n"),
    /之前段落\nSmartArt（流程，3 项）：\n- 调研\n {2}- 访谈 12 家网点\n- 方案\n- 落地\n之后段落/,
  );
  assert.equal(block.shapes, undefined);
  assert.equal(block.box, undefined);
  assert.match(result.summary.zh, /1 个 SmartArt/);
});

test("drawing cache resolves presentation associations, exact geometry, paragraphs and shared tint", async () => {
  const deck = (await parse("process"))["deck-template"];
  const diagram = deck.templateDetail.smartArts[0];
  assert.equal(diagram.shapes.length, 5);
  assert.deepEqual(
    diagram.shapes.map((/** @type {{ role: any; }} */ s) => s.role),
    ["node", "node", "node", "connector", "connector"],
  );
  const node = diagram.shapes[0];
  assert.equal(node.nodeId, "n0");
  for (const [i, value] of [0.125, 0.347, 0.1969, 0.21].entries()) assert.ok(Math.abs(node.box[i] - value) <= 1e-4);
  const boxes = [
    [0.125, 0.347, 0.1969, 0.21],
    [0.3875, 0.347, 0.1969, 0.21],
    [0.65, 0.347, 0.1969, 0.21],
    [0.35, 0.347, 0.0375, 0.21],
    [0.6125, 0.347, 0.0375, 0.21],
  ];
  diagram.shapes.forEach((/** @type {{ box: number[]; }} */ shape, /** @type {number} */ n) =>
    boxes[n].forEach((expected, i) => {
      assert.ok(Math.abs(shape.box[i] - expected) <= 1e-4);
    }),
  );
  assert.equal(node.geom.preset, "roundRect");
  assert.deepEqual(node.geom.adj, { adj: 10000 });
  assert.equal(node.fill.hex, "#C00000");
  assert.equal(node.fill.scheme, "accent1");
  assert.equal(node.line.color.hex, "#600000");
  // a:ln w is EMU and imported width is PPTD px (ruling 112): 12700 EMU is 1 pt, or 4/3 px.
  assert.ok(Math.abs(node.line.width - 12700 / 9525) < 1e-4);
  assert.equal(node.text.anchor, "ctr");
  assert.deepEqual(
    node.text.paras.map((/** @type {{ lvl: any; }} */ p) => p.lvl),
    [0, 1],
  );
  assert.equal(node.text.paras[0].runs[0].sz, 18);
  assert.equal(node.text.paras[0].runs[0].color.hex, "#FFFFFF");
  assert.equal(diagram.shapes[3].geom.preset, "rightArrow");
  // OOXML tint 60000 retains 60% of each source channel: round(c*.6 + 255*.4).
  assert.equal(diagram.shapes[3].fill.hex, "#D96666");
  assert.deepEqual(diagram.shapes[3].fill.mods, [{ name: "tint", value: 60000 }]);
  assert.equal(deck.smartArts[0].shapes, undefined);
});

test("SmartArt huge fixture parses inside the real 256 MB / 10 s worker boundary", async () => {
  assert.equal(PARSE_RESOURCE_LIMITS.maxOldGenerationSizeMb, 256);
  assert.equal(PARSE_TIMEOUT_MS, 10000);
  const pool = new ParsePool({ maxConcurrent: 1 });
  const started = performance.now();
  try {
    const result = await pool.run({
      materialId: "synthetic-worker",
      name: "smartart.pptx",
      bytes: smartartFixture("huge"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.derivative.status, "ok");
    assert.ok(performance.now() - started < PARSE_TIMEOUT_MS);
    assert.equal(
      flatten(/** @type {ParsedDerivative} */ (result.derivative)["deck-template"].templateDetail.smartArts[0].nodes)
        .length,
      200,
    );
  } finally {
    await pool.close();
  }
});

test("connection order, rather than point storage order, orders top-level SmartArt text", async () => {
  const result = await changed("nocache", {
    "ppt/diagrams/data1.xml": (/** @type {string} */ xml) =>
      xml
        .replace('destId="n0" srcOrd="0"', 'destId="n0" srcOrd="2"')
        .replace('destId="n2" srcOrd="2"', 'destId="n2" srcOrd="0"'),
  });
  assert.deepEqual(
    result["deck-template"].templateDetail.smartArts[0].nodes.map((/** @type {{ text: any; }} */ n) => n.text),
    ["落地", "方案", "调研"],
  );
});
