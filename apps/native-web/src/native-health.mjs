/** @param {NodeJS.ProcessEnv} env */
export function hasNativeModelKey(env) {
  return [
    env.MINIMAX_CN_API_KEY,
    env.MINIMAXCN_API_KEY,
    env.MINIMAX_API_KEY,
    env.OPENROUTER_ONLYUSE_FREEMODEL_API_KEY,
  ].some((value) => Boolean(value?.trim()));
}

/** @param {{researchOn: boolean, imageSearchOn: boolean, imageGenerateOn: boolean, visionOn: boolean, renderReady: boolean}} config */
export function nativeCapability({ researchOn, imageSearchOn, imageGenerateOn, visionOn, renderReady }) {
  return {
    research: researchOn ? { mode: "http", configured: true } : { mode: "attachments-gap", configured: false },
    imageSearch: { configured: imageSearchOn, via: imageSearchOn ? "http" : "none" },
    imageGenerate: { configured: imageGenerateOn, via: imageGenerateOn ? "http" : "none" },
    vision: visionOn
      ? {
          mode: "main-model",
          note: "Main chat may accept image_url parts. If it cannot, admit you did not see the slide.",
        }
      : { mode: "none", note: "No vision. Structural QA only. Do not pretend you saw the page." },
    pageRaster: { mode: "native-slide", note: "render_page screenshots native #slide." },
    render: renderReady,
    runtime: { kind: "dsh", piAvailable: false, piNote: "Pi is not the product kernel. Use MiniMax China via DSH." },
    mediaPolicy: "optional",
  };
}
