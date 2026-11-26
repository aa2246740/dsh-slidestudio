import assert from "node:assert/strict";
import { test } from "node:test";
import { textParser } from "./parsers/text.mjs";
import { csvParser, detectDelimiter, parseDelimited, inferType } from "./parsers/csv.mjs";
import { encodeGb18030 } from "./gb18030.mjs";
import { runParseJob } from "./parse-worker.mjs";

/** @typedef {import("./zip-guard.mjs").MaterialRejection} MaterialRejection */
/**
 * @typedef {{encoding: string, delimiter: string, rowCount: number, colCount: number, chars: number,
 *   headerRow: string[], columns: {header: string, inferredType: string}[], rows: string[][]}} CsvPayload
 * @typedef {import("./derivative.mjs").ParserResult<CsvPayload> & {truncated: {applied: boolean, reason?: string}}} CsvResult
 */
/**
 * The text parser reads only `name` and `bytes`; `extension` mirrors the host's job shape.
 * @typedef {{name: string, bytes: Uint8Array}} TextInput
 */

test("text-utf8-v1 counts code-point characters and reports them in summary.zh", () => {
  const bytes = Buffer.from("# 大纲\n\n这是第 2 行 ✨", "utf8");
  const parsed = textParser.parse(/** @type {TextInput} */ ({ name: "outline.md", extension: ".md", bytes }));
  assert.equal(parsed.payload.chars, Array.from("# 大纲\n\n这是第 2 行 ✨").length);
  assert.match(parsed.summary.zh, /文本/);
  assert.match(parsed.summary.zh, /字$/);
});

test("text-utf8-v1 rejects empty and invalid-UTF-8 content with Chinese reasons", () => {
  assert.throws(
    () =>
      textParser.parse(
        /** @type {TextInput} */ ({ name: "empty.txt", extension: ".txt", bytes: Buffer.from("   \n") }),
      ),
    (/** @type {MaterialRejection} */ error) => error.code === "empty" && /文件为空/.test(error.message),
  );
  assert.throws(
    () =>
      textParser.parse(
        /** @type {TextInput} */ ({ name: "bad.txt", extension: ".txt", bytes: Buffer.from([0xc3, 0x28]) }),
      ),
    (/** @type {MaterialRejection} */ error) =>
      error.code === "unsupported-encoding" && /另存为 UTF-8/.test(error.message),
  );
});

test("csv-v1 decodes UTF-8, UTF-8 BOM and GB18030 with the right header", () => {
  const header = "地区,销售额\n华东,1203.17\n华南,987.42\n";
  /** @type {[string, Uint8Array][]} */
  const encodings = [
    ["UTF-8", Buffer.from(header, "utf8")],
    ["UTF-8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(header, "utf8")])],
    ["GB18030", encodeGb18030(header)],
  ];
  for (const [label, bytes] of encodings) {
    const parsed = /** @type {CsvResult} */ (csvParser.parse({ name: "data.csv", extension: ".csv", bytes }));
    assert.equal(parsed.payload.encoding, label, label);
    assert.equal(parsed.payload.headerRow[0], "地区", label);
    assert.equal(parsed.payload.rowCount, 2, label);
    assert.match(parsed.summary.zh, new RegExp(label.replace(" ", "\\ ")));
    assert.match(parsed.summary.zh, /120|2 行/);
    assert.doesNotMatch(parsed.summary.zh, /\uFFFD/);
  }
});

test("csv-v1 detects , ; tab and | delimiters including tab under a .csv name", () => {
  assert.equal(detectDelimiter("a,b,c\n1,2,3"), ",");
  assert.equal(detectDelimiter("a;b\nc;d"), ";");
  assert.equal(detectDelimiter("a\tb\n1\t2"), "\t");
  assert.equal(detectDelimiter("a|b\n1|2"), "|");
  const tabCsv = /** @type {CsvResult} */ (
    csvParser.parse({
      name: "tab-in.csv",
      extension: ".csv",
      bytes: Buffer.from("地区\t销售额\n华东\t1203.17\n"),
    })
  );
  assert.equal(tabCsv.payload.delimiter, "\t");
  assert.match(tabCsv.summary.zh, /制表符分隔/);
});

test("csv-v1 parses quoted fields with escapes and embedded separators", () => {
  const rows = parseDelimited('name,note\n"张三"," said ""ok"", fine"\n', ",");
  assert.deepEqual(rows, [
    ["name", "note"],
    ["张三", ' said "ok", fine'],
  ]);
});

test("csv-v1 infers column types and caps preview rows with a warning", () => {
  const lines = ["序号,金额,地区"];
  for (let i = 1; i <= 300; i += 1) lines.push(`${i},${(i * 1.5).toFixed(2)},区域${i}`);
  const parsed = /** @type {CsvResult} */ (
    csvParser.parse({
      name: "big.csv",
      extension: ".csv",
      bytes: Buffer.from(lines.join("\n")),
    })
  );
  assert.equal(parsed.payload.columns[0].inferredType, "number");
  assert.equal(parsed.payload.columns[1].inferredType, "number");
  assert.equal(parsed.payload.columns[2].inferredType, "text");
  assert.equal(parsed.payload.rowCount, 300);
  assert.equal(parsed.payload.rows.length, 200);
  assert.match(parsed.warnings[0]?.message ?? "", /仅预览前 200 行，完整 300 行/);
  assert.equal(parsed.truncated.applied, true);
});

test("csv-v1 rejects undecodable bytes as unsupported-encoding with a Chinese reason", () => {
  assert.throws(
    () =>
      csvParser.parse({
        name: "bad-encoding.csv",
        extension: ".csv",
        bytes: Buffer.from([0x81, 0x40, 0xff, 0xfe, 0x00, 0x81]),
      }),
    (/** @type {MaterialRejection} */ error) => error.code === "unsupported-encoding" && /编码/.test(error.message),
  );
});

test("inferType treats non-numeric mixture as text", () => {
  const rows = [["1"], ["2"], ["x"]];
  assert.equal(inferType(rows, 0), "text");
});

test("runParseJob builds a material-derivative/v1 envelope end to end", async () => {
  const derivative = await runParseJob({
    materialId: "id-1",
    name: "utf8.csv",
    bytes: Buffer.from("地区,销售额\n华东,1203.17\n"),
    declaredMime: "text/csv",
  });
  assert.equal(derivative.schema, "material-derivative/v1");
  assert.equal(derivative.kind, "table");
  assert.equal(derivative.parser.id, "csv-v1");
  assert.equal(derivative.source.sha256.length, 64);
  assert.match(derivative.summary?.zh ?? "", /CSV · UTF-8 编码 · 逗号分隔 · 1 行 · 列：地区、销售额/);
});
