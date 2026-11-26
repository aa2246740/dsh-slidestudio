import { attrOf, descendantsOf, localNameOf, parseRels, parseXml, resolvePartPath } from "./ooxml.mjs";
import {
  ancestorGroupMatrix,
  boxArray,
  geometryOf,
  inheritBoxes,
  parseShapes,
  runsOf,
  titleOf,
  transformBox,
} from "./pptx-geometry.mjs";
import { colorMapOf, gradientsOf, noteColors } from "./pptx-colors.mjs";
import { resolveShapeFonts } from "./pptx-fonts.mjs";
import { readChart } from "./pptx-charts.mjs";
import { diagramChars, diagramFrameBox, diagramText, readDiagram, takeDiagram } from "./ooxml-diagram.mjs";
/** @typedef {import("./ooxml.mjs").DomNode} Node */
/** @typedef {import("./pptx.mjs").Theme} Theme */
/** @typedef {{root:Node,master:Node,theme:Theme,map:Record<string,string>}} Context */

/** Speaker notes: the notes page's body placeholders and free text, joined by line.
 * @param {import("./ooxml.mjs").PackageReader} pkg @param {string} part
 * @param {Map<string, import("./ooxml.mjs").PartRelationship>} rels @param {number} width @param {number} height */
function notesOf(pkg, part, rels, width, height) {
  const notesRel = [...rels.values()].find((rel) => rel.type === "notesSlide" && !rel.external);
  const notesPart = notesRel && resolvePartPath(part, notesRel.target);
  const notesText = notesPart && pkg.text(notesPart);
  if (!notesText || !notesPart) return "";
  return parseShapes(parseXml(notesText, notesPart), width, height)
    .filter((shape) => !shape.ph || shape.ph.type === "body")
    .map((shape) => shape.text)
    .filter(Boolean)
    .join("\n");
}

/** A chart run inside a `<c:title>` counts as a title for the font tiers. @param {Node} rich */
function isChartTitle(rich) {
  let parent = rich.parentNode;
  while (parent) {
    if (localNameOf(parent) === "title") return true;
    parent = parent.parentNode;
  }
  return false;
}

/**
 * The slide's embedded charts with their frame boxes, plus the chart text runs and font sizes.
 * @param {import("./ooxml.mjs").PackageReader} pkg @param {string} part @param {Node} root
 * @param {Map<string, import("./ooxml.mjs").PartRelationship>} rels
 * @param {import("./pptx-geometry.mjs").Shape[]} shapes
 * @param {{slide: number, theme: Theme, map: Record<string,string>, colors: Map<string,import("./pptx-colors.mjs").ColorUse>}} ctx
 */
function readSlideCharts(pkg, part, root, rels, shapes, ctx) {
  const { theme, map, colors } = ctx;
  /** @type {number[]} */ const chartSizes = [];
  /** @type {import("./pptx-geometry.mjs").Run[]} */ const chartRuns = [];
  const chartShapes = shapes.filter((shape) => shape.kind === "chart" || shape.sourceKind === "chart");
  const chartBoxes = new Map();
  descendantsOf(root, "chart").forEach((node, frameIndex) => {
    const relationshipId = attrOf(node, "r:id");
    if (relationshipId) {
      const box = chartShapes[frameIndex]?.box;
      chartBoxes.set(relationshipId, box ? boxArray(box) : null);
    }
  });
  const charts = [];
  for (const [relationshipId, rel] of rels) {
    if (rel.type !== "chart" || rel.external) continue;
    const chartPart = resolvePartPath(part, rel.target),
      chartText = pkg.text(chartPart);
    if (!chartText) continue;
    const chart = parseXml(chartText, chartPart);
    const chartRels = parseRels(pkg, chartPart);
    const external = descendantsOf(chart, "externalData").some((externalData) => {
      const relationshipId = attrOf(externalData, "r:id");
      return relationshipId ? chartRels.get(relationshipId)?.external === true : false;
    });
    charts.push(
      readChart(chart, {
        chartId: chartPart.slice(chartPart.lastIndexOf("/") + 1).replace(/\.xml$/i, ""),
        slide: ctx.slide,
        box: chartBoxes.get(relationshipId) ?? null,
        external,
        theme,
        map,
      }),
    );
    noteColors(chart, theme, map, colors, true);
    const chartTextShapes = descendantsOf(chart, "rich").map(
      (rich) =>
        /** @type {import("./pptx-geometry.mjs").Shape} */ ({
          ph: isChartTitle(rich) ? { type: "title", idx: null } : null,
          name: null,
          box: null,
          text: "",
          embed: null,
          kind: "chart",
          runs: runsOf(rich),
        }),
    );
    resolveShapeFonts(chartTextShapes, theme, []);
    chartRuns.push(...chartTextShapes.flatMap((shape) => shape.runs));
    for (const node of [...descendantsOf(chart, "rPr"), ...descendantsOf(chart, "defRPr")]) {
      const pt = Number(attrOf(node, "sz")) / 100;
      if (pt > 0) chartSizes.push(pt);
    }
  }
  return { charts, chartRuns, chartSizes };
}

/** @param {import("./ooxml.mjs").PackageReader} pkg @param {string} part
 * @param {number} index @param {number} width @param {number} height
 * @param {Map<string,Context>} contexts @param {Theme|null} fallback
 * @param {Map<string,import("./pptx-colors.mjs").ColorUse>} colors
 * @param {import("./ooxml-diagram.mjs").DiagramBudget} [diagramBudget] */
export function readSlide(
  pkg,
  part,
  index,
  width,
  height,
  contexts,
  fallback,
  colors,
  diagramBudget = { count: 0, truncated: false },
) {
  const text = pkg.text(part);
  if (text === undefined) return null;
  const root = parseXml(text, part),
    rels = parseRels(pkg, part);
  const layout = [...rels.values()].find((rel) => rel.type === "slideLayout" && !rel.external);
  const layoutPart = layout ? resolvePartPath(part, layout.target) : null;
  const context = layoutPart ? contexts.get(layoutPart) : undefined;
  const theme = context?.theme ?? fallback ?? { name: null, colors: {}, fonts: { major: null, minor: null } };
  const map = colorMapOf(root, context?.map);
  const shapes = parseShapes(root, width, height);
  if (context)
    inheritBoxes(shapes, [parseShapes(context.root, width, height), parseShapes(context.master, width, height)]);
  noteColors(root, theme, map, colors);
  if (context) noteColors(context.root, theme, map, colors);
  resolveShapeFonts(shapes, theme, [context?.root, context?.master]);
  const { charts, chartRuns, chartSizes } = readSlideCharts(pkg, part, root, rels, shapes, {
    slide: index,
    theme,
    map,
    colors,
  });
  const tables = shapes.flatMap((shape, n) =>
    shape.table
      ? [
          {
            ...shape.table,
            slide: index,
            id: `s${index}-table${n + 1}`,
            box: shape.box ? boxArray(shape.box) : null,
          },
        ]
      : [],
  );
  const tableText = tables
    .map((table) => table.rows.map((row) => row.map((cell) => cell.text).join("\t")).join("\n"))
    .join("\n");
  const notes = notesOf(pkg, part, rels, width, height);
  const smartArts = [];
  const diagramWarnings = [];
  const diagramTexts = [];
  for (const frame of descendantsOf(root, "graphicFrame")) {
    const relIds = descendantsOf(frame, "relIds")[0];
    if (!relIds) continue;
    if (!takeDiagram(diagramBudget, diagramWarnings)) break;
    const frameBox = diagramFrameBox(frame);
    const transform = ancestorGroupMatrix(frame);
    const pageBox = frameBox && transformBox(frameBox, transform);
    const diagram = readDiagram(pkg, part, rels, relIds, frameBox, {
      width,
      height,
      theme,
      map,
      transform,
      index: smartArts.length,
    });
    diagramWarnings.push(
      ...diagram.warnings.map((warning) => ({
        ...warning,
        message: `第 ${index} 页：${warning.message}`,
      })),
    );
    smartArts.push({
      id: `s${index}-${smartArts.length + 1}`,
      slide: index,
      name: attrOf(descendantsOf(frame, "cNvPr")[0] ?? frame, "name"),
      box:
        pageBox && width && height
          ? [pageBox.x / width, pageBox.y / height, pageBox.w / width, pageBox.h / height]
          : null,
      layout: diagram.layout.family,
      nodeCount: diagram.nodes.length,
      chars: diagramChars(diagram.nodes),
      cache: diagram.cache,
      nodes: diagram.nodes,
      layoutInfo: diagram.layout,
      ...(diagram.shapes ? { shapes: diagram.shapes } : {}),
    });
    diagramTexts.push(diagramText(diagram));
  }
  return {
    root,
    rels,
    theme,
    map,
    shapes,
    layoutPart,
    tables,
    chartSizes,
    chartRuns,
    charts,
    smartArts,
    diagramWarnings,
    detail: {
      index,
      shapes: shapes.map(geometryOf),
      gradients: gradientsOf(root, theme, map),
    },
    summary: {
      index,
      part,
      hidden: attrOf(root, "show") === "0",
      title: titleOf(shapes),
      placeholders: shapes.filter((shape) => shape.ph).length,
      ...(tableText ? { tableText } : {}),
      ...(notes ? { notes } : {}),
      text: [...shapes.map((shape) => shape.text).filter(Boolean), ...diagramTexts].join("\n"),
    },
  };
}
