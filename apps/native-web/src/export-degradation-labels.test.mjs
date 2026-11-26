import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPORT_DEGRADATION_GROUPS,
  EXPORT_DEGRADATION_LINES,
  exportDegradationHtml,
  exportDegradationLines,
} from "../public/export-degradation-labels.js";
import { EXPORT_I18N } from "../public/export-i18n.js";

test("image fallback and shadow degradations get their own lines in stable order", () => {
  assert.deepEqual(exportDegradationLines([{ kind: "missing-image" }, { kind: "shadow-not-exported" }]), [
    "1 处以图片保底",
    "1 处文本框阴影未导出，文字仍可编辑",
  ]);
});

test("all image fallback kinds share one counted line", () => {
  assert.deepEqual(
    exportDegradationLines([
      { kind: "missing-image" },
      { kind: "full-page-raster" },
      { kind: "background-only" },
      { kind: "unsupported-element" },
    ]),
    ["4 处以图片保底"],
  );
});

test("chart degradations use their own lines and follow the stable order", () => {
  assert.deepEqual(
    exportDegradationLines([
      { kind: "chart-export-failed" },
      { kind: "chart-type-fallback" },
      { kind: "chart-type-fallback" },
      { kind: "missing-image" },
    ]),
    ["1 处以图片保底", "2 处图表以近似方式导出", "1 处图表未能导出"],
  );
});

test("percent-stacked label degradations get their own line, not the approximate-chart line", () => {
  assert.deepEqual(
    exportDegradationLines([
      { kind: "chart-type-fallback" },
      { kind: "chart-percent-labels-as-values" },
      { kind: "chart-percent-labels-as-values" },
    ]),
    ["1 处图表以近似方式导出", "2 处百分比堆叠图标签导出为原始数值"],
  );
  assert.deepEqual(exportDegradationLines([{ kind: "chart-percent-labels-as-values" }]), [
    "1 处百分比堆叠图标签导出为原始数值",
  ]);
});

test("colour fallbacks get their own counted line before the generic line", () => {
  assert.deepEqual(
    exportDegradationLines([
      { kind: "something-new" },
      { kind: "color-fallback" },
      { kind: "color-fallback" },
      { kind: "shadow-not-exported" },
    ]),
    ["1 处文本框阴影未导出，文字仍可编辑", "2 处颜色无法解析，已改用默认色", "1 处效果未完整导出"],
  );
  assert.deepEqual(exportDegradationLines([{ kind: "color-fallback" }]), ["1 处颜色无法解析，已改用默认色"]);
});

test("a fixed page total gets its own line that says to re-export after page changes", () => {
  assert.deepEqual(exportDegradationLines([{ kind: "something-new" }, { kind: "static-page-count" }]), [
    "1 处总页数已导出为固定文字，在 PowerPoint 中增减页面后需重新导出",
    "1 处效果未完整导出",
  ]);
  assert.deepEqual(exportDegradationLines([{ kind: "static-page-count" }, { kind: "static-page-count" }]), [
    "2 处总页数已导出为固定文字，在 PowerPoint 中增减页面后需重新导出",
  ]);
});

test("an unknown kind falls back to one generic line placed last", () => {
  assert.deepEqual(exportDegradationLines([{ kind: "shadow-not-exported" }, { kind: "something-new" }]), [
    "1 处文本框阴影未导出，文字仍可编辑",
    "1 处效果未完整导出",
  ]);
  assert.deepEqual(exportDegradationLines([{ kind: "something-new" }]), ["1 处效果未完整导出"]);
});

test("no degradations yields no lines and non-array input is ignored", () => {
  assert.deepEqual(exportDegradationLines([]), []);
  assert.deepEqual(exportDegradationLines(undefined), []);
  assert.deepEqual(exportDegradationLines(null), []);
});

test("a count-only export report keeps the image fallback wording", () => {
  assert.deepEqual(exportDegradationLines(2), ["2 处以图片保底"]);
  assert.deepEqual(exportDegradationLines(0), []);
});

test("html output renders one escaped small element per line", () => {
  assert.equal(
    exportDegradationHtml([{ kind: "missing-image" }, { kind: "shadow-not-exported" }]),
    '<small class="export-deg">1 处以图片保底</small>' +
      '<small class="export-deg">1 处文本框阴影未导出，文字仍可编辑</small>',
  );
  assert.equal(exportDegradationHtml([]), "");
});

test("html output tolerates malformed items and a non-finite count", () => {
  assert.equal(exportDegradationHtml(Number.NaN), "");
  assert.equal(
    exportDegradationHtml(/** @type {{ kind?: string }[]} */ (/** @type {unknown} */ ([null, { kind: 7 }]))),
    '<small class="export-deg">2 处效果未完整导出</small>',
  );
});

test("every exporter kind group has exactly one line and an English translation", () => {
  const groups = EXPORT_DEGRADATION_LINES.map(([group]) => group);
  assert.deepEqual(groups.slice(0, -1), Object.keys(EXPORT_DEGRADATION_GROUPS));
  assert.equal(groups.at(-1), "other");
  for (const [, key] of EXPORT_DEGRADATION_LINES) {
    const english = /** @type {Record<string, string>} */ (EXPORT_I18N)[key];
    assert.ok(english, `missing English for ${key}`);
    assert.match(english, /\{count\}/);
  }
});
