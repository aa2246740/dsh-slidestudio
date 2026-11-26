import assert from "node:assert/strict";
import crypto from "node:crypto";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { test } from "node:test";
import { eachTest } from "./test-fixtures/each.mjs";
import { buildPptx } from "../testlib/pptx-fixture.mjs";
import { ensureWdpWarning } from "./parsers/pptx-logos.mjs";
import { runParseJob } from "./parse-worker.mjs";
import { generateSamples, readSample, SAMPLES_SKIP } from "./sample-fixtures.mjs";

/**
 * Parsers type their payloads as `object`; these tests walk the stored
 * `deck-template` JSON directly, so payload keys stay loose (`any`).
 * @typedef {import("./derivative.mjs").Derivative & {summary: {zh: string, facts?: object}} & Record<string, any>} ParsedDerivative
 */

const hash = (/** @type {crypto.BinaryLike} */ bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const parse = (
  /** @type {Uint8Array<ArrayBuffer> | Buffer<ArrayBuffer>} */ bytes,
  materialId = "11111111-1111-1111-1111-111111111111-test.pptx",
) => /** @type {Promise<ParsedDerivative>} */ (runParseJob({ name: "test.pptx", bytes, materialId }));

test("VAL-TPLR-001: v2 detail is self-contained, hash-bound and contains no OOXML", async () => {
  const derivative = await parse(buildPptx());
  assert.equal(derivative.parser.id, "pptx-ooxml-v2");
  const deck = derivative["deck-template"];
  assert.equal(deck.detail.file, "template-detail.json");
  assert.equal(hash(`${JSON.stringify(deck.templateDetail, null, 2)}\n`), deck.detail.sha256);
  assert.equal(deck.templateDetail.slides.length, 2);
  assert.deepEqual(deck.templateDetail.observedColors, deck.observedColors);
  assert.deepEqual(deck.templateDetail.fontsUsed, deck.fontsUsed);
  assert.deepEqual(deck.templateDetail.logos, deck.logos);
  assert.deepEqual(deck.templateDetail.archetypes, deck.archetypes);
  assert.equal(deck.templateDetail.slides[0].title, deck.slides[0].title);
  assert.doesNotMatch(JSON.stringify(derivative), /<a:|<p:|<c:|<dgm:|<dsp:/);
  assert.match(derivative.summary.zh, /2 页样例（文字可按需读取）/);
  assert.match(derivative.summary.zh, /未发现 Logo 候选/);
});

eachTest(
  [
    ["lumMod", "75000", "#900000"],
    ["lumOff", "20000", "#FF2727"],
    ["tint", "50000", "#E08080"],
    ["shade", "50000", "#600000"],
    ["satMod", "0", "#606060"],
    ["alpha", "50000", "#C00000"],
  ],
  "VAL-TPLR-003: resolves %s without inventing unrelated colors",
  async (modifier, value, expected) => {
    const files = unzipSync(buildPptx());
    files["ppt/theme/theme1.xml"] = strToU8(strFromU8(files["ppt/theme/theme1.xml"]).replace("C8102E", "C00000"));
    files["ppt/slides/slide1.xml"] = strToU8(
      strFromU8(files["ppt/slides/slide1.xml"]).replace(
        "<p:spPr/>",
        `<p:spPr><a:solidFill><a:schemeClr val="accent1"><a:${modifier} val="${value}"/></a:schemeClr></a:solidFill></p:spPr>`,
      ),
    );
    const deck = (await parse(zipSync(files)))["deck-template"];
    assert.equal(deck.observedColors[0].hex, expected);
    assert.deepEqual(deck.observedColors[0].roles, ["fill"]);
    assert.equal(deck.observedColors.length, 1);
  },
);

test("WDP skip warning is not hidden by an earlier media warning", () => {
  const warnings = [{ code: "photo-processing-failed", message: "已有照片处理警告" }];
  ensureWdpWarning(warnings);
  ensureWdpWarning(warnings);
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ["photo-processing-failed", "unsupported-wdp"],
  );
});

test("placeholder geometry and run fonts inherit layout/master defaults and honor the master color map", async () => {
  const files = unzipSync(buildPptx());
  files["ppt/slides/_rels/slide1.xml.rels"] = strToU8(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="layout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>',
  );
  files["ppt/slideMasters/slideMaster1.xml"] = strToU8(
    strFromU8(files["ppt/slideMasters/slideMaster1.xml"]).replace('tx1="dk1"', 'tx1="accent1"'),
  );
  files["ppt/slideLayouts/slideLayout1.xml"] = strToU8(
    strFromU8(files["ppt/slideLayouts/slideLayout1.xml"]).replace(
      "<a:lstStyle/>",
      '<a:lstStyle><a:lvl1pPr><a:defRPr sz="2600"><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/></a:defRPr></a:lvl1pPr></a:lstStyle>',
    ),
  );
  files["ppt/slides/slide1.xml"] = strToU8(
    strFromU8(files["ppt/slides/slide1.xml"]).replace(
      "<p:spPr/>",
      '<p:spPr><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></p:spPr>',
    ),
  );
  const deck = (await parse(zipSync(files)))["deck-template"];
  assert.deepEqual(deck.templateDetail.slides[0].shapes[0].box, [0.05, 0.05, 0.4, 0.12]);
  assert.ok(
    deck.fontsUsed.some(
      (/** @type {{ mapped: { latin: string; ea: string; }; }} */ font) =>
        font.mapped.latin === "微软雅黑" && font.mapped.ea === "微软雅黑",
    ),
  );
  assert.ok(deck.fontSizeTiers.find((/** @type {{ role: string; }} */ tier) => tier.role === "cover").pt.includes(26));
  assert.equal(deck.observedColors[0].hex, "#C8102E");
});
