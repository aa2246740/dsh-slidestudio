import assert from "node:assert/strict";
import { test } from "node:test";
import { ParsePool, PARSE_RESOURCE_LIMITS } from "./parse-pool.mjs";
import { buildPdf } from "./pdf-fixture-pdfs.mjs";
import * as styleHints from "./pdf-style-hints.mjs";
import {
  MAX_PDF_STYLE_PAGES,
  MAX_PDF_STYLE_OPERATORS_PER_PAGE,
  MAX_PDF_STYLE_OPERATORS_TOTAL,
  PDF_DOCUMENT_OPTIONS,
} from "./pdf-style-hints.mjs";

/** Loosely typed views: the tests hand in partial pdf.js stand-ins. */
/** @type {(input: any) => Promise<any>} */
const extractPdfStyleProfile = styleHints.extractPdfStyleProfile;
/** @type {(input: any) => Promise<Map<number, number>>} */
const extractPdfPageImageCoverage = styleHints.extractPdfPageImageCoverage;

test("PDF style scan caps operator inspection at 30 pages and records vector roles", async () => {
  const OPS = { setFillRGBColor: 1, constructPath: 2, fill: 3, paintImageXObject: 4 };
  /** @type {any[]} */ const visited = [];
  const unpdf = {
    getResolvedPDFJS: async () => ({ OPS }),
    getMeta: async () => ({ info: {} }),
  };
  const proxy = {
    getPage: async (/** @type {any} */ pageNumber) => {
      visited.push(pageNumber);
      const isBeyondLimit = pageNumber > MAX_PDF_STYLE_PAGES;
      return {
        commonObjs: { get: () => undefined },
        cleanup() {},
        getOperatorList: async () => ({
          fnArray: [OPS.setFillRGBColor, OPS.constructPath, OPS.paintImageXObject],
          argsArray: [[isBeyondLimit ? "#00FF00" : "#C00000"], [OPS.fill, [], {}], ["ignored-raster-image"]],
        }),
      };
    },
  };

  const profile = await extractPdfStyleProfile({
    unpdf,
    proxy,
    pageCount: 42,
  });

  assert.deepEqual(
    visited,
    Array.from({ length: 30 }, (_, index) => index + 1),
  );
  assert.equal(profile.pagesScanned, 30);
  assert.deepEqual(profile.accentColors, [{ hex: "#C00000", share: 1, roles: ["fill"] }]);
});

test("PDF document options disable image decoding and JavaScript", () => {
  assert.equal(PDF_DOCUMENT_OPTIONS.maxImageSize, 1);
  assert.equal(PDF_DOCUMENT_OPTIONS.fontExtraProperties, true);
  assert.equal(PDF_DOCUMENT_OPTIONS.isEvalSupported, false);
});

test("PDF style operator budgets stop an oversized page before scanning its operators", async () => {
  const OPS = { setFillRGBColor: 1 };
  /** @type {any[]} */ const visited = [];
  let cleaned = 0;
  const profile = await extractPdfStyleProfile({
    unpdf: {
      getResolvedPDFJS: async () => ({ OPS }),
      getMeta: async () => ({ info: {} }),
    },
    proxy: {
      getPage: async (/** @type {any} */ pageNumber) => {
        visited.push(pageNumber);
        return {
          commonObjs: { get: () => undefined },
          cleanup() {
            cleaned += 1;
          },
          getOperatorList: async () => ({
            fnArray: Array(MAX_PDF_STYLE_OPERATORS_PER_PAGE + 1).fill(OPS.setFillRGBColor),
            argsArray: [],
          }),
        };
      },
    },
    pageCount: 30,
  });
  assert.equal(profile, undefined);
  assert.deepEqual(visited, [1]);
  assert.equal(cleaned, 1);
});

test("PDF image operator coverage is measured in page area without raster decoding", async () => {
  const OPS = { transform: 1, paintImageXObject: 2 };
  /** @type {any[]} */ const visited = [];
  /** @type {any[]} */ const cleaned = [];
  const coverage = await extractPdfPageImageCoverage({
    unpdf: { getResolvedPDFJS: async () => ({ OPS }) },
    proxy: {
      getPage: async (/** @type {any} */ pageNumber) => ({
        getViewport: () => ({
          width: 600,
          height: 800,
          transform: [1, 0, 0, -1, 0, 800],
        }),
        getOperatorList: async () => {
          visited.push(pageNumber);
          const width = pageNumber === 1 ? 500 : 100;
          const height = pageNumber === 1 ? 700 : 100;
          return {
            fnArray: [OPS.transform, OPS.paintImageXObject],
            argsArray: [[width, 0, 0, height, 10, 10], ["synthetic-image"]],
          };
        },
        cleanup: () => cleaned.push(pageNumber),
      }),
    },
    pageNumbers: [1, 2],
  });
  assert.deepEqual(visited, [1, 2]);
  assert.deepEqual(cleaned, [1, 2]);
  assert.ok((coverage.get(1) ?? 0) >= 0.5);
  assert.ok((coverage.get(2) ?? 1) < 0.5);
});

test("PDF style total operator budget stops before visiting another page", async () => {
  const OPS = { ignored: 1 };
  const visited = [];
  const operatorsPerPage = Math.floor(MAX_PDF_STYLE_OPERATORS_TOTAL / 3);
  assert.ok(operatorsPerPage <= MAX_PDF_STYLE_OPERATORS_PER_PAGE);
  const profile = await extractPdfStyleProfile({
    unpdf: { getResolvedPDFJS: async () => ({ OPS }) },
    proxy: {
      getPage: async (/** @type {any} */ pageNumber) => {
        visited.push(pageNumber);
        return {
          commonObjs: { get: () => undefined },
          cleanup() {},
          getOperatorList: async () => ({
            fnArray: Array(operatorsPerPage).fill(OPS.ignored),
            argsArray: [],
          }),
        };
      },
    },
    pageCount: 30,
  });
  assert.equal(profile, undefined);
  assert.equal(visited.length, 4);
});

test("text hints use visible PDF text rendering modes and ignore invisible text", async () => {
  const OPS = {
    setFillRGBColor: 1,
    setStrokeRGBColor: 2,
    setTextRenderingMode: 3,
    showText: 4,
  };
  const profile = await extractPdfStyleProfile({
    unpdf: {
      getResolvedPDFJS: async () => ({ OPS }),
      getMeta: async () => ({ info: {} }),
    },
    proxy: {
      getPage: async () => ({
        commonObjs: { get: () => undefined },
        cleanup() {},
        getOperatorList: async () => ({
          fnArray: [
            OPS.setFillRGBColor,
            OPS.setStrokeRGBColor,
            OPS.showText,
            OPS.setTextRenderingMode,
            OPS.showText,
            OPS.setFillRGBColor,
            OPS.setTextRenderingMode,
            OPS.showText,
          ],
          argsArray: [
            ["#C00000"],
            ["#0000FF"],
            [["visible fill"]],
            [1],
            [["visible stroke"]],
            ["#00FF00"],
            [3],
            [["invisible"]],
          ],
        }),
      }),
    },
    pageCount: 1,
  });
  assert.deepEqual(profile.accentColors, [
    { hex: "#0000FF", share: 0.5, roles: ["text"] },
    { hex: "#C00000", share: 0.5, roles: ["text"] },
  ]);
});

test("large embedded-image PDF parses inside the bounded worker", { timeout: 30_000 }, async () => {
  const bytes = largeImagePdf();
  const pool = new ParsePool({
    maxConcurrent: 1,
    timeoutMs: 10_000,
    resourceLimits: PARSE_RESOURCE_LIMITS,
  });
  try {
    const result = await pool.run({
      materialId: "large-image-pdf",
      name: "large-embedded-image.pdf",
      bytes,
    });
    assert.equal(result.ok, true);
    assert.equal(result.derivative.parser.id, "pdf-unpdf-v4");
    assert.equal(result.derivative.status, "ok");
    assert.equal(result.derivative.document.pageCount, 1);
    assert.equal(result.derivative.document.styleProfile, undefined);
  } finally {
    await pool.close();
  }
});

test("style scan failure is swallowed so PDF text parsing can still succeed", async () => {
  const profile = await extractPdfStyleProfile({
    unpdf: {
      getResolvedPDFJS: async () => {
        throw new Error("synthetic operator-list failure");
      },
    },
    proxy: {},
    pageCount: 1,
  });
  assert.equal(profile, undefined);
});

/** One page with a 4000×4000 embedded picture: decoding it would blow the parse budget. */
function largeImagePdf() {
  return buildPdf({
    pages: [
      {
        text: "Large embedded image PDF parse budget sample",
        images: [{ width: 4000, height: 4000, x: 40, y: 40, rgb: [0, 0, 0] }],
      },
    ],
  });
}
