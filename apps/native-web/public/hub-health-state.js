import { t } from "./i18n.js";
import { isRecord } from "./generation-data.js";

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
  return (!want.provider || want.provider === got.provider) && (!want.model || want.model === got.model);
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
  const visionHint =
    visionMode === "main-model"
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
      {
        id: "research",
        label: t("联网"),
        on: researchOn,
        hint: researchOn
          ? nativeSearch
            ? t("联网检索 · 模型自带")
            : t("联网检索工具 · 已配置")
          : t("联网检索 · 未配置"),
      },
      {
        id: "search",
        label: t("搜图"),
        on: searchOn,
        hint: searchOn ? t("搜图工具 · 已配置") : t("搜图工具 · 未配置（可在 设置 → 工具 接入）"),
      },
      {
        id: "generate",
        label: t("生图"),
        on: generateOn,
        hint: generateOn ? t("生图工具 · 已配置") : t("生图工具 · 未配置（可在 设置 → 工具 接入）"),
      },
    ],
  };
}

/**
 * `true` / `false` when this health document states
 * `capability.vision.modelAcceptsImages`. Missing or non-boolean is unknown
 * (`null`) and must not become a warning.
 * @param {unknown} health
 * @returns {boolean | null}
 */
export function healthModelAcceptsImages(health) {
  if (!isRecord(health)) return null;
  const capability = isRecord(health.capability) ? health.capability : null;
  const vision = capability && isRecord(capability.vision) ? capability.vision : null;
  if (!vision) return null;
  if (vision.modelAcceptsImages === true) return true;
  if (vision.modelAcceptsImages === false) return false;
  return null;
}

/**
 * Input modalities for one provider/model in a `/slides/models` payload. A
 * missing model or list is unknown. An explicit `[]` returns as empty so
 * callers can refuse to treat "not declared yet" as text-only.
 * @param {unknown} directory
 * @param {string} provider
 * @param {string} model
 * @returns {readonly string[] | undefined}
 */
export function modalitiesFor(directory, provider, model) {
  if (!Array.isArray(directory) || !provider || !model) return undefined;
  const group = directory.find(
    (entry) => isRecord(entry) && entry.providerId === provider && Array.isArray(entry.models),
  );
  if (!isRecord(group) || !Array.isArray(group.models)) return undefined;
  const entry = group.models.find((row) => isRecord(row) && row.id === model);
  if (!isRecord(entry) || !Array.isArray(entry.inputModalities)) return undefined;
  /** @type {unknown[]} */
  const modalities = entry.inputModalities;
  return modalities.filter((item) => typeof item === "string");
}

/**
 * Whether the selected model accepts image input. `true`/`false` are definite.
 * `null` is unknown and must not warn. An empty modality list stays unknown:
 * the models route writes `[]` when the live catalog has not declared input yet.
 * @param {boolean | null | undefined} healthAccepts
 * @param {readonly string[] | undefined} modalities
 * @returns {boolean | null}
 */
export function resolveImageCapability(healthAccepts, modalities) {
  if (healthAccepts === true) return true;
  if (Array.isArray(modalities) && modalities.includes("image")) return true;
  if (Array.isArray(modalities) && modalities.length === 0) return null;
  if (Array.isArray(modalities)) return false;
  if (healthAccepts === false) return false;
  return null;
}
