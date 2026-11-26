import { imageClipIssues } from "@open-slidestudio/pptd-v2";
import { mediaExists } from "@open-slidestudio/presentation-run";

/**
 * Write-time refusals for the media a page draws (VAL-PPTD-004 to 006). A picture
 * and a picture-filled shape must name a file under the project's `media/`, and a
 * picture crop must leave a visible area. Every Chinese message names the element,
 * so the agent can repair that one element and write the page again.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const REPAIR_MEDIA = "请先用 search_image 或 generate_image 取得素材，再写入该元素";

/** The media source drawn by an element, or undefined when it draws no picture. */
function drawnMediaSource(item: Record<string, unknown>): { src: string; fill: boolean } | undefined {
  if (item.elementType === "image") {
    return { src: typeof item.src === "string" ? item.src : "", fill: false };
  }
  if (item.elementType === "shape" && isRecord(item.fill) && item.fill.type === "image") {
    return { src: typeof item.fill.src === "string" ? item.fill.src : "", fill: true };
  }
  return undefined;
}

/** Chinese refusals for every picture or picture fill whose media file is not in the project. */
export function writePageMediaIssues(elements: unknown, projectRoot: string | undefined): string[] {
  if (!projectRoot || !Array.isArray(elements)) return [];
  const issues: string[] = [];
  elements.forEach((item, index) => {
    if (!isRecord(item)) return;
    const drawn = drawnMediaSource(item);
    if (!drawn || (drawn.src && mediaExists(projectRoot, drawn.src))) return;
    const where = `$.elements[${index}]（elementId "${String(item.elementId ?? "")}"）`;
    const label = drawn.fill ? "填充图片" : "图片";
    const shown = drawn.src || "（未填写）";
    issues.push(`${where}的${label}素材 ${shown} 在项目 media/ 中不存在，${REPAIR_MEDIA}`);
  });
  return issues;
}

/** Chinese refusals for write-time media problems; empty when every drawn picture is usable. */
export function writePageMediaRefusal(
  elements: unknown,
  projectRoot: string | undefined,
): { readonly error: "missing_media" | "invalid_crop"; readonly detail: string } | undefined {
  const missing = writePageMediaIssues(elements, projectRoot);
  if (missing.length) return { error: "missing_media", detail: missing.join("\n") };
  const crop = imageClipIssues(elements);
  if (crop.length) return { error: "invalid_crop", detail: crop.join("\n") };
  return undefined;
}
