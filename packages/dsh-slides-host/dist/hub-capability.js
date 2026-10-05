import { inspectCapabilities, } from "@open-slidestudio/presentation-run";
/** Stop before creating a paid generation that cannot pass its render gate. */
export function assertGenerationRenderingReady(card, mode) {
    if (mode === "discuss" || card.render)
        return;
    throw new Error("页面渲染环境未就绪，暂未开始生成。请按安装说明配置 Playwright 1.61.1 / Chromium Headless Shell 1228 运行时后重试；这不代表当前模型不支持视觉。已有文稿不受影响。");
}
export function hubCapabilityCard(input) {
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
//# sourceMappingURL=hub-capability.js.map