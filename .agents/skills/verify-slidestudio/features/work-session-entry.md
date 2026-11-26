# Generation sessions stay out of Work

Since Phase 3B-2 (`ADR-0012`), SlideStudio generation runs inside `@open-slidestudio/slides-runtime`
over the 4-service DSH thin shell (`webServer`, `connection`, `llm`, `attachments`, plus optional
`mcpManager` registration). SlideStudio never calls `ctx.agents.create`, never registers a `slides`
agent preset, and never creates DSH Work sidebar sessions or SlideStudio-titled Work workspaces.
Project history lives in the SlideStudio Hub list (`/api/projects`), which scans `output/` and
`output/dsh-slices/` — it does not depend on Work session visibility.

For historical pre-cutover sessions that were already archived in a user's DSH home before Phase
3B-2, the client still installs a `conversation.composer` takeover — readable history plus a single
"在演示文稿中继续" action, no Work text box. Reachable only through the sidebar's archived filter
for those pre-cutover sessions; ordinary Work sessions are unaffected.

## Source

- `dsh-slidestudio/src/dsh-slidestudio.ts`: 4-service thin shell (`inject = ["webServer",
"connection", "llm", "attachments"]`) mounting `@open-slidestudio/dsh-slides-host` and optional
  `registerSlidesMcp`.
- `packages/dsh-slides-host/src/plugin.ts`: `inject = ["webServer", "llm", "attachments"]`
  (optional `connection` via `ctx.get`), driving sessions via `SessionRuntimeManager` on
  `@open-slidestudio/slides-runtime` with zero DSH agent/session/workspace service calls.
- `dsh-slidestudio/src/client/index.tsx`: `conversation.composer` takeover and bound-project
  navigation for historical pre-cutover sessions, with optional `personal.open()`.

## Automated proof

```sh
npm test -w @open-slidestudio/dsh-slides-host   # four-service.e2e.test.ts, session-runtime-manager, session-recovery
npm run build --prefix dsh-slidestudio
npm run test:client --prefix dsh-slidestudio    # composer takeover + rc5 compatibility fixtures
```

These tests do not prove that an already running Host has loaded the updated server module.

## Native acceptance recipe

1. Record the running Host, installed versions, current workspace records and existing projects.
2. Install the package through the official manager; complete any required restart so the new
   server code is actually loaded.
3. Generate a small real PPT through the installed plugin. Confirm **no** new session appears in
   the Work sidebar in grouped, flat, or search views, and no 演示文稿 workspace is created.
4. Open the deck again from the SlideStudio Hub and send one AI instruction. Confirm the run executes
   entirely through `/slides/sessions*` without creating any Work sidebar entry.
5. Open a normal Work session and verify its input remains editable.
6. Save native screenshots and structured observations. Distinguish live model generation from the
   mocked client fixture and scoped server guard tests.

## Limits

- Historical pre-cutover archived sessions remain reachable via the sidebar's archived filter; that
  path shows the client composer takeover, not a Work input.
- Recheck the 4-service surface contract (`docs/architecture/dsh-surface-manifest.json`) on every
  Harness upgrade.
