# Changelog

## 0.3.1 — 2026-11-27

- Unified left AI panel status and recovery card: replaces legacy hidden generation fallback DOM/CSS with a warm/ink-themed `.generation-status-card` featuring live 429 retry countdown, model switch, stop wait, resume, collapsible technical details, mode-aware discuss/edit failure cards, and complete English i18n coverage.
- Fault classification parity and live recovery: aligns provider fault classification (`2056` token-plan, `401/403` auth, `429` rate-limit, `5xx` unavailable, quota) across `@open-slidestudio/dsh-slides-host` and `@open-slidestudio/slides-runtime`, persists `turn-max-tokens` pause faults instead of leaving the panel stuck on thinking, and detects interrupted long turns whose start scrolled past the 128 KB trace tail window.
- Left-panel state machine and responsiveness fixes: unlocks resume on 0-page empty decks, prevents ghost DOM leaks on row kind changes, eliminates duplicate `/slides/state` polling with out-of-order sequence guards, makes reasoning timers demand-driven, ensures Stop works immediately after Resume, isolates `/api/open` refresh failures from disconnect handling, surfaces visible reconnect status, and lazily resolves the session ID on early submit.

## 0.3.0 — 2026-11-27

- DSH 0.2.2-rc.5 compatibility and 4-service thin shell: `dsh-slidestudio` and `@open-slidestudio/dsh-slides-host` inject only `webServer`, `connection`, `llm`, and `attachments`, removing host agent, tool-registry, preset, workspace, and session-journal dependencies.
- Host-agnostic SlideStudio Core architecture:
  - `@open-slidestudio/slides-tools`: canonical 32-tool slide contract, material readers, layout writing, batch footer removal, and atomic dual-file project writer lease (`writer-lease.v1.json` + `runtime-turn.lease.v1.json`) with PID/hostname guard.
  - `@open-slidestudio/slides-runtime`: standalone `@earendil-works/pi-agent-core@1.6.1` + `@earendil-works/pi-ai@1.6.1` agent loop, `DshLlmPort` streaming adapter, context budget, session log (`runtime-session.v1.jsonl`), and 2-lane priority session transitions (user commands preempt automatic rate-limit resume).
  - `@open-slidestudio/slides-mcp`: standalone stdio and loopback HTTP MCP server over the canonical slide tools, plus optional DSH rc.5 `mcpManager.register` integration behind feature flag `mcp_register` and reusable external skill (`skills/slidestudio/SKILL.md`).
- Editor, PPTD v2, and exporter upgrades: full Layout Mode (`#layout-rail`, `#layout-banner`, master/layout editing, page-number insertion), attachment chips and material scoping, upgraded PPTD v2 XML lint, and verified hybrid native PPTX export (`validateExportReport`).
- Pure-JS release packaging: DAG-hoisted dependency bundling with zero `sharp` / `@napi-rs/canvas` native addons and `verify:no-intranet` public-boundary enforcement.

## 0.2.9 — 2026-11-03

- The published plugin includes `config/feature-flags.json`. If that file is missing, the editor uses the safe flag defaults instead of crashing on startup.
- An editor sidecar that exits is restarted after a short cooldown, on its configured port, instead of answering 503 until the plugin is reloaded.

## 0.2.8 — 2026-10-20

- Playwright onboarding in the Hub: a runtime panel shows checking, installing, ready, failed, or manual setup, with the failure reason, a retry button, `npm run setup:browser`, and the `SLIDESTUDIO_PLAYWRIGHT_RUNTIME` override. `/slides/health` reports the actual rendering runtime.
- Tools pane and image API presets with safe endpoint templating; interruptible stop and standalone editor routing.
- AI review locks: new `GET /api/reviews/ai-lock/status`; expired or orphaned review guards can be recovered, while live guards and busy sessions stay protected. A pending browser edit is archived and kept in the composer, never resubmitted.
- Session checks no longer take the project write lock; run ledger and binding writes are skipped when nothing changed; an operator stop waits at most 15 s for idle.
- The `/app` editor proxy passes same-origin edits to the sidecar and rejects cross-site requests.
- Windows: the local launcher starts DSH through the current Node (no `spawn npm ENOENT`), key files are written atomically with owner-only ACLs, tar extraction and `chrome-headless-shell.exe` detection work, and permission errors during the session scan return 400 instead of 500.
- Node engines are now `^22.19.0 || >=24.11.0`.
- Repository tooling: ops alerting, automated PR review digests, feature flags, ratcheted type checks, bundle budgets for all four app payloads, and generated API docs. CI builds native packages and installs the pinned Playwright runtime before coverage.

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
