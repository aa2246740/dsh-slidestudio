# Agent guide — open-slidestudio

## Mission

Build a real product, not a pixel-clone of Kimi branding. Reuse **interaction patterns and acceptance criteria** from `_reference/Kimi_Slides_PRD.md` and `FRAME_BY_FRAME_ANALYSIS.md`. Product name is **DSH SlideStudio**.

## Non-negotiables

1. **YAML PPTD v2 is disk SSOT** (`@open-slidestudio/pptd-v2`) — never treat slide bitmaps as the document model; **no dual IR** (see `LEGACY.md`, `CONTEXT.md`).
2. **Production: zero Kimi iframe/CDN** — oracle iframe only for dev capture (`docs/editor-oracle/`).
3. **No KIMI trademarks** in product branding claims; 1:1 UI alignment is recreation-phase, not trademark use.
4. **Multi-model** — intranet/local LLM via config; never hardcode a single public SaaS vendor.
5. **Editable export** — hybrid native exporter (`@open-slidestudio/exporter-native`); full-page raster is a failure mode.
6. **Dead-button ban** — no clickable editor control without an oracle row.

## Workspace map

### Native path (prefer for new work)

- `packages/pptd-v2` — Kimi YAML PPTD v2 parse/serialize
- `packages/project-store` — versions on PPTD dirs
- `packages/exporter-native` — offline hybrid PPTX
- `packages/canvas-session` — session + dead-button gate
- `packages/agent-harness` — offline generate tools timeline
- `docs/wayfinder/`, `docs/editor-oracle/`, `docs/specs/` — law
- `vendor/open-kimi-ppt/` — pinned skill note

### Legacy (do not extend as SSOT)

- `packages/pptd` — old TS Deck IR
- `packages/agent-core`, `exporter-pptx`, `design-brain`, `apps/web` — prior product spine

- `_reference/` — reverse-engineering evidence (read-only inspiration)

## Parallel work rules

- Own one package or one app surface per agent when possible.
- Do not rewrite another package’s public API without updating consumers and `docs/architecture/`.
- Prefer small, typed exports over god modules.
- Keep demos runnable offline with a mock agent provider.

## Quality bar

- TypeScript strict, no `any` without comment.
- Unit tests for command apply/undo and schema validation.
- UI states: empty, loading, error, success, reduced-motion.
- Match PRD acceptance IDs `AC-01`… where implemented; mark gaps in docs.

## Design workflow

Use Ultimate Design **Pro mode** for product chrome and slide theme systems: freeze Decision Snapshot → contract → artifact → critique → verify. Persist contracts in repo.

## Agent skills

### Issue tracker

Tickets live in a **Feishu Base** (`dsh-openslides tickets`, table `tickets`), driven by `scripts/feishu-ticket.mjs` or the `feishu` MCP server. Credentials live in gitignored `.devin/*.local.json`. Small fix-and-commit work needs no ticket. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context product domain: root `CONTEXT.md` (lazy) + `docs/adr/` + `docs/architecture/`. See `docs/agents/domain.md`.
