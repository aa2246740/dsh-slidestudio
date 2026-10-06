# Recent work ("继续协作")

`GET /api/projects` lists directories with a `.pptd` directly under `output/` and
`output/dsh-slices/`. The Hub shows them as rows; fixtures are hidden. Driver id `hub-projects`
(`drivers/hub.mjs`).

## What the driver proves

- A scratch project `output/verify-<run>-hub-projects` with a unique title is listed by that title with
  `8 页 · 刚刚 · <磁盘占用>` (`sizeBytes` from `/api/projects`), and an unread dot until opened.
- Fixtures are never listed.
- Clicking a row opens `index.html?project=<dir>&workspace=1`, the editor shows that deck, the path is
  added to `localStorage["oss.viewed.projects"]`, and back on the Hub the dot is gone.
- The trash button (`.proj-trash`, `aria-label="删除项目…"`) opens a `confirm` naming the project;
  cancelling keeps row and directory; accepting removes both and toasts 已删除.
- `DELETE /api/projects` with a path outside `output/` answers 400 and leaves it (checked on a copy in
  `os.tmpdir()`), and with no path answers 400.

## Gotchas

- The list also shows the user's real projects under `output/`. Never delete or select anything that
  is not `verify-<run>-*`; `ctx.outputProject()` cleans up its own leftovers in `stop()`.
- The empty state (还没有项目…) cannot be asserted on a workspace that has real projects.
- The row is a link plus a click handler; the trash button only shows on hover or focus.
