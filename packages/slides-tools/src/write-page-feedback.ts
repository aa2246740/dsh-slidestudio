import {
  readCommittedPagePlan,
  requestedExhibitIssues,
  persistPageKey,
  type SkillPageInput,
} from "@open-slidestudio/presentation-run";

const EXHIBIT_ROLES: Readonly<Record<string, string>> = {
  "kpi-cards": "kpi-card",
  "comparison-cards": "comparison-card",
  "diagram:funnel": "funnel",
  "diagram:gauge": "gauge",
  "diagram:pyramid": "pyramid",
  "diagram:matrix": "matrix",
  "diagram:timeline": "timeline",
};

export function missingDeclaredExhibitWarnings(root: string, pageId: string, page: SkillPageInput): string[] {
  const todo = (() => {
    try {
      return readCommittedPagePlan(root).find((item) => item.pageId === persistPageKey(pageId));
    } catch {
      return undefined;
    }
  })();
  if (!todo) return [];
  return requestedExhibitIssues(page, {
    title: todo.title,
    ...(todo.note ? { note: todo.note } : {}),
    exhibits: [...todo.exhibits],
  }).map((issue) => {
    const kind = issue.message.match(/requires ([^ ]+) from/)?.[1] ?? "declared";
    const role = EXHIBIT_ROLES[kind];
    return role
      ? `计划展项「${kind}」缺少对应元素（exhibitRole="${role}"）；review_pages 门禁不变。`
      : `计划展项「${kind}」缺少对应的可编辑 PPTD 元素；review_pages 门禁不变。`;
  });
}

export function withNormalizedPageResult(value: unknown, normalized: readonly string[]): unknown {
  if (!normalized.length || !value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return { ...(value as Record<string, unknown>), normalized };
}
