/** Chinese chip warnings for the pictures found in a DOCX or PDF. */

/** @type {Record<string, (count: number) => string>} */
const SKIP_REASONS = {
  small: (count) => `${count} 张小于 64×64 像素（图标或装饰）`,
  unsupported: (count) => `${count} 张格式不支持（如 EMF、WMF、SVG）`,
  tooLarge: (count) => `${count} 张文件过大（单张上限 8 MB）`,
  undecodable: (count) => `${count} 张无法完整解码`,
  unreadable: (count) => `${count} 张读取失败`,
  duplicate: (count) => `${count} 张与已保留的图片重复`,
  budget: (count) => `${count} 张因处理时间已到没有处理`,
  pageScan: (count) => `${count} 张是铺满整页的扫描图（整页内容见页面预览）`,
  strip: (count) => `${count} 张是细长条（长宽比超过 8，多为分隔线或装饰）`,
  faint: (count) => `${count} 张几乎透明（多为阴影或装饰）`,
  flat: (count) => `${count} 张是单色渐隐的填充（色条、阴影等装饰）`,
};

/**
 * @param {{section: {found: number, countComplete: boolean, kept: number, limit: number,
 *   skipped: Record<string, number>}, timedOut: boolean, stopped?: "memory"|"time",
 *   pagesScanned?: number}} input
 * @returns {{code: string, message: string}[]}
 */
export function embeddedWarnings({ section, timedOut, stopped, pagesScanned }) {
  /** @type {{code: string, message: string}[]} */
  const warnings = [];
  if (section.kept >= section.limit && (section.found > section.limit || !section.countComplete)) {
    const total = section.countComplete ? `${section.found} 张` : `${section.limit} 张以上`;
    warnings.push({
      code: "embedded-images-limit",
      message: `文档里有 ${total}可用图片，只保留了前 ${section.limit} 张；其余图片可另存后单独上传`,
    });
  }
  const reasons = Object.entries(section.skipped)
    .filter(([key, count]) => count > 0 && SKIP_REASONS[key])
    .map(([key, count]) => /** @type {(count: number) => string} */ (SKIP_REASONS[key])(count));
  if (reasons.length) {
    warnings.push({
      code: "embedded-images-skipped",
      message: `有些内嵌图片没有保留：${reasons.join("；")}`,
    });
  }
  if (stopped === "memory") {
    warnings.push({
      code: "embedded-images-memory",
      message: `提取内嵌图片占用内存过大，已停止；只保留了已经提取的 ${section.kept} 张，其余图片可另存后单独上传`,
    });
  } else if (timedOut) {
    warnings.push({
      code: "embedded-images-timeout",
      message: `提取内嵌图片用时过长，只扫描了前 ${pagesScanned ?? 0} 页；其余页面的图片没有提取`,
    });
  }
  return warnings;
}
