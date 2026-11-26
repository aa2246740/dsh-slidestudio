import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { runParseJob } from "./parse-worker.mjs";
import { XML_DECL, RELS_NS, rel, esc, wp, W_NS } from "./test-fixtures/docx-parse-kit.mjs";

// --- CAP-33: theme style hints and embedded chart data ----------------------

const CHART_NS =
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/**
 * @typedef {import("./derivative.mjs").Derivative & {document: {charts: unknown[]}, summary: {zh: string}}} DocxDerivative
 * @typedef {{code?: string, message: string}} CodedError
 */

/** One cached series for an in-memory chart part.
 * @param {{index: number, name: string, cats: string[], values: number[], ptCount?: number}} series */
const chartSer = ({ index, name, cats, values, ptCount }) =>
  `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>` +
  `<c:tx><c:strRef><c:f>S!$B$${index + 1}</c:f><c:strCache><c:ptCount val="1"/>` +
  `<c:pt idx="0"><c:v>${esc(name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
  `<c:cat><c:strRef><c:f>S!$A$2:$A$5</c:f><c:strCache><c:ptCount val="${cats.length}"/>` +
  cats.map((cat, i) => `<c:pt idx="${i}"><c:v>${esc(cat)}</c:v></c:pt>`).join("") +
  `</c:strCache></c:strRef></c:cat>` +
  `<c:val><c:numRef><c:f>S!$B$2:$B$5</c:f><c:numCache><c:formatCode>General</c:formatCode>` +
  `<c:ptCount val="${ptCount ?? values.length}"/>` +
  values.map((value, i) => `<c:pt idx="${i}"><c:v>${value}</c:v></c:pt>`).join("") +
  `</c:numCache></c:numRef></c:val></c:ser>`;

/** A complete chartSpace with one barChart group. */
const chartSpace = (/** @type {string[]} */ series) =>
  `${XML_DECL}<c:chartSpace ${CHART_NS}><c:chart><c:plotArea><c:layout/>` +
  `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>` +
  series.join("") +
  `<c:axId val="1"/><c:axId val="2"/></c:barChart>` +
  `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>` +
  `<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>` +
  `</c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`;

/**
 * An in-memory docx whose document rels carry the given chart relationships and
 * whose `word/charts/` holds the given chart parts. Every internal chart rel is
 * referenced from the body through a `c:chart r:id` drawing, like Word writes
 * them; `{ referenced: false }` keeps the rels orphaned (relationship-table
 * entries no container drawing points at).
 * @param {{id: string, external?: boolean}[]} chartRels
 * @param {Record<string, string>} charts part path (word/charts/…) → chart XML
 * @param {{referenced?: boolean}} [options]
 */
function docxWithCharts(chartRels, charts = {}, { referenced = true } = {}) {
  const rels = chartRels
    .map(
      ({ id, external }) =>
        `<Relationship Id="${id}" Type="${rel("chart")}" Target="charts/chart${id.slice(3)}.xml"${
          external ? ' TargetMode="External"' : ""
        }/>`,
    )
    .join("");
  const chartDrawings = referenced
    ? chartRels
        .filter(({ external }) => !external)
        .map(
          ({ id }) =>
            `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="5486400" cy="3200400"/>` +
            `<wp:docPr id="${id.slice(3)}" name="图表 ${id.slice(3)}"/>` +
            `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
            `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${id}"/>` +
            `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
        )
        .join("")
    : "";
  /** @type {Record<string, Uint8Array>} */
  const files = {
    "[Content_Types].xml": strToU8(
      `${XML_DECL}<Types xmlns="${RELS_NS}">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${rel("officeDocument")}" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `${XML_DECL}<w:document ${W_NS}><w:body>${wp("图表说明。", undefined)}${chartDrawings}<w:sectPr/></w:body></w:document>`,
    ),
    "word/_rels/document.xml.rels": strToU8(`${XML_DECL}<Relationships xmlns="${RELS_NS}">${rels}</Relationships>`),
  };
  for (const [path, xml] of Object.entries(charts)) {
    files[path] = strToU8(xml);
  }
  return Buffer.from(zipSync(files, { level: 6 }));
}

test("an external chart relationship is listed as metadata and never fetched", async () => {
  const bytes = docxWithCharts([{ id: "rId1", external: true }]);
  const derivative = /** @type {DocxDerivative} */ (await runParseJob({ materialId: "me", name: "ext.docx", bytes }));
  assert.deepEqual(derivative.document.charts, []);
});

test("a chart relationship the body never references is ignored (orphan rel)", async () => {
  const bytes = docxWithCharts(
    [{ id: "rId1" }],
    {
      "word/charts/chart1.xml": chartSpace([chartSer({ index: 0, name: "营收", cats: ["一"], values: [1] })]),
    },
    { referenced: false },
  );
  const derivative = /** @type {DocxDerivative} */ (
    await runParseJob({ materialId: "morp", name: "orphan-chart.docx", bytes })
  );
  assert.deepEqual(derivative.document.charts, [], "an orphan relationship-table entry is not an embedded chart");
  assert.doesNotMatch(derivative.summary.zh, /图表/);
});

test("a chart cache above the point cap fails closed with a Chinese reason", async () => {
  const bytes = docxWithCharts([{ id: "rId1" }], {
    "word/charts/chart1.xml": chartSpace([
      chartSer({ index: 0, name: "系列", cats: ["一"], values: [1], ptCount: 200_000 }),
    ]),
  });
  await assert.rejects(
    runParseJob({ materialId: "mb", name: "huge.docx", bytes }),
    (/** @type {CodedError} */ error) => error.code === "archive-limit" && /图表缓存/.test(error.message),
  );
});

test("chart discovery is capped at 100 parts with a Chinese warning", async () => {
  const chartRels = Array.from({ length: 120 }, (_, index) => ({
    id: `rId${index + 1}`,
  }));
  const charts = Object.fromEntries(
    chartRels.map(({ id }) => [
      `word/charts/chart${id.slice(3)}.xml`,
      chartSpace([chartSer({ index: 0, name: "系列", cats: ["一"], values: [1] })]),
    ]),
  );
  const bytes = docxWithCharts(chartRels, charts);
  const derivative = /** @type {DocxDerivative} */ (
    await runParseJob({ materialId: "mcap", name: "many.docx", bytes })
  );
  assert.equal(derivative.document.charts.length, 100);
  assert.ok(derivative.warnings.some((warning) => warning.code === "charts-truncated" && /图表/.test(warning.message)));
});
