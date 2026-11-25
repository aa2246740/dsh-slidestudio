/**
 * Waterfall and scatter chart export. Both kinds need native overlays (connector lines,
 * quadrant tints, label plates) on top of a pptxgenjs chart, so they stay out of the
 * categorical path in export-pptd.ts. The editor paints the same model and shared layout
 * (`waterfallChartModel`, `scatterChartModel`, `chartLayout`).
 */
import type PptxGenJS from "pptxgenjs";
import {
  CHART_FONT_FACE,
  CHART_TEXT_PX,
  chartLayout,
  formatChartValue,
  placeScatterLabels,
  resolveChartLegend,
  scatterChartModel,
  waterfallChartModel,
  type ChartElement,
} from "@open-slidestudio/pptd-v2";
import { chartSwatch, hexNoHash } from "./chart-map.js";
import { pxToIn } from "./export-units.js";
import { cssPxToPt, HAIRLINE_PT, MARKER_RING_PT } from "./stroke-units.js";

type ChartSurfaceStyle = {
  ink: string;
  grid: string;
  background: string;
};

function relativeLuminance(color: string): number {
  const value = color.replace(/^#/, "");
  if (!/^[0-9A-F]{6}$/i.test(value)) return 1;
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(channels[0]!) + 0.7152 * linear(channels[1]!) + 0.0722 * linear(channels[2]!);
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** Composite an exported semi-transparent shape over its actual surface. */
function compositeHex(foreground: string, background: string, transparency: number): string {
  const alpha = Math.max(0, Math.min(1, 1 - transparency / 100));
  const fg = foreground.replace(/^#/, "");
  const bg = background.replace(/^#/, "");
  const component = (offset: number) => {
    const value =
      Number.parseInt(fg.slice(offset, offset + 2), 16) * alpha +
      Number.parseInt(bg.slice(offset, offset + 2), 16) * (1 - alpha);
    return Math.round(value).toString(16).padStart(2, "0");
  };
  return `#${component(0)}${component(2)}${component(4)}`.toUpperCase();
}

type ScatterLabelStyle = { foreground: string; backplate: string; transparency: number };

/**
 * Labels sit above semi-transparent quadrant fills, so the page color alone
 * is not enough for legibility. Pick a direct readable ink when possible and
 * place it on a high-contrast plate to keep that result stable in PowerPoint.
 */
function readableScatterLabelStyle(underlay: string): ScatterLabelStyle {
  const dark = "0F172A";
  const light = "F8FAFC";
  const darkOnUnderlay = contrastRatio(`#${dark}`, underlay);
  const lightOnUnderlay = contrastRatio(`#${light}`, underlay);
  const foreground = darkOnUnderlay >= lightOnUnderlay ? dark : light;
  const backplate = foreground === dark ? light : dark;
  const transparency = 12;
  const effectiveBackplate = compositeHex(`#${backplate}`, underlay, transparency);
  return contrastRatio(`#${foreground}`, effectiveBackplate) >= 4.5
    ? { foreground, backplate, transparency }
    : { foreground, backplate, transparency: 0 };
}

export function mapWaterfallChart(
  slide: PptxGenJS.Slide,
  el: ChartElement,
  size: [number, number],
  layout: { w: number; h: number },
  surface: ChartSurfaceStyle,
  tickPt: number,
  catPt: number,
  labelPt: number,
  axisTitlePt: number,
): void {
  const [x, y, w, h] = el.bounds;
  const model = waterfallChartModel(el);
  const labels = model.bars.map((bar) => bar.label);
  const data: PptxGenJS.OptsChartData[] = [
    {
      name: "基线",
      labels,
      values: model.bars.map((bar) => (bar.kind === "total" ? 0 : Math.min(bar.start, bar.end))),
    },
    {
      name: "增加",
      labels,
      values: model.bars.map((bar) => (bar.kind === "increase" ? Math.abs(bar.value) : 0)),
    },
    {
      name: "减少",
      labels,
      values: model.bars.map((bar) => (bar.kind === "decrease" ? Math.abs(bar.value) : 0)),
    },
    {
      name: "合计",
      labels,
      values: model.bars.map((bar) =>
        bar.kind === "total" ? Math.abs(bar.end) : bar.kind === "subtotal" ? Math.abs(bar.value) : 0,
      ),
    },
  ];
  const valueRange = Math.max(1e-9, model.valueMax - model.valueMin);
  const wfLayout = waterfallLayoutFor(el, model, w, h);
  slide.addChart("bar", data, {
    x: pxToIn(x, size[0], layout.w),
    y: pxToIn(y, size[1], layout.h),
    w: pxToIn(w, size[0], layout.w),
    h: pxToIn(h, size[1], layout.h),
    layout: {
      x: wfLayout.plot.x / w,
      y: wfLayout.plot.y / h,
      w: wfLayout.plot.w / w,
      h: wfLayout.plot.h / h,
    },
    barDir: "col",
    barGrouping: "stacked",
    barOverlapPct: 100,
    showLegend: false,
    showValue: false,
    dataLabelColor: surface.ink,
    dataLabelFontFace: CHART_FONT_FACE,
    dataLabelFontSize: labelPt,
    showTitle: false,
    showCatAxisTitle: Boolean(el.axis?.x),
    catAxisTitle: el.axis?.x,
    catAxisTitleColor: surface.ink,
    catAxisTitleFontFace: CHART_FONT_FACE,
    catAxisTitleFontSize: axisTitlePt,
    catAxisLabelColor: surface.ink,
    catAxisLabelFontFace: CHART_FONT_FACE,
    catAxisLabelFontSize: catPt,
    catAxisLineColor: surface.grid,
    catAxisLineSize: HAIRLINE_PT,
    catGridLine: { style: "none" },
    showValAxisTitle: Boolean(el.axis?.y),
    valAxisTitle: el.axis?.y,
    valAxisTitleColor: surface.ink,
    valAxisTitleFontFace: CHART_FONT_FACE,
    valAxisTitleFontSize: axisTitlePt,
    valAxisLabelColor: surface.ink,
    valAxisLabelFontFace: CHART_FONT_FACE,
    valAxisLabelFontSize: tickPt,
    valAxisLineColor: surface.grid,
    valAxisLineSize: HAIRLINE_PT,
    valAxisLabelFormatCode: "#,##0" + (model.scale.tickDecimals > 0 ? `.${"0".repeat(model.scale.tickDecimals)}` : ""),
    valAxisMinVal: model.valueMin,
    valAxisMaxVal: model.valueMax,
    valAxisMajorUnit: model.scale.step,
    chartColors: ["transparent", "10B981", "EF4444", "F59E0B"],
    valGridLine: { color: surface.grid, size: HAIRLINE_PT },
  });
  if (el.title && wfLayout.title) {
    const t = wfLayout.title;
    slide.addText(typeof el.title === "string" ? el.title : (el.title.text ?? ""), {
      x: pxToIn(x + t.x, size[0], layout.w),
      y: pxToIn(y + t.y, size[1], layout.h),
      w: pxToIn(t.w, size[0], layout.w),
      h: pxToIn(t.h, size[1], layout.h),
      fontFace: CHART_FONT_FACE,
      fontSize: Math.round(cssPxToPt(CHART_TEXT_PX.title) * 100) / 100,
      color: surface.ink,
      align: "left",
      valign: "middle",
      margin: 0,
      wrap: false,
    });
  }

  // Connector lines and labels stay editable while the embedded workbook
  // remains the source for bar geometry. The plot rect is the same one the
  // canvas painter computed through the shared layout.
  const plot = {
    x: x + wfLayout.plot.x,
    y: y + wfLayout.plot.y,
    w: wfLayout.plot.w,
    h: wfLayout.plot.h,
  };
  const group = plot.w / Math.max(1, model.bars.length);
  const yFor = (value: number) => plot.y + ((model.valueMax - value) / valueRange) * plot.h;
  model.bars.forEach((bar, index) => {
    const centerX = plot.x + group * (index + 0.5);
    const topValue = Math.max(bar.start, bar.end);
    slide.addText(
      formatChartValue(bar.value, undefined, {
        signed: bar.kind === "increase" || bar.kind === "decrease",
      }),
      {
        x: pxToIn(centerX - group * 0.42, size[0], layout.w),
        y: pxToIn(Math.max(plot.y, yFor(topValue) - 13), size[1], layout.h),
        w: pxToIn(group * 0.84, size[0], layout.w),
        h: pxToIn(12, size[1], layout.h),
        fontFace: CHART_FONT_FACE,
        fontSize: labelPt,
        color: surface.ink,
        align: "center",
        margin: 0,
        fit: "shrink",
      },
    );
    if (index >= model.bars.length - 1) return;
    const next = model.bars[index + 1]!;
    const connectorValue = next.kind === "total" ? bar.end : next.start;
    const connectorY = yFor(connectorValue);
    slide.addShape("line", {
      x: pxToIn(centerX + group * 0.32, size[0], layout.w),
      y: pxToIn(connectorY, size[1], layout.h),
      w: pxToIn(group * 0.36, size[0], layout.w),
      h: 0,
      line: { color: "9CA3AF", width: HAIRLINE_PT, dashType: "dash" },
    });
  });
}

export function mapScatterChart(
  slide: PptxGenJS.Slide,
  el: ChartElement,
  size: [number, number],
  layout: { w: number; h: number },
  surface: ChartSurfaceStyle,
  tickPt: number,
  catPt: number,
  axisTitlePt: number,
): void {
  const [x, y, w, h] = el.bounds;
  const model = scatterChartModel(el);
  const color = hexNoHash(chartSwatch(el, 0));
  const data: PptxGenJS.OptsChartData[] = [
    { name: model.xName, values: model.points.map((point) => point.x) },
    {
      name: el.series[0]?.name ?? model.yName,
      values: model.points.map((point) => point.y),
    },
  ];
  const scLayout = scatterLayoutFor(el, model, w, h);
  const plot = {
    x: x + scLayout.plot.x,
    y: y + scLayout.plot.y,
    w: scLayout.plot.w,
    h: scLayout.plot.h,
  };
  const thresholdX = plot.x + plot.w * 0.7;
  const thresholdY = plot.y + plot.h * 0.3;
  const quadrants = [
    {
      x: plot.x,
      y: plot.y,
      w: thresholdX - plot.x,
      h: thresholdY - plot.y,
      color: "FEF3C7",
      transparency: 55,
    },
    {
      x: thresholdX,
      y: plot.y,
      w: plot.x + plot.w - thresholdX,
      h: thresholdY - plot.y,
      color: "FEE2E2",
      transparency: 35,
    },
    {
      x: plot.x,
      y: thresholdY,
      w: thresholdX - plot.x,
      h: plot.y + plot.h - thresholdY,
      color: "ECFDF5",
      transparency: 35,
    },
    {
      x: thresholdX,
      y: thresholdY,
      w: plot.x + plot.w - thresholdX,
      h: plot.y + plot.h - thresholdY,
      color: "FEF3C7",
      transparency: 55,
    },
  ];
  for (const quadrant of quadrants) {
    slide.addShape("rect", {
      x: pxToIn(quadrant.x, size[0], layout.w),
      y: pxToIn(quadrant.y, size[1], layout.h),
      w: pxToIn(quadrant.w, size[0], layout.w),
      h: pxToIn(quadrant.h, size[1], layout.h),
      fill: { color: quadrant.color, transparency: quadrant.transparency },
      line: { color: quadrant.color, transparency: 100 },
    });
  }
  slide.addChart("scatter", data, {
    x: pxToIn(x, size[0], layout.w),
    y: pxToIn(y, size[1], layout.h),
    w: pxToIn(w, size[0], layout.w),
    h: pxToIn(h, size[1], layout.h),
    layout: {
      x: scLayout.plot.x / w,
      y: scLayout.plot.y / h,
      w: scLayout.plot.w / w,
      h: scLayout.plot.h / h,
    },
    showTitle: false,
    showLegend: resolveChartLegend(el.legend).show,
    legendColor: surface.ink,
    legendFontFace: CHART_FONT_FACE,
    legendFontSize: Math.round(cssPxToPt(CHART_TEXT_PX.legend) * 100) / 100,
    showLabel: false,
    showValue: false,
    dataLabelColor: surface.ink,
    chartColors: [color],
    lineSize: 0,
    lineDataSymbol: "circle",
    lineDataSymbolSize: 8,
    lineDataSymbolLineColor: color,
    lineDataSymbolLineSize: MARKER_RING_PT,
    catAxisMinVal: model.xMin,
    catAxisMaxVal: model.xMax,
    catAxisMajorUnit: model.xScale.step,
    valAxisMinVal: model.yMin,
    valAxisMaxVal: model.yMax,
    valAxisMajorUnit: model.yScale.step,
    showCatAxisTitle: true,
    catAxisTitle: el.axis?.x ?? model.xName,
    catAxisTitleColor: surface.ink,
    catAxisTitleFontFace: CHART_FONT_FACE,
    catAxisTitleFontSize: axisTitlePt,
    catAxisLabelColor: surface.ink,
    catAxisLabelFontFace: CHART_FONT_FACE,
    catAxisLabelFontSize: catPt,
    catAxisLineColor: surface.grid,
    catAxisLineSize: HAIRLINE_PT,
    showValAxisTitle: true,
    valAxisTitle: el.axis?.y ?? model.yName,
    valAxisTitleColor: surface.ink,
    valAxisTitleFontFace: CHART_FONT_FACE,
    valAxisTitleFontSize: axisTitlePt,
    valAxisLabelColor: surface.ink,
    valAxisLabelFontFace: CHART_FONT_FACE,
    valAxisLabelFontSize: tickPt,
    valAxisLineColor: surface.grid,
    valAxisLineSize: HAIRLINE_PT,
    valAxisLabelFormatCode:
      "#,##0" + (model.yScale.tickDecimals > 0 ? `.${"0".repeat(model.yScale.tickDecimals)}` : ""),
    catLabelFormatCode: "#,##0" + (model.xScale.tickDecimals > 0 ? `.${"0".repeat(model.xScale.tickDecimals)}` : ""),
    valGridLine: { color: surface.grid, size: HAIRLINE_PT },
    catGridLine: { color: surface.grid, size: HAIRLINE_PT },
    // No chart-area or plot-area frame: the editor paints neither (ruling 113). pptxgenjs
    // replaces a zero border with its 1 pt default, so an omitted border is the only way to
    // export no line.
    chartArea: {
      fill: { color: "FFFFFF", transparency: 100 },
    },
    plotArea: {
      fill: { color: "FFFFFF", transparency: 100 },
    },
  });
  if (el.title && scLayout.title) {
    const t = scLayout.title;
    slide.addText(typeof el.title === "string" ? el.title : (el.title.text ?? ""), {
      x: pxToIn(x + t.x, size[0], layout.w),
      y: pxToIn(y + t.y, size[1], layout.h),
      w: pxToIn(t.w, size[0], layout.w),
      h: pxToIn(t.h, size[1], layout.h),
      fontFace: CHART_FONT_FACE,
      fontSize: Math.round(cssPxToPt(CHART_TEXT_PX.title) * 100) / 100,
      color: surface.ink,
      align: "left",
      valign: "middle",
      margin: 0,
      wrap: false,
    });
  }
  const xRange = Math.max(1e-9, model.xMax - model.xMin);
  const yRange = Math.max(1e-9, model.yMax - model.yMin);
  const placements = placeScatterLabels(
    model.points.map((point) => ({
      label: point.label,
      x: plot.x + ((point.x - model.xMin) / xRange) * plot.w,
      y: plot.y + ((model.yMax - point.y) / yRange) * plot.h,
    })),
    { left: x + 2, top: y + 4, right: x + w - 2, bottom: y + h - 3 },
    9,
  );
  for (const placement of placements) {
    const quadrant = quadrants.find(
      (candidate) =>
        placement.pointX >= candidate.x &&
        placement.pointX <= candidate.x + candidate.w &&
        placement.pointY >= candidate.y &&
        placement.pointY <= candidate.y + candidate.h,
    );
    const underlay = quadrant
      ? compositeHex(`#${quadrant.color}`, surface.background, quadrant.transparency)
      : surface.background;
    const labelStyle = readableScatterLabelStyle(underlay);
    const plateLeft = placement.box.left - 3;
    const plateTop = placement.box.top - 1;
    const plateWidth = placement.box.right - placement.box.left + 6;
    const plateHeight = placement.box.bottom - placement.box.top + 5;
    slide.addShape("roundRect", {
      x: pxToIn(plateLeft, size[0], layout.w),
      y: pxToIn(plateTop, size[1], layout.h),
      w: pxToIn(plateWidth, size[0], layout.w),
      h: pxToIn(plateHeight, size[1], layout.h),
      fill: { color: labelStyle.backplate, transparency: labelStyle.transparency },
      line: { color: labelStyle.backplate, transparency: 100 },
    });
    slide.addText(placement.label, {
      x: pxToIn(placement.box.left, size[0], layout.w),
      y: pxToIn(placement.box.top, size[1], layout.h),
      w: pxToIn(placement.box.right - placement.box.left, size[0], layout.w),
      h: pxToIn(placement.box.bottom - placement.box.top + 3, size[1], layout.h),
      fontFace: CHART_FONT_FACE,
      fontSize: Math.round(cssPxToPt(CHART_TEXT_PX.scatterLabel) * 100) / 100,
      bold: true,
      color: labelStyle.foreground,
      margin: 0,
      wrap: false,
      fit: "none",
      valign: "middle",
    });
  }
}

/** Shared element-relative layout for scatter and its label overlays. */
function scatterLayoutFor(
  el: ChartElement,
  model: ReturnType<typeof scatterChartModel>,
  w: number,
  h: number,
): ReturnType<typeof chartLayout> {
  const tickLabels = model.yScale.ticks.map((t) => formatChartValue(t, model.yScale.tickDecimals));
  const widestTickLabel = tickLabels.reduce((best, label) => (label.length > best.length ? label : best), "0");
  return chartLayout(
    { w, h },
    {
      title: typeof el.title === "string" ? el.title : (el.title?.text ?? ""),
      legend: resolveChartLegend(el.legend),
      legendItems: [el.series[0]?.name ?? model.yName],
      widestTickLabel,
      widestCategoryLabel: "",
      categoryCount: 1,
      axis: { x: el.axis?.x ?? model.xName, y: el.axis?.y ?? model.yName },
    },
  );
}

/** Shared element-relative layout for waterfall and the overlay labels. */
function waterfallLayoutFor(
  el: ChartElement,
  model: ReturnType<typeof waterfallChartModel>,
  w: number,
  h: number,
): ReturnType<typeof chartLayout> {
  const tickLabels = model.scale.ticks.map((t) => formatChartValue(t, model.scale.tickDecimals));
  const widestTickLabel = tickLabels.reduce((best, label) => (label.length > best.length ? label : best), "0");
  const widestCategoryLabel = model.bars
    .map((bar) => bar.label)
    .reduce((best, label) => (String(label).length > best.length ? String(label) : best), "");
  return chartLayout(
    { w, h },
    {
      title: typeof el.title === "string" ? el.title : (el.title?.text ?? ""),
      legend: resolveChartLegend(el.legend),
      legendItems: [],
      widestTickLabel,
      widestCategoryLabel,
      categoryCount: Math.max(1, model.bars.length),
      axis: el.axis,
    },
  );
}
/** px-in-slide fraction → pptxgenjs manualLayout fraction of the chart area. */
export function fractionOfChart(px: number, span: number): number {
  return Math.max(0, Math.min(1, px / Math.max(1, span)));
}
