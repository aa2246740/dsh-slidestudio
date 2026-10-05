# Generation sessions stay out of Work

SlideStudio generation sessions never appear in the DSH Work sidebar. New sessions are created
with `origin: "subagent"`, which the host hides from grouped, flat and search views, and are never
attached to a workspace. Sessions created before this change (legacy, no `origin`) are archived at
plugin startup by `hideSlidesSessions`, and SlideStudio-titled workspace registrations holding only
slides sessions are deleted. Project history lives in the SlideStudio Hub list (`/api/projects`),
which scans `output/` and `output/dsh-slices/` — it does not depend on Work session visibility.

An archived session cannot run (the host's archived-session gate rejects every pre-step), so
`LegacySessionHider` unarchives a legacy session before resuming it, then re-archives it on the next
idle/disposed. The message and steer routes call `ensureSessionRunnable` before `followup`/`steer`
so a re-archive in flight can never gate a user turn. Net effect: a legacy session is visible in
Work only while its deck's agent is actually running.

The client still installs a `conversation.composer` takeover for slides-bound sessions — readable
history plus a single "在演示文稿中继续" action, no Work text box. Reachable now only through the
sidebar's archived filter (legacy sessions), not for new sessions. Ordinary Work sessions are
unaffected.

## Source

- `packages/dsh-slides-host/src/session-workspace.ts`: `slidesSessionMeta` (`origin: "subagent"`),
  `hideSlidesSessions` startup sweep (preset `slides` + bound, cwd under `output/dsh-slices`, or
  cwd equal to the plugin's workspace/data root — the pre-per-project layout),
  `LegacySessionHider`.
- `packages/dsh-slides-host/src/plugin.ts`: `ctx.agents.create` uses `slidesSessionMeta`; idle and
  disposed hooks feed `onSettled`.
- `packages/dsh-slides-host/src/routes.ts`: `ensureSessionRunnable` before followup and steer.
- `dsh-slidestudio/src/client/index.tsx`: `conversation.composer` chain and bound-project
  navigation, with optional `personal.open()`.

## Automated proof

```sh
npm run test -w @open-slidestudio/dsh-slides-host   # session-workspace.test.ts: sweep, hider, meta
npm run build --prefix dsh-slidestudio
npm run test:client --prefix dsh-slidestudio      # composer takeover fixture
```

These tests do not prove that an already running Host has loaded the updated server module.

## Native acceptance recipe

1. Record the running Host, installed versions, current workspace records and existing projects.
2. Install the package through the official manager; complete any required restart so the new
   server code is actually loaded.
3. Generate a small real PPT through the installed plugin. Confirm **no** new session appears in
   the Work sidebar in grouped, flat, or search views, and no 演示文稿 workspace is created.
4. Open the deck again from the SlideStudio Hub and send one AI instruction. If the deck predates
   this change its session may appear in Work while the run is active; once it settles, confirm it
   is gone again (archived filter shows it).
5. Open a normal Work session and verify its input remains editable.
6. Save native screenshots and structured observations. Distinguish live model generation from the
   mocked client fixture and scoped server guard tests.

## Limits

- `origin` is immutable in the session header: sessions created after the change stay hidden for
  life, and legacy sessions can only be hidden by archiving — which blocks them while archived, so
  they are visible during an active run.
- Archived sessions remain reachable via the sidebar's archived filter; that path shows the
  composer takeover, not a Work input.
- Third-party plugins reading the raw session list (not the sidebar selectors) may still list them.
- Recheck `sessionVisible` and the archived-session gate on every Harness upgrade.
