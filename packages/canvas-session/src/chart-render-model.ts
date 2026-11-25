import {
  chartGrouping,
  chartKind,
  type ChartElement,
  type ChartGrouping,
  type PptdProject,
} from "@open-slidestudio/pptd-v2";
import { fillCss } from "./fill-css.js";

/** Chart fields the editor paints from, added to a render element of `elementType` chart. */
export type ChartRenderFields = {
  chart: true;
  chartTitle: string | undefined;
  /** Kind of the first series, such as `bar`, `radar` or `doughnut`. */
  chartType: string;
  chartData: ChartElement["data"];
  chartSeries: ChartElement["series"];
  chartLegend: ChartElement["legend"];
  chartBackgroundCss?: string;
  chartLabels: boolean;
  chartAxis: ChartElement["axis"];
  chartColors: string[];
  /** Bar grouping; `clustered` for every chart that is not a bar chart. */
  chartGrouping: ChartGrouping;
};

export function chartRenderFields(chart: ChartElement, theme: PptdProject["presentation"]["theme"]): ChartRenderFields {
  return {
    chart: true,
    chartTitle: typeof chart.title === "string" ? chart.title : chart.title?.text,
    chartType: chart.series[0]?.type ?? "bar",
    chartData: chart.data,
    chartSeries: chart.series,
    chartLegend: chart.legend,
    chartBackgroundCss: fillCss(chart.background, theme),
    chartLabels: chart.labels !== false,
    chartAxis: chart.axis,
    chartColors: chart.colors?.length
      ? [...chart.colors]
      : chart.series.map((series) =>
          typeof series.fill === "string"
            ? series.fill
            : series.fill && "color" in series.fill
              ? String(series.fill.color)
              : "",
        ),
    chartGrouping: chartKind(chart) === "bar" ? chartGrouping(chart) : "clustered",
  };
}
