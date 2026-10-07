# Settings

`#btn-settings` swaps `#home-screen` for `#settings-screen`. The nav shows four panes chosen by
`[data-settings-pane]`: 模型 (`#pane-models`), 订阅登录 (`#pane-oauth`), 工具 (`#pane-tools`),
外观 (`#pane-appearance`). Driver id `hub-settings`
(`drivers/hub.mjs`). The Hub picker is a floating listbox `#pi-model` whose option buttons carry
`data-model-key="providerId/modelId"`; login belongs to Settings. Driver id `hub-create`.

## What the driver proves (providers and tool settings stubbed in the page, no real kernel or key)

- Each tab shows exactly one pane; back returns to the Hub.
- 模型: rows with a ready dot; + 添加提供方 lists unused presets; adding one opens its key field; 保存 posts
  the key to that provider only; the key is not in the page text or any input afterwards; a custom
  provider form (`#custom-*`) adds a row tagged 自定义; 删除 removes a user-added provider
  (`DELETE /slides/providers/:id`) but only the stored key of a built-in one (`…/key`).
- 订阅登录: 未登录 → 账号登录 → a code challenge input → 继续 → 已登录.
- 工具: the nav opens `#pane-tools`. Each endpoint has a format select — `#search-preset`
  (generic POST / Pixabay / Pexels / Unsplash / Bing 图片 / 自定义模板) and `#image-preset`
  (OpenAI 兼容 / 阿里百炼·同步 / 阿里百炼·异步任务 / Gemini Imagen / Stability SD3 / 自定义模板).
  Choosing 自定义模板 expands `#search-tpl` (5 fields incl. 署名) or `#image-tpl` (4 fields, no
  署名); a named preset collapses it. Save PUTs both endpoints with `preset` (and `template`
  when chosen), clears the key field and says 已保存; invalid template headers JSON are refused
  client-side before the PUT; clearing a URL switches that service off.
- 外观: two radios (暖调, 水墨 · OOPS). Choosing one sets `html[data-theme]` and `localStorage["oss.theme"]`
  (`warm` removes both); a reload applies it before first paint (`theme-boot.js`); the editor opens in
  the same theme.

## Gotchas

- Keys used are fake (`sk-verify-NOT-A-REAL-KEY-0000`); assert only that they are absent.
- The OAuth pane's real login opens a browser window and polls; the driver only covers the code
  challenge path.
- Theme is per browser (`localStorage`), so each scratch browser context starts in 暖调.
