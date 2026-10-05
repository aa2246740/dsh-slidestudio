# DSH SlideStudio verification map

One file per scripted feature. Every id below is a `--list` entry of
`../scripts/drive.mjs` and lives in the driver named in the last column. Read `../SKILL.md` first for
how to run, the fake-kernel boundary, doctor and evidence rules.

## Baseline

- The harness gives every feature a scratch copy of `fixtures/okp-yu7-ppt` (8 pages: cover, tables,
  chart, images; manifest `yu7.pptd`; element ids such as `slogan`, `cover-en`). Never drive the
  checked-in fixture itself.
- Open a deck at `<base>/index.html?project=<abs dir>` (add `&workspace=1` for the AI panel,
  `&live=1&session=<id>` for a bound session). The Hub is `<base>/`.
- The editor is ready when the cover `#workspace-cover` is hidden, `#doc-title` is not `未加载` and
  `#slide .el[data-id]` exists.
- Model output is out of scope: the AI-panel features use a fake session and canned replies.

## Feature files

| File | Surface | Driver |
| --- | --- | --- |
| `hub-create.md` | Create Hub: prompt, Send gating, layout, style panel, attachments, model panel | `hub` |
| `hub-launch.md` | Send → editor hand-off, live URL, failure recovery, queue | `hub` |
| `hub-projects.md` | "继续协作" list: open, unread dot, delete | `hub` |
| `hub-settings.md` | Settings panes, API keys, subscription login, tools, theme | `hub` |
| `open-deck.md` | Load a project; title, rail, first page | `editor-core` |
| `page-rail.md` | Select, add, duplicate, reorder, delete pages; rail modes | `editor-core` |
| `undo-redo.md` | Buttons, shortcuts, disk | `editor-core` |
| `zoom.md` | Zoom in/out, clamp, fit | `editor-core` |
| `notes.md` | Speaker notes panel and persistence | `editor-core` |
| `present.md` | Play mode | `editor-core` |
| `edit-text.md` | In-place text edit, formatting, link | `editing` |
| `insert-shape.md` | Shape gallery and line presets | `editing` |
| `insert-table.md` | Table size grid | `editing` |
| `chart-edit.md` | Chart type and data overlay | `editing` |
| `insert-image.md` | Image through the file chooser | `editing` |
| `inspector-arrange.md` | X/Y/W/H, opacity, drag, multi-select, duplicate, delete | `editing` |
| `context-menu.md` | Right-click on an element and on blank canvas | `editing` |
| `comment-annotate.md` | 批注 mode, floating card, queued chip, box select | `review` |
| `comment-send-agent.md` | Sending queued comments to the agent | `review` |
| `versions.md` | Version menu, snapshot, preview, restore | `review` |
| `export-pptx.md` | Editable PPTX, error and retry | `review` |
| `export-pdf-png.md` | PDF (all pages) and PNG (one page) | `review` |
| `assistant-panel.md` | AI panel open/close, chips, morphing send/stop | `assistant` |
| `assistant-chat-turn.md` | A conversation turn, IME, failure, history | `assistant` |
| `assistant-questions.md` | Agent questions in the chat | `assistant` |
| `generation-live.md` | Live run: steer, stop, new instruction | `assistant` |
| `assistant-attachments.md` | Composer attachments | `assistant` |
| `assistant-model.md` | Model picker | `assistant` |

## Host integration (outside the 28 editor drivers)

| File | Surface | Verification |
| --- | --- | --- |
| `work-session-entry.md` | Generation sessions hidden from Work (subagent origin / archive + re-hide), project history in the Hub, composer takeover on the archived path | Built-client fixture, scoped server tests, native Desktop acceptance |

## Not mapped

- Real generation, provider login/OAuth, model output: needs credentials (`SKILL.md`).
- Hub `#btn-kind` (output type): `hidden`, only slides exist. Docs and Report are disabled entries.
- The Hub's inline generation view (`#agent-screen`, `#generation-showcase`): `showAgentScreen()` in
  `public/hub.js` is never called, since Create hands off to the editor at once (`hub-launch`). The
  markup is dead code, not a feature.
