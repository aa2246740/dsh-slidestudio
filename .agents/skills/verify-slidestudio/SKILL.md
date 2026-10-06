---
name: verify-slidestudio
description: Drive DSH SlideStudio like a user and capture evidence. Runs 28 scripted features (Create Hub, editor canvas, inspector, comments, versions, export, AI panel) against a disposable editor server and a fake DSH kernel, with the repo-pinned Chromium. Use to prove the Hub, editor, comment, version, export or AI-panel UI works end to end without provider credentials. It never proves model output; real generation is `scripts/dsh-slides.mjs` and `npm run test:real-generation`.
---

# verify-slidestudio

`node .agents/skills/verify-slidestudio/scripts/drive.mjs` drives the product the way a person does:
clicks, typing, drags and keys in the repo-pinned Chromium. Every action is paired with an
observable end state (DOM, files on disk, HTTP bodies) and a screenshot. All 28 features take about
3 minutes (about 135 s of driving plus startup).

## Run it

```bash
node .agents/skills/verify-slidestudio/scripts/drive.mjs --list                 # ids + titles
node .agents/skills/verify-slidestudio/scripts/drive.mjs page-rail undo-redo    # some features
node .agents/skills/verify-slidestudio/scripts/drive.mjs all                    # everything
```

Exit code 1 when any check failed or a browser error was recorded. Output per feature:
`ok`/`FAIL`, checks passed, then each failed check, the last commands the page sent, browser errors
and `PRODUCT GAP` lines. Evidence lands in `output/qa-verify-slidestudio/<run>/` (git-ignored, kept
after cleanup): `report.md`, `report.json`, `server.log`, and per feature `NN-name.png`,
`commands.json`, `failure-N.png` on a crash.

Prerequisite for Codex verification: the existing shared runtime at
`~/.codex/playwright-runtime/runtime.mjs` (Playwright 1.61.1 / Chromium Headless Shell 1228).
Set `SLIDESTUDIO_PLAYWRIGHT_RUNTIME` to that path if another local runtime exists.
Do not install a project-local browser or fall back to system Chrome.

## Work sidebar and Personal entry

`features/work-session-entry.md` covers the Host-facing surface separately from the 28 editor
features. Generation sessions are hidden from the Work sidebar (`origin: "subagent"` for new ones,
archive + re-hide for legacy ones); project history lives in the Hub's `/api/projects` list, not in
Work. Run `npm run test:client --prefix dsh-slidestudio` for the built client and
`npm run test -w @open-slidestudio/dsh-slides-host` for the hide sweep, `LegacySessionHider` and
input guards. The client fixture uses a real `SliceSessionStore.inspect()` payload, a mocked Host
slot registry, and the shared pinned browser. It proves the composer takeover on the archived path
and standalone routing, not native Host activation. Use native Codex CUA for the installed Desktop
path; record its actual package and runtime separately. A successful install alone does not prove
updated server code is loaded.

`dsh-slidestudio` is not in the root workspaces: install its deps standalone before `test:client`
with `pnpm --dir dsh-slidestudio install --ignore-workspace --frozen-lockfile
--config.auto-install-peers=false` (its lockfile pins `autoInstallPeers: false`; `npm install`
fails on the `link:` dep and the optional `dsh-personal` peer is not on npm).

## Session-hiding probe

`scripts/session-hiding/` verifies the Work-sidebar hiding path end to end inside a real Host —
the layer unit tests mock: service existence, durable session headers, the registry round-trip:

```bash
DSH_RC2_HOST=<dir with @deepseek-ai/dsh@rc.2 installed> \
  node .agents/skills/verify-slidestudio/scripts/session-hiding/run.mjs [--timeout 120]
```

It needs `dsh-slidestudio/lib` and `packages/dsh-slides-host/dist` built. `run.mjs` boots
`npx dsh web --patch … --no-open --port 0` under a fresh temp `DSH_HOME` (a real stack is never
disturbed), then `probe.js` runs in-process: a `slidesSessionMeta` session (the real session store
must persist `origin: "subagent"` in its header), a legacy slides session plus a SlideStudio-titled
workspace, `hideSlidesSessions` on the real `workspaceRegistry`, and `LegacySessionHider`
unarchive → settle → re-archive. No model calls. 9 assertions; log: `output/session-hiding/run-*.log`.
Exit 1 on any FAIL.

## RC2 isolation probe

`scripts/rc2-isolation/` verifies the Slides agent-plane session-isolation fix end to end inside a
real Host — it does not replace the 28 UI features, it covers the layer they cannot see (tool
roster, `open_project` execution, shell denial, normal-agent independence):

```bash
DSH_RC2_HOST=<dir with @deepseek-ai/dsh@rc.2 installed> \
  node .agents/skills/verify-slidestudio/scripts/rc2-isolation/run.mjs [--timeout 90000]
```

It needs `dsh-slidestudio/lib` built (`npx tsc -p tsconfig.json` +
`DSHX_HARNESS=<abs> npx -y tsdown`) and `$DSH_RC2_HOST/node_modules/@deepseek-ai/dsh-agent-preset-registry`
present. `run.mjs` writes a patch (`dsh-slidestudio` + the `dps-probe` script entry, registry
`default: slides`), boots `npx dsh web --patch … --no-open --port 0` under a fresh temp `DSH_HOME`,
and runs `probe.js` in-process — a slides agent then a normal agent with real tools, reporting
`[probe]` lines. 10 assertions: preset resolves via `composedPreset`, slides roster intact,
`open_project` really executes, non-slides agents keep native tools and get no slides plane,
`ask_user_question` only routes for the bound session, `bash` denied for a stale-bound session,
no `MountConflict`/plane warnings, clean dispose. Log: `output/rc2-isolation/run-*.log`;
Never use `--keep`: verification must stop its temporary Host and preserve only evidence.
Exit 1 on any FAIL.

A Host that only reports the static roster does not prove isolation — the probe executes a tool
call and a denied call to prove the binding, per HANDOFF.

## What the harness starts

`scripts/lib.mjs` owns everything, per run:

- one editor server (`apps/native-web/src/server.mjs`) on a **free port**, never 55200, with
  `SLIDESTUDIO_RETENTION_DAYS=0`;
- an in-process **fake DSH kernel** on another free port (`SLIDES_DSH_PORT`) that answers the boot
  probes: `/slides/catalog`, `/slides/health`, `/slides/providers`, tool settings, `/plugins/*`. It
  generates nothing. So the Hub boots and Send enables without credentials, through the real proxy;
- one scratch deck per feature: `ctx.deck(name[, fixture])` copies `fixtures/okp-yu7-ppt` (8 pages,
  text, tables, charts, images) to `output/verify-<run>/<name>/` **without** `.versions/` and `_agent/`
  (git-ignored leftovers of whoever last ran the editor on the fixture). `?project=` must be inside
  the repo or `os.tmpdir()`; a literal `/tmp` path is refused on macOS (`/var/folders`);
- `ctx.outputProject(name, title)` for the Hub list: a scratch project directly under `output/`
  named `verify-<run>-<name>`, the only place the list scans and DELETE may remove;
- `fakeSession(page, …)`: a DSH session bound at the network boundary (intent, turn, stop, questions,
  providers, activity) whose replies are canned strings the driver wrote.

`stop()` kills only the processes the run started and removes the scratch decks. It never touches the
user's stack on 55200 (editor) and 13080 (kernel), or a `dsh-studio` on 3080.

## Doctor

- `drive.mjs` health-checks the server at start (`/api/health` → `product: "DSH SlideStudio"`) and
  again after every feature; an unhealthy server aborts the run instead of poisoning the next
  feature.
- A failing feature: read its `failure-N.png` and `commands.json` first. A wedged UI on a healthy
  server: rerun that feature alone; the deck is recreated each time.
- Environment failures look like `Pinned Playwright runtime is unavailable`, `editor did not
  become healthy` (see `server.log`), or a port clash. Product failures look like a failed
  `rec.check` with the page otherwise healthy.

## Feature map

`features/README.md` indexes one file per feature (28). Groups: Hub (`hub-*`), editor core, editing,
review/export, AI panel. Each file says what a user sees, how to reach it, what the driver proves,
and the gotchas learned by driving it.

## Evidence rules

- Assert on state, not only pixels: DOM text, counts, page/manifest files on disk (poll with
  `rec.until`, the server answers before every write is visible), downloaded files unzipped or
  magic-checked, request bodies.
- Browser `pageerror` and `console.error` fail a feature unless it lists the expected noise in
  `ignoreErrors` (forced 4xx/5xx paths, the aborted stubbed `/events` stream).
- Mock only at the outer provider boundary. Never stub `#slide`, the export endpoint or the comment
  store. Stubs for `/slides/*` and `/plugins/*` stand in for the kernel, never for the product.
- `rec.gap(name, ok, detail)` records a **product** behaviour the map says should work but does
  not. It prints `PRODUCT GAP`, stays out of the pass/fail count, and flips to `resolved` when
  the product is fixed (then promote it to `rec.check`). No gap is open at the moment.
- Keys typed in Settings are fake (`sk-verify-NOT-A-REAL-KEY-…`) and asserted absent from the page.

## What this skill does not prove

- Model output or generation quality, provider login and OAuth callbacks, real reasoning streams:
  these need a provider (`npm run test:real-generation`, `scripts/dsh-slides.mjs`). The AI-panel
  features prove the UI and the request bodies only; replies there are stub text.
- Native OS behaviour: fullscreen, file pickers, IME composition, clipboard interop, Office reopening.
- Visual parity against the frozen reference (`docs/editor-oracle/`) and pixel comparisons.

## Editing the skill

Add a feature: append `{ id, title, ignoreErrors?, async run(ctx, rec) }` to the matching
`scripts/drivers/*.mjs`, add `features/<id>.md` and a row in `features/README.md`. Use
`ctx.deck()` for state, `newPage()` + `openEditor()` for the page, `waitForCommand(page, cmd)`
**before** the action to sync on `POST /api/command` (it resolves after the page has repainted from the
answer), `rec.until` for disk and for DOM that may lag. Always close `page.__context`. Re-run the
feature until it passes 3 times in a row, one of them under CPU load (`yes > /dev/null &` per core);
timing races are driver bugs until proven otherwise.

Selectors that differ from what the source suggests: canvas elements are `.el[data-id]` (not
`.element`); the inspector is `#property-panel` (hidden with width 0 when nothing is selected, and it
collapses to a 48px strip at 1440px while the AI panel is open: `ensureInspector` in
`drivers/editing.mjs`); the composer is `#work-brief`; the deck manifest is `<name>.pptd`
(`yu7.pptd`), not `deck.pptd`; there is no `insert.chart` button.

Menus: `#version-menu` stays open after 手动快照 — never click `#btn-versions` blindly to
"open" it (the button toggles; a second click while it is open closes it, and a
`waitForSelector(visible)` that races the async toggle can still pass during the stale-open
window, leaving row clicks to time out on an invisible 0×0 target). Use `openVersionMenu()` in
`drivers/review.mjs`, which only clicks when `el.hidden` is true. Same pattern anywhere else a
button both toggles a popup and leaves it open after an in-popup action.

## Helpers

- `scripts/lib.mjs`: `startRun`, `recorder`, `newPage`, `openEditor`, `waitForCommand`,
  `readManifest`/`readPageAt`, `snapshotDir`, `stubKernelRoutes`, `fakeSession`, `unzipEntries`.
- `scripts/drive.mjs`: runner and report writer.
- `scripts/drivers/`: `hub`, `editor-core`, `editing`, `review`, `assistant`.
- Repo context: `scripts/lib/pinned-playwright.mjs`, `scripts/qa/*` (`comment-send-agent` runs
  `scripts/qa/editor-comment-batch.mjs`), `apps/native-web/src/*-dom.test.mjs`.
