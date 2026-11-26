import assert from "node:assert/strict";
import { test } from "node:test";
import { pdfParser } from "./parsers/pdf.mjs";
import * as parseWorker from "./parse-worker.mjs";
import { ruleSegmentsFromOperatorList, tableClusters } from "./pdf-tables.mjs";
import { pdfSample, RULED_ROWS, UNRULED_ROWS } from "./pdf-fixture-samples.mjs";

/** @param {string} name @returns {Promise<any>} */
const parseSample = (name) => parsePdf({ name, bytes: pdfSample(name) });
/** @type {(job: any) => Promise<any>} */
const runParseJob = parseWorker.runParseJob;
/** @type {(input: {name: string, bytes: Uint8Array}) => Promise<any>} */
const parsePdf = (input) => pdfParser.parse(input);

/** Declared cells of tables.pdf, whitespace-normalized like the parser output. */
const declaredRuled = RULED_ROWS;
const declaredUnruled = UNRULED_ROWS;
const normalizeCell = (/** @type {any} */ cell) =>
  String(cell ?? "")
    .replace(/\s+/g, " ")
    .trim();

test("VAL-PDF-008: tables.pdf reconstructs exactly the declared ruled and unruled tables", async () => {
  const parsed = await parseSample("tables.pdf");
  const tables = parsed.payload.tables;
  assert.equal(tables.length, 2, "exactly one ruled and one unruled table");
  const ruled = tables[0];
  assert.equal(ruled.page, 1);
  assert.equal(ruled.rows, 6);
  assert.equal(ruled.cols, 4);
  assert.deepEqual(
    ruled.cells.map((/** @type {any} */ row) => row.map(normalizeCell)),
    declaredRuled,
  );
  assert.equal(ruled.ruled, true, "the fixture draws ruling rectangles");
  assert.ok(ruled.confidence > 0.7, `ruled confidence should be high, got ${ruled.confidence}`);

  const unruled = tables[1];
  assert.equal(unruled.page, 2);
  assert.equal(unruled.rows, 5);
  assert.equal(unruled.cols, 3);
  assert.deepEqual(
    unruled.cells.map((/** @type {any} */ row) => row.map(normalizeCell)),
    declaredUnruled,
  );
  assert.equal(unruled.ruled, false);
  assert.ok(unruled.confidence > 0.4, `unruled confidence should be fair, got ${unruled.confidence}`);
  for (const entry of tables) {
    assert.ok(entry.confidence > 0 && entry.confidence <= 1, "confidence stays in (0,1]");
  }
  assert.equal(parsed.status, "ok", "a table PDF without low-text pages parses clean");
});

test("VAL-PDF-008: the stored derivative carries the same tables and the summary names the count", async () => {
  const bytes = pdfSample("tables.pdf");
  const derivative = await runParseJob({ materialId: "pub-tables", name: "tables.pdf", bytes });
  assert.equal(derivative.document.tables.length, 2);
  assert.equal(derivative.document.tables[0].page, 1);
  assert.equal(derivative.document.tables[1].page, 2);
  assert.match(derivative.summary.zh, /2 个表格/);
  assert.equal(derivative.summary.facts.tables, 2);
});

test("tables.pdf parses deterministically: two parses give identical table JSON", async () => {
  const bytes = pdfSample("tables.pdf");
  const first = await parsePdf({ name: "tables.pdf", bytes });
  const second = await parsePdf({ name: "tables.pdf", bytes });
  assert.equal(JSON.stringify(first.payload.tables), JSON.stringify(second.payload.tables));
});

test("text.pdf and scan-only.pdf yield an empty table list", async () => {
  assert.deepEqual((await parseSample("text.pdf")).payload.tables, []);
  assert.deepEqual((await parseSample("scan-only.pdf")).payload.tables, []);
  const textSummary = (await parseSample("text.pdf")).summary.zh;
  assert.doesNotMatch(textSummary, /表格/, "no table claim when none was found");
});

test("long.pdf keeps an empty table list within the text-parse budget", async () => {
  const started = performance.now();
  const parsed = await parseSample("long.pdf");
  assert.ok(
    performance.now() - started < 2000,
    `long.pdf text+tables parse must stay under 2 s, got ${performance.now() - started} ms`,
  );
  assert.deepEqual(parsed.payload.tables, []);
});

// ---------------------------------------------------------------------------
// Unit coverage of the clustering itself (hostile shapes, caps, determinism).
// ---------------------------------------------------------------------------

/** @param {{text: string, x: number, y: number, fontSize?: number}} item */
const item = ({ text, x, y, fontSize = 11 }) => ({ text, x, y, fontSize });

test("a page with one text item produces no table", () => {
  assert.deepEqual(tableClusters([item({ text: "只有一行", x: 60, y: 700 })], { horizontal: [], vertical: [] }), []);
});

test("prose rows (one item per line) produce no table", () => {
  const prose = [
    item({ text: "第一段普通文字，占满整行的宽度。", x: 56, y: 720, fontSize: 14 }),
    item({ text: "第二段普通文字，继续占满整行。", x: 56, y: 700, fontSize: 14 }),
    item({ text: "第三段普通文字，收尾。", x: 56, y: 680, fontSize: 14 }),
  ];
  assert.deepEqual(tableClusters(prose, { horizontal: [], vertical: [] }), []);
});

test("two aligned rows with two columns form one table with confidence in range", () => {
  const rows = [
    [item({ text: "名称", x: 60, y: 720 }), item({ text: "数值", x: 200, y: 720 })],
    [item({ text: "华东", x: 60, y: 692 }), item({ text: "120", x: 200, y: 692 })],
    [item({ text: "华南", x: 60, y: 664 }), item({ text: "131", x: 200, y: 664 })],
  ];
  const flat = rows.flat();
  const tables = tableClusters(flat, { horizontal: [], vertical: [] });
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rows, 3);
  assert.equal(tables[0].cols, 2);
  assert.deepEqual(tables[0].cells[0], ["名称", "数值"]);
  assert.ok(tables[0].confidence > 0 && tables[0].confidence <= 1);
});

test("a ruled grid assigns items by ruling intervals, not whitespace gaps", () => {
  const rules = {
    horizontal: [714, 690, 666].map((y) => ({ y, x0: 56, x1: 400 })),
    vertical: [56, 180, 300].map((x) => ({ x, y0: 666, y1: 714 })),
  };
  const cells = [
    item({ text: "甲", x: 70, y: 705 }),
    item({ text: "乙", x: 190, y: 705 }),
    item({ text: "丙", x: 250, y: 682 }),
  ];
  const tables = tableClusters(cells, rules);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].ruled, true);
  assert.deepEqual(tables[0].cells, [
    ["甲", "乙"],
    ["", "丙"],
  ]);
  assert.ok(tables[0].confidence >= 0.7);
});

test("a table wider than the cell cap truncates rows and flags truncated", () => {
  const rows = Array.from({ length: 30 }, (_, r) => [
    item({ text: `r${r}`, x: 60, y: 720 - r * 20 }),
    item({ text: String(r * 7), x: 200, y: 720 - r * 20 }),
  ]);
  const tables = tableClusters(rows.flat(), { horizontal: [], vertical: [] });
  assert.equal(tables.length, 1);
  assert.equal(tables[0].truncated, true);
  assert.ok(tables[0].cells.length <= 20, "rows are capped at 20 per table");
});

test("whitespace-only items never become cells", () => {
  const items = [
    item({ text: "甲", x: 60, y: 700 }),
    item({ text: " ", x: 90, y: 700 }),
    item({ text: "乙", x: 200, y: 700 }),
    item({ text: "丙", x: 60, y: 670 }),
    item({ text: "丁", x: 200, y: 670 }),
  ];
  const tables = tableClusters(items, { horizontal: [], vertical: [] });
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].cells[0], ["甲", "乙"]);
  assert.deepEqual(tables[0].cells[1], ["丙", "丁"]);
});

// ---------------------------------------------------------------------------
// Graphics-state regressions (M8-SCR-10/11): a plain `cm` neither corrupts the
// affine d component nor enters the q/Q save stack; form begin/end keep their
// own boundary. Mirrors pdf-image-paints.mjs, the sibling matrix tracker.
// ---------------------------------------------------------------------------

/** Fabricated pdf.js operator ids; the scanner only resolves names through the map. */
const OPS_TEST = Object.freeze({
  save: 1,
  restore: 2,
  transform: 3,
  paintFormXObjectBegin: 4,
  paintFormXObjectEnd: 5,
  constructPath: 6,
  stroke: 7,
});
const testNamesByOperator = new Map(Object.entries(OPS_TEST).map(([name, id]) => [id, name]));
/** @param {{fn: number, args: unknown[]}[]} ops */
const operatorListOf = (ops) => ({
  fnArray: ops.map((entry) => entry.fn),
  argsArray: ops.map((entry) => entry.args),
});
const op = (/** @type {keyof typeof OPS_TEST} */ name, /** @type {any} */ args) => ({ fn: OPS_TEST[name], args });
/** Interleaved [moveTo, x, y, lineTo, x, y] path array as bundled pdf.js emits. */
const hline = (/** @type {number} */ x1, /** @type {number} */ y, /** @type {number} */ x2) => [0, x1, y, 1, x2, y];
/** Vertical rule path array. */
const vline = (/** @type {number} */ x, /** @type {number} */ y1, /** @type {number} */ y2) => [0, x, y1, 1, x, y2];
const strokePath = (/** @type {number[][]} */ paths) => [OPS_TEST.stroke, paths];

test("M8-SCR-10: a plain cm translation moves ruling lines without scaling them", () => {
  const ops = [
    op("transform", [1, 0, 0, 1, 50, 100]),
    op(
      "constructPath",
      strokePath([
        hline(0, 100, 200),
        hline(0, 120, 200),
        hline(0, 140, 200),
        vline(0, 100, 140),
        vline(100, 100, 140),
        vline(200, 100, 140),
      ]),
    ),
  ];
  const segments = ruleSegmentsFromOperatorList(operatorListOf(ops), testNamesByOperator);
  assert.deepEqual(
    segments.horizontal.map((rule) => rule.y),
    [200, 220, 240],
    "the translation reaches y without scaling or shifting it by anything else",
  );
  assert.deepEqual(
    segments.vertical.map((rule) => rule.x),
    [50, 150, 250],
  );
});

test("M8-SCR-10: a translated ruled grid keeps exact 2x2 cells for right-aligned text", () => {
  const ops = [
    op("transform", [1, 0, 0, 1, 100, 72]),
    op(
      "constructPath",
      strokePath([
        hline(0, 20, 200),
        hline(0, 40, 200),
        hline(0, 60, 200),
        vline(0, 20, 60),
        vline(100, 20, 60),
        vline(200, 20, 60),
      ]),
    ),
  ];
  const segments = ruleSegmentsFromOperatorList(operatorListOf(ops), testNamesByOperator);
  // unpdf text items arrive in page space (already translated), unlike the rules.
  const items = [
    item({ text: "Region", x: 108, y: 124 }),
    item({ text: "120", x: 272, y: 124 }),
    item({ text: "East", x: 108, y: 104 }),
    item({ text: "95", x: 280, y: 104 }),
  ];
  const tables = tableClusters(items, segments);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].ruled, true, "the translated grid must still classify as ruled");
  assert.deepEqual(tables[0].cells, [
    ["Region", "120"],
    ["East", "95"],
  ]);
});

test("M8-SCR-11: q/cm/cm/Q restores the saved CTM instead of the last cm", () => {
  const ops = [
    op("save", []),
    op("transform", [1, 0, 0, 1, 100, 50]),
    op("constructPath", strokePath([hline(10, 20, 110)])),
    op("transform", [1, 0, 0, 1, 0, 20]),
    op("constructPath", strokePath([hline(10, 20, 110)])),
    op("restore", []),
    op("constructPath", strokePath([hline(10, 20, 110)])),
  ];
  const segments = ruleSegmentsFromOperatorList(operatorListOf(ops), testNamesByOperator);
  assert.deepEqual(
    segments.horizontal.map((rule) => [rule.y, rule.x0, rule.x1]),
    [
      [70, 110, 210],
      [90, 110, 210],
      [20, 10, 110],
    ],
    "inside the q the cms concatenate; after Q the pre-q matrix is back",
  );
});

test("M8-SCR-11: form XObject begin/end keeps its boundary around a nested cm", () => {
  const ops = [
    op("transform", [1, 0, 0, 1, 10, 10]),
    op("save", []),
    op("paintFormXObjectBegin", [
      [1, 0, 0, 1, 100, 100],
      [0, 0, 200, 200],
    ]),
    op("transform", [1, 0, 0, 1, 5, 5]),
    op("constructPath", strokePath([hline(0, 0, 200)])),
    op("paintFormXObjectEnd", []),
    op("constructPath", strokePath([hline(0, 0, 200)])),
    op("restore", []),
    op("constructPath", strokePath([hline(0, 20, 200)])),
  ];
  const segments = ruleSegmentsFromOperatorList(operatorListOf(ops), testNamesByOperator);
  assert.deepEqual(
    segments.horizontal.map((rule) => [rule.y, rule.x0, rule.x1]),
    [
      [115, 115, 315],
      [10, 10, 210],
      [30, 10, 210],
    ],
    "the plain cm before q must not enter the stack; Q restores the q state, which still carries it",
  );
});

// ---------------------------------------------------------------------------
// Real-parser regressions (M8-SCR-10): the same translated table through
// pdfParser.parse, built like the tables.pdf fixture (re S grid + Tj text).
// ---------------------------------------------------------------------------

/** One-page PDF whose 2x2 ruled table is drawn entirely inside q 1 0 0 1 100 72 cm … Q. */
function translatedRuledTablePdf() {
  const content = [
    "q",
    "1 0 0 1 100 72 cm",
    "0.6 w 0.55 G",
    "0 20 200 0.8 re S",
    "0 40 200 0.8 re S",
    "0 60 200 0.8 re S",
    "0 20 0.8 40 re S",
    "100 20 0.8 40 re S",
    "200 20 0.8 40 re S",
    "BT /F1 11 Tf 8 52 Td (Region) Tj ET",
    "BT /F1 11 Tf 172 52 Td (120) Tj ET",
    "BT /F1 11 Tf 8 32 Td (East) Tj ET",
    "BT /F1 11 Tf 180 32 Td (95) Tj ET",
    "Q",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  const header = Buffer.from("%PDF-1.4\n", "latin1");
  const chunks = [header];
  /** @type {any[]} */ const offsets = [];
  let at = header.length;
  objects.forEach((body, index) => {
    offsets.push(at);
    const serialized = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    chunks.push(serialized);
    at += serialized.length;
  });
  const xrefAt = at;
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  chunks.push(
    Buffer.from(
      `${xref}trailer << /Size ${objects.length + 1} /Root 1 0 R >>\n` + `startxref\n${xrefAt}\n%%EOF\n`,
      "latin1",
    ),
  );
  return Buffer.concat(chunks);
}

test("M8-SCR-10: the real parser reconstructs a 2x2 ruled table drawn inside q/cm/Q", async () => {
  const parsed = await parsePdf({
    name: "translated-tables.pdf",
    bytes: new Uint8Array(translatedRuledTablePdf()),
  });
  const tables = parsed.payload.tables;
  assert.equal(tables.length, 1);
  assert.equal(tables[0].page, 1);
  assert.equal(tables[0].ruled, true, "the translated grid must still classify as ruled");
  assert.equal(tables[0].rows, 2);
  assert.equal(tables[0].cols, 2);
  assert.deepEqual(
    tables[0].cells.map((/** @type {any} */ row) => row.map(normalizeCell)),
    [
      ["Region", "120"],
      ["East", "95"],
    ],
  );
  assert.ok(tables[0].confidence > 0.7, `ruled confidence stays high, got ${tables[0].confidence}`);
});

test("M8-SCR-10: the parse worker stores the translated ruled table in the derivative", async () => {
  const derivative = await runParseJob({
    materialId: "pub-translated-tables",
    name: "translated-tables.pdf",
    bytes: translatedRuledTablePdf(),
  });
  assert.equal(derivative.document.tables.length, 1);
  assert.equal(derivative.document.tables[0].ruled, true);
  assert.match(derivative.summary.zh, /1 个表格/);
});
