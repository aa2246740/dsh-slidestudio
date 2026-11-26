/**
 * The non-blocking Chinese hint a period mismatch earns after `write_page`. It reads the report the
 * figure detector produced and decides nothing itself; writes are never blocked on it.
 */
import type { MaterialFigureMatch, MaterialFigureReading, MaterialFiguresReport } from "./material-figures.js";
import { periodUpdateHint } from "./period-figures.js";
import { effectivePeriods, type PeriodMap } from "./period-map.js";

function readingName(readings: readonly MaterialFigureReading[], materialId: string): string {
  return readings.find((reading) => reading.materialId === materialId)?.materialName ?? materialId;
}

/**
 * Non-blocking correction instructions grouped by mismatched source page. Under a monthly update
 * (`monthly`) a text without a period label counts as the map's period for its side, and a figure
 * that traces to a declared missing item (`acknowledged`) is not hinted again; a stale figure from
 * another chart or table on the same page still is.
 */
export function materialFiguresHint(
  report: MaterialFiguresReport,
  readings: readonly MaterialFigureReading[],
  monthly?: Readonly<{
    periodMap: PeriodMap;
    acknowledged: (match: MaterialFigureMatch) => boolean;
  }>,
): string | undefined {
  if (!report.matches.length) return undefined;
  const lines: string[] = [];
  const categorySources = new Set<string>();
  for (const match of report.matches) {
    if (match.chart?.categoriesMatch !== false) continue;
    const source = `${match.materialId}#${match.sourcePage}`;
    if (categorySources.has(source)) continue;
    categorySources.add(source);
    lines.push(
      `提示：本页图表复用了资料「${readingName(readings, match.materialId)}」第 ${match.sourcePage} 页的数值，但类别或顺序不同；请恢复源图表的类别和顺序，并保留源期间。先重新读取该资料的 charts/slides 核对；如另用非模板数据，须使用有依据的新数据并准确声明 provenance，不能仅改标签或声明。当前不构成图表替代证据。`,
    );
  }
  const byTarget = new Map<string, { name: string; page: number; values: string[]; periods: string[] }>();
  for (const match of report.matches) {
    if (monthly?.acknowledged(match)) continue;
    const key = `${match.materialId}#${match.sourcePage}`;
    const entry = byTarget.get(key) ?? {
      name: readingName(readings, match.materialId),
      page: match.sourcePage,
      values: [],
      periods: [...match.sourcePeriods],
    };
    if (!entry.values.includes(match.value)) entry.values.push(match.value);
    byTarget.set(key, entry);
  }
  const pagePeriods = effectivePeriods(report.pagePeriods, monthly?.periodMap, "page");
  for (const [key, target] of byTarget) {
    const periods = effectivePeriods(target.periods, monthly?.periodMap, "source");
    if (!pagePeriods.length || !periods.length) continue;
    if (periods.some((period) => pagePeriods.includes(period))) continue;
    if (monthly) {
      lines.push(
        periodUpdateHint({
          name: target.name,
          page: target.page,
          values: target.values,
          sourcePeriods: periods,
          periodMap: monthly.periodMap,
        }),
      );
      continue;
    }
    const source = target.page > 0 ? `第 ${target.page} 页` : "";
    lines.push(
      `提示：本页的 ${target.values.join("、")} 与资料「${target.name}」${source}的原文完全一致；` +
        `资料中的期间是「${periods.join("、")}」，本页标注为「${pagePeriods.join("、")}」。` +
        "下一步：先用 read_material 重新读取上述源内容（PPTX 为 charts/slides），再用 write_page 完整重写同一页，修正后再调用 render_page/review_pages。" +
        "沿用原数必须恢复原期间及其类别/数值对应关系、单位和实体，不得保留模板数值却标为源资料之外的期间。" +
        "若改用非模板数据，须换成另一个已读来源支持的新数字，并核对该期间、单位和实体；仅在用户允许时才可改用新的示意数字。" +
        "同步更正 provenance.basis/materials/quoted/note，准确说明来源或示意性质；只改标签、补注原期间或声明 mock 均不能修正原数错期。" +
        "保存成功不表示来源问题已解决。这条提示不阻止保存。",
    );
  }
  return lines.length ? lines.join("\n") : undefined;
}
