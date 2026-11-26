---
status: superseded
date: 2026-08-26
supersedes: 0004-pi-is-the-single-agent-kernel
superseded-by: 0012-slides-runtime-core-agent-loop
---

> Superseded by [ADR-0012](0012-slides-runtime-core-agent-loop.md): the single-loop rule stays, but the loop is now the host-neutral `@open-slidestudio/slides-runtime`; DSH becomes a thin service channel in Phase 3B. Kept as the DSH-kernel record.

# DSH is the single production Agent Kernel

The single-kernel rule in [ADR-0004](0004-pi-is-the-single-agent-kernel.md) stays. The kernel itself changes. Production Agent Runs use DeepSeek Harness `0.1.5-rc.2` (git tag `dsh-v0.1.5-rc.2`, commit `fb2c4b9e698e30edb738bca4cf0618587db7d203`; the pin of record, including the registry tarball sha512, lives in [dsh-lock.md](../architecture/dsh-lock.md)). Pi RPC is no longer the production kernel after the cutover in [the single-user DSH plan](../architecture/dsh-single-user-migration-plan.md).

`@deepseek-ai/dsh-llm-pi-ai` may still call provider SDKs. That is an LLM adapter, not a second kernel.

## Decision

1. Open SlideStudio stays an independent product. It does not embed a Kimi iframe and does not ship the DSH default chrome.
2. The product profile stacks `@deepseek-ai/dsh-base` and the non-visual Host, transport, client runtime, session projection, and renderer rows from `@deepseek-ai/dsh-web-app`. It disables official visual rows such as `ui-layout`. An Open SlideStudio client plugin registers the only `root`. Two `root` registrants is a boot failure, not a CSS override.
3. The Agent Director owns semantic understanding, reference choice, research, design, page writing, and revision. The Host may reject invalid PPTD, layout collisions, missing receipts, and path escapes. The Host must not classify a brief into a category or design preset, paint pages, or report success after a template fallback.
4. YAML PPTD v2 remains the only slide document. DSH session events are the only conversation log. `_agent` ledgers hold execution receipts, not a second deck.
5. Hub generate is DSH `POST /slides/sessions` plus `PresentationRun`. `POST /api/generate` and `/api/pi/*` return 410. `createPiBrain` is not the product path.

## Considered options

- Keep Pi as the kernel and treat DSH as an experiment.
- Stack `dsh-base` only and keep `apps/native-web` as a second server beside DSH.
- Stack `dsh-web-app` unchanged and restyle the official AppFrame.

The first option keeps the dual-truth problem ADR-0004 already rejected. The second option leaves two UIs and two session owners. The third option cannot own `root`, because `ui-layout` already registers it. The accepted option uses DSH composition the way rc.2 documents it. Profile, bundle, and plugin replacement are the seams.

## Consequences

- Phase 7 closed the production graph: `dsh-slides-host` calls `PresentationRun` domain tools. `runPiHand` / HandsPort are not on that path. `@open-slidestudio/agent-harness` remains the Phase 0 freeze and a fixture package (`createPiBrain`, host painters). It is not a `slides` profile dependency.
- `docs/specs/open-slidestudio-gate1-gate2.md` clauses that require automatic template selection or allow mock or offline fake generation are historical UI inventory. They are not production law.
- Bring Your Own Key and supplier OAuth enter through DSH credentials and `dsh-llm-pi-ai`. They are Provider Connections. There is still no Open SlideStudio account.
- DSH upgrades go through a candidate profile and dump-config contract tests. Production stays pinned to `0.1.5-rc.2` until those pass.
- OpenKimi 76 source files and 44 visual previews stay complete and uncompressed. Receipts use `available → consulted → adopted → executed`. Host preset ids are not a substitute.

## Rejected alternatives

- Forking DSH source to delete its UI. Composition already removes `ui-layout`.
- A CLI-only DSH slice as the Phase 1 exit. [ADR-0007](0007-local-web-normal-creation-path-is-the-first-vertical-slice.md) still requires the product UI.
- Host classifiers such as `resolvePlaybookCategory` and `resolveGenerateDesign` on the DSH production path. They are the semantic overreach this cutover exists to delete.
