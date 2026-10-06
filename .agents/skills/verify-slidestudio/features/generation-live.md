# Live generation controls

While a run is live the panel is locked (`#work-chat.is-live-generation`), the canvas is read-only and the
composer accepts steer/stop while the title-bar AI button can collapse and restore the panel.
Driver id `generation-live` (`drivers/assistant.mjs`), session bound with
`&live=1&session=verify-session`. The run itself is faked: the driver writes the events the panel renders.

## What a user does

- Progress rows appear in `#editor-generation-event-list` (reasoning, tool rows).
- Text typed during a run that was **not** started from this composer is a **steer**: posted with
  `steer: true`, no intent read, the draft clears once accepted.
- Text typed during a run **started from this composer** is held. The draft stays and the toast
  `#app-toast` says 助手正在回复，完成后可以继续发送. Nothing is posted.
- An empty composer plus the stop square stops the run. One JSON stop request, confirmed within seconds;
  `#generation-think-status` (正在思考) disappears. A paused run may offer `#editor-generation-resume`
  (继续完成生成).
- A new instruction after a stop goes through the intent read and becomes a `generate` turn on the same
  session.

## What the driver proves

- Locked panel with rows; steer posted as `{text, steer:true}` with no intent read; draft cleared.
- Stop: one request, `application/json`, button returns to send within 5 s, no lingering 正在思考.
- New instruction: reaches the same session with the new text, `conversationMode: "generate"`, exactly one
  intent read.
- Held draft: text kept, toast shown, no extra turn.

## Unfinished generation regression (0.2.2)

`apps/native-web/src/generation-process-dom.test.mjs` also covers an idle run with
five reported pages and no provider exception. The visible conversation timeline must
show the incomplete screenshot/layout and deck review checks, plus a recovery action.
The assertion checks visibility, not just hidden DOM text. This uses a simulated activity
response over a real fixture deck; it does not prove five newly generated slides.

`generation-activity-project.test.mjs` checks that the real activity endpoint forwards
execution blockers from a real project. `freestyle-planning.test.ts` and the Host's
`produce-agent-tools.test.ts` exercise freely adopted teaching designs through both
planning gates, including an outline update after the initial commit.

## Host-restart interruption (0.2.5)

A Host/App kill mid-turn (`SIGKILL`, crash, OS AutomaticTermination) leaves the
agent-trace turn open forever and the UI reads it as 正在思考. The Host now marks
the dead turn durably: `markInterruptedTurn` (`interruption.ts`) closes open
step/turn trace rows as cancelled and writes a `host-interrupted` fault. It runs
once per bound project at plugin activation (nothing can be busy at boot) and
lazily on `/slides/state` when the session is idle. The projections then read
`paused` with `recovery.kind === "continue"`, so the editor shows 已暂停 plus the
existing 继续完成生成 action instead of a stuck spinner. A pending rate-limit
retry or an existing fault still owns the verdict and is never overwritten.
`interruption.test.ts` covers the real signature where the turn-start row has
scrolled out of the 128 KB trace tail and only a running step remains.

On 2026-10-05, the incremental UI pass covered `hub-create`, `hub-launch`,
`assistant-model`, `generation-live`, and `export-pptx`: 81/81 checks, with no browser
errors. Real model/image delivery evidence is recorded separately in the local bugfix report.

## Gotchas

- Held versus steer depends on who started the run. `assistantTurnPending` clears only when the agent
  status goes idle, which the fake reproduces by setting `s.busy`/`s.phase` in `s.onTurn`.
- The resume button is checked only when visible; when the panel hides it the driver records a note, not
  a failure.
- This never runs the kernel. A real generation is out of scope (see `../SKILL.md`).
