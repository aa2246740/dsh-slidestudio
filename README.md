# DSH SlideStudio

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的演示文稿插件：描述需求，AI 生成稿件；在画布上修改，再导出可编辑 PPTX。

**DSH SlideStudio — create and edit presentations inside DeepSeek Harness.**

## 安装

版本 **0.2.2**，支持 DeepSeek Harness **0.2.0-rc.2 至 0.2.x**。

### 桌面端：输入一个名字

打开 **插件 → 添加插件**，输入：

```text
dsh-slidestudio
```

点击安装，再点击 **立即启用**。安装了 Personal 时，入口在 Personal 侧栏；否则入口在工作空间主导航。Personal 为可选依赖，使用时需 **0.2.8 或更新的 0.2.x**（[Personal 0.2.8 安装包](https://github.com/aa2246740/dsh-personal-entry/releases/tag/v0.2.8)）。

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

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。
