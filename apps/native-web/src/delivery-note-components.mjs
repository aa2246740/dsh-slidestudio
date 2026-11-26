/**
 * Template component lines of the 「资料使用情况」 card: the decorations the Host expanded into
 * pages and layouts, by page and by layout. Read-only over `design.components` and `layouts` of
 * `delivery-provenance.v1.json`, which the compose step fills from `template.component-used`
 * facts only. A component the Agent merely read in the kit, or later removed, is never listed here.
 */
import { array, canonicalMaterialId, compactPageRanges, pagePositions, record, text } from "./delivery-note-shared.mjs";

const MAX_GROUPS = 8;
const MAX_LABELS = 6;

/** `material:<id>#cover.arc-1` → the material id and the component id. @param {string} ref */
function splitRef(ref) {
  const at = ref.indexOf("#");
  const source = at < 0 ? "" : canonicalMaterialId(ref.slice(0, at));
  return { source, id: at < 0 ? ref : ref.slice(at + 1) };
}

/** @param {string[]} labels */
function labelList(labels) {
  const shown = labels.slice(0, MAX_LABELS).join("、");
  return labels.length > MAX_LABELS ? `${shown}等 ${labels.length} 个` : shown;
}

/** @template K @param {Map<K, string[]>} map @param {K} key @param {string} label */
function addLabel(map, key, label) {
  const labels = map.get(key) ?? [];
  if (!labels.includes(label)) labels.push(label);
  map.set(key, labels);
}

/**
 * Pages that reuse the same components read as one group: 第 2–4 页（body.mark-1）.
 * @param {Map<number, string[]>} byPage
 */
function pageGroupLine(byPage) {
  /** @type {Map<string, {positions: number[], labels: string[]}>} */
  const groups = new Map();
  for (const [position, labels] of [...byPage].sort(([left], [right]) => left - right)) {
    const key = labels.join("\n");
    const group = groups.get(key) ?? { positions: [], labels };
    group.positions.push(position);
    groups.set(key, group);
  }
  const all = [...groups.values()];
  const shown = all
    .slice(0, MAX_GROUPS)
    .map((group) => `第 ${compactPageRanges(group.positions)} 页（${labelList(group.labels)}）`);
  const rest = all.slice(MAX_GROUPS).reduce((sum, group) => sum + group.positions.length, 0);
  return `沿用了模板组件的页：${shown.join("；")}${rest ? `；另有 ${rest} 页` : ""}。`;
}

/** @param {Map<string, string[]>} byLayout @param {unknown} layouts */
function layoutLine(byLayout, layouts) {
  const layoutNames = new Map(array(layouts).map((layout) => [text(record(layout).id), text(record(layout).name)]));
  const shown = [...byLayout].map(
    ([layoutId, labels]) => `『${layoutNames.get(layoutId) || layoutId}』（${labelList(labels)}）`,
  );
  return `沿用了模板组件的版式：${shown.join("；")}。`;
}

/**
 * @param {unknown} components `provenance.design.components`
 * @param {unknown} layouts `provenance.layouts`
 * @param {unknown} pages `provenance.pages`, in deck order
 * @param {Map<string, Record<string, unknown>>} materialsById provenance materials by id
 * @returns {string[]} at most one line for pages and one for layouts
 */
export function componentUsageLines(components, layouts, pages, materialsById) {
  const entries = array(components)
    .map(record)
    .map((entry) => ({ ...splitRef(text(entry.ref)), entry }))
    .filter((item) => text(item.entry.ref) && item.id);
  if (!entries.length) return [];
  // Two templates may both define body.header, so the template is named only when it is ambiguous.
  const sources = new Set(entries.map((item) => item.source));
  /** @param {{source: string, id: string}} item */
  const label = (item) => {
    const name = sources.size > 1 ? text(materialsById.get(item.source)?.name) : "";
    return name ? `『${name}』${item.id}` : item.id;
  };
  const positions = pagePositions(pages);
  /** @type {Map<number, string[]>} */
  const byPage = new Map();
  /** @type {Map<string, string[]>} */
  const byLayout = new Map();
  for (const item of entries) {
    const layoutId = text(item.entry.layoutId);
    if (layoutId) {
      addLabel(byLayout, layoutId, label(item));
      continue;
    }
    for (const pageId of array(item.entry.pages)) {
      const position = positions.get(text(pageId));
      if (position) addLabel(byPage, position, label(item));
    }
  }
  /** @type {string[]} */
  const lines = [];
  if (byPage.size) lines.push(pageGroupLine(byPage));
  if (byLayout.size) lines.push(layoutLine(byLayout, layouts));
  return lines;
}
