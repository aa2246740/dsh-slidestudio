import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  titleOnlyCoverPage,
  type ChartElement,
  type Page,
  type PptdProject,
} from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "./export-pptd.js";

/*
 * VAL-FMT-006 (CAP-33): the cached values read from an Office document's
 * embedded chart (chart-report.docx — see parsers-docx.test.mjs in
 * apps/native-web) must land unchanged in a native slide chart, so an Agent
 * can turn a read chart into an editable PPTD chart and export it.
 */
const CHART_CATS = ["第一季度", "第二季度", "第三季度", "第四季度"];
const REVENUE = [1204.31, 1387.55, 1502.19, 1675.83];
const GROSS = [401.2, 455.7, 498.1, 530.5];

const officeValuesChart = {
  elementId: "office-chart",
  elementType: "chart",
  bounds: [60, 60, 700, 380],
  data: {
    cols: ["季度", "营收", "毛利"],
    rows: CHART_CATS.map((quarter, index) => [quarter, REVENUE[index], GROSS[index]]),
  },
  series: [
    { type: "bar", name: "营收", encode: { x: "季度", y: "营收" } },
    { type: "bar", name: "毛利", encode: { x: "季度", y: "毛利" } },
  ],
} as unknown as ChartElement;

/** @param {PptdProject} project */
async function exportChartXml(project: PptdProject): Promise<string> {
  const result = await exportProjectToPptx(project);
  assert.equal(result.report.ok, true, JSON.stringify(result.report.degradations));
  const zip = await JSZip.loadAsync(result.data);
  const name = Object.keys(zip.files).find((entry) => /^ppt\/charts\/chart\d+\.xml$/.test(entry));
  assert.ok(name, "one chart part is exported");
  return zip.file(name)!.async("string");
}

describe("export: Office chart values survive a native round trip (VAL-FMT-006)", () => {
  it("writes the read categories and series values into the chart caches verbatim", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-office-chart-values-"));
    try {
      const project = createEmptyProject(dir, { title: "季度经营图表" });
      listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("季度经营图表"));
      const page: Page = {
        pageType: "content",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [officeValuesChart],
      };
      listComposedPage(project, "pages/01-chart.page", page);
      saveProject(project);
      const xml = await exportChartXml(project);
      const caches = [...xml.matchAll(/<c:numCache>[\s\S]*?<\/c:numCache>/g)].map((match) =>
        [...match[0].matchAll(/<c:v>([^<]*)<\/c:v>/g)].map((value) => Number(value[1])),
      );
      const revenueCache = caches.find((values) => values.includes(1675.83));
      assert.deepEqual(revenueCache, REVENUE, "revenue series cache keeps every read value");
      const grossCache = caches.find((values) => values.includes(530.5));
      assert.deepEqual(grossCache, GROSS, "gross series cache keeps every read value");
      // The exporter writes string categories as a multiLvlStrRef cache.
      const stringCache = [...xml.matchAll(/<c:multiLvlStrCache>[\s\S]*?<\/c:multiLvlStrCache>/g)]
        .map((match) => [...match[0].matchAll(/<c:v>([^<]*)<\/c:v>/g)].map((value) => value[1]))
        .find((values) => values.includes("第一季度"));
      assert.deepEqual(stringCache, CHART_CATS, "category cache keeps the read categories in order");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
