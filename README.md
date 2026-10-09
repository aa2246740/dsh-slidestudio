# DSH SlideStudio

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的演示文稿插件：描述需求，AI 生成稿件；在画布上修改，再导出可编辑 PPTX。

**DSH SlideStudio — create and edit presentations inside DeepSeek Harness.**

## 安装

版本 **0.2.3**，支持 DeepSeek Harness **0.2.0-rc.2 至 0.2.x**。

### 桌面端：输入一个名字

打开 **插件 → 添加插件**，输入：

```text
dsh-slidestudio
```

点击安装，再点击 **立即启用**。安装了 Personal 时，入口在 Personal 侧栏；否则入口在工作空间主导航。Personal 为可选依赖，支持 **0.2.8 或更新的 0.2.x**，推荐升级到 [Personal 0.2.9](https://github.com/aa2246740/dsh-personal-entry/releases/tag/v0.2.9)，它修复了侧栏入口挤压，并支持直接回到对应 PPT。

升级后若安装器提示「下次启动后加载」，请先等正在运行的任务结束，再正常退出并重新打开 DSH，完成后台更新。

### 命令行：一条命令

安装到 Web profile：

```sh
dsh plugin --profile web add dsh-slidestudio
```

桌面端建议使用上面的插件管理器，确保安装到当前窗口使用的 profile。也可从 [Releases](https://github.com/aa2246740/dsh-slidestudio/releases) 下载 `.tgz`，在「添加插件」中输入其绝对路径。

采用官方支持的 **npm 包 + `dsh.bundle.patch`** 方式，包内已编译，安装时不需要克隆仓库或构建源码。约定见官方[插件发布指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)和[插件管理器说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.zh.md)。

### 开始生成前

1. 在 **DSH 设置 → 模型** 中接入模型，SlideStudio 使用同一份模型列表。
2. 渲染需要 **Playwright 1.61.1 / Chromium Headless Shell 1228** 的运行时。插件不包含浏览器，也不会在安装时下载它；默认读取 `~/.codex/playwright-runtime/runtime.mjs`，其他位置通过 `SLIDESTUDIO_PLAYWRIGHT_RUNTIME` 指定。检查方法见 [安装与运行说明](INSTALL-DSH.md#渲染运行时)。缺少运行时的机器，安装插件后仍需先配置渲染环境。

## 功能

- **AI 生成**：输入主题和用途，生成大纲、页面和渲染结果，随时查看进度、停止或继续。
- **画布编辑**：修改文字、图片、形状、图表和样式。
- **批注与助手**：选中元素留下批注，或让 AI 继续修改稿件。
- **可编辑 PPTX**：文本、形状和支持的图表导出为原生对象，可在 PowerPoint / WPS 中继续编辑。
- **中英双语**：跟随 DSH 的语言设置。
- **两种入口**：Personal 侧栏或独立主导航，使用当前 Harness 的模型与凭据。

## 数据与升级

新安装的项目保存在 `$DSH_HOME/data/dsh-slidestudio/workspace`，不随插件卸载而删除。已连接的源码工作区继续使用原目录，位置记录在 `$DSH_HOME/data/dsh-slidestudio/workspace.json`。

官方插件管理器目前通过卸载后重新安装来升级。**从 0.2.0 或旧名 `dsh-openslides` 升级前，先按[迁移说明](INSTALL-DSH.md#旧版本迁移)保留项目**；旧版本尚未使用固定数据目录。

源码开发、运行时要求与数据位置见 [INSTALL-DSH.md](INSTALL-DSH.md)。

## 源码开发

要求 Node.js `^22.19.0 || >=24.0.0` 和 npm。在克隆后的仓库根目录运行：

```sh
npm run setup:dev
```

这一命令依次安装锁定依赖、构建原生包、准备固定浏览器并启动产品；
Ctrl+C 停止本次服务。已初始化的仓库用 `npm start`，不必重新安装。

打开 `http://127.0.0.1:13080`，编辑器在 `http://127.0.0.1:55200`。
安装需要联网；生成前在设置中配置模型。开发使用独立的 `.dsh/home`，
不会向桌面端的 Home 启动第二个 Host。
端口被占用时，通过 `SLIDES_DSH_PORT` 和 `SLIDES_EDITOR_PORT` 选择空闲端口，
保留其他正在运行的服务。

日常构建用 `npm run build:native`；完整构建（含旧版应用）用 `npm run build`。
完整构建后类型检查用 `npm run typecheck`，原生包测试用 `npm run test:native`，
编辑器测试用 `npm test -w @open-slidestudio/native-web`。
`npm run dev` 仅启动已归档的旧版 web/API，不是正常产品入口。
代理开发流程与测试边界见 [AGENTS.md](AGENTS.md)。

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。

## 生成会话与工作区

生成会话不出现在工作侧栏。新会话以子代理身份创建，分组、平铺和搜索都不列出。升级前留下的生成会话会在插件启动时归档，原来的「演示文稿 · SlideStudio」工作区登记一并删除，会话日志和文稿目录不动。旧文稿再次交给 AI 修改时，对应的旧会话会取消归档，重新出现在侧栏里。

从归档列表打开生成会话时，可以查看生成记录，输入框会显示「在演示文稿中继续」。点击会打开对应 PPT；内容修改、继续或停止生成都在编辑器完成。普通工作会话仍可正常输入。

升级会自动整理能识别的旧 PPT 会话。官方工作区以会话最初的工作目录为准，因此来自不同旧目录的记录可能分成几个组；已有工作区名称会保留。当前官方接口没有独立的插件会话隐藏开关，平铺视图和搜索仍能看到这些记录。
