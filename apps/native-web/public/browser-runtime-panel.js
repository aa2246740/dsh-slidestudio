/** @typedef {{ phase: "checking" | "installing" | "ready" | "failed" | "manual", error?: string }} RuntimeState */

/**
 * @param {HTMLElement} root
 * @param {{ request?: typeof fetch, t?: (value: string) => string, onReady?: () => void }} [options]
 */
export function mountBrowserRuntimePanel(root, { request = fetch, t = (value) => value, onReady = () => {} } = {}) {
  const doc = root.ownerDocument;
  const heading = doc.createElement("strong");
  const detail = doc.createElement("p");
  const error = doc.createElement("p");
  const retry = doc.createElement("button");
  const help = doc.createElement("details");
  const summary = doc.createElement("summary");
  const instructions = doc.createElement("p");
  const command = doc.createElement("code");
  const offline = doc.createElement("p");
  const live = doc.createElement("div");
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  live.append(heading, detail);
  error.className = "browser-runtime-error";
  retry.type = "button";
  retry.dataset.control = "chrome.createhub.runtime.retry";
  summary.dataset.control = "chrome.createhub.runtime.help";
  help.append(summary, instructions, command, offline);
  root.className = "browser-runtime-panel";
  root.append(live, error, retry, help);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let disposed = false;
  let busy = false;
  let ready = false;
  let settled = false;
  /** @type {RuntimeState} */
  let currentState = { phase: "checking" };

  /** @param {RuntimeState} state */
  function paint(state) {
    currentState = state;
    const preparing = state.phase === "installing" || state.phase === "checking";
    const nextReady = state.phase === "ready";
    root.dataset.phase = state.phase;
    root.hidden = nextReady || !settled;
    heading.textContent = t(nextReady ? "渲染环境已就绪" : preparing ? "正在准备渲染环境" : "渲染环境尚未就绪");
    detail.textContent = t(
      nextReady
        ? "无需自行安装 Playwright，截图和渲染校验已可用。"
        : preparing
          ? "首次使用需要下载浏览器，请保持应用开启；完成后会自动启用。"
          : "暂时无法截图或进行渲染校验。你仍可以配置模型、整理需求和打开已有文稿。",
    );
    error.textContent = state.error || "";
    error.hidden = !state.error;
    retry.textContent = t(state.phase === "manual" ? "重新检查渲染环境" : "重新准备渲染环境");
    retry.hidden = preparing || nextReady;
    retry.disabled = busy;
    summary.textContent = t("手动安装与离线配置");
    instructions.textContent = t(
      "源码安装：在 SlideStudio 仓库目录运行以下命令，然后重新启动应用。插件用户可先点击重试。",
    );
    command.textContent = "npm run setup:browser";
    offline.textContent = t(
      "离线环境：准备兼容的 Playwright 浏览器运行时，将 SLIDESTUDIO_PLAYWRIGHT_RUNTIME 指向 runtime.mjs 后重启。只有 npm 包而没有浏览器文件仍不可用。",
    );
    help.hidden = nextReady;
    if (nextReady && !ready) onReady();
    ready = nextReady;
    clearTimeout(timer);
    if (preparing && !disposed)
      timer = setTimeout(() => {
        void refresh();
      }, 2000);
  }

  async function refresh(install = false) {
    if (busy || disposed) return;
    busy = true;
    retry.disabled = true;
    clearTimeout(timer);
    try {
      const response = await request("/slides/runtime", {
        method: install ? "POST" : "GET",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(t("无法连接渲染环境服务，请确认应用已启动后重试。"));
      const state = await response.json();
      settled = true;
      if (!disposed) paint(state);
    } catch (cause) {
      settled = true;
      if (!disposed) paint({ phase: "failed", error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      busy = false;
      retry.disabled = false;
    }
  }
  retry.addEventListener("click", () => {
    void refresh(true);
  });
  paint({ phase: "checking" });
  void refresh();
  return {
    refresh,
    repaint() {
      paint(currentState);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
