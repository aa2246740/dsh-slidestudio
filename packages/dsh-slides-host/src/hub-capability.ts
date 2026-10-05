import {
  inspectCapabilities,
  type CapabilitySnapshot,
  type ModelInputModality,
} from "@open-slidestudio/presentation-run";

export type HubCapabilityCard = CapabilitySnapshot;

/** Stop before creating a paid generation that cannot pass its render gate. */
export function assertGenerationRenderingReady(
  card: Pick<CapabilitySnapshot, "render">,
  mode?: string,
  provisionError?: string,
): void {
  if (mode === "discuss" || card.render) return;
  const auto = provisionError
    ? `已尝试自动准备渲染运行时但失败（${provisionError.slice(0, 200)}）；`
    : "";
  throw new Error(`页面渲染环境未就绪，暂未开始生成。${auto}可按安装说明手动配置 Playwright 1.61.1 / Chromium Headless Shell 1228 运行时（SLIDESTUDIO_PLAYWRIGHT_RUNTIME）后重试；这不代表当前模型不支持视觉。已有文稿不受影响。`);
}

export function hubCapabilityCard(input: {
  readonly providerId: string;
  readonly ready: boolean;
  readonly modelId?: string;
  readonly modelInputModalities?: readonly ModelInputModality[];
  readonly env?: NodeJS.ProcessEnv;
  readonly rasterReady?: boolean;
  readonly nativeSearch?: boolean;
}): HubCapabilityCard {
  return inspectCapabilities({
    env: input.env ?? process.env,
    providerId: input.providerId,
    modelId: input.modelId,
    modelInputModalities: input.modelInputModalities,
    ready: input.ready,
    rasterReady: input.rasterReady,
    nativeSearch: input.nativeSearch,
  });
}
