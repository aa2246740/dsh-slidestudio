import {
  axisTitlesSvg,
  chartLayoutFor,
  chartRuntime,
  chartSemanticInput,
  chartSvgShell,
  legendSvg,
} from "./chart-paint-layout.js";
import { areaFillAttributes } from "./chart-paint-gradient.js";
import { paintDoughnutSvg } from "./chart-paint-doughnut.js";
import { paintRadarSvg } from "./chart-paint-radar.js";
import { paintStackedBarsSvg, stackedSegmentsSvg } from "./chart-paint-stacked.js";
import { escapeHtmlText } from "./rich-text-editor.js";

/** @typedef {import("@open-slidestudio/canvas-session").RenderElement} RenderElement */
/** @typedef {import("@open-slidestudio/pptd-v2").CategoricalChartModel} CategoricalChartModel */
/** @typedef {ReturnType<typeof chartLayoutFor>["layout"]} ChartLayout */
/**
 *  Everything a categorical special painter needs. `legend` and `axisTitles` are markup the caller built for the shared chrome; `swatch` returns the escaped paint for an index.
 * @typedef {{w: number, h: number, layout: ChartLayout, titleSvg: string, legend: string, axisTitles: string, categorical: CategoricalChartModel, swatch: (index: number) => string, ink: string, gridColor: string, showLabels: boolean, focusRow: number, catBandY: number, valueText: (value: number) => string}} SpecialChartInput
 */
/** @param {number} value @param {boolean} [signed] */
function chartNumber(value, signed = false) {
  const { formatChartValue } = chartRuntime();
  return formatChartValue(value, undefined, { signed });
}

/** Value-axis grid + tick labels for a shared scale inside `plot`. */

/** @param {RenderElement} el @param {number} w @param {number} h @param {string} titleSvg @param {string} axisSvg @param {string} ink @param {string} gridColor */
export function paintWaterfallSvg(el, w, h, titleSvg, axisSvg, ink, gridColor) {
  const { waterfallChartModel, CHART_TEXT_PX, formatChartValue } = chartRuntime();
  const model = waterfallChartModel(chartSemanticInput(el));
  const { layout } = chartLayoutFor(el, null, {
    scale: model.scale,
    categories: model.bars.map((bar) => bar.label),
  });
  const plot = layout.plot;
  const valueMin = model.scale.min;
  const range = Math.max(1e-9, model.scale.max - valueMin);
  /** @param {number} value */
  const yFor = (value) => plot.y + ((model.scale.max - value) / range) * plot.h;
  const group = plot.w / Math.max(1, model.bars.length);
  const barW = Math.max(8, Math.min(46, group * 0.58));
  const grid = model.scale.ticks
    .map((tick) => {
      const y = yFor(tick);
      return `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.w}" y2="${y}" stroke="${gridColor}" stroke-width="1"/><text x="${plot.x - 6}" y="${y + 3}" text-anchor="end" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(formatChartValue(tick, model.scale.tickDecimals))}</text>`;
    })
    .join("");
  const bars = model.bars
    .map((bar, index) => {
      const centerX = plot.x + group * (index + 0.5);
      const x = centerX - barW / 2;
      const yTop = Math.max(plot.y, yFor(Math.max(bar.start, bar.end)));
      const yBottom = Math.min(plot.y + plot.h, yFor(Math.min(bar.start, bar.end)));
      const height = Math.max(2, yBottom - yTop);
      const color =
        bar.kind === "increase"
          ? "#10B981"
          : bar.kind === "decrease"
            ? "#EF4444"
            : bar.kind === "subtotal"
              ? "#F59E0B"
              : "#2563EB";
      const value = chartNumber(bar.value, bar.kind === "increase" || bar.kind === "decrease");
      const labelY = Math.max(plot.y + 11, yTop - 4);
      const categoryY = layout.categoryBand ? layout.categoryBand.y + CHART_TEXT_PX.category : plot.y + plot.h + 14;
      const next = model.bars[index + 1];
      const connector = next
        ? `<line x1="${x + barW}" y1="${yFor(next.kind === "total" ? bar.end : next.start)}" x2="${plot.x + group * (index + 1.5) - barW / 2}" y2="${yFor(next.kind === "total" ? bar.end : next.start)}" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="3 3"/>`
        : "";
      return `${connector}<rect x="${x}" y="${yTop}" width="${barW}" height="${height}" rx="1" fill="${color}"/><text x="${centerX}" y="${labelY}" text-anchor="middle" font-size="${CHART_TEXT_PX.dataLabel}" fill="${ink}">${escapeHtmlText(value)}</text><text x="${centerX}" y="${categoryY}" text-anchor="middle" font-size="${CHART_TEXT_PX.category}" fill="${ink}">${escapeHtmlText(bar.label)}</text>`;
    })
    .join("");
  return chartSvgShell(w, h, `${titleSvg}${grid}${bars}${axisSvg}`);
}

/** @param {RenderElement} el @param {number} w @param {number} h @param {string} titleSvg @param {string} ink @param {string} gridColor */
export function paintScatterSvg(el, w, h, titleSvg, ink, gridColor) {
  const { scatterChartModel, placeScatterLabels, CHART_TEXT_PX, formatChartValue } = chartRuntime();
  const model = scatterChartModel(chartSemanticInput(el));
  const { layout } = chartLayoutFor(el, null, {
    scale: model.yScale,
    categories: [],
  });
  const plot = layout.plot;
  const xRange = Math.max(1e-9, model.xMax - model.xMin);
  const yRange = Math.max(1e-9, model.yMax - model.yMin);
  /** @param {number} value */
  const xFor = (value) => plot.x + ((value - model.xMin) / xRange) * plot.w;
  /** @param {number} value */
  const yFor = (value) => plot.y + ((model.yMax - value) / yRange) * plot.h;
  const xThreshold = model.xMin + xRange * 0.7;
  const yThreshold = model.yMin + yRange * 0.7;
  const thresholdX = xFor(xThreshold);
  const thresholdY = yFor(yThreshold);
  const quadrants = `<rect x="${plot.x}" y="${plot.y}" width="${thresholdX - plot.x}" height="${thresholdY - plot.y}" fill="#FEF3C7" opacity="0.45"/><rect x="${thresholdX}" y="${plot.y}" width="${plot.x + plot.w - thresholdX}" height="${thresholdY - plot.y}" fill="#FEE2E2" opacity="0.7"/><rect x="${plot.x}" y="${thresholdY}" width="${thresholdX - plot.x}" height="${plot.y + plot.h - thresholdY}" fill="#ECFDF5" opacity="0.7"/><rect x="${thresholdX}" y="${thresholdY}" width="${plot.x + plot.w - thresholdX}" height="${plot.y + plot.h - thresholdY}" fill="#FEF3C7" opacity="0.45"/>`;
  const grid =
    model.xScale.ticks
      .map((tick) => {
        const x = xFor(tick);
        return `<line x1="${x}" y1="${plot.y}" x2="${x}" y2="${plot.y + plot.h}" stroke="${gridColor}" stroke-width="1"/><text x="${x}" y="${plot.y + plot.h + 13}" text-anchor="middle" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(formatChartValue(tick, model.xScale.tickDecimals))}</text>`;
      })
      .join("") +
    model.yScale.ticks
      .map((tick) => {
        const y = yFor(tick);
        return `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.w}" y2="${y}" stroke="${gridColor}" stroke-width="1"/><text x="${plot.x - 7}" y="${y + 3}" text-anchor="end" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(formatChartValue(tick, model.yScale.tickDecimals))}</text>`;
      })
      .join("");
  const placements = placeScatterLabels(
    model.points.map((point) => ({
      label: point.label,
      x: xFor(point.x),
      y: yFor(point.y),
    })),
    { left: 2, top: 4, right: w - 2, bottom: h - 3 },
    9,
  );
  const points = placements
    .map(
      ({ label, pointX, pointY, textX, baseline, anchor }) =>
        `<circle cx="${pointX}" cy="${pointY}" r="6" fill="#DC2626" stroke="#FFFFFF" stroke-width="2"/><text x="${textX}" y="${baseline}" text-anchor="${anchor}" font-size="${CHART_TEXT_PX.scatterLabel}" font-weight="600" fill="#0B1F3A" style="paint-order:stroke;stroke:#FFFFFF;stroke-width:3px;stroke-linejoin:round;">${escapeHtmlText(label)}</text>`,
    )
    .join("");
  const axes = `<text x="${plot.x + plot.w / 2}" y="${h - 3}" text-anchor="middle" font-size="${CHART_TEXT_PX.axisTitle}" fill="${ink}">${escapeHtmlText(el.chartAxis?.x || model.xName)}</text><text transform="translate(10 ${plot.y + plot.h / 2}) rotate(-90)" text-anchor="middle" font-size="${CHART_TEXT_PX.axisTitle}" fill="${ink}">${escapeHtmlText(el.chartAxis?.y || model.yName)}</text>`;
  return chartSvgShell(w, h, `${titleSvg}${quadrants}${grid}${points}${axes}`);
}

/** @param {RenderElement} el @param {number} w @param {number} h @param {string} titleSvg @param {CategoricalChartModel} categorical @param {(index: number) => string} swatch @param {string} ink @param {string} gridColor @param {boolean} showLabels */
export function paintComboChartSvg(el, w, h, titleSvg, categorical, swatch, ink, gridColor, showLabels) {
  const { CHART_TEXT_PX, formatChartValue, alignedSecondaryScale, percentText } = chartRuntime();
  const secondarySeries = categorical.series.filter((series) => series.axis === "secondary");
  const primaryScale = categorical.scale;
  const secondaryScale = secondarySeries.length
    ? alignedSecondaryScale(
        secondarySeries.flatMap((series) => series.values),
        primaryScale,
      )
    : undefined;
  const { layout } = chartLayoutFor(el, categorical, {
    secondaryScale,
  });
  const plot = layout.plot;
  /** @param {number} value @param {"primary" | "secondary"} axis */
  const yFor = (value, axis) => {
    const scale = axis === "secondary" ? secondaryScale : primaryScale;
    if (!scale) return plot.y + plot.h;
    const range = Math.max(1e-9, scale.max - scale.min);
    return plot.y + plot.h - ((value - scale.min) / range) * plot.h;
  };
  const zeroY = yFor(0, "primary");
  // Percent-stacked bars are shares of the primary axis, so its ticks read as percentages.
  /** @param {number} tick */
  const primaryTickText = (tick) =>
    categorical.grouping === "percentStacked" ? percentText(tick) : formatChartValue(tick, primaryScale.tickDecimals);
  const grid = primaryScale.ticks
    .map((tick) => {
      const y = yFor(tick, "primary");
      const left = primaryTickText(tick);
      const right = secondaryScale
        ? formatChartValue(
            secondaryScale.min +
              ((tick - primaryScale.min) / Math.max(1e-9, primaryScale.max - primaryScale.min)) *
                (secondaryScale.max - secondaryScale.min),
            secondaryScale.tickDecimals,
          )
        : "";
      return `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.w}" y2="${y}" stroke="${gridColor}" stroke-width="1"/><text x="${plot.x - 6}" y="${y + 3}" text-anchor="end" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(left)}</text>${secondaryScale ? `<text x="${plot.x + plot.w + 6}" y="${y + 3}" text-anchor="start" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(right)}</text>` : ""}`;
    })
    .join("");
  const categories = categorical.categories;
  const xStep = categories.length ? plot.w / categories.length : plot.w;
  const barSeries = categorical.series.filter((series) => series.kind === "bar");
  // Stacked grouping stacks the primary-axis bars into one column per category, as the exported chart does. Bars on the secondary axis keep their side-by-side placement.
  const stacked = categorical.grouping !== "clustered";
  const stackedGrouping = categorical.grouping === "percentStacked" ? "percentStacked" : "stacked";
  const stackedSeries = stacked ? barSeries.filter((series) => series.axis !== "secondary") : [];
  const stackedColors = stackedSeries.map((series) => swatch(categorical.series.indexOf(series)));
  const sideBySide = barSeries.filter((series) => !stackedSeries.includes(series));
  const barWidth = Math.max(4, Math.min(34, (xStep * 0.62) / Math.max(1, barSeries.length)));
  // A stacked column takes the footprint of the clustered group it replaces, so the width holds.
  const stackedBars = stacked
    ? stackedSegmentsSvg({
        horizontal: false,
        grouping: stackedGrouping,
        count: categories.length,
        bars: stackedSeries,
        along: (value) => yFor(value, "primary"),
        slot: (category) => ({ start: plot.x + xStep * category, size: xStep }),
        thickness: barWidth * barSeries.length,
        showLabels,
        dataLabelPx: CHART_TEXT_PX.dataLabel,
        ink,
        valueText: (value) => formatChartValue(value),
        paint: (index) => stackedColors[index] ?? "",
      })
    : "";
  const bars = sideBySide
    .map((series, seriesIndex) =>
      series.values
        .map((value, rowIndex) => {
          const groupWidth = barWidth * sideBySide.length;
          const x = plot.x + xStep * (rowIndex + 0.5) - groupWidth / 2 + seriesIndex * barWidth;
          const axisScale = series.axis === "secondary" ? secondaryScale : primaryScale;
          const baseY = axisScale ? yFor(Math.max(axisScale.min, 0), series.axis) : zeroY;
          const y = yFor(value, series.axis);
          const top = Math.min(y, baseY);
          const height = Math.max(1, Math.abs(baseY - y));
          const color = swatch(categorical.series.indexOf(series));
          const label =
            showLabels && value !== 0
              ? `<text x="${x + barWidth / 2}" y="${value >= 0 ? Math.max(plot.y + 11, top - 4) : top + height + 11}" text-anchor="middle" font-size="${CHART_TEXT_PX.dataLabel}" fill="${ink}">${escapeHtmlText(formatChartValue(value))}</text>`
              : "";
          return `<rect x="${x}" y="${top}" width="${Math.max(1, barWidth - 2)}" height="${height}" fill="${color}"/>${label}`;
        })
        .join(""),
    )
    .join("");
  const lines = categorical.series
    .filter((series) => series.kind === "line" || series.kind === "area")
    .map((series) => {
      const color = swatch(categorical.series.indexOf(series));
      const points = series.values.map((value, index) => ({
        x: plot.x + xStep * (index + 0.5),
        y: yFor(value, series.axis),
        value,
      }));
      const pointList = points.map((point) => `${point.x},${point.y}`).join(" ");
      const first = points[0];
      const last = points.at(-1);
      const area =
        series.kind === "area" && first && last
          ? `<polygon points="${pointList} ${last.x},${zeroY} ${first.x},${zeroY}" ${areaFillAttributes(color, "33")}/>`
          : "";
      const labels = showLabels
        ? points
            .map(
              (point) =>
                `<text x="${point.x}" y="${Math.max(plot.y + 11, point.y - 7)}" text-anchor="middle" font-size="${CHART_TEXT_PX.dataLabel}" fill="${ink}">${escapeHtmlText(formatChartValue(point.value))}</text>`,
            )
            .join("")
        : "";
      const dots = points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="3" fill="${color}"/>`).join("");
      return `${area}<polyline points="${pointList}" fill="none" stroke="${color}" stroke-width="3"/>${dots}${labels}`;
    })
    .join("");
  const categoryLabels = categories
    .map((category, index) => {
      const y = layout.categoryBand ? layout.categoryBand.y + CHART_TEXT_PX.category : plot.y + plot.h + 14;
      return `<text x="${plot.x + xStep * (index + 0.5)}" y="${y}" text-anchor="middle" font-size="${CHART_TEXT_PX.category}" fill="${ink}">${escapeHtmlText(category)}</text>`;
    })
    .join("");
  const legend = legendSvg(layout, swatch, ink);
  const axisTitles = axisTitlesSvg(layout, el.chartAxis || {}, ink, true);
  return chartSvgShell(w, h, `${titleSvg}${grid}${stackedBars}${bars}${lines}${categoryLabels}${legend}${axisTitles}`);
}

/** @param {SpecialChartInput} input */
export function paintRadarChartSvg(input) {
  const { CHART_TEXT_PX, formatChartValue } = chartRuntime();
  const { categorical, layout } = input;
  const body = paintRadarSvg({
    plot: layout.plot,
    categories: categorical.categories,
    series: categorical.series.map((series, index) => ({
      name: series.name,
      values: series.values,
      paint: input.swatch(index),
    })),
    scale: categorical.scale,
    ink: input.ink,
    gridColor: input.gridColor,
    showLabels: input.showLabels,
    fonts: CHART_TEXT_PX,
    formatTick: (tick) => formatChartValue(tick, categorical.scale.tickDecimals),
    valueText: input.valueText,
  });
  return chartSvgShell(input.w, input.h, input.titleSvg + body + input.legend);
}

/** @param {SpecialChartInput} input */
export function paintDoughnutChartSvg(input) {
  const { CHART_TEXT_PX } = chartRuntime();
  const { categorical, layout } = input;
  const body = paintDoughnutSvg({
    plot: layout.plot,
    categories: categorical.categories,
    values: categorical.series[0]?.values ?? [],
    paints: categorical.categories.map((_, index) => input.swatch(index)),
    ink: input.ink,
    showLabels: input.showLabels,
    fonts: CHART_TEXT_PX,
  });
  return chartSvgShell(input.w, input.h, input.titleSvg + body + input.legend);
}

/**
 *  The plot a horizontal bar chart draws into, to the right of its category names. The same arithmetic as the clustered horizontal branch, so stacked and clustered bars line up.
 * @param {{x: number, y: number, w: number, h: number}} plot @param {string[]} categories
 */
function horizontalBarPlot(plot, categories) {
  const { CHART_TEXT_PX, measureChartText } = chartRuntime();
  const labelWidth = categories.reduce(
    (best, label) => Math.max(best, measureChartText(String(label), CHART_TEXT_PX.category)),
    0,
  );
  const x = plot.x + labelWidth + 8;
  return { x, y: plot.y, w: Math.max(1, plot.x + plot.w - x), h: plot.h };
}

/** @param {SpecialChartInput} input */
export function paintStackedChartSvg(input) {
  const { CHART_TEXT_PX, formatChartValue, percentText } = chartRuntime();
  const { categorical, layout } = input;
  const percent = categorical.grouping === "percentStacked";
  const scale = categorical.scale;
  const single = categorical.series.length === 1;
  const body = paintStackedBarsSvg({
    plot:
      categorical.orientation === "horizontal" ? horizontalBarPlot(layout.plot, categorical.categories) : layout.plot,
    orientation: categorical.orientation,
    grouping: percent ? "percentStacked" : "stacked",
    categories: categorical.categories,
    series: categorical.series.map((series) => ({
      name: series.name,
      values: series.values,
      kind: series.kind,
    })),
    scale,
    focusRow: input.focusRow,
    showLabels: input.showLabels,
    ink: input.ink,
    gridColor: input.gridColor,
    fonts: CHART_TEXT_PX,
    formatTick: percent ? percentText : (tick) => formatChartValue(tick, scale.tickDecimals),
    valueText: input.valueText,
    categoryY: input.catBandY,
    // A one-series bar chart colours each category, as the clustered painter does.
    paint: (seriesIndex, categoryIndex) => (single ? input.swatch(categoryIndex) : input.swatch(seriesIndex)),
  });
  return chartSvgShell(input.w, input.h, input.titleSvg + body + input.legend + input.axisTitles);
}
