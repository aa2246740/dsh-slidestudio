export type ImageGeneratePreset =
  "openai" | "dashscope-sync" | "dashscope-task" | "gemini-imagen" | "stability" | "template";

export const IMAGE_GENERATE_PRESETS: readonly ImageGeneratePreset[] = [
  "openai",
  "dashscope-sync",
  "dashscope-task",
  "gemini-imagen",
  "stability",
  "template",
];

export function generatePreset(preset?: string): ImageGeneratePreset {
  const normalized = preset?.trim();
  return (IMAGE_GENERATE_PRESETS as readonly string[]).includes(normalized ?? "")
    ? (normalized as ImageGeneratePreset)
    : "openai";
}

export function aspectRatio(aspect?: string): string {
  const raw = (aspect || "16:9").trim();
  if (raw === "square") return "1:1";
  if (raw === "portrait") return "3:4";
  if (raw === "widescreen") return "16:9";
  return raw;
}

export function sizeForAspect(aspect?: string): string {
  const ratio = aspectRatio(aspect);
  if (ratio === "1:1") return "1024x1024";
  if (ratio === "3:4" || ratio === "9:16") return "1024x1536";
  if (ratio === "4:3") return "1024x768";
  return "1536x1024";
}

export function dashscopeSyncSize(aspect?: string): string {
  const ratio = aspectRatio(aspect);
  if (ratio === "1:1") return "1328*1328";
  if (ratio === "3:4") return "1140*1472";
  if (ratio === "9:16") return "928*1664";
  if (ratio === "4:3") return "1472*1140";
  return "1664*928";
}

export function dashscopeTaskSize(aspect?: string): string {
  const ratio = aspectRatio(aspect);
  if (ratio === "1:1") return "1024*1024";
  if (ratio === "3:4" || ratio === "9:16") return "960*1440";
  if (ratio === "4:3") return "1024*768";
  return "1440*960";
}

export function stabilityAspect(aspect?: string): string {
  const ratio = aspectRatio(aspect);
  if (ratio === "1:1" || ratio === "16:9" || ratio === "9:16") return ratio;
  if (ratio === "4:3") return "3:2";
  if (ratio === "3:4") return "2:3";
  return "16:9";
}
