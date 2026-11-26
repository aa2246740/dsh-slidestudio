import { boxArray, clampBox } from "./pptx-geometry.mjs";
/** @typedef {import("./pptx-geometry.mjs").Shape} Shape */
/** @typedef {{index:number,title:string|null,text:string,shapes:Shape[]}} Page */
/** @typedef {{id:string,kind:string,slides:number[],slots:{role:string,box:number[],clamped:boolean,font?:{pt:number}}[]}} Archetype */

/** This classifies reference geometry, not a user brief or generated page.
 * A coarse slot signature clusters repeated section decoration despite text changes.
 * @param {Page[]} pages */
export function clusterArchetypes(pages) {
  /** @type {Map<string,Archetype>} */ const clusters = new Map();
  for (const page of pages) {
    /** @param {Shape} shape */
    const kindOf = (shape) => shape.sourceKind ?? shape.kind;
    const charts = page.shapes.filter((s) => kindOf(s) === "chart"),
      tables = page.shapes.filter((s) => kindOf(s) === "table");
    const sparse = page.shapes.filter((s) => s.text).reduce((n, s) => n + s.text.length, 0) < 100;
    const decorated = page.shapes.some((s) => kindOf(s) === "custom" || s.embed);
    const kind =
      page.index === 1
        ? "cover"
        : /目录|contents/i.test(page.title ?? "")
          ? "toc"
          : page.index === pages.length && sparse
            ? "closing"
            : tables.length
              ? "body-table"
              : charts.length
                ? "body-chart-grid"
                : sparse && decorated
                  ? "section"
                  : "body-text";
    const useful = page.shapes.filter((s) => s.box && (s.text || kindOf(s) === "chart" || kindOf(s) === "table"));
    const signature = kind === "section" ? "section" : kind === "body-chart-grid" ? `${kind}-${charts.length}` : kind;
    const existing = clusters.get(signature);
    if (existing) {
      existing.slides.push(page.index);
      continue;
    }
    const slots = useful.map((shape) => {
      const clipped = clampBox(/** @type {NonNullable<Shape["box"]>} */ (shape.box));
      const role =
        shape.text === page.title
          ? "title"
          : kindOf(shape) === "chart"
            ? "chart-area"
            : kindOf(shape) === "table"
              ? "table-area"
              : "body";
      const pt = Math.max(0, ...shape.runs.map((run) => run.pt ?? 0));
      return {
        role,
        box: boxArray(clipped),
        clamped: clipped.clamped,
        ...(pt ? { font: { pt } } : {}),
      };
    });
    clusters.set(signature, {
      id: `archetype-${clusters.size + 1}`,
      kind,
      slides: [page.index],
      slots,
    });
  }
  return [...clusters.values()];
}
