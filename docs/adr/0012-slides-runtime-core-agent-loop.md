---
status: accepted
date: 2026-11-26
supersedes: 0009-dsh-is-the-single-agent-kernel
---

# slides-runtime is the single host-neutral core agent loop

[ADR-0009](0009-dsh-is-the-single-agent-kernel.md) made DeepSeek Harness the production agent kernel. The single-loop rule stays; the loop moves out of the host. `@open-slidestudio/slides-runtime`, built on `@earendil-works/pi-agent-core@1.6.1` and `@earendil-works/pi-ai@1.6.1`, is the target single host-neutral agent loop for deck production: Phase 3A ships the package, LLM ports and guard parity proof standalone, and Phase 3B cuts the `dsh-slidestudio` plugin over so hosts provide services to it and do not run a second loop.

## Decision

1. **One loop.** `SlidesAgentRuntime` drives pi-agent-core's `Agent` over the canonical `@open-slidestudio/slides-tools` suite. It owns the context budget (`transformContext`), the argument short-loop guard, the durable progress guard, fault classification and 429 backoff, the `ask_user_question` suspension tool (interactive hosts only), the `_agent/runtime-session.v1.jsonl` session log, the public `_agent/agent-trace.jsonl` projection and the slides-tools single-writer lease.
2. **Pinned loop packages.** Exactly `@earendil-works/pi-agent-core@1.6.1` and `@earendil-works/pi-ai@1.6.1`. `@earendil-works/pi-coding-agent`, durable-loop add-ons and the frozen `createPiBrain` / `runPiHand` ports stay forbidden in production sources (`verify:no-fake-path`).
3. **Host-neutral LLM port.** The loop talks to `LlmPort` (a pi-agent-core `StreamFn` plus route metadata). `PiAiLlmPort` runs SlideStudio standalone against registered pi-ai models or any OpenAI-compatible endpoint. `DshLlmPort` (`packages/dsh-slides-host`) bridges DSH `ctx.llm` and `ctx.attachments`.
4. **DSH becomes a thin channel.** In Phase 3B the `dsh-slidestudio` plugin shrinks to four services — `webServer`, `connection`, `llm`, `attachments` — plus an optional `mcpManager` registration. The DSH session journal is no longer the conversation log; DSH agent presets, tool registries and guards stop driving production runs.
5. **External agents share the same surface.** Claude Code, Codex and other MCP hosts use `@open-slidestudio/slides-mcp`, which serves the same `slides-tools` definitions under the same single-writer lease. There is no second tool contract.
6. **No intranet or gateway specifics in core.** The context budget exposes generic `GatewayCompat` and `ContextBudgetHooks` seams that default to empty. Deployment-specific compatibility lives outside this repository.
7. **YAML PPTD v2 stays the only document** and `_agent` ledgers stay execution receipts ([ADR-0001](0001-monorepo-and-pptd.md), [ADR-0008](0008-openkimi-source-and-review-receipts.md)).

## Non-goals

- No subagents.
- No general-purpose shell or filesystem tools; only the product slide tools (and `ask_user_question` for interactive hosts).
- No plan mode.
- No built-in MCP client inside the loop.
- No permission-prompt system.
- Strictly one project per run and one writer per project.

## Consequences

- Phase 3A ships the package, both LLM ports and the guard parity proof; `packages/dsh-slides-host/src/plugin.ts` keeps its current behavior until Phase 3B switches the plugin to the thin shell.
- Guard thresholds are unchanged (short loop 3; business rejection 3; invalid arguments 8; planning 64; production 32). `guard-parity.test.ts` replays one recorded fixture through the host guards and the runtime guards and requires identical trips.
- Root `@earendil-works/pi-ai` moves to `1.6.1`. `vendor/dsh-llm-pi-ai` keeps its `^0.87.1` pin through a nested install, so the isolated DSH host continues to resolve the vendored adapter unchanged.
- DSH release packaging (`dsh-slidestudio/scripts/release.mjs`, verified offline by `verify-release.mjs`) bundles the full production closure of `slides-tools`, `slides-runtime`, and hoisted pure-JS `pi-agent-core` / `pi-ai` dependencies with no native image addons. DSH dev profile packaging (`dsh-slides-bundle`, `scripts/lib/dsh-profile-sync.mjs`) declares `slides-tools` and `slides-runtime` via `file:` dependencies, which `npm run dsh:profile:init` installs as local copies using `npm install --install-links --legacy-peer-deps` — resolving regular third-party dependencies from npm cache or registry while leaving host-provided `@deepseek-ai/*` `peerDependencies` uninstalled for the DSH host to supply at runtime.

See [slides-runtime architecture](../architecture/slides-runtime.md).
