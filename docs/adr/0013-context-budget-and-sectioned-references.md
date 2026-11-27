---
status: accepted
date: 2026-11-27
---

# Context budget calibration, sectioned references and stage-scoped tools

Real generation traces on 128k–200k models (`glm-5.4`, `grok-4.7`) revealed that SlideStudio consumed ~81k–84k input tokens before writing slide 1, peaked at ~142.8k on a 6-slide deck, and paid ~128k input tokens on a single comment-edit turn:

- 18–19 produce tool schemas consumed ~106 KB (~30k tokens), including `write_layout` (38.1 KB, unused in normal deck generation) and material tools (5.5 KB, unused when no attachments exist).
- Mandatory reference chunks (`SKILL.md`, full `pptd.md`, `slides_categories.md`) consumed 110.7 KB (~32.9k real tokens), with `pptd.md`'s chart specification alone accounting for 40.6 KB even on chart-free decks.
- `keepRecentResults: 2` truncated parallel `read_reference` results before the model saw them while the ledger still counted them read; `escalate()` tier 0→1 could be a no-op; `clampMaxTokens` crushed output down to 1,024 tokens instead of rejecting undersized windows; low-`maxTokens` routes exhausted their output budget on reasoning before emitting tool calls.

## Decision

1. **Sectioned reference manifest v2 (`@open-slidestudio/presentation-run`).**
   - New runs use `openkimi-source-manifest-v2-sectioned` (`openkimi-sectioned-v2`), splitting `openkimi:reference/pptd.md` into byte-exact, SHA-256-verified semantic section groups (`openkimi:reference/pptd.md::<section>`). Existing v1 ledgers remain unchanged and readable.
   - Pre-`commit_design` required reads drop from 110,655 B to 53,647 B (-51.5%, 3 `pptd.md` core chunks instead of 8). Specialized sections (`line`, `image`, `icon`, `table`, `chart`, `animation`) are gated on demand at `write_page` via `writePageReferencePreflight` (`error: "reference_section_unread"`, `next: "read_reference"`).
   - Delivery-confirmed reference accounting (`reference_delivery_confirmation` feature flag, default `true` in Hub runtimes) records `reference.chunk-prepared` on read and promotes to `reference.chunk-returned` only after `slides-runtime` confirms untruncated delivery via `onDeliveredReferences` -> `recordReferenceDeliveredByCommandId`.
   - `list_references(kind: "design")` serves 43 deduplicated design-system selection cards (17 aliases folded, <= 16 KiB). Write-page rejection details are capped to 992 chars (`<= 1,024` with prefix) while preserving every offending field name. Model switches on committed v2 ledgers carry verified baseline reads into the new epoch (`reference.epoch-carried`) while re-requiring specialized sections on demand.

2. **Stage-scoped produce tools and targeted patching (`@open-slidestudio/slides-tools`).**
   - `applyProduceStagePolicy` removes `write_layout` outside layout work and removes material tools (`list_materials`, `read_material`, `query_material`) when no attachments exist, reducing produce tool schemas from 105,916 B to 63,590 B (no attachments) / 69,107 B (with attachments).
   - Opt-in `patch_page_elements` (1,303 B schema, <= 2 KB budget) applies targeted element field/bounds/style/z-order/removal patches onto the canonical page on disk and executes through the exact `executeWritePageOnce` YAML PPTD v2 path (zero dual IR). It rides with `write_page` and is withheld by every lock that withholds `write_page`.
   - Committed `commit_design` returns a compact `< 1 KB` `designContract` anchor card (`design-contract.v1`), and `directorBrief` drops attachment instructions when `hasAttachments: false`.

3. **Calibrated, window-tiered context budget and recovery (`@open-slidestudio/slides-runtime` + `@open-slidestudio/dsh-slides-host`).**
   - `TokenCalibration` calibrates offline token estimates (3.5 bytes/token CJK-aware baseline) against provider `usage` (`input + cacheRead + cacheWrite`, bounded `[0.7, 1.8]`). Output reserve defaults to `max(4096, 12% window)`.
   - All tool results of the latest assistant step are protected verbatim; `ContextBudget.escalate()` probes tiers `floor+1..4` and jumps directly to the lowest tier that strictly reduces tokens.
   - Windows that cannot fit protected context with at least 4,096 output tokens (including 32k models) fail pre-flight with `context-window-too-small` (`CONTEXT_WINDOW_TOO_SMALL`) before dispatching a doomed request, rendered in the left panel with explicit >= 64k model-switch guidance.
   - 64k–96k windows activate working-set mode (active page verbatim, completed pages collapsed to one-line `[页面回执]` receipts, superseded `write_page` arguments pruned, `keepImageSteps: 1, maxImages: 2`). Windows `>= 180k` stay cache-first (append-only, no prefix mutation) below 75% budget.
   - Low-`maxTokens` routes cap initial `reasoningEffort` (`<= 8,192` -> `low`, `<= 16,384` -> `medium`), and replies truncated by `max-tokens` without tool calls strip the truncated reply from in-memory context, step reasoning down one notch (down to explicit `off` respected by `DshLlmPort`), nudge, and auto-continue up to 2 times.
   - Comment/review edit turns and model-switch / failover recovery start from a fresh context seeded with a compact `< 2,500`-char disk summary (`buildDiskContextSummary` -> `seedFromSummary`), while `_agent/runtime-session.v1.jsonl` remains append-only.

## Consequences

- YAML PPTD v2 remains the sole disk SSOT ([ADR-0001](0001-monorepo-and-pptd.md)) and byte-exact reference verification remains intact ([ADR-0008](0008-openkimi-source-and-review-receipts.md)).
- 32k-window models are explicitly unsupported for full deck generation and receive an actionable model-switch error immediately instead of silent truncation or loops.
- 64k–128k models can complete full multi-page generation without context starvation, while >= 180k models preserve prompt-cache prefix stability.
- Comment turns and model switches avoid replaying stale intermediate reasoning while preserving user dialogue, design contract, page plan, and disk status.
