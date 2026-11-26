import assert from "node:assert/strict";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { test } from "node:test";
import { buildPptx } from "../testlib/pptx-fixture.mjs";
import { runParseJob } from "./parse-worker.mjs";
import { thmxParser } from "./parsers/thmx.mjs";

/**
 * Parsed sections such as "deck-template" are open JSON that the assertions
 * walk dynamically, so they are typed loosely on top of the derivative envelope.
 * @typedef {import("./derivative.mjs").Derivative & {[section: string]: any}} ParsedDerivative
 */
/**
 * The theme-file payload the assertions read; its other parts are open JSON.
 * @typedef {Record<string, unknown> & {theme: {colors: Record<string, string>,
 *   fonts: {major: {latin: string, hans: string}, minor: {latin: string, hans: string}},
 *   fontMappings: unknown}}} ThemePayload
 */
/** @typedef {{code?: string, message: string}} RejectionLike */

/**
 * Calls the parser with the worker's input shape (it reads only `bytes`).
 * @param {{name: string, extension: string, bytes: Uint8Array}} input
 */
const parseThemeFile = (input) =>
  /** @type {Promise<import("./derivative.mjs").ParserResult<ThemePayload>>} */ (thmxParser.parse(input));

const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const POTX_MAIN = "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml";

const SCHEME = [
  ["dk1", '<a:sysClr val="windowText" lastClr="000000"/>', "#000000"],
  ["lt1", '<a:sysClr val="window" lastClr="FFFFFF"/>', "#FFFFFF"],
  ["dk2", '<a:srgbClr val="1F2A44"/>', "#1F2A44"],
  ["lt2", '<a:srgbClr val="EEF1F6"/>', "#EEF1F6"],
  ["accent1", '<a:srgbClr val="00589C"/>', "#00589C"],
  ["accent2", '<a:srgbClr val="C8102E"/>', "#C8102E"],
  ["accent3", '<a:srgbClr val="F2A900"/>', "#F2A900"],
  ["accent4", '<a:srgbClr val="5B6770"/>', "#5B6770"],
  ["accent5", '<a:srgbClr val="7A9A01"/>', "#7A9A01"],
  ["accent6", '<a:srgbClr val="00A3AD"/>', "#00A3AD"],
  ["hlink", '<a:srgbClr val="0563C1"/>', "#0563C1"],
  ["folHlink", '<a:srgbClr val="954F72"/>', "#954F72"],
];

const themeXml = ({ colors = true } = {}) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="${A_NS}" name="品牌主题"><a:themeElements>` +
  (colors
    ? `<a:clrScheme name="品牌">${SCHEME.map(([key, xml]) => `<a:${key}>${xml}</a:${key}>`).join("")}</a:clrScheme>`
    : "") +
  `<a:fontScheme name="品牌"><a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/><a:font script="Hans" typeface="宋体"/></a:majorFont>` +
  `<a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:font script="Hans" typeface="微软雅黑"/></a:minorFont></a:fontScheme>` +
  `</a:themeElements></a:theme>`;

function thmx(overrides = {}) {
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/theme/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`,
      ),
      "theme/theme/theme1.xml": strToU8(themeXml(overrides)),
    }),
  );
}

test("a theme file yields the twelve scheme colours and the major and minor fonts", async () => {
  const parsed = await parseThemeFile({ name: "brand.thmx", extension: ".thmx", bytes: thmx() });
  const colors = parsed.payload.theme.colors;
  assert.deepEqual(
    Object.entries(colors),
    SCHEME.map(([key, , hex]) => [key, hex]),
  );
  assert.equal(parsed.payload.theme.fonts.major.latin, "Georgia");
  assert.equal(parsed.payload.theme.fonts.major.hans, "宋体");
  assert.equal(parsed.payload.theme.fonts.minor.latin, "Arial");
  assert.equal(parsed.payload.theme.fonts.minor.hans, "微软雅黑");
  assert.ok(parsed.payload.theme.fontMappings);
});

test("the theme record carries no layouts, slides, logos, charts or sidecar files", async () => {
  const { payload } = await parseThemeFile({
    name: "brand.thmx",
    extension: ".thmx",
    bytes: thmx(),
  });
  assert.deepEqual(payload.masters, []);
  assert.deepEqual(payload.slides, []);
  assert.deepEqual(payload.media, []);
  assert.deepEqual(payload.logos, []);
  assert.equal(payload.logo, null);
  assert.equal(payload.detail, undefined);
  assert.equal(payload.kit, undefined);
  assert.equal(payload.templateDetail, undefined);
});

test("the summary says palette and fonts only", async () => {
  const { summary } = await parseThemeFile({
    name: "brand.thmx",
    extension: ".thmx",
    bytes: thmx(),
  });
  assert.match(summary.zh, /^主题文件 · 12 种主题色 · 标题字体 Georgia/);
  assert.match(summary.zh, /正文字体 Arial/);
  assert.match(summary.zh, /（只提供配色和字体）$/);
});

test("the worker job stores a deck-template record without raw OOXML", async () => {
  const derivative = /** @type {ParsedDerivative} */ (
    await runParseJob({ materialId: "t1", name: "brand.thmx", bytes: thmx() })
  );
  assert.equal(derivative.status, "ok");
  assert.equal(derivative.kind, "deck-template");
  assert.equal(derivative.parser.id, "thmx-theme-v1");
  assert.equal(derivative.source.detectedMime, "application/vnd.ms-officetheme");
  assert.equal(derivative["deck-template"].theme.colors.accent1, "#00589C");
  assert.doesNotMatch(JSON.stringify(derivative), /<a:|<p:/);
});

test("a theme file without a colour scheme or without the theme part is rejected", async () => {
  await assert.rejects(
    parseThemeFile({ name: "x.thmx", extension: ".thmx", bytes: thmx({ colors: false }) }),
    (/** @type {RejectionLike} */ error) => error.code === "corrupt" && /配色/.test(error.message),
  );
  const missing = Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/theme/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`,
      ),
      "theme/theme/theme1.xml": strToU8(""),
    }),
  );
  await assert.rejects(
    parseThemeFile({ name: "x.thmx", extension: ".thmx", bytes: missing }),
    (/** @type {RejectionLike} */ error) => error.code === "corrupt",
  );
});

/**
 * The same deck as a template: only the main part's content type differs.
 * @param {Uint8Array<ArrayBufferLike> | Buffer<ArrayBuffer>} pptx
 */
function asTemplate(pptx) {
  const files = unzipSync(pptx);
  files["[Content_Types].xml"] = strToU8(
    strFromU8(files["[Content_Types].xml"]).replace(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
      POTX_MAIN,
    ),
  );
  return Buffer.from(zipSync(files));
}

test(".potx goes through the same template parser as .pptx", async () => {
  const pptx = buildPptx({ withMedia: true });
  const asDeck = /** @type {ParsedDerivative} */ (
    await runParseJob({ materialId: "p1", name: "deck.pptx", bytes: pptx })
  );
  const asTpl = /** @type {ParsedDerivative} */ (
    await runParseJob({ materialId: "p2", name: "deck.potx", bytes: asTemplate(pptx) })
  );
  assert.equal(asTpl.status, "ok");
  assert.equal(asTpl.kind, "deck-template");
  assert.equal(asTpl.parser.id, "pptx-ooxml-v2");
  assert.equal(asTpl.source.detectedMime, "application/vnd.openxmlformats-officedocument.presentationml.template");
  assert.equal(asTpl.source.extensionMismatch, false);
  const strip = (/** @type {ParsedDerivative} */ derivative) => ({
    theme: derivative["deck-template"].theme,
    masters: derivative["deck-template"].masters,
    slides: derivative["deck-template"].slides,
    logoCandidates: derivative["deck-template"].logoCandidates,
  });
  assert.deepEqual(strip(asTpl), strip(asDeck));
  assert.ok(asTpl["deck-template"].detail?.sha256);
});

test("a .pptx renamed .potx and a .potx renamed .pptx keep the content-based record", async () => {
  const pptx = buildPptx();
  const renamedDeck = await runParseJob({ materialId: "p3", name: "deck.potx", bytes: pptx });
  assert.equal(renamedDeck.parser.id, "pptx-ooxml-v2");
  assert.equal(renamedDeck.source.extensionMismatch, true);
  assert.match(renamedDeck.warnings[0]?.message ?? "", /扩展名为 \.potx/);
  const renamedTemplate = await runParseJob({
    materialId: "p4",
    name: "template.pptx",
    bytes: asTemplate(pptx),
  });
  assert.equal(renamedTemplate.source.extensionMismatch, true);
  assert.match(renamedTemplate.warnings[0]?.message ?? "", /扩展名为 \.pptx/);
});
