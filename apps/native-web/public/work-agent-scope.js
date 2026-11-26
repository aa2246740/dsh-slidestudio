import { t } from "./i18n.js";

/** One stale-target sentence (Chinese source key; callers translate it with `t`). Every caller
 * offers the same reload recovery, including the layout-mode AI turn in layout-edit-turn.js. */
export const STALE_PAGE_TARGET = "目标页面当前不可用，请重新载入文稿后再试。";

/** Convert the validated model decision to concrete editor targets exactly once.
 * Natural-language parsing must never narrow or widen this authorization. */
export function targetFromAssistantIntent(plan, { pagePaths = [], pageIndex = 0, selectedElements = [] } = {}) {
  const invalid = (error) => ({ ok: false, scope: "invalid", label: `${t("无法发送")} · ${error}`, error });
  if (plan?.ok !== true || plan.intent !== "edit" || !["current", "selection", "pages", "deck"].includes(plan.scope)) {
    return invalid(t("助手未能确定修改范围；输入内容已保留。"));
  }
  if (
    !pagePaths.length ||
    pagePaths.some((path) => typeof path !== "string" || !path.endsWith(".page")) ||
    !Number.isSafeInteger(pageIndex) ||
    pageIndex < 0 ||
    pageIndex >= pagePaths.length
  ) {
    return invalid(t(STALE_PAGE_TARGET));
  }
  let indexes;
  if (plan.scope === "pages") {
    if (
      !Array.isArray(plan.pages) ||
      !plan.pages.length ||
      plan.pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > pagePaths.length)
    ) {
      return invalid(
        t("助手返回的页码不在当前文稿的 {pages} 页范围内；输入内容已保留。", { pages: `1–${pagePaths.length}` }),
      );
    }
    indexes = [...new Set(plan.pages)].sort((a, b) => a - b).map((page) => page - 1);
  } else indexes = plan.scope === "deck" ? pagePaths.map((_, index) => index) : [pageIndex];
  const elements = plan.scope === "selection" ? selectedElements : [];
  if (plan.scope === "selection" && (!elements.length || elements.some((element) => !element?.id))) {
    return invalid(t("没有选中对象。请先选择对象，或直接说明目标页面。"));
  }
  const paths = indexes.map((index) => pagePaths[index]);
  const ids = paths.map((path) =>
    path
      .split("/")
      .pop()
      .replace(/\.page$/i, ""),
  );
  if (new Set(ids).size !== ids.length) return invalid(t("页面标识重复，请重新载入文稿后再试。"));
  const anchor = plan.scope === "deck" ? pageIndex : indexes[0];
  const targetPageId = pagePaths[anchor]
    .split("/")
    .pop()
    .replace(/\.page$/i, "");
  const numbers = indexes.map((index) => index + 1);
  const elementIds = [...new Set(elements.map((element) => element.id))];
  const structureOnly = plan.structureOnly === true;
  const insertIndex =
    structureOnly && plan.insertIndex !== undefined && plan.insertIndex !== null ? plan.insertIndex : undefined;
  if (
    structureOnly &&
    insertIndex !== undefined &&
    (!Number.isSafeInteger(insertIndex) || insertIndex < 0 || insertIndex > pagePaths.length)
  ) {
    return invalid(t("助手返回的插入位置不在当前文稿内；输入内容已保留。"));
  }
  // A structural turn may also carry a whitelist of baseline pages the agent
  // may rewrite ("加一页并把第2页标题改大" → editablePageIds for page 2), and
  // a delete list for remove/merge turns ("删掉第3页" → deletablePageIds).
  const toPageIds = (numbers) => [
    ...new Set(
      numbers
        .filter((page) => Number.isSafeInteger(page) && page >= 1 && page <= pagePaths.length)
        .map((page) =>
          pagePaths[page - 1]
            .split("/")
            .pop()
            .replace(/\.page$/i, ""),
        ),
    ),
  ];
  const editablePageIds = structureOnly && Array.isArray(plan.editablePages) ? toPageIds(plan.editablePages) : [];
  if (structureOnly && Array.isArray(plan.editablePages) && plan.editablePages.length !== editablePageIds.length) {
    return invalid(t("助手返回的可编辑页码不在当前文稿内；输入内容已保留。"));
  }
  const deletablePageIds = structureOnly && Array.isArray(plan.deletablePages) ? toPageIds(plan.deletablePages) : [];
  if (structureOnly && Array.isArray(plan.deletablePages) && plan.deletablePages.length !== deletablePageIds.length) {
    return invalid(t("助手返回的可删除页码不在当前文稿内；输入内容已保留。"));
  }
  if (deletablePageIds.some((id) => editablePageIds.includes(id))) {
    return invalid(t("助手返回的结构范围自相矛盾；输入内容已保留。"));
  }
  // reorderTo is the desired final order (1-based, permutation of every
  // page). Order is the payload here — keep it, don't sort.
  const reorderPageIds =
    structureOnly && Array.isArray(plan.reorderTo)
      ? plan.reorderTo.map((page) =>
          Number.isSafeInteger(page) && page >= 1 && page <= pagePaths.length
            ? pagePaths[page - 1]
                .split("/")
                .pop()
                .replace(/\.page$/i, "")
            : "",
        )
      : [];
  if (structureOnly && Array.isArray(plan.reorderTo)) {
    const sorted = [...plan.reorderTo].sort((a, b) => a - b);
    if (plan.reorderTo.length !== pagePaths.length || sorted.some((page, index) => page !== index + 1)) {
      return invalid(t("助手返回的重排顺序没有覆盖全部页面；输入内容已保留。"));
    }
    if (plan.reorderTo.every((page, index) => page === index + 1)) {
      return invalid(t("助手返回的重排顺序与当前一致，没有变化；输入内容已保留。"));
    }
  }
  if (structureOnly && insertIndex === undefined && !deletablePageIds.length && !reorderPageIds.length) {
    return invalid(t("助手未能确定结构修改内容；输入内容已保留。"));
  }
  const expectedAddCount =
    structureOnly && Number.isSafeInteger(plan.addCount) && plan.addCount >= 1 ? plan.addCount : undefined;
  // A full rewrite is its own scope kind: every baseline page is a target and
  // the committed plan replaces the whole page list.
  const rewrite = plan.rewrite === true;
  if (rewrite && (structureOnly || plan.scope !== "deck")) {
    return invalid(t("助手返回的重写范围自相矛盾；输入内容已保留。"));
  }
  // Deck-level metadata rides on any scope ("加一页，顺便把文稿标题改了" —
  // a structural lock plus the title grant). Each entry is a field name the
  // verify step may see move; anything else stays a violation.
  const editableMeta =
    !rewrite && Array.isArray(plan.editableMeta)
      ? [...new Set(plan.editableMeta.filter((field) => field === "title" || field === "theme"))]
      : [];
  // A meta-only request ("把文稿标题改成X") takes the narrowest lock there is:
  // the anchor page stays frozen and only the whitelisted deck fields may
  // move. A plain current-scope page lock would let the agent rewrite the
  // page too — more power than the user granted.
  const metaOnly =
    editableMeta.length > 0 && plan.scope === "current" && !structureOnly && !rewrite && !elementIds.length;
  const metaLabel = editableMeta.length
    ? `${t("可改文稿")}${editableMeta.map((field) => (field === "title" ? t("标题") : t("主题"))).join(t("、"))}`
    : "";
  const positionLabel =
    insertIndex === 0
      ? t("开头新增页面")
      : insertIndex !== undefined && insertIndex >= pagePaths.length
        ? t("末尾新增页面")
        : insertIndex !== undefined
          ? t("第 {index} 页后新增页面", { index: insertIndex })
          : "";
  const deleteLabel = deletablePageIds.length
    ? t("删除第 {pages} 页", { pages: plan.deletablePages.join(t("、")) })
    : "";
  const reorderLabel = reorderPageIds.length
    ? t("页面重排为第 {pages} 页顺序", { pages: plan.reorderTo.join(t("、")) })
    : "";
  const baseLabel = structureOnly
    ? `${t("结构调整")} · ${[positionLabel && `${positionLabel}${expectedAddCount && expectedAddCount > 1 ? ` ×${expectedAddCount}` : ""}`, deleteLabel, reorderLabel, editablePageIds.length ? t("可改第 {pages} 页", { pages: plan.editablePages.join(t("、")) }) : ""].filter(Boolean).join(" + ")}`
    : metaOnly
      ? `${t("文稿元数据")} · ${metaLabel}`
      : rewrite
        ? t("整稿重写 · 将替换全部 {n} 页", { n: paths.length })
        : plan.scope === "deck"
          ? t("整份文稿 · {n} 页", { n: paths.length })
          : plan.scope === "selection"
            ? t("第 {page} 页", { page: anchor + 1 }) +
              " · " +
              (elements.length === 1
                ? elements[0].label || t("所选对象")
                : t("已选 {n} 个对象", { n: elements.length }))
            : plan.scope === "pages"
              ? `${t("第 {page} 页", { page: numbers.join(t("、")) })} · ${numbers.length === 1 ? t("指定页面") : t("指定 {n} 页", { n: numbers.length })}`
              : `${t("第 {page} 页", { page: anchor + 1 })}${t("，当前页")}`;
  const label = metaOnly ? baseLabel : metaLabel ? `${baseLabel} + ${metaLabel}` : baseLabel;
  return {
    ok: true,
    scope: metaOnly ? "meta" : plan.scope === "selection" ? "elements" : plan.scope === "current" ? "page" : plan.scope,
    ...(rewrite ? { rewrite: true } : {}),
    ...(editableMeta.length ? { editableMeta } : {}),
    ...(structureOnly
      ? {
          structureOnly: true,
          ...(insertIndex !== undefined ? { insertIndex } : {}),
          ...(editablePageIds.length ? { editablePageIds } : {}),
          ...(deletablePageIds.length ? { deletablePageIds } : {}),
          ...(reorderPageIds.length ? { reorderPageIds } : {}),
          ...(expectedAddCount ? { expectedAddCount } : {}),
        }
      : {}),
    pageIndex: anchor,
    pageIndexes: indexes,
    pagePath: pagePaths[anchor],
    pagePaths: paths,
    targetPageId,
    targetPageIds: ids,
    elementId: elementIds.length === 1 ? elementIds[0] : "",
    elementIds,
    label,
  };
}
