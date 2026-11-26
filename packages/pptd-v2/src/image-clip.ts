/**
 * Crop rules for pictures and picture fills (VAL-PPTD-004 to 006). A crop is a
 * fraction of the natural picture removed from each side. The visible part must
 * keep some area in both axes, so the picture never collapses to nothing.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Chinese refusal for one crop object, or undefined when every side is usable. `label` names the owner, for example "crop". */
export function cropIssue(crop: unknown, label: string): string | undefined {
  if (crop == null) return undefined;
  if (!isRecord(crop)) return `${label} 必须是对象`;
  const sides: Record<"left" | "top" | "right" | "bottom", number> = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  };
  for (const side of ["left", "top", "right", "bottom"] as const) {
    const value = crop[side] ?? 0;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return `${label}.${side} 必须是 0 到 1 之间的数字`;
    }
    sides[side] = value;
  }
  if (sides.left + sides.right >= 1 || sides.top + sides.bottom >= 1) {
    return `${label} 的左右或上下裁切之和必须小于 1，否则没有可见的图片`;
  }
  return undefined;
}

/**
 * Chinese write-page refusals for every picture crop and every picture-filled
 * shape crop in an element list. Each message names the element index and id.
 */
export function imageClipIssues(elements: unknown): string[] {
  if (!Array.isArray(elements)) return [];
  const issues: string[] = [];
  elements.forEach((item, index) => {
    if (!isRecord(item)) return;
    const where = `$.elements[${index}]（elementId "${String(item.elementId ?? "")}"）`;
    if (item.elementType === "image") {
      const issue = cropIssue(item.crop, "crop");
      if (issue) issues.push(`${where}的 ${issue}`);
    }
    if (item.elementType === "shape" && isRecord(item.fill) && item.fill.type === "image") {
      const issue = cropIssue(item.fill.crop, "fill.crop");
      if (issue) issues.push(`${where}的 ${issue}`);
    }
  });
  return issues;
}
