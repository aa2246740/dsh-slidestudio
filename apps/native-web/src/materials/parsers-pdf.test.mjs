import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPdfError, pdfParser } from "./parsers/pdf.mjs";
import { runParseJob } from "./parse-worker.mjs";
import { buildMultiPagePdf } from "./pdf-fixture-pdfs.mjs";
import { pdfSample } from "./pdf-fixture-samples.mjs";

/** @param {string} name */
const parseSample = (name) => pdfParser.parse({ name, bytes: pdfSample(name) });

/** @param {any} value @returns {any} loosely typed view of a parser payload */
const loose = (value) => value;

test("pdf-unpdf-v4 extracts per-page text with page count and char count", async () => {
  const parsed = loose(await parseSample("text.pdf"));
  assert.equal(parsed.payload.pageCount, 5);
  assert.equal(parsed.payload.pages.length, 5);
  assert.ok(parsed.payload.pages.every((/** @type {any} */ page) => page.chars > 20 && !page.lowText));
  assert.ok(parsed.payload.chars > 0);
  assert.equal(parsed.status, "ok");
  assert.deepEqual(parsed.warnings, []);
  assert.match(parsed.summary.zh, /^PDF · 5 页 · 约 [\d,]+ 字$/);
});

test("long.pdf (40 pages) extracts all pages", async () => {
  const started = performance.now();
  const parsed = loose(await parseSample("long.pdf"));
  assert.ok(performance.now() - started < 2000, "40-page text and style parse must stay under 2 s");
  assert.equal(parsed.payload.pageCount, 40);
  assert.equal(parsed.payload.pages.length, 40);
  assert.equal(parsed.status, "ok");
});

test("styled-report.pdf exposes deterministic vector colour and mapped font hints", async () => {
  const bytes = pdfSample("styled-report.pdf");
  const started = performance.now();
  const parsed = loose(await pdfParser.parse({ name: "styled-report.pdf", bytes }));
  assert.ok(performance.now() - started < 2000, "text and style scan must fit the parse budget");
  assert.match(parsed.payload.pages[0].text, /2026年1-2月 达标率 89\.64%/);
  assert.equal(parsed.payload.styleProfile.schema, "style-profile/v1");
  assert.equal(parsed.payload.styleProfile.source, "pdf-vector-ops");
  assert.equal(parsed.payload.styleProfile.pagesScanned, 1);
  assert.equal(parsed.payload.styleProfile.accentColors[0].hex, "#C00000");
  assert.ok(parsed.payload.styleProfile.accentColors[0].roles.includes("fill"));
  assert.equal(parsed.payload.styleProfile.fonts[0].source, "HYQiHei-EES");
  assert.equal(parsed.payload.styleProfile.fonts[0].mapped.ea, "微软雅黑");
  assert.equal(parsed.payload.pages[0].hasImage, undefined, "image coverage is measured by the render child");
  assert.equal("styleHints" in parsed.payload, false, "styleHints is only a host payload mirror");

  const derivative = loose(await runParseJob({ materialId: "styled-report", name: "styled-report.pdf", bytes }));
  assert.deepEqual(derivative.document.styleProfile, parsed.payload.styleProfile);
});

test("plain text PDF does not advertise an accent style profile", async () => {
  const parsed = loose(await parseSample("text.pdf"));
  assert.equal(parsed.payload.styleProfile, undefined);
});

test("mixed-scan.pdf flags low-text pages with neutral wording until page images are measured", async () => {
  const parsed = loose(await parseSample("mixed-scan.pdf"));
  assert.equal(parsed.status, "partial");
  assert.deepEqual(
    parsed.payload.pages.filter((/** @type {any} */ page) => page.lowText).map((/** @type {any} */ page) => page.index),
    [2, 3],
  );
  assert.ok(parsed.payload.pages.every((/** @type {any} */ page) => page.hasImage === undefined));
  const warning = parsed.warnings.find((/** @type {any} */ w) => w.code === "scanned-pages");
  assert.ok(warning, "expected a scanned-pages warning");
  assert.equal(
    warning.message,
    "第 2、3 页几乎没有可提取的文字，可能是整页图片或扫描件；当前版本不做文字识别（OCR），这几页的内容 Agent 读不到",
  );
  assert.match(parsed.summary.zh, /第 2、3 页几乎没有文字（可能是整页图片），未识别（不做 OCR）$/);
  assert.doesNotMatch(parsed.summary.zh, /扫描图片/);
  assert.doesNotMatch(warning.message, /扫描图片/);

  // The stored record is a partial success: the warning carries the honesty.
  const derivative = loose(
    await runParseJob({
      materialId: "pub-mixed",
      name: "mixed-scan.pdf",
      bytes: pdfSample("mixed-scan.pdf"),
    }),
  );
  assert.equal(derivative.status, "partial");
  assert.equal(derivative.kind, "document");
  assert.equal(derivative.parser.id, "pdf-unpdf-v4");
  assert.ok(derivative.warnings.some((/** @type {any} */ w) => w.code === "scanned-pages"));
});

test("scan-only.pdf keeps every page low-text without inventing text", async () => {
  const parsed = loose(await parseSample("scan-only.pdf"));
  assert.equal(parsed.payload.chars, 0);
  assert.ok(parsed.payload.pages.every((/** @type {any} */ page) => page.lowText));
  assert.equal(parsed.status, "partial");
  assert.match(parsed.summary.zh, /第 1、2、3 页几乎没有文字（可能是整页图片），未识别（不做 OCR）$/);
  const warning = parsed.warnings.find((/** @type {any} */ w) => w.code === "scanned-pages");
  assert.match(warning.message, /^第 1、2、3 页几乎没有可提取的文字，可能是整页图片或扫描件/);
  assert.doesNotMatch(parsed.summary.zh, /扫描图片/);
  assert.doesNotMatch(warning.message, /扫描图片/);

  const derivative = loose(
    await runParseJob({
      materialId: "pub-scan-only",
      name: "scan-only.pdf",
      bytes: pdfSample("scan-only.pdf"),
    }),
  );
  assert.equal(derivative.status, "partial");
  assert.ok(derivative.warnings.length > 0, "all-scanned PDF must not look like an ordinary success");
});

test("blank-page.pdf marks only the empty page as low-text", async () => {
  const parsed = loose(await parseSample("blank-page.pdf"));
  assert.equal(parsed.payload.pages[0].lowText, true);
  assert.equal(parsed.payload.pages[1].lowText, false);
  assert.match(parsed.summary.zh, /第 1 页几乎没有文字（可能是整页图片），未识别（不做 OCR）$/);
  const warning = parsed.warnings.find((/** @type {any} */ item) => item.code === "scanned-pages");
  assert.match(warning.message, /^第 1 页几乎没有可提取的文字，可能是整页图片或扫描件/);
});

test("more than 10 low-text pages cap the list once, never doubling 页", async () => {
  const parsed = loose(
    await pdfParser.parse({
      name: "low-text-capped.pdf",
      bytes: buildMultiPagePdf(12, (i) => `P${i + 1}`),
    }),
  );
  assert.equal(parsed.payload.pageCount, 12);
  assert.ok(parsed.payload.pages.every((/** @type {any} */ page) => page.lowText));
  assert.equal(parsed.status, "partial");
  assert.match(
    parsed.summary.zh,
    /第 1、2、3、4、5、6、7、8、9、10 等 12 页几乎没有文字（可能是整页图片），未识别（不做 OCR）$/,
  );
  assert.doesNotMatch(parsed.summary.zh, /页 页/);
  const warning = parsed.warnings.find((/** @type {any} */ w) => w.code === "scanned-pages");
  assert.equal(
    warning?.message,
    "第 1、2、3、4、5、6、7、8、9、10 等 12 页几乎没有可提取的文字，可能是整页图片或扫描件；当前版本不做文字识别（OCR），这几页的内容 Agent 读不到",
  );
  assert.doesNotMatch(warning?.message ?? "", /页 页/);
});

test("secret.pdf (standard security /Encrypt trailer) is rejected as encrypted", async () => {
  await assert.rejects(
    () => parseSample("secret.pdf"),
    (/** @type {any} */ error) =>
      error.code === "encrypted" && /加密/.test(error.message) && /取消密码/.test(error.message),
  );
});

test("garbage.pdf is rejected as corrupt with a Chinese reason", async () => {
  await assert.rejects(
    () => parseSample("garbage.pdf"),
    (/** @type {any} */ error) => error.code === "corrupt" && /损坏或内容不完整/.test(error.message),
  );
});

test("PDFs beyond 300 pages are truncated with a warning, never silently cut", async () => {
  const parsed = loose(await pdfParser.parse({ name: "huge-pages.pdf", bytes: buildMultiPagePdf(305) }));
  assert.equal(parsed.payload.pageCount, 305);
  assert.equal(parsed.payload.pages.length, 300);
  assert.deepEqual(parsed.payload.tables, [], "tables stay an empty list beyond the 300-page cut");
  assert.equal(parsed.truncated.applied, true);
  const warning = parsed.warnings.find((/** @type {any} */ w) => w.code === "page-limit");
  assert.match(warning.message, /305 页/);
  assert.match(warning.message, /仅提取前 300 页/);
});

test("a password-protected PDF (PasswordException) is rejected as encrypted", () => {
  // Real password (non-empty user password): pdf.js raises PasswordException.
  const error = new Error("Incorrect password");
  error.name = "PasswordException";
  assert.throws(
    () => {
      throw classifyPdfError(error);
    },
    (/** @type {any} */ thrown) => thrown.code === "encrypted" && /加密/.test(thrown.message),
  );
  const invalid = new Error("Invalid PDF structure.");
  invalid.name = "InvalidPDFException";
  assert.throws(
    () => {
      throw classifyPdfError(invalid);
    },
    (/** @type {any} */ thrown) => thrown.code === "corrupt" && /损坏或内容不完整/.test(thrown.message),
  );
});
