# Changelog

## 0.2.4 — 2026-10-05

- Resolve the Playwright rendering runtime automatically: `SLIDESTUDIO_PLAYWRIGHT_RUNTIME`, the repo copy, a managed dir under the DSH data dir, a self-consistent `~/.codex` seed, or a machine-wide Playwright install. A stale codex seed no longer claims the runtime, and machines with nothing usable get a background download of the pinned runtime (npm registry tarballs plus Playwright's own browser installer, npmmirror fallback, no npm required on the host).

## 0.2.2 — 2026-10-05

- Keep freely adopted design sources through the strict planning gate and later outline updates, fixing repeated `missing_theme_pack` rejections.
- Read image-input capability from the Harness-resolved model metadata. Distinguish missing page rendering, disconnected providers, disabled visual review, and text-only models.
- Refuse to start generation when its required rendering runtime is missing; discussion remains available.
- Show concrete unfinished checks and the recovery action below a stopped generation, including when the model ended without reporting an exception.

## Unreleased

- DSH kernel upgraded to `@deepseek-ai/dsh` 0.2.0-rc.2 (was rc.1); vendored `dsh-llm-pi-ai` rebased to upstream rc.2 with the three Open SlideStudio patches re-applied; `dsh-oauth-login` vendor refreshed to upstream main `1b64aa8`
- PNG export follows the browser tab's current page, not the default session's page
- Inspector X, Y, width, and height edits no longer overwrite each other
- A deck with no AI conversation explains why, and that it can still be edited by hand

## 0.2.0 — 2026-09-29

Sealed snapshot of `main` (`1b82468`). Product version only; workspace package versions stay at 0.1.0.

- Native DSH (`@deepseek-ai/dsh` 0.2.0-rc.1) is the production agent kernel
- YAML PPTD v2 remains the document; the editor covers direct edits, comments, versions, and one continuous chat
- Editable PPTX export; slide faces are Office and WPS fonts, and canvas and export share one chart layout
- Warm and ink themes, instant launch from the Hub, and a folded live agent timeline
- A finished deck that only needs another export is not offered as a paused generation
- Office and WPS fonts are not reported as export failures

## 0.1.0 — 2026-08-04

### Production release

- Full Create → Mock Agent → Workspace → PPTX export path
- PPTD structured IR as document source of truth
- Packages: `pptd`, `agent-core`, `exporter-pptx`, `design-brain`, `web`
- Chart whitelist with editable table fallback
- Version history, comments, play mode, undo/redo, keyboard nudge
- Offline smoke + browser E2E (Playwright)
- GitHub Actions CI
- Apache-2.0 license
