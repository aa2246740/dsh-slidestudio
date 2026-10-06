# Spec: Open SlideStudio — Gate 1 (主路径) + Gate 2 (全量)

> **Historical UI inventory — not production law.** Per ADR-0009 (consequences),
> clauses below that require automatic template selection or allow mock/offline
> fake generation describe the pre-DSH spec era. The production kernel is DSH;
> the normal creation path must be a real provider-backed Agent Run
> (`POST /slides/sessions` + `PresentationRun`), and `/api/generate` returns 410.

**Status:** published · seams confirmed · Linear parent OOP-5 + tickets OOP-6…OOP-17  

**Source:** batch-grill Decision Snapshot (user confirmed) + existing monorepo  
**Vocabulary:** PPTD, deck, slide, element, design brain, recipe, CompositionPlan, pin annotation, version snapshot, Open SlideStudio  
**ADR:** 0001 monorepo + PPTD as sole document truth

---

## Problem Statement

Anyone who needs a presentation still faces a gap between “AI that dumps a pretty PDF-like blob” and “a real product where I can generate, critique, annotate for the agent, edit objects, and hand over a PowerPoint colleagues can edit.”

The Kimi Slides video set the bar for **flow completeness**, **workspace feel**, and **editable output**. Open SlideStudio already has a spine (prompt → agent → PPTD → export) but:

- Generated decks still often feel like **AI template fill-in** (ugly / no design authority).
- Product chrome and tools are **partially wired**; some controls look real but fail user trust.
- **Pin comments** were implemented more like human discussion pins than **agent work orders** (“change *here* like this”).
- Full video/PRD capability list is not done, so the product still **feels incomplete** next to the reference experience.

The user wants **both**: a **Gate 1** “I can demo this seriously” path, and a **Gate 2** “PRD/video checklist cleared” path—without KIMI trademark, without fake “consulting-grade” claims, without realtime multiplayer.

---

## Solution

Ship Open SlideStudio as an open product that:

1. **Generates** multi-slide decks from a short brief (Chinese or English), with system-chosen design under a design brain, optional **template wall with auto-default**.
2. **Shows agent work** in a split workspace (chat/process | editor).
3. Lets users **edit PPTD objects** (text, shapes, images, charts with data, tables, SmartArt-level structure).
4. Lets users **pin agent annotations** on the slide, batch “process all pins,” get a **new version**, pins can clear after success; failures keep pin + reason + retry (no aggressive full rollback—versions cover undo).
5. Supports **NL refine**, **version history / restore**, **play**, **export editable PPTX** (and secondary PNG/PDF as convenience).
6. Supports **image → editable rebuild** (structured objects, not full-page bitmap).
7. Measures success in two gates (below), with rigorous **behavior-level tests** at agreed seams.

### Gate 1 — 主路径完成 (“可以给人演示了”)

1. Chinese one-line brief → complete deck that is **not ugly** (conclusion titles, page variety, data pages with takeaway).  
2. Comfortable hand edit: text, image, chart numbers.  
3. Export **editable PPTX**.  
4. Split workspace feels like a **real product**.  
5. NL page refine + version rollback.

### Gate 2 — 全量完成 (“和视频能力对齐了”)

Everything in Gate 1, plus PRD/video residual: pin→agent batch workflow (correct semantics), template wall + auto default, image rebuild quality, chart/SmartArt polish, play, attach flows, remaining chrome parity—**checklist zero**.

---

## User Stories

### Create & generate

1. As a presentation author, I want to type a short brief and get a full deck, so that I skip blank-slide paralysis.  
2. As a Chinese business user, I want Chinese decks with conclusion-style titles, so that leadership can read title-only.  
3. As an author, I want the system to pick a coherent visual system by default, so that I don’t babysit fonts and colors.  
4. As an author, I want a visible template/category wall with auto default selection, so that the product feels complete without forcing me to choose.  
5. As an author, I want to attach references (docs/images), so that generation uses my material.  
6. As an author, I want to see agent steps while generating, so that long waits feel trustworthy.  
7. As an author, I want generation to vary layouts across slides, so that it doesn’t look like one template stamped repeatedly.  
8. As an author, I want charts and tables with takeaway titles, so that data slides argue something.  
9. As an author, I want forbidden “AI default” looks avoided (generic purple, empty claims), so that output doesn’t scream slop.  
10. As an author, I want offline/mock generation when LLM is down, so that demos don’t hard-fail.

### Workspace & product feel

11. As an author, I want a split chat | editor workspace, so that agent and document stay co-visible.  
12. As an author, I want the left rail not to steal half the stage, so that the slide is primary.  
13. As an author, I want bottom tools that always do something honest (or explain why not), so that I trust the product.  
14. As an author, I want thumbnails and page switch, so that I can navigate multi-page decks.  
15. As an author, I want Play mode with keyboard, so that I can rehearse.  
16. As an author, I want Share as a clear entry (even if access is local-session level), so that chrome matches expectations.  
17. As an author, I want loading/empty/error states that don’t look broken, so that the product feels finished.

### Direct editing

18. As an author, I want to select elements and edit text, so that I can fix wording instantly.  
19. As an author, I want to add text, shapes, images, tables, charts, so that I can extend the deck by hand.  
20. As an author, I want chart data editing with live update and undo, so that numbers stay trustworthy.  
21. As an author, I want SmartArt/process nodes editable, so that structure slides stay structured.  
22. As an author, I want nudge/move of selected elements, so that layout tweaks are fast.  
23. As an author, I want undo/redo for local edits, so that mistakes are cheap.

### Agent annotations (pins) — corrected semantics

24. As an author, I want to pin a note on a slide position with change instructions, so that the **agent** knows *where* and *what* to change.  
25. As an author, I want multiple open pins, so that I can batch feedback like review marks.  
26. As an author, I want “Process all annotations” once, so that the agent applies them in one run.  
27. As an author, I want a new version after successful pin processing, so that history captures the change.  
28. As an author, I want pins to clear (or leave only version notes) after success, so that the canvas isn’t cluttered.  
29. As an author, I want failed pins to remain with a reason and retry, so that partial success doesn’t erase intent.  
30. As an author, I do **not** want automatic full-deck rollback on imperfect edits, so that I can refine with more pins; I use versions when I need to rewind.

### NL refine & versions

31. As an author, I want chat refine on the current deck, so that I can say “make the cover darker” without re-prompting from zero.  
32. As an author, I want version list with latest/history, so that I can compare outcomes.  
33. As an author, I want restore / back to latest, so that experiments are safe.  
34. As an author, I want readonly when viewing history, so that I don’t corrupt the past.

### Image rebuild

35. As an author, I want to attach an infographic and ask to rebuild, so that I get editable objects not a dead image.  
36. As an author, I want rebuild QA notes when confidence is low, so that I know what to review.  
37. As an author, I want portrait rebuilds when the source is vertical, so that layout matches intent.

### Export

38. As an author, I want PPTX export of structured objects, so that colleagues edit in PowerPoint.  
39. As an author, I want a fidelity report when export degrades, so that I’m not surprised.  
40. As an author, I want optional PNG/PDF convenience export, so that I can share previews.

### Quality & trust

41. As a stakeholder, I want no KIMI trademark in product UI, so that the project stays clean legally/brand-wise.  
42. As a stakeholder, I want no “consulting-grade” claims until I explicitly approve, so that marketing doesn’t oversell.  
43. As an author, I want broken tools never silent-fail, so that reliability is obvious.  
44. As a developer-agent, I want Gate 1 acceptance automatable at high seams, so that “done” isn’t vibes-only.

---

## Implementation Decisions

1. **PPTD remains sole document IR** (ADR-0001). Canvas, agent, exporter all read/write PPTD; never full-page bitmap as truth.  
2. **Two delivery gates** in planning and tickets: Gate 1 demo path first; Gate 2 full PRD/video checklist.  
3. **Design brain owns geometry/recipe selection**; LLM owns narrative content + soft hints; outline compile goes through CompositionPlan path already started.  
4. **Product name Open SlideStudio**; soft rebrand only—no KIMI assets/trademarks.  
5. **Template wall exists**; **default selection is automatic** (user can override).  
6. **Pin annotations are agent work orders**, not primarily human discussion threads. Batch process → agent refine scoped by pin coordinates + text → version snapshot; success clears pins (or leaves version summary only); failure keeps pin + reason + retry.  
7. **Versions are the rewind mechanism**; do not force full undo of an agent batch on “not perfect.”  
8. **Multi-model**: core APIs stay provider-agnostic; Real LLM path + Mock path both honor rebuild/pin/refine contracts.  
9. **Modules involved (logical):**  
   - document/commands (PPTD apply/undo, chart/smartart commands)  
   - design brain (contract, recipes, select, compose, lint)  
   - agent harness (run, refine, image rebuild, pin-batch apply)  
   - exporter (PPTX fidelity)  
   - web product (Create Hub, workspace, pins UI, tools, export/share/play)  
10. **Pin-batch agent input** must include: deck snapshot, list of {slideId, x, y, text, id}, instruction to edit only relevant regions/objects and return full deck or command batch with version bump.  
11. **Acceptance language** for generation quality is observable (title is claim-like, recipe variety, quality score / lint, native export coverage)—not brand slogans.  
12. **Linear** is the issue tracker (team Oops / project slides); this spec publishes as parent; tickets via `/to-tickets` later.

---

## Testing Decisions

### What good tests do

- Assert **external behavior** users/agents care about: given prompt/refs → deck properties; given command → deck state; given export → editable coverage signals.  
- Prefer **highest seam** (fewest tests, most confidence).  
- No tests that lock private function names or CSS class strings unless they *are* the product contract.

### Proposed test seams (confirm)

Prefer **one primary seam** with two supporting seams:

| # | Seam | Why | Example behaviors |
|---|------|-----|-------------------|
| **S1 (primary)** | **Agent run boundary** — `createAgentRun` / provider `run` with Mock (and optional Real when env set) | Highest product seam: generate, refine, rebuild, (later) pin-batch | Gate 1: mock generate → multi-slide deck, claim-like titles or design score, steps include compose; refine bumps version; rebuild intent → portrait + connectors |
| **S2** | **PPTD command boundary** — `applyCommand` / undo | Already strong prior art; all editor actions should land here | Chart data update + undo; add element; pin processing *results* as commands |
| **S3** | **Design-brain compose boundary** — `composeDeckPlans` / lint | Generation quality without LLM flakiness | Recipe variety; soft vs locked recipe; lint flags generic titles / streaks |
| **S4 (optional later)** | **Export boundary** — `exportDeckToPptx` | Gate 1 export claim | nativeCoverage / no throw on sample + generated decks |
| **S5 (optional)** | **Browser smoke** (existing scripts) | Product feel / tools not silent | Generate path or fixture deck: tool click adds element; not full visual regression |

**Ideal concentration:** Gate 1 automation lives mostly in **S1 + S2 + S3**; S4 on critical sample; UI only where pure unit seams can’t prove “button does something.”

### Prior art

- `packages/pptd` command apply/undo tests  
- `packages/agent-core` mock run + sample deck + image-rebuild tests  
- `packages/design-brain` compose pipeline tests  
- `packages/exporter-pptx` export tests  
- repo smoke/e2e scripts  

### Testing rigor for this program

- Every Gate 1 ticket must list acceptance criteria that map to S1–S4 where possible.  
- No ticket closed without: typecheck + package tests for touched packages + at least one behavior assertion for the user-visible claim.  
- Generation “not ugly” is tested via **lint/score + structural variety**, plus a fixed golden outline fixture—not screenshot AI judgment in CI.

---

## Out of Scope

- KIMI trademark, official assets, or impersonation  
- Claiming “consulting-grade / McKinsey-style” without explicit user sign-off  
- Realtime multiplayer co-editing  
- Full server-side Share ACL / permissions product  
- Perfect multi-modal vision OCR as the only rebuild path (structured rebuild is in scope; state-of-the-art vision may be later enhancement under Gate 2)  
- Aggressive automatic full-deck rollback when pin-batch is imperfect  
- Pixel-perfect clone of every Kimi chrome pixel  

---

## Further Notes

### Decision Snapshot (confirmed)

- Goal: Kimi-like **flow + chrome feel + deck quality**; brand Open SlideStudio.  
- Full PRD/video capability eventually (Gate 2).  
- Demo priorities 1–5 = Gate 1.  
- Pins = agent annotations; batch process; version history; fail keeps pin.  
- Template wall + auto default.  
- Audience: anyone who wants PPT; Chinese business demo as default sample.  
- Tracker: Linear oops / OOP / project slides.  
- Artifacts: this spec + tickets (to-tickets next).

### Suggested sample brief (Gate 1 demo)

> 「为经营委员会写一版 Q3 区域增长决策材料：华北贡献、试点 vs 全量、本周动作。」

### Next process step

Done: seams confirmed; published to Linear; `/to-tickets` created children. Next: implement frontier tickets (or workflow) — start **OOP-6, OOP-7, OOP-8, OOP-9, OOP-14**.

---

## Seam confirmation

**Confirmed** (S1 agent mock primary; S2 PPTD commands; S3 design-brain; S4 export; S5 light browser smoke).

## Ticket map (Linear-era IDs, now local)

| Ticket | ID | Gate | Blocked by |
|--------|--------|------|------------|
| Spec parent | OOP-5 | — | — |
| T1 Chinese brief → non-ugly deck | OOP-6 | G1 | — |
| T2 Hand-edit text + chart + undo | OOP-7 | G1 | — |
| T3 Export editable PPTX | OOP-10 | G1 | OOP-6 |
| T4 Workspace + honest tools + brand | OOP-8 | G1 | — |
| T5 NL refine + versions | OOP-9 | G1 | — |
| T6 Gate 1 demo acceptance | OOP-11 | G1 | OOP-6…10 |
| T7 Pin → agent process-all | OOP-12 | G2 | OOP-9 |
| T8 Template wall + auto default | OOP-13 | G2 | OOP-6 |
| T9 Image rebuild portrait + QA | OOP-14 | G2 | — |
| T10 SmartArt/process editable | OOP-15 | G2 | OOP-7 |
| T11 Play / Share / attach chrome | OOP-16 | G2 | OOP-8 |
| T12 Gate 2 checklist zero | OOP-17 | G2 | OOP-12…16 |

Note: triage labels now live as options on the `标签` field of the `tickets` Feishu Base table; see docs/agents/triage-labels.md.
