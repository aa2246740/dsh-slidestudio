/**
 * Cached chart data reader. It deliberately reads only cached OOXML values;
 * workbook relationships are metadata and are never opened or fetched.
 */
import { attrOf, childElements, descendantsOf, firstOf, localNameOf, textOf } from "./ooxml.mjs";
import { gradientsOf, resolveColor } from "./pptx-colors.mjs";
import { MaterialRejection } from "../zip-guard.mjs";

/** @typedef {import("./ooxml.mjs").DomNode} Node */
/** @typedef {{colors:Record<string,string|null>}} Theme */

/** @type {Record<string,string>} */
const TYPE_BY_ELEMENT = {
  barChart: "bar",
  lineChart: "line",
  pieChart: "pie",
  areaChart: "area",
  radarChart: "radar",
  doughnutChart: "doughnut",
  scatterChart: "scatter",
};
const MAX_CACHE_POINTS = 100_000;

/**
 * Read chart parts into a safe, serializable description. A Word/Excel chart
 * carries no slide: `slide` is then null and `box` is null too (CAP-33).
 * @param {Node} root
 * @param {{chartId:string,slide:number|null,box:[number,number,number,number]|null,
 *   external:boolean,theme:Theme,map:Record<string,string>}} context
 */
export function readChart(root, context) {
  const plotArea = descendantsOf(root, "plotArea")[0] ?? root;
  const groups = childElements(plotArea)
    .map((node) => ({ node, name: localNameOf(node) }))
    .filter(({ name }) => Object.hasOwn(TYPE_BY_ELEMENT, name))
    .map(({ node, name }) => {
      const type = TYPE_BY_ELEMENT[name] ?? "unknown";
      const groupingNode = firstOf(node, "grouping");
      const grouping = groupingNode ? attrOf(groupingNode, "val") : null;
      const directionNode = type === "bar" ? firstOf(node, "barDir") : null;
      const rawDirection = directionNode ? attrOf(directionNode, "val") : null;
      return {
        node,
        type,
        grouping,
        ...(rawDirection ? { direction: rawDirection === "col" ? "column" : rawDirection } : {}),
      };
    });
  const distinctTypes = new Set(groups.map((group) => group.type));
  const type = distinctTypes.size > 1 ? "combination" : (groups[0]?.type ?? "unknown");
  const combo =
    type === "combination"
      ? groups.map(({ type: groupType, grouping, direction }) => ({
          type: groupType,
          grouping,
          ...(direction ? { direction } : {}),
        }))
      : [];
  const singleDirection = type === "bar" ? groups[0]?.direction : undefined;
  const grouping = groups.find((group) => group.grouping !== null)?.grouping ?? null;
  const series = groups
    .flatMap((group) =>
      descendantsOf(group.node, "ser").map((ser) => seriesOf(ser, group.node, context.theme, context.map)),
    )
    .map((series, index) => ({ series, index }))
    // c:idx identifies a series; c:order controls its position across plot groups.
    .sort((a, b) => (a.series.order ?? a.index) - (b.series.order ?? b.index) || a.index - b.index)
    .map(({ series }) => series);
  const title = titleOf(root);

  return {
    chartId: context.chartId,
    slide: context.slide,
    box: context.box,
    type,
    grouping,
    combo,
    series,
    ...(singleDirection ? { direction: singleDirection } : {}),
    ...(title ? { title } : {}),
    external: context.external,
  };
}

/**
 * @param {Node} series
 * @param {Node} group
 * @param {Theme} theme
 * @param {Record<string,string>} map
 */
function seriesOf(series, group, theme, map) {
  const tx = firstOf(series, "tx");
  const name = tx ? nameOf(tx) : null;
  const family = localNameOf(group);
  const scatter = family === "scatterChart";
  const cat = firstOf(series, scatter ? "xVal" : "cat");
  const val = firstOf(series, scatter ? "yVal" : "val");
  const categories = cat ? cachedValues(cat) : { values: [] };
  const values = val ? cachedValues(val) : { values: [] };
  const orderNode = firstOf(series, "order");
  const rawOrder = orderNode ? attrOf(orderNode, "val") : null;
  const order = rawOrder?.trim() ? Number(rawOrder) : Number.NaN;
  const { color, gradient } = seriesPaintOf(series, group, theme, map);
  return {
    name,
    categories: categories.values,
    values: values.values,
    numFmt: numberFormatOf(val, values.formatCode),
    ...(scatter ? { xNumFmt: numberFormatOf(cat, categories.formatCode) } : {}),
    ...(Number.isSafeInteger(order) && order >= 0 ? { order } : {}),
    ...(color ? { color } : {}),
    ...(gradient ? { gradient } : {}),
  };
}

/**
 * Line-like series (line, scatter, unfilled radar) take their colour from the outline.
 * @param {Node} series @param {Node} group
 * @param {Theme} theme @param {Record<string,string>} map
 */
function seriesPaintOf(series, group, theme, map) {
  const family = localNameOf(group);
  const radarStyle = firstOf(group, "radarStyle");
  const linePaint =
    family === "lineChart" ||
    family === "scatterChart" ||
    (family === "radarChart" && (!radarStyle || attrOf(radarStyle, "val") !== "filled"));
  const spPr = firstOf(series, "spPr") ?? series;
  const paint = linePaint ? (firstOf(spPr, "ln") ?? spPr) : spPr;
  const fill = paint && firstOf(paint, "solidFill");
  const colorNode =
    fill && childElements(fill).find((node) => ["srgbClr", "schemeClr", "sysClr"].includes(localNameOf(node)));
  const color = colorNode ? resolveColor(colorNode, theme, map)?.hex : undefined;
  const gradient = paint && firstOf(paint, "gradFill") ? gradientsOf(paint, theme, map)[0] : undefined;
  return { color, gradient };
}

/** @param {Node|null} container @param {string|null|undefined} formatCode */
function numberFormatOf(container, formatCode) {
  return (
    (container &&
      descendantsOf(container, "numFmt")
        .map((node) => attrOf(node, "formatCode"))
        .find(Boolean)) ??
    formatCode ??
    null
  );
}

/**
 * Cached point arrays are index-addressed in OOXML. Keep sparse values explicit
 * as nulls so categories and values do not shift relative to the source cache.
 * @param {Node} container
 * @returns {{values:(string|number|null)[],formatCode?:string|null}}
 */
function cachedValues(container) {
  const reference = childElements(container).find((node) =>
    ["strRef", "numRef", "strLit", "numLit"].includes(localNameOf(node)),
  );
  if (!reference) return { values: [] };
  const referenceName = localNameOf(reference);
  const cache = ["strLit", "numLit"].includes(referenceName)
    ? reference
    : childElements(reference).find((node) => ["strCache", "numCache", "strLit", "numLit"].includes(localNameOf(node)));
  if (!cache) return { values: [] };
  const numeric = ["numCache", "numLit"].includes(localNameOf(cache));
  const points = descendantsOf(cache, "pt");
  let nextIndex = 0;
  const indexedPoints = points.map((point) => {
    const rawIndex = attrOf(point, "idx");
    const index = rawIndex === null ? nextIndex : Number(rawIndex);
    nextIndex = Number.isSafeInteger(index) && index >= 0 ? index + 1 : nextIndex;
    return { point, index };
  });
  const maximumIndex = indexedPoints.reduce(
    (max, entry) => (Number.isSafeInteger(entry.index) && entry.index >= 0 ? Math.max(max, entry.index) : max),
    -1,
  );
  const countNode = firstOf(cache, "ptCount");
  const countValue = countNode ? attrOf(countNode, "val") : null;
  const declaredCount = countValue === null ? Number.NaN : Number(countValue);
  const length = Number.isSafeInteger(declaredCount) && declaredCount >= 0 ? declaredCount : maximumIndex + 1;
  if (length > MAX_CACHE_POINTS || maximumIndex >= MAX_CACHE_POINTS) {
    throw new MaterialRejection("archive-limit", "图表缓存数据超出安全限制，无法读取；请减少图表数据后重新导出");
  }
  /** @type {(string|number|null)[]} */
  const values = Array.from({ length }, () => null);
  for (const { point, index } of indexedPoints) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= length) continue;
    const value = firstOf(point, "v")?.textContent ?? "";
    values[index] = numeric ? numericValue(value) : value;
  }
  const formatCode = firstOf(cache, "formatCode")?.textContent ?? null;
  return { values, formatCode };
}

/** @param {string} value @returns {number|string} */
function numericValue(value) {
  const parsed = Number(value);
  return value.trim() !== "" && Number.isFinite(parsed) ? parsed : value;
}

/** @param {Node} tx */
function nameOf(tx) {
  const cache = descendantsOf(tx, "strCache")[0] ?? descendantsOf(tx, "strLit")[0];
  const cachedName = cache && firstCacheValue(cache);
  if (cachedName?.length) return String(cachedName[0] ?? "");
  const value = descendantsOf(tx, "v")[0];
  if (value) return value.textContent ?? "";
  const richText = descendantsOf(tx, "t")
    .map((node) => node.textContent ?? "")
    .join("");
  return richText || null;
}

/** @param {Node} cache */
function firstCacheValue(cache) {
  const point = descendantsOf(cache, "pt")[0];
  const value = point && firstOf(point, "v");
  return value ? [value.textContent ?? ""] : [];
}

/** @param {Node} root */
function titleOf(root) {
  const title = descendantsOf(root, "title")[0];
  if (!title) return null;
  const rich = descendantsOf(title, "t")
    .map((node) => node.textContent ?? "")
    .join("");
  if (rich) return rich;
  const cached = descendantsOf(title, "v")
    .map((node) => node.textContent ?? "")
    .join("");
  return cached || textOf(title) || null;
}
