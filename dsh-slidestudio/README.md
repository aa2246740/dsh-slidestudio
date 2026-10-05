# DSH SlideStudio

AI presentations for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): describe your deck, edit it on the canvas and export editable PPTX. 中英双语，使用 DSH 中已配置的模型。

## Install / 安装

**Desktop:** open **Plugins → Add plugin**, enter `dsh-slidestudio`, install and enable it.

**桌面端：**打开 **插件 → 添加插件**，输入 `dsh-slidestudio`，安装后点击 **立即启用**。

**CLI (Web profile):**

```sh
dsh plugin --profile web add dsh-slidestudio
```

This prebuilt npm package uses the official `dsh.bundle.patch` convention. No source checkout or install-time build is needed.

Requires DeepSeek Harness 0.2.0-rc.2 through 0.2.x and Node.js ^22.19.0 or >=24.0.0. The optional Personal entry requires dsh-personal 0.2.8 through 0.2.x; otherwise Slides appears in the main navigation.

## Before generating

Configure a model in **DSH Settings → Models**. Page rendering uses a pinned **Playwright / Chromium Headless Shell** runtime. The plugin finds one automatically — a `SLIDESTUDIO_PLAYWRIGHT_RUNTIME` override, a repo or managed copy under the DSH data dir, a healthy `~/.codex` seed, or a Playwright already installed on the machine — and downloads the pinned runtime in the background when the machine has none. See the [runtime and migration guide](https://github.com/aa2246740/dsh-slidestudio/blob/main/INSTALL-DSH.md).

Generation checks for this rendering runtime before starting. Model visual review additionally
requires image input in the Harness-resolved model capabilities. Text-only models can complete
deterministic page and deck checks, then compose and export; they do not perform model visual review.
If a model stops early, the conversation shows which checks remain and how to continue.

## Features

- Live AI generation with progress, stop and continue controls
- Canvas editing for text, images, shapes and charts
- Element annotations and an AI assistant
- Editable PPTX export for PowerPoint / WPS
- The same model catalog as DSH
- Personal sidebar or standalone navigation

New installations keep projects under `$DSH_HOME/data/dsh-slidestudio/workspace`, outside the package. Linked source workspaces keep their existing project location. Follow the migration guide before uninstalling a 0.2.0 or old-name installation.

[Repository](https://github.com/aa2246740/dsh-slidestudio) · [Releases](https://github.com/aa2246740/dsh-slidestudio/releases) · [Issues](https://github.com/aa2246740/dsh-slidestudio/issues)

Apache-2.0.

生成会话会归入「演示文稿 · SlideStudio」工作区；侧栏使用「按工作区分组」即可收起记录。误点记录时，通过「在演示文稿中继续」打开对应 PPT，工作区输入框不再接受编辑指令。来自不同旧目录的会话可能分组显示，已有工作区名称会保留。
