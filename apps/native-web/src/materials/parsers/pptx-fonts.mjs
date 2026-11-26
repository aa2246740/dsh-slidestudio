import { normalizeFontFamily } from "@open-slidestudio/pptd-v2";
import { attrOf, childrenOf, descendantsOf, firstOf } from "./ooxml.mjs";
/** @typedef {import("./ooxml.mjs").DomNode} Node */
/** @typedef {import("./pptx-geometry.mjs").Shape} Shape */
/** @typedef {import("./pptx-geometry.mjs").Run} Run */
/** @typedef {import("./pptx.mjs").Theme} Theme */
/** @typedef {{latin:string,ea:string,chars:number,mapped:{latin:string,ea:string},note:string}} SourceFontUse */
/** @typedef {{latin:string,ea:string,chars:number,mapped:{latin:string,ea:string},note:string,sourceFonts:SourceFontUse[]}} FontUse */

/** @param {Node|undefined} root @param {Shape} shape @param {number} level */
function inheritedProps(root, shape, level) {
  if (!root) return [];
  const type = shape.ph?.type ?? "body";
  const style = descendantsOf(root, /title/i.test(type) ? "titleStyle" : "bodyStyle")[0];
  const levelStyle = style && firstOf(style, `lvl${level}pPr`);
  const candidates = shape.ph ? descendantsOf(root, "sp").map((sp) => ({ sp, ph: descendantsOf(sp, "ph")[0] })) : [];
  const matching = (
    candidates.find(({ ph }) => ph && shape.ph?.idx !== null && attrOf(ph, "idx") === shape.ph?.idx) ??
    candidates.find(({ ph }) => ph && (attrOf(ph, "type") ?? "body") === type)
  )?.sp;
  const body = matching && firstOf(matching, "txBody");
  const list = body && firstOf(body, "lstStyle");
  const listLevel = list && firstOf(list, `lvl${level}pPr`);
  const paragraphs = body
    ? childrenOf(body, "p")
        .map((p) => firstOf(p, "pPr"))
        .filter((p) => p && Number(attrOf(p, "lvl") ?? 0) + 1 === level)
    : [];
  return [
    ...paragraphs.map((p) => p && firstOf(p, "defRPr")),
    listLevel && firstOf(listLevel, "defRPr"),
    levelStyle && firstOf(levelStyle, "defRPr"),
  ].filter((p) => p !== null && p !== undefined);
}
/** @param {Shape[]} shapes @param {Theme} theme @param {(Node|undefined)[]} parents */
export function resolveShapeFonts(shapes, theme, parents) {
  for (const shape of shapes) {
    const major = Boolean(shape.ph && /title/i.test(shape.ph.type ?? ""));
    const fallback = major ? theme.fonts.major : theme.fonts.minor;
    /** @param {string|null} face @param {"latin"|"ea"} script */
    const resolve = (face, script) => {
      if (face?.startsWith("+mj")) return theme.fonts.major?.[script] || theme.fonts.major?.hans || null;
      if (face?.startsWith("+mn")) return theme.fonts.minor?.[script] || theme.fonts.minor?.hans || null;
      return face || fallback?.[script] || fallback?.hans || null;
    };
    for (const run of shape.runs) {
      const props = parents.flatMap((parent) => inheritedProps(parent, shape, run.level ?? 1));
      const latin = props.map((p) => firstOf(p, "latin")).find(Boolean);
      const ea = props.map((p) => firstOf(p, "ea")).find(Boolean);
      run.latin = resolve(run.latin || (latin ? attrOf(latin, "typeface") : null), "latin");
      run.ea = resolve(run.ea || (ea ? attrOf(ea, "typeface") : null), "ea");
      const size = props.find((p) => attrOf(p, "sz"));
      if (run.pt === null && size) run.pt = Number(attrOf(size, "sz")) / 100;
    }
  }
}
/** @param {{index:number,shapes:Shape[],chartRuns?:Run[],chart?:boolean}[]} pages */
export function fontStatistics(pages) {
  /** @type {Map<string,SourceFontUse>} */ const sources = new Map();
  /** @type {Map<string,Set<number>>} */ const tiers = new Map(
    ["cover", "title", "body", "chart"].map((role) => [role, new Set()]),
  );
  for (const page of pages) {
    for (const shape of page.shapes) for (const run of shape.runs) addRun(run, page, shape);
    for (const run of page.chartRuns ?? []) addRun(run, page, null, true);
  }
  /** @param {Run} run @param {{index:number,chart?:boolean}} page
   * @param {Shape|null} shape @param {boolean} chartRun */
  function addRun(run, page, shape, chartRun = false) {
    if (!run.text) return;
    const latin = run.latin ?? "",
      ea = run.ea ?? "",
      key = `${latin}\0${ea}`;
    const normalized = normalizeFontFamily({ latin, ea });
    const mapped = /** @type {{latin:string,ea:string}} */ (normalized.fontFamily);
    const use = sources.get(key) ?? {
      latin,
      ea,
      chars: 0,
      mapped,
      note: normalized.note ? `已映射：${normalized.note}；不嵌入字体` : "字体已在白名单中，不嵌入字体",
    };
    use.chars += Array.from(run.text).length;
    sources.set(key, use);
    if (run.pt) {
      const role =
        chartRun || page.chart
          ? "chart"
          : page.index === 1
            ? "cover"
            : shape?.box && shape.box.y < 0.12
              ? "title"
              : "body";
      tiers.get(role)?.add(run.pt);
    }
  }
  const groups = [...sources.values()].reduce((byMappedFamily, source) => {
    const key = `${source.mapped.latin}\0${source.mapped.ea}`;
    const group = byMappedFamily.get(key) ?? {
      latin: source.mapped.latin,
      ea: source.mapped.ea,
      chars: 0,
      mapped: source.mapped,
      note: "实际字体按共享白名单映射，不嵌入字体",
      sourceFonts: [],
    };
    group.chars += source.chars;
    group.sourceFonts.push(source);
    byMappedFamily.set(key, group);
    return byMappedFamily;
  }, /** @type {Map<string,FontUse>} */ (new Map()));
  return {
    fontsUsed: [...groups.values()].sort((a, b) => b.chars - a.chars || a.latin.localeCompare(b.latin)),
    fontSizeTiers: [...tiers].map(([role, pt]) => ({ role, pt: [...pt].sort((a, b) => b - a) })),
  };
}
