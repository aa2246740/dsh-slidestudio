# Core agent loop (`@open-slidestudio/slides-runtime`)

`packages/slides-runtime` is the single host-neutral agent loop that produces
decks ([ADR-0012](../adr/0012-slides-runtime-core-agent-loop.md)). It drives
`@earendil-works/pi-agent-core@1.6.1` (`Agent`) over the canonical
[`@open-slidestudio/slides-tools`](slides-tools.md) suite and talks to models
only through an `LlmPort`. Runtime dependencies are Node built-ins,
`pi-agent-core@1.6.1`, `pi-ai@1.6.1`, `pptd-v2`, `presentation-run` and
`slides-tools`; `boundary.test.ts` fails on any host SDK, `pi-coding-agent`,
durable-loop, native image codec or internal-deployment reference.

## Modules

| Module                                                  | Role                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `llm-port.ts`                                           | `LlmPort` / `LlmRoute` / `LlmFailure`; failures travel as a terminal assistant message with a structured diagnostic       |
| `llm-port-pi-ai.ts`                                     | `PiAiLlmPort`: registered pi-ai models or a custom OpenAI-compatible endpoint + API key; captures HTTP status/Retry-After |
| `token-estimate.ts`                                     | CJK-aware token estimation, image load                                                                                    |
| `context-compaction.ts`, `context-budget.ts`            | tiered projection for `transformContext`, image offload, `maxTokens` clamp, overflow detection, `GatewayCompat` / hooks   |
| `guard-events.ts`                                       | host-neutral turn / step / tool-call / tool-result vocabulary                                                             |
| `tool-loop-guard.ts`                                    | short loop on identical invalid arguments (3, one count per step)                                                         |
| `progress-snapshot.ts`, `progress-guard.ts`             | durable progress reducer (rejection 3, invalid args 8, planning 64, production 32) over ledger + disk evidence            |
| `faults.ts`, `redact.ts`                                | fault taxonomy, Retry-After parsing, 429 backoff, redaction                                                               |
| `session-store.ts`                                      | `_agent/runtime-session.v1.jsonl` append log, crash recovery, transcript repair                                           |
| `trace-projection.ts`                                   | `_agent/agent-trace.jsonl` rows compatible with the host `AgentTraceRow` contract, truth-guarded                          |
| `user-question.ts`                                      | optional `ask_user_question` suspension tool and `_agent/assistant-questions.v1.json` broker                              |
| `tool-adapter.ts`                                       | `SlideToolDefinition` → `AgentTool` (INVALID_ARGS, images, deferred `onContentDelivered`, timeout, serial gate)           |
| `lease-keeper.ts`                                       | acquire / heartbeat / loss detection / release of the slides-tools writer lease                                           |
| `local-project-port.ts`                                 | standalone `SlideProjectPort` under `<dataRoot>/output/dsh-slices/run-*`                                                  |
| `runtime-config.ts`, `runtime-support.ts`, `runtime.ts` | options, tool assembly, budget-aware stream, `SlidesAgentRuntime` / `createSlidesRuntime`                                 |

## Turn lifecycle

A **turn** is one `prompt()` (or `resume()`); a **step** is one assistant
message. Per turn the runtime:

1. when a project is already bound, acquires the writer lease first (refusing
   both another process and another active in-process runtime instance even when
   `caller.id` matches; a refusal fails the turn closed before writing
   `turn/start`, recovery closures, hooks, or `turn/end` to disk), re-inspects
   disk under that lease to refresh the transcript/turn counter/sequence numbers
   and close only genuinely still-open turns or pending questions, then appends
   `turn/start` to the session log and trace and starts the guards;
2. runs the pi-agent-core loop: `transformContext` projects the transcript
   under the budget, the stream wrapper clamps `maxTokens` within the remaining
   context window and refuses to call the port once the run is aborted,
   `beforeToolCall` blocks every call after a fault, `adaptSlideTool` refuses
   already-aborted calls and holds the serial slot while a timed-out tool is
   still settling (revoking write authority via the aborted `AbortSignal`), and
   `steer()` messages are injected after the current step;
3. observes `tool_execution_*` events: both guards see a neutral event,
   validation failures (pi-ai schema or the tool's domain validator) are
   reported as `INVALID_ARGS`, and a trip aborts the run as `paused`;
4. persists every committed message (with registered secrets and error fields
   redacted), and fires a tool's deferred `onContentDelivered` hook only after
   a subsequent model request retained that tool result's image block
   post-`transformContext` and completed without error, abort, or turn fault
   (while the writer lease is still held);
5. retries a provider context overflow (by text pattern, pi-ai classifier, or
   structured `CONTEXT_WINDOW_EXCEEDED` code) once with an escalated compaction
   tier, and a 429 with `Retry-After` or the 15s/30s/60s/2m/5m backoff (default
   3 attempts); auth, quota and other faults end the turn as `failed`;
6. runs `PostTurnHook[]` sequentially (default none), re-verifying lease
   authorization and passing the turn `AbortSignal` before each hook and
   recomputing the turn result if a mid-hook takeover occurred, then appends
   `fault` / `turn/end` and releases the lease only when still authorized (a
   refused, lost, or editor-preempted turn skips remaining hooks and `_agent/`
   writes and leaves the current holder's lease untouched).

`open_project` binds the project mid-turn: the writer lease is acquired first;
only on success do buffered log and trace rows flush to the new `_agent/`.
Every lease acquisition re-syncs both `runtime-session.v1.jsonl` and
`agent-trace.jsonl` sequence numbers from disk so sequential handoffs between
runtime instances stay monotonic. A heartbeat renews the lease, and every
`_agent/` disk write re-verifies ownership under the lease lock; if the lease
is lost (TTL takeover) or the editor preempts an `mcp`-kind caller, the run
stops with `writer-lease-lost` / `lease-preempted-by-editor`, writes no further
`_agent/` records, skips remaining post-turn hooks, and never releases another
owner's lease.

## Recovery

`createSlidesRuntime({ project })` inspects the session log and pending
questions read-only without mutating disk (so constructing a second runtime
never interrupts a live writer's active turn or pending question): a
crash-truncated final line is ignored, failed assistant replies are dropped, and
dangling tool calls receive an interrupted error result in memory. When that
runtime later acquires the writer lease for `prompt()` or `resume()`, it
re-inspects disk fresh under the lease (refreshing its in-memory transcript and
turn counter if another writer completed work in the meantime) and closes only
turns or pending questions that are still open on disk. `resume()` re-validates
that the refreshed transcript still ends in a user or tool message before
continuing.

## LLM ports

- `PiAiLlmPort({ kind: "registered", models, providerId, modelId })` or
  `createBuiltinPiAiPort(...)` uses pi-ai's catalog; `{ kind:
"openai-compatible", baseUrl, apiKey, modelId, contextWindow, maxTokens }`
  registers one custom provider (`openai-completions` by default). API keys are
  registered for redaction before errors reach the transcript or session log.
- `DshLlmPort` (`packages/dsh-slides-host/src/dsh-llm-port.ts`) accepts DSH
  `0.2.0-rc.2` and `0.2.2-rc.5` `LlmRuntime` and `AttachmentStore` directly,
  converts the transcript to DSH `GenerateOptions` (preserving assistant
  `replayState` across turns and saving inline images through
  `ctx.attachments.saveImage`, failing closed with `ATTACHMENTS_UNAVAILABLE`
  when absent), and converts DSH `StreamChunk`s back to pi-ai events, keeping
  `stopReason`, `finish.replayState`, full usage (`input + output + cacheRead +
cacheWrite` when `totalTokens` is omitted), failure code, status and
  `providerRetryAfterMs`.

## DSH host (Phase 3B-2, complete)

The `dsh-slidestudio` plugin runs every Hub slide session on this loop. Its
server surface is the four thin DSH services (`webServer`, `connection`, `llm`,
`attachments`) plus the optional, flag-gated `mcpManager` registration
([surface manifest](dsh-surface-manifest.json)). `packages/dsh-slides-host`
never calls `ctx.agents`, `ctx.tools`, agent presets, session projections,
`workspaceRegistry`, `sessionQuery`, `profileContext`, or listens to
`agent/*` / `session/event`.

| Host module                  | Role                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-runtime-manager.ts` | one `SlidesAgentRuntime` per session: followup / resume / steer / operator stop; rebuilds an idle runtime on route or policy change                |
| `session-runtime-config.ts`  | `DshLlmPort` route (`ctx.llm.resolveModelInfo` limits), `SliceSessionStore` project port, `hub-run:<sessionId>` caller, `rateLimit.maxAttempts: 0` |
| `produce-tool-policy.ts`     | per-turn allowlist (capabilities, discussion mode, editor edit scopes) passed as `excludeTools`; Hub hides `web_search` and `open_in_editor`       |
| `runtime-stream-bridge.ts`   | `message_update` text/thinking deltas, tool and turn events → live `AgentTraceRow` snapshots on `/slides/sessions/:id/events`                      |
| `session-recovery.ts`        | turn outcomes → durable faults, same-session 429 wait/resume and provider failover (Grok fallback, minimax-cn ⇄ openrouter)                        |
| `session-commands.ts`        | create / resume / model switch (transactional rollback) / operator stop (bounded wait, lease release)                                              |
| `assistant-questions.ts`     | HTTP bridge to the running runtime's `QuestionBroker`; idle sessions read `_agent/assistant-questions.v1.json`                                     |

Conventions the host keeps:

- A session runtime is fixed at construction (route, tool set, discussion
  guard), so the manager recomputes the runtime key before every turn and
  rebuilds an idle runtime when it changes. History survives the rebuild
  through `_agent/runtime-session.v1.jsonl` recovery.
- The host's `RateLimitResumeController` owns the disk-persisted 429 wait
  (`_agent/dsh-rate-limit-wait.json`), so the loop runs with no in-turn
  retries; failover rebinds the store provider and resumes the transcript.
- Discussion turns expose only `inspect_capabilities`, `list_references`,
  `read_reference`, `read_page` and `ask_user_question`, and disable the
  durable progress guard.
- Personal mode reads the user's DSH home from `DSH_HOME` (else `~/.dsh`),
  matching the Host's own resolution, so `profileContext` is not needed.
- Disposing the plugin disposes every session runtime: a running turn is
  aborted and releases its writer lease. Activation marks turns left open by a
  dead process interrupted and drops that process's Hub writer leases.

## Verification

`npm test -w @open-slidestudio/slides-runtime` is fully offline: the
end-to-end produce chain (open → references → plan → write → synthetic raster
→ review → compose → export), question suspension, crash recovery, lease
heartbeat/takeover/preemption, steering/abort, backoff and overflow retry run
against a scripted port; `PiAiLlmPort` is exercised against closed and
loopback-only endpoints. `packages/dsh-slides-host/src/guard-parity.test.ts`
replays `packages/slides-runtime/fixtures/guard-ab.v1.json` through the frozen
reference host guards (`tool-loop-guard.ts`, `product-progress-guard.ts`, no
longer on the production path) and the runtime guards and requires identical
trips, fault codes and backoff values.
`packages/dsh-slides-host/src/four-service.e2e.test.ts` activates the host on a
context that offers only `webServer`, `connection`, `llm` and `attachments`
(any other service access throws) and drives create → live SSE deltas →
question answer → follow-up → model switch → operator stop offline through
`SlidesAgentRuntime` + `DshLlmPort`.
