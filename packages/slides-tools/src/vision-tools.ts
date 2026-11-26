/**
 * Tools that only make sense when the selected model accepts image input.
 * The allowlist hides them from text-only models; these messages cover a call
 * that arrives anyway (the tool guard, and the execute-time defense).
 */
export const VISION_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(["view_material", "record_material_notes"]);

export function visionUnavailableDetail(name: string): string {
  return name === "record_material_notes"
    ? "当前模型不能看图，record_material_notes 不可用；没有看过图片就无法记录看图说明。"
    : "当前模型不能看图，view_material 不可用；图片资料只能使用尺寸、主色等元信息。";
}
