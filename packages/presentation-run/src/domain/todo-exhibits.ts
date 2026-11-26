import { isTodoExhibitKind, type TodoExhibitKind } from "./page-plan.js";

export type TodoExhibitContract = {
  title: string;
  note?: string;
  exhibits?: TodoExhibitKind[];
  exhibitOrigins?: Partial<Record<TodoExhibitKind, string>>;
};

/** Compatibility path for old outlines. New runs must write typed exhibits. */
export function inferTodoExhibits(text: string): TodoExhibitKind[] {
  const normalized = text
    .replace(/(?:无|不含|不要|without|no)\s*(?:数据)?表(?:格)?/gi, "")
    .replace(/(?:无|不含|不要|without|no)\s*图表/gi, "");
  const found: TodoExhibitKind[] = [];
  const add = (kind: TodoExhibitKind, pattern: RegExp) => {
    if (pattern.test(normalized) && !found.includes(kind)) found.push(kind);
  };
  add("chart:waterfall", /waterfall|瀑布/i);
  add("chart:scatter", /scatter|risk\s*matrix|风险矩阵/i);
  add("chart:doughnut", /donut|doughnut|\bring\b|环形|圆环/i);
  add("chart:pie", /饼图/i);
  add("chart:radar", /radar|雷达/i);
  const percentStacked = /percent(?:age)?\s*stacked|百分比堆叠/i;
  add("chart:percentStacked", percentStacked);
  // A percent-stacked brief is not also a plain stacked one.
  if (!percentStacked.test(normalized)) add("chart:stacked", /stacked|堆叠/i);
  add("chart:line", /spark(?:line)?|\bline\b|折线|趋势线/i);
  add("chart:bar", /\bbars\b|\bbar\s+(?:chart|graph)\b|stack(?:ed)?|柱|条形|堆[叠积]条|时效条|拆分条|账龄条/i);
  add("chart:combo", /combo|dual[-\s]?axis|双轴图/i);
  add("table", /\btables?\b|四列表|区域表|附表|数据表|底表|活动表|拆解表|缺货表|表格/i);
  add("diagram:funnel", /funnel|转化漏斗|漏斗/i);
  add("diagram:gauge", /gauge|仪表盘|进度环|达成率环/i);
  add("diagram:pyramid", /pyramid|金字塔|层级塔/i);
  add("diagram:matrix", /decision\s*matrix|priority\s*matrix|2[×x]2|四象限|九宫格|(?<!风险)矩阵/i);
  add("diagram:timeline", /timeline|时间线|时间轴|路线图|里程碑|发展历程|演进路线/i);
  add("kpi-cards", /\bkpi\b|kpi\s*卡|(?:大|小)?卡片/i);
  add("comparison-cards", /comparison\s*cards?|对照卡/i);
  // A stacked bar chart is one exhibit, so its "柱" cue does not add a plain bar chart as well.
  const stacked = found.some((kind) => kind === "chart:stacked" || kind === "chart:percentStacked");
  return stacked ? found.filter((kind) => kind !== "chart:bar") : found;
}

export function inferBriefPageExhibits(brief: string, pageNumber: number): TodoExhibitKind[] {
  const sections = [...brief.matchAll(/【第\s*(\d+)\s*页[^】]*】([\s\S]*?)(?=【第\s*\d+\s*页|$)/g)];
  const section = sections.find((match) => Number(match[1]) === pageNumber)?.[2];
  return section ? inferTodoExhibits(section) : [];
}

/** An explicitly supplied array is the complete contract, including [] and none. */
export function resolveTodoExhibitContract(
  todo: TodoExhibitContract,
  index: number,
  brief: string,
): TodoExhibitContract & { exhibits: TodoExhibitKind[] } {
  if (todo.exhibits !== undefined) {
    const declared = todo.exhibits.filter(isTodoExhibitKind);
    return { ...todo, exhibits: declared.length ? declared : ["none"] };
  }
  const inferred = inferTodoExhibits(`${todo.title}\n${todo.note ?? ""}`);
  const briefRequired = inferBriefPageExhibits(brief, index + 1);
  const exhibits = [...new Set([...inferred, ...briefRequired])];
  const exhibitOrigins: TodoExhibitContract["exhibitOrigins"] = {};
  for (const kind of exhibits) {
    exhibitOrigins[kind] = [
      ...(inferred.includes(kind) ? ["plan declaration (legacy title/note inference)"] : []),
      ...(briefRequired.includes(kind) ? [`brief page ${index + 1}`] : []),
    ].join(" and ");
  }
  return { ...todo, exhibits: exhibits.length ? exhibits : ["none"], exhibitOrigins };
}

export function resolveTodoExhibits(todo: TodoExhibitContract, index: number, brief: string): TodoExhibitKind[] {
  return resolveTodoExhibitContract(todo, index, brief).exhibits;
}
