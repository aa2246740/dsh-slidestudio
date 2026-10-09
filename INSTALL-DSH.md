# 安装与运行 DSH SlideStudio

## 官方安装方式

桌面端打开 **插件 → 添加插件**，输入 `dsh-slidestudio`，安装后点击 **立即启用**。

Web profile 使用：

```sh
dsh plugin --profile web add dsh-slidestudio
```

也可安装 [GitHub Release](https://github.com/aa2246740/dsh-slidestudio/releases) 中的 `.tgz`；将文件绝对路径填入同一输入框。包名、npm 名、插件 ID 均为 `dsh-slidestudio`，展示名为 **DSH SlideStudio**。

预编译包通过 `dsh.bundle.patch` 激活服务端和客户端，无需安装时构建，也不要再手动添加重复 patch。约定来自官方[发布指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)与[插件管理器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.zh.md)。

要求 Node.js `^22.19.0 || >=24.0.0`、DSH `>=0.2.0-rc.2 <0.3.0-0`。Personal 可选；使用时需 `>=0.2.8 <0.3.0`。安装 Personal 后从其侧栏进入；未安装时从主导航进入。

## 渲染运行时

PPT 页面渲染使用 pinned 的 **Playwright 1.61.1、Chromium Headless Shell 1228**。插件包不含浏览器，但会自己把运行时找出来或装好，通常不需要手动配置。

启用时按以下顺序查找，第一个可用的即生效：

1. `SLIDESTUDIO_PLAYWRIGHT_RUNTIME` 指向的 runtime.mjs（设置后只认它）
2. 源码仓库 `.runtime/playwright/runtime.mjs`（开发环境 `npm run setup:browser` 生成）
3. 托管运行时 `$DSH_HOME/data/dsh-slidestudio/playwright-runtime/runtime.mjs`，模块与浏览器齐全才使用
4. `~/.codex/playwright-runtime/runtime.mjs`，同样要求模块与浏览器齐全、版本与声明一致；缺件或版本不符直接跳过，不会再锁死在一个不可用的文件上
5. 机器上已有的 Playwright（全局 `npm i -g playwright` 等安装方式 + `PLAYWRIGHT_BROWSERS_PATH` 或系统默认浏览器目录里能启动的 Chromium）；找到后自动登记到托管目录再使用

都找不到时插件在后台自动安装 pinned 运行时：从 npm registry 拉取 `playwright` / `playwright-core` 包（`registry.npmmirror.com` 作为备用源），用 Playwright 自带的安装命令下载 Chromium Headless Shell，写入托管目录；安装过程不依赖机器上装有 npm。机器上只有一半时（比如只有 Playwright 包或只有浏览器）会复用已有的一半、只补另一半。装好后生成照常进行，无需重启。

仍需要手动指定时（例如统一维护的运行时）：

```sh
export SLIDESTUDIO_PLAYWRIGHT_RUNTIME=/absolute/path/to/runtime.mjs
```

在启动 DSH 的同一环境中检查托管运行时：

```sh
node --input-type=module -e 'import { homedir } from "node:os"; import { pathToFileURL } from "node:url"; const p = process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME || (process.env.DSH_HOME || homedir() + "/.dsh") + "/data/dsh-slidestudio/playwright-runtime/runtime.mjs"; const r = await import(pathToFileURL(p)); console.log(await r.verifyPinnedRuntime());'
```

自动安装失败（断网、registry 不可达）时，生成入口会说明失败原因，再由运行环境维护者提供运行时；不要用系统 Chrome 替代。

## 配置模型

在 **DSH 设置 → 模型** 中完成模型配置。SlideStudio 的模型选择器读取当前 Harness 的目录和凭据，不另建一套模型配置。在插件中点击设置会打开 DSH 设置；关闭后返回原入口。

### 页面截图与视觉检查

页面截图需要上面的渲染运行时；让模型看图还需要当前 **provider / model** 在 Harness 中声明支持图片输入。插件按 Harness 解析后的模型能力开放视觉工具，不根据模型名字猜测。

- 渲染环境缺失：开始生成前会提示配置运行时，避免生成到最后才发现无法检查页面。
- 模型支持图片：`render_page` 把页面 PNG 作为图片附件交给模型，再由 `review_page` 记录检查结果。
- 模型只支持文本：仍可生成，通过截图、确定性排版检查和整稿检查后合稿、导出；不会宣称已完成模型视觉检查。
- 显示“已生成 N 页，收尾未完成”：状态下方会列出尚未完成的检查，可点击“继续完成生成”。这不一定伴随模型异常；模型提前结束回复也会留下未完成步骤。

## 数据位置

- 新安装：`$DSH_HOME/data/dsh-slidestudio/workspace/output/dsh-slices/` 保存生成项目，`output/attachments/` 保存上传材料。
- 未指定 `DSH_HOME` 时，使用当前 Harness profile 的 Home，通常是 `~/.dsh`。
- 已连接的源码工作区：保留原项目位置，避免复制整份仓库。
- 位置记录：`$DSH_HOME/data/dsh-slidestudio/workspace.json`。
- 自定义位置：在启动 Host 前设置绝对路径 `SLIDESTUDIO_DATA_DIR`。该目录成为后续安装复用的项目位置。

卸载插件不会清理上述固定目录。位置记录指向已不存在的目录时，插件会报错，需恢复目录或明确设置新的数据目录。

## 旧版本迁移

**0.2.0 和旧名 `dsh-openslides` 可能把项目保存在插件包目录。卸载前先迁移数据。**

1. 找到旧安装中含有 `output/dsh-slices` 的目录。
2. 将其中的 `output/` 保留到插件安装目录之外的固定位置，例如 `~/SlideStudio-data/output/`；保留旧数据直到新入口验证完成。
3. 设置 `SLIDESTUDIO_DATA_DIR` 为固定目录的绝对路径（上例为 `/Users/你的用户名/SlideStudio-data`），让当前 Host 读取该配置。
4. 通过插件管理器卸载旧包、安装 `dsh-slidestudio` 并启用，确认历史稿件能够打开、编辑和导出。

已经用本版本连接过的源码工作区，会记录原目录；后续改为 npm 安装可继续读取它，不用搬动原稿。

## 从源码开发

```sh
git clone https://github.com/aa2246740/dsh-slidestudio.git
cd dsh-slidestudio
npm run setup:dev
```

这一命令安装锁定依赖、构建原生包、准备固定浏览器，然后运行独立开发
profile。Hub 在 `http://127.0.0.1:13080`，编辑器在
`http://127.0.0.1:55200`。Ctrl+C 停止本次启动的服务。后续仅构建用
`npm run build:native`，启动用 `npm start`；测试命令见 [AGENTS.md](AGENTS.md)。
开发 profile 是仓库中的 `.dsh/home`，不是桌面端正在使用的 Home。

客户端编译还需插件目录中的开发依赖及 dshx 的 `externalClientBundle` 适配器。设置 `DSHX_HARNESS` 为含 `tools/dshx/src/client-build.js` 的 Harness 路径，在插件目录安装开发依赖后执行 `npm run build --prefix dsh-slidestudio`。官方 Harness 源码不需要修改。

从本地源码链接切换到 npm 包时，当前 Host 可能仍缓存旧模块。安装后核对实际运行路径；若仍是旧源码，正常退出并重新打开 DSH，再检查项目与生成。桌面端卸载本地链接偶尔会留下同名软链接，应确认它已不在 profile 配置中且只指向旧源码，再由维护者处理；不要删除源码或项目目录。

在当前 Harness 的插件管理器中添加本仓库的 `dsh-slidestudio/` 绝对路径。不要向同一 Home 启动第二个 Host。

## 构建发布包

完成上面的构建环境后，在仓库根目录运行：

```sh
npm run release:package
```

产物位于 `dsh-slidestudio/.local/release/`，包含 `.tgz` 和 `SHA256SUMS`。脚本检查最终包的生产依赖、生成资源、形状资源和实际可编辑 PPTX 导出，临时解包目录会自动清理。

发布前还需在真实 Harness 中检查双入口、模型同步、生成、设置跳转、下载以及升级后的项目保留。自动回归使用模拟模型边界，不能代替真实模型验收。

| 环境变量                         | 作用                               |
| -------------------------------- | ---------------------------------- |
| `SLIDESTUDIO_DATA_DIR`           | 固定项目目录，需绝对路径           |
| `SLIDESTUDIO_PLAYWRIGHT_RUNTIME` | 指定浏览器运行时模块，设置后只认它 |
| `SLIDES_EDITOR_PORT`             | 编辑器本地端口，默认 `56200`       |
| `SLIDESTUDIO_SKILL_ROOT`         | 可选，覆盖设计资源目录             |
