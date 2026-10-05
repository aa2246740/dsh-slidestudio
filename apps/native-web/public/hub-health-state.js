import { t } from "./i18n.js";

function cleanSelection(selection = {}) {
  return {
    provider: String(selection.provider || "").trim(),
    model: String(selection.model || "").trim(),
  };
}

export function createHealthRequestGate() {
  let latest = 0;
  return {
    begin(selection) {
      return { id: ++latest, selection: cleanSelection(selection) };
    },
    isCurrent(request, selection) {
      const current = cleanSelection(selection);
      return Boolean(
        request &&
        request.id === latest &&
        request.selection.provider === current.provider &&
        request.selection.model === current.model,
      );
    },
  };
}

export function healthSelectionMatches(requested, received) {
  const want = cleanSelection(requested);
  const got = cleanSelection({
    provider: received?.providerId ?? received?.provider,
    model: received?.model,
  });
  return (!want.provider || want.provider === got.provider) &&
    (!want.model || want.model === got.model);
}

export function selectedHealthReady(health) {
  return health?.selection?.ready === true;
}

/**
 * The four things the Hub strip shows for the model the user is about to
 * send. `on` lights the chip; `hint` explains why on hover.
 */
export function capabilityViewModel(card, extras = {}) {
  if (extras.state === "loading" || extras.state === "mismatch" || extras.state === "error" || !card) {
    return { chips: [] };
  }

  const visionMode = card.vision?.mode;
  const modelAcceptsImages = card.vision?.modelAcceptsImages;
  const providerReady = extras.piAuthReady ?? extras.piAvailable ?? card.runtime?.piAvailable;
  const visionOn = visionMode === "main-model" || visionMode === "reviewer";
  const visionReason = card.vision?.unavailableReason;
  const visionHint = visionMode === "main-model"
    ? t("当前模型能看页面")
    : visionMode === "reviewer"
      ? t("由独立审阅模型看页面")
      : visionReason === "disabled"
        ? t("视觉检查已在运行配置中关闭")
        : visionReason === "raster-unavailable" || card.render === false
          ? t("页面渲染环境未就绪，暂时无法截图检查；请查看安装说明中的渲染运行时配置")
          : visionReason === "provider-unavailable"
            ? t("当前模型尚未连接，请在 DSH 设置中完成登录或配置")
            : modelAcceptsImages && !providerReady
              ? t("这个模型能看页面，但还没登录")
              : t("Harness 未声明当前模型支持图片输入，请选择支持看图的模型");
  const researchOn = Boolean(card.research?.configured);
  const nativeSearch = card.research?.via === "native" || card.research?.via === "pi-xai-hosted";
  const searchOn = Boolean(card.imageSearch?.configured);
  const generateOn = Boolean(card.imageGenerate?.configured);

  return {
    chips: [
      { id: "vision", label: t("看图"), on: visionOn, hint: visionHint },
      { id: "research", label: t("联网"), on: researchOn, hint: researchOn ? (nativeSearch ? t("联网检索 · 模型自带") : t("联网检索工具 · 已配置")) : t("联网检索 · 未配置") },
      { id: "search", label: t("搜图"), on: searchOn, hint: searchOn ? t("搜图工具 · 已配置") : t("搜图工具 · 未配置") },
      { id: "generate", label: t("生图"), on: generateOn, hint: generateOn ? t("生图工具 · 已配置") : t("生图工具 · 未配置") },
    ],
  };
}
