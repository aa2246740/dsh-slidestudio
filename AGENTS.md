# Agent guide — open-slidestudio

## Mission

Build a real product, not a pixel-clone of Kimi branding. Reuse **interaction patterns and acceptance criteria** from `_reference/Kimi_Slides_PRD.md` and `FRAME_BY_FRAME_ANALYSIS.md`. Product name is **DSH SlideStudio**.

## Setup and development

Run commands from the repository root with Node.js `^22.19.0 || >=24.0.0` and npm.

```sh
npm run setup:dev
```

This fresh-clone command runs `npm ci`, `npm run build:native`,
`npm run setup:browser`, then `npm start`. It stays in the foreground; Ctrl+C
stops the services it launched. For an already installed checkout use `npm start`,
not another clean install.

`npm start` runs the product Hub at `http://127.0.0.1:13080` and editor at
`http://127.0.0.1:55200`. It uses the isolated `.dsh/home` profile; configure a
model in Settings before generating. Browser setup installs the pinned runtime
in `.runtime/playwright`, reusing a compatible local runtime when available.
Installation needs network access, but building and offline tests do not need
provider credentials. Keep existing projects and other running Harness profiles intact.

For later edits, rebuild with `npm run build:native` and restart this checkout's
service. `npm run native:dev` runs only the editor sidecar; it does not start the
Agent kernel. `npm run dev` is the **legacy** web/API stack, not the product.
`npm run build` builds both native and legacy workspaces.
If a port is occupied, choose unused `SLIDES_DSH_PORT` / `SLIDES_EDITOR_PORT`
values instead of stopping another checkout. See `scripts/lib/dsh-runtime.mjs`.

## Validation workflow

For quality baselines, Vitest collection/coverage, CI evidence, dependency
updates or generated API docs, read `docs/agents/readiness-quality.md`.
For HTTP diagnostics, provider/startup incidents or profiling, read
`docs/operations/runbook.md`; for logs, attachments or evidence containing
personal information, follow `docs/operations/data-handling.md`.

Choose the smallest relevant check before running broader gates:

| Change                                    | Command                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| All TypeScript workspaces                 | `npm run build && npm run typecheck` (legacy dependencies need their compiled declarations too) |
| JavaScript/TypeScript correctness         | `npm run lint`                                                                                  |
| Changed authored files                    | `npm run format:check -- <paths>`; apply formatting with `npm run format -- <paths>`            |
| Quality tooling and command documentation | `npm run test:tooling`                                                                          |
| One native package                        | `npm test -w @open-slidestudio/pptd-v2` (replace with the affected workspace name)              |
| Native package suite                      | `npm run test:native`                                                                           |
| Editor/server and DOM tests               | `npm test -w @open-slidestudio/native-web`                                                      |
| Editor control inventory                  | `npm run oracle:validate`                                                                       |
| Production boundaries                     | `npm run verify:no-fake-path && npm run verify:no-kimi-runtime`                                 |

Package TypeScript tests compile themselves; build native dependencies before
editor tests. Use scratch projects for mutation tests. Tests use `*.test.ts`,
`*.test.mjs`, or the plugin's `scripts/test-*.mjs` convention. Real generation
(`npm run test:real-generation`) sends data to a provider and requires explicit
consent; offline tests do not prove model output.

ESLint checks all four apps plus packages and scripts. Syntax, undefined names,
duplicate keys, unsafe control flow, and React Hook errors block validation.
Unused code, redundant assignments/escapes, intentional control-character
regexes, and existing explicit `any` remain visible warnings during incremental
adoption; fix relevant warnings when touching their code. Rules are not disabled
with inline suppressions. Prettier covers authored files with the existing plugin
quote/semicolon style preserved. Format changed paths, not the entire repository;
its ignore file protects reference/vendor content, fixtures, generated output,
lockfiles, and release workflows.

`npm ci` installs Husky through `prepare`. Before committing, lint-staged formats
only staged authored files and runs ESLint, preserving partially staged edits
with its backup/restore transaction. The hook then runs tooling tests, the full
build (needed for legacy declarations), type checking, and offline workspace
tests. Failures block the commit. Reinstall the hook with `npm run prepare` if
needed; check any existing custom Git hooks before changing `core.hooksPath`.
The hook also enforces quality baselines, generated-doc freshness, secret
scanning and the critical-interface coverage gate described above.

Use camelCase for functions/variables, PascalCase for types/React components,
and UPPER_SNAKE_CASE for module constants. Preserve established public names.
After a change, check the diff for user work and generated files, run the
relevant checks, and leave this checkout's local service available for acceptance.
For plugin packaging or a real Harness integration, read `INSTALL-DSH.md`.

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
