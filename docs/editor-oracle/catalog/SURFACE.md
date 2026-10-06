# Full editor surface enumeration order (locked)

**Ticket:** Full editor surface enumeration order (no MVP shortcut)  
**Method:** OOP-29 — comprehensive, no minimum path  
**Row format:** OOP-30 — `docs/editor-oracle/schema/SPEC.md`

## Principles

1. **Breadth-first catalog, depth-first capture.** First list *all* controls in a section as `discovered` rows (id + title + location), then capture dual-channel evidence section by section until every intended row is `specified` → `implemented` → `verified`.
2. **No shipping native UI for a section until its catalog table exists** (even if many rows are still `discovered`).
3. **Order below is mandatory for work sequencing** (what we attack next). Skipping ahead is allowed only for blockers (`blocked`), not for “easier demos.”
4. **Kimi-aligned UI** is in scope while enumerating (record control placement/labels in `kimiUi`).
5. Revisit the entire list after major open-kimi / iframe UI changes; append new ids, never reuse ids for different semantics.

## Pass structure (repeat per section)

| Pass | Output |
|------|--------|
| **P0 Discover** | Screenshot of chrome/panel; checklist of controls; create `discovered` rows in `catalog/index.yaml` + stub `row.json` |
| **P1 Capture** | For each row: iframe action → shots + PPTD/export evidence → `specified` |
| **P2 Implement** | Native wiring → `implemented` |
| **P3 Verify** | Self-test checklist → `verified` |

Handoff for “editor 1:1” requires all non-`wont-port` rows in sections S0–S12 to reach **`verified`** (S13+ may trail only if explicitly deferred on the map).

---

## Enumeration order (S0 → S13)

### S0 — Bootstrap & fixtures

| # | Work item | Notes |
|---|-----------|--------|
| S0.1 | Register at least one multi-page `okp-*` fixture | From open-kimi examples |
| S0.2 | Register one `syn-empty` / minimal deck | Insert & empty states |
| S0.3 | Register one chart-heavy + one table-heavy page fixture | Or pages inside okp fixture |
| S0.4 | open-kimi serve + open fixture smoke | Dev environment only |

### S1 — Global chrome (always visible)

**P0 Discover (2026-08-14 official iframe on YU7):** complete. Shots: `docs/editor-oracle/runs/iframe-compare/04-yu7-desktop.png`, `06-yu7-official-pages.png`.

| Control | Row id | Status |
|---------|--------|--------|
| 撤销 | `chrome.history.undo` | verified |
| 重做 | `chrome.history.redo` | verified |
| 放大 | `chrome.zoom.in` | verified |
| 缩小 | `chrome.zoom.out` | verified |
| 播放 | `chrome.present.play` | verified |
| 全屏 | `chrome.present.fullscreen` | implemented |
| 页轨开关 | `chrome.pages.rail.toggle` | verified |
| 页选择 | `chrome.pages.navigate` | verified |
| 新建页面 | `chrome.pages.add` | verified |
| 缩放百分比 | `chrome.zoom.percent` | verified |
| 删除页 | `chrome.pages.delete` | verified |
| 复制页 | `chrome.pages.duplicate` | verified |
| 上移/下移重排 | `chrome.pages.reorder` | verified |
| 导出入口 | `chrome.export.open` | implemented |
| 导出 PPTX | `chrome.export.pptx` | implemented |
| 导出 PNG | `chrome.export.image` | implemented |
| Google 幻灯片 | `chrome.export.google` | wont-port |
| 演讲者备注 | `chrome.notes.toggle` | implemented |
| 历史版本菜单 | `chrome.history.versions.open` | implemented |
| 保存版本 | `chrome.history.versions.snapshot` | implemented |
| 只读预览 | `chrome.history.versions.preview` | implemented（PRD 4.5：Vn 下拉 → 只读稿 → Restore / Back to latest） |
| 恢复版本 | `chrome.history.versions.restore` | implemented（恢复不抹链，基于快照新建 latest） |

Insert pill:

| Control | Row id | Status |
|---------|--------|--------|
| T 文本 | `insert.text` | verified |
| 形状 | `insert.shape` | verified |
| 图片 | `insert.image` | verified |
| 表格 | `insert.table` | verified |
| 图表 | `insert.chart` | verified |
| 更多 | `insert.more` | verified（线条/图标菜单） |

S5–S8 leftovers (2026-08-14): official 27-font picker (`element.text.toolbar.fontfamily.set`), line height / letter spacing / highlight, image replace+upload, shape library + line arrows, icon name picker. Generate / account / Google remain out.

Enumerate every control that does **not** require a selection:

- Undo / Redo  
- Zoom in/out / fit  
- Play / preview (if present)  
- Page list: select, reorder, add, delete, duplicate  
- Save / autosave indicators  
- Export entry (open dialog only in this section)  
- Help / shortcuts overlay if any  
- Account/brand chrome only if it affects editing (else note `wont-port` for product shell)

### S2 — Export dialog (full)

Every control inside export UI:

- Format tabs (PPTX / image / PDF if present)  
- Font embed toggle  
- Transition options if exposed  
- Download / confirm / cancel  
- Error and disabled states  

Pair with export PPTX goldens in row `export/`.

### S3 — Selection model

- Click empty canvas  
- Click element; shift/cmd multi-select if any  
- Marquee select if any  
- Esc clear  
- Tab / Shift+Tab cycle (`selection.tab`)  
- Selection chrome: handles, rotate, outline  
- Locked / hidden elements behavior (`element.lock.toggle` / `element.visibility.toggle`)  

### S4 — Insert flows

From insert menu / shortcuts, one row family per type:

- text, shape (palette), line, image, icon, table, chart  
- SmartArt layouts (`insert.smartart`: process / cycle / hierarchy → nodes + connectors)  
- Any “from template/snippet” insert  

Each row: before empty selection → after new element in PPTD.

### S5 — Element: text

Contextual toolbar + panel + inline edit:

- Enter/exit edit mode  
- Font family, size, bold/italic/underline  
- Color, highlight  
- Align (h+v+justify), line height, letter spacing  
- Lists (bullet/number) + links (`element.text.toolbar.list.set` / `link.set`)  
- Delete, duplicate, arrange (z-order)  
- Position/size via handles and numeric fields if any  

### S6 — Element: shape

- Shape kind / adjustments  
- Fill (solid/gradient/image if UI allows)  
- Stroke, radius, shadow, opacity  
- Flip, rotate  
- Replace shape  

### S7 — Element: line

- Endpoints, curve mode  
- Arrow heads  
- Stroke style/width/color  

### S8 — Element: image

- Replace image  
- Crop / fit modes  
- Mask / crop shape if present  
- Rebuild to editable objects (`element.image.rebuild`, AC-11)  
- Opacity, border, shadow  

### S9 — Element: icon

- Icon pick/search  
- Color / size  

### S10 — Element: table

- Select cell / multi-cell  
- Edit cell text  
- Row/column add delete  
- Merge if present  
- Cell fill, border, align  
- Table style presets if any  

### S11 — Element: chart

- Open data editor  
- Edit categories/series values  
- Chart type switch  
- Legend, labels, axis titles  
- Series color  
- Close data editor & persist to PPTD  

### S12 — Page background, theme, notes

- Page solid/gradient/image background  
- Theme color tokens if editable in UI (`theme.color.set` on empty selection)  
- Speaker notes panel  
- Keyboard help (`chrome.keyboard.help`, `?`)  

### S13 — Animation, keyboard, context menu, residual

- Page / element animations UI (if present in iframe)  
- Full shortcut matrix  
- Right-click context menu items  
- SmartArt node add/delete/layout (`element.smartart.*`, AC-07)  
- Any control discovered later → append here with new id; do not skip verification  

---

## Section exit criteria

A section is **catalog-complete** when:

1. Discover pass screenshots exist under `runs/` or section note.  
2. Every visible interactive control has a row id in `catalog/index.yaml`.  
3. No native implementation references unlabeled controls.

A section is **parity-complete** when all its rows are `verified` or `wont-port` with reason.

## Mapping to `surface` enum (OOP-30 schema)

| Section | `surface` values |
|---------|------------------|
| S1 | `chrome.global`, `chrome.pages` |
| S2 | `chrome.export` |
| S3 | `selection` |
| S4 | `insert` |
| S5–S11 | `element.*` |
| S4/S13 SmartArt | `insert`, `element.smartart` |
| S12 | `theme.background`, `notes` |
| S13 | `animation`, `keyboard`, `context-menu`, `other` |

## Explicitly rejected sequences

- “Text + export only vertical slice then demo” as a substitute for S0–S12  
- Implementing toolbar buttons before Discover pass for that section  
- Closing editor 1:1 while S1–S11 still have `discovered`/`capturing` rows without `wont-port`
