import { t } from "./i18n.js";

/** @param {unknown} value */
function text(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/**
 * @param {{execution?: {blockers?: Array<{code?: string, pageIds?: string[]}>}}} activity
 * @param {{composeBlockers?: unknown[]}} inspection
 */
export function unfinishedGenerationReason(activity, inspection) {
  const blockers = Array.isArray(activity?.execution?.blockers) ? activity.execution.blockers : [];
  const messages = [];
  const pageCountFor = /** @param {string | undefined} code */ (code) =>
    new Set(blockers.filter((row) => row.code === code).flatMap((row) => row.pageIds || [])).size;
  for (const code of new Set(blockers.map((row) => row.code))) {
    const n = pageCountFor(code);
    const messageByCode = /** @type {Record<string, string>} */ ({
      missing_plan: t("页面规划尚未完成"),
      legacy_incomplete_plan: t("页面规划需要补全"),
      missing_pages: t("还有 {n} 页尚未写入", { n }),
      extra_pages: t("页面与当前规划不一致，需要核对"),
      page_render_needed: t("有 {n} 页尚未完成截图与排版检查", { n }),
      page_image_needed: t("有 {n} 页的截图尚未送达当前模型", { n }),
      page_visual_review_needed: t("有 {n} 页尚未完成视觉检查", { n }),
      page_needs_revision: t("有 {n} 页未通过检查，需要修订", { n }),
      structural_review_needed: t("整稿结构检查尚未通过"),
      compose_needed: t("页面检查已通过，尚未完成合稿"),
      export_needed: t("文稿已合稿，尚未完成导出"),
      missing_references: t("必需参考资料尚未读完"),
      project_unreadable: t("项目暂时无法读取，请检查文件是否可访问"),
      identity_collision: t("项目中存在重复页面标识，需要修复后继续"),
      activity_unknown: t("暂时无法确认生成会话状态，请等待连接恢复"),
    });
    const message = messageByCode[String(code)];
    if (message) messages.push(message);
  }
  if (!messages.length && Array.isArray(inspection.composeBlockers)) {
    if (inspection.composeBlockers.some((value) => /rendered layout/i.test(text(value)))) {
      messages.push(t("页面截图或排版检查尚未通过"));
    } else if (inspection.composeBlockers.some((value) => /visual review|image content/i.test(text(value)))) {
      messages.push(t("页面截图尚未送达模型，或视觉检查尚未完成"));
    }
  }
  return messages.length ? messages.join(t("；")) : t("模型已结束本轮回复，但尚未完成整稿检查与合稿");
}
