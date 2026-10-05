---
status: accepted
date: 2026-10-05
supersedes: the workspace-grouping part of DESIGN.md "2026-10-05 会话入口修复"
---

# Slides generation sessions stay out of the Work sidebar

SlideStudio is its own panel, its own plugin, its own editor. Its generation sessions are an implementation detail of the agent run. Listing them in the DSH Work sidebar, even grouped under「演示文稿 · SlideStudio」, only adds noise.

DSH 0.2.0-rc.2 has no plugin-level "hidden session" flag. Two public mechanisms hide a session from the sidebar:

- `meta.origin: "subagent"` at creation. `dsh-client-ui-workspace#sessionVisible` drops subagent-origin sessions from grouped, flat and search views. `dsh-session` accepts the origin without a `parentSession`.
- `workspaceRegistry.archiveSession`. Hidden from default views, but `archived-session-gate` in `dsh-api-session-controller` rejects every `agent/pre-step` of an archived session, so an archived session cannot generate.

## Decision

1. New sessions are created with `slidesSessionMeta(cwd)` = `{ cwd, agentPreset: "slides", origin: "subagent" }` and never attached to a workspace. No parent on purpose.
2. At startup `hideSlidesSessions` archives every legacy slides session (preset `slides` and either bound in the store or with cwd `…/output/dsh-slices`), then deletes workspaces titled `演示文稿 · SlideStudio` whose members are all slides sessions. Deleting a registration keeps the directory and session logs. A slides-preset session at any other cwd is the user's own Work conversation and is left alone.
3. `resumeAgent` calls `ensureSessionUnarchived` before `ctx.agents.resume`. A resumed legacy session shows up in the sidebar again. That is accepted; only decks created before this change are affected.

## Consequences

- Header `origin` is durable. Sessions created after this change stay hidden; there is no switch to show them.
- Subagent-origin sessions are refused by generic session routing (`hasApiSessionSubagentOwner`, `validateAddress`) and by `dsh-headless`/`dsh-acp` resume. SlideStudio drives its agents in-process through `ctx.agents` and its own `/slides` routes, so it does not use those paths. Do not add a feature that opens these sessions through the official conversation UI.
- `dsh-workspace-changes` skips subagent-origin sessions. Slides sessions have no git change tracking, which they never needed.
- Third-party plugins that list sessions on their own (not through the official sidebar) may still show them.
- If a later Harness requires `parentSession` for subagent origin, creation fails loudly at `ctx.agents.create`. Re-check `sessionVisible` and the header validation on every Harness upgrade.
