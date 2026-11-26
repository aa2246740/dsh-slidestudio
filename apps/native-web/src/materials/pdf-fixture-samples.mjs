/**
 * Test-only named PDF samples, built in code with `buildPdf` (same contents as the
 * shared attachment sample set: text, styled report, long, scans, photos, tables,
 * garbage and an encrypted trailer). Each sample is built once per process.
 */
import { buildPdf, fixtureRandom } from "./pdf-fixture-pdfs.mjs";

/** Ruled table on page 1 of tables.pdf (Chinese headers + numbers). */
export const RULED_ROWS = [
  ["季度", "目标（万）", "完成（万）", "达标率"],
  ["2025年Q1", "120", "108", "90.0%"],
  ["2025年Q2", "130", "117", "90.0%"],
  ["2025年Q3", "125", "113", "90.4%"],
  ["2025年Q4", "140", "126", "90.0%"],
  ["2026年Q1", "150", "139", "92.7%"],
];
/** Whitespace-aligned table on page 2 of tables.pdf. */
export const UNRULED_ROWS = [
  ["地区", "负责人", "状态"],
  ["华东", "王琳", "已完成"],
  ["华南", "陈明", "进行中"],
  ["西南", "赵倩", "已完成"],
  ["东北", "孙强", "待启动"],
];

/**
 * @param {string[][]} rows @param {number[]} columns @param {number} top
 * @param {number} lineHeight @param {number} size
 */
function gridItems(rows, columns, top, lineHeight, size) {
  return rows.flatMap((cells, rowIndex) =>
    cells.map((text, columnIndex) => ({
      text,
      x: columns[columnIndex] ?? 0,
      y: top - rowIndex * lineHeight,
      size,
    })),
  );
}

function tablesPdf() {
  const ruledVector = [
    "0.6 w 0.55 G",
    ...[738, 714, 690, 666, 642, 618, 594].map((y) => `56 ${y} 480 0.8 re S`),
    ...[56, 176, 296, 416, 536].map((x) => `${x} 594 0.8 144 re S`),
  ].join("\n");
  return buildPdf({
    fontName: "HYQiHei-EES",
    pages: [
      { vectorContent: ruledVector, items: gridItems(RULED_ROWS, [64, 184, 304, 424], 726, 24, 11) },
      { items: gridItems(UNRULED_ROWS, [64, 256, 396], 700, 28, 11) },
      { text: "第三页只有普通段落文字，没有任何表格结构，用于确认无表格 PDF 返回空列表。" },
    ],
  });
}

/** @param {number} pageIndex */
function galleryPage(pageIndex) {
  return {
    text: `Gallery page ${pageIndex + 1}.`,
    images: Array.from({ length: 5 }, (_, order) => {
      const n = pageIndex * 5 + order;
      return {
        width: 64,
        height: 64,
        x: 40 + order * 90,
        y: 600,
        rgb: /** @type {[number, number, number]} */ ([(n * 37 + 20) % 256, (n * 91 + 40) % 256, (n * 53 + 60) % 256]),
      };
    }),
  };
}

/** @param {[number, number, number]} rgb @param {string} [text] */
const scanPage = (rgb, text) => ({
  ...(text ? { text } : {}),
  raster: { width: 595, height: 842, x: 0, y: 0, rgb },
});

/** @type {Record<string, () => Buffer>} */
const SAMPLES = {
  "text.pdf": () =>
    buildPdf({
      pages: Array.from({ length: 5 }, (_, i) => ({
        text: `Page ${i + 1} quarterly narrative text for parsing checks.`,
      })),
    }),
  "styled-report.pdf": () =>
    buildPdf({
      fontName: "HYQiHei-EES",
      pages: [
        {
          vectorContent: "0.753 0 0 rg 40 700 500 80 re f",
          text: "2026年1-2月 达标率 89.64%",
          raster: { width: 420, height: 110, x: 84, y: 650, rgb: [180, 6, 6] },
        },
      ],
    }),
  "long.pdf": () =>
    buildPdf({
      pages: Array.from({ length: 40 }, (_, i) => ({
        text: `Page ${i + 1}: long document body text for extraction timing.`,
      })),
    }),
  "mixed-scan.pdf": () =>
    buildPdf({
      pages: [
        { text: "Page 1 introduces the report and carries the overview." },
        { vectorOnly: true },
        { vectorOnly: true },
        { text: "Page 4 returns to readable text after the scanned pages." },
      ],
    }),
  "scan-only.pdf": () => buildPdf({ pages: Array.from({ length: 3 }, () => ({ vectorOnly: true })) }),
  "photo-in.pdf": () =>
    buildPdf({
      pages: [
        {
          text: "Photo page one: a wide photo and two small icons.",
          images: [
            { width: 240, height: 160, x: 56, y: 520, rgb: [170, 120, 70], noise: 60, seed: 101 },
            { width: 32, height: 32, x: 56, y: 470, rgb: [200, 30, 30] },
            { width: 24, height: 24, x: 100, y: 470, rgb: [30, 120, 200] },
          ],
        },
        {
          text: "Photo page two: a portrait photo and one tiny mark.",
          images: [
            { width: 160, height: 200, x: 56, y: 480, rgb: [60, 110, 160], noise: 50, seed: 202 },
            { width: 48, height: 48, x: 300, y: 480, rgb: [40, 160, 80] },
          ],
        },
      ],
    }),
  "photo-many.pdf": () => buildPdf({ pages: Array.from({ length: 9 }, (_, i) => galleryPage(i)) }),
  "scan-pages.pdf": () =>
    buildPdf({
      pages: [
        scanPage([236, 236, 232]),
        scanPage([230, 232, 236], "Scanned page 2"),
        scanPage([232, 236, 230]),
        {
          text: "Page 4 is an ordinary text page that carries one small photo.",
          images: [{ width: 240, height: 160, x: 56, y: 520, rgb: [90, 140, 110], noise: 55, seed: 404 }],
        },
      ],
    }),
  "blank-page.pdf": () =>
    buildPdf({
      pages: [{}, { text: "Page 2 has ordinary readable text for the blank-page check." }],
    }),
  "tables.pdf": tablesPdf,
  "garbage.pdf": () => {
    const random = fixtureRandom(7);
    const noise = Buffer.from(Array.from({ length: 2048 }, () => Math.floor(random() * 256)));
    return Buffer.concat([Buffer.from("%PDF-1.4\n"), noise]);
  },
  "secret.pdf": () => buildPdf({ pages: [{ text: "Encrypted fixture page one." }], encrypt: true }),
};

/** @type {Map<string, Buffer>} */
const built = new Map();

/**
 * A fresh copy of one named sample (callers may mutate it).
 * @param {string} name
 * @returns {Buffer}
 */
export function pdfSample(name) {
  let bytes = built.get(name);
  if (!bytes) {
    const make = SAMPLES[name];
    if (!make) throw new Error(`unknown PDF fixture ${name}`);
    bytes = make();
    built.set(name, bytes);
  }
  return Buffer.from(bytes);
}
