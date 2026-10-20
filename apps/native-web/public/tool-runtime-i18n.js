export const TOOL_RUNTIME_I18N = {
  "此修改已停止运行。当前演示文稿不会回滚，之前的快照仍保留在版本历史中；待处理指令会保留在编辑框中。是否解除本地保护？":
    "This edit has stopped running. The current deck will not be rolled back; the previous snapshot remains in version history, and the pending instruction will be preserved in the editor. Release local protection?",
  "无法归档待处理指令；本地保护仍保持。":
    "Could not archive the pending instruction; local protection remains enabled.",
  "待处理指令已恢复到编辑框；演示文稿未回滚。":
    "The pending instruction was restored to the editor; the deck was not rolled back.",
  渲染环境: "Rendering environment",
  渲染环境已就绪: "Rendering is ready",
  正在准备渲染环境: "Preparing the rendering environment",
  渲染环境尚未就绪: "Rendering is not ready yet",
  "无需自行安装 Playwright，截图和渲染校验已可用。":
    "No manual Playwright installation needed. Screenshots and rendering checks are available.",
  "首次使用需要下载浏览器，请保持应用开启；完成后会自动启用。":
    "First use requires a browser download. Keep the app open; rendering will be enabled automatically when ready.",
  "暂时无法截图或进行渲染校验。你仍可以配置模型、整理需求和打开已有文稿。":
    "Screenshots and rendering checks are unavailable for now. You can still configure models, draft your brief and open existing presentations.",
  重新准备渲染环境: "Retry browser setup",
  重新检查渲染环境: "Check browser setup again",
  手动安装与离线配置: "Manual and offline setup",
  "源码安装：在 SlideStudio 仓库目录运行以下命令，然后重新启动应用。插件用户可先点击重试。":
    "Source checkout: run the command below in the SlideStudio repository, then restart the app. Plugin users can try the retry button first.",
  "离线环境：准备兼容的 Playwright 浏览器运行时，将 SLIDESTUDIO_PLAYWRIGHT_RUNTIME 指向 runtime.mjs 后重启。只有 npm 包而没有浏览器文件仍不可用。":
    "Offline: provide a compatible Playwright browser runtime, set SLIDESTUDIO_PLAYWRIGHT_RUNTIME to runtime.mjs, then restart. The npm package alone is not enough; browser files are required.",
  "无法连接渲染环境服务，请确认应用已启动后重试。":
    "Cannot reach the rendering service. Make sure the app is running, then retry.",
  视觉检查已在运行配置中关闭: "Visual review is disabled in the runtime configuration",
  "页面渲染环境未就绪，暂时无法截图检查；请查看安装说明中的渲染运行时配置":
    "Page rendering is not ready, so screenshot review is unavailable. See the rendering runtime section of the installation guide.",
};
