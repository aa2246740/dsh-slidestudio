---
version: alpha
name: Open SlideStudio Product Chrome
description: A quiet, high-density local AI slide workbench that recreates the frozen Kimi Slides interaction reference without shipping Kimi branding, iframe, or cloud shell.

colors:
  primary: "#1A1917"
  ink: "#1A1917"
  muted: "#6D6A62"
  subtle: "#8B877D"
  line: "#E3DFD4"
  work: "#F1EFE8"
  chrome: "#FDFCFA"
  panel: "#FAF9F5"
  surface: "#FFFFFF"
  accent: "#D97757"
  accent-text: "#B5573A"
  selected: "#D97757"
  focus: "#D97757"
  success: "#467343"
  error: "#B53333"

typography:
  ui-sm:
    fontFamily: 'Inter, MiSans, "PingFang SC", "Noto Sans SC", system-ui, sans-serif'
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
  ui-md:
    fontFamily: 'Inter, MiSans, "PingFang SC", "Noto Sans SC", system-ui, sans-serif'
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: 'Inter, MiSans, "PingFang SC", "Noto Sans SC", system-ui, sans-serif'
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.3
  wordmark:
    fontFamily: 'Unna, "Songti SC", 思源宋体, Georgia, serif'
    fontSize: 56px
    fontWeight: 400
    lineHeight: 1.05
    letterSpacing: -0.015em

rounded:
  none: 0px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 22px
  full: 9999px

spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px

components:
  icon-button:
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    width: 32px
    height: 32px
  chrome-pill:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.ui-sm}"
    rounded: "{rounded.full}"
    height: 32px
  prompt-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "{spacing.md}"
  send-button:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.full}"
  tooltip:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    typography: "{typography.ui-sm}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
---

# Design System

## Overview

Open SlideStudio is a standalone local AI presentation product. Its product chrome follows
the frozen Kimi Slides editor interaction reference dated 2026-08-20, including density,
control placement, hover feedback, tooltips, page rail, canvas toolbar, and creation flow.
It does not copy Kimi branding, logos, account surfaces, payment, or cloud services.

The design read is a quiet professional workbench: white chrome, pale work area, compact
controls, minimal elevation, and content-led color. The product must feel direct and
trustworthy, especially while an Agent is working. Decorative card grids, glass effects,
generic gradients, fake progress, and dead buttons are forbidden.

## Colors

- ink is the primary chrome, active control, and tooltip color.
- muted and subtle carry secondary labels and unavailable metadata, never the only
  indication of a critical state.
- line separates persistent chrome only when spacing cannot carry the grouping.
- work is the editor field around the slide; surface is the page and control surface.
- selected is the selection/active reference color. It is not a general brand wash.
- focus is reserved for visible keyboard focus.
- error is paired with explanatory recovery text, not used alone.
- A stopped generation with unfinished pages uses an attention marker, never a success check.
  Show the concrete unfinished checks and recovery action directly below its status in the
  conversation timeline, even when there is no provider exception. Use existing muted text,
  12 px type and 1.6 line height; let long reasons wrap within the panel.
- New persistent colors require a contract update before code changes.

## Typography

UI uses Inter for Latin and MiSans/PingFang/Noto Sans SC fallbacks for Chinese. Dense chrome
stays mainly at 12-14 px, with weight and spacing establishing hierarchy. The 42 px wordmark
is the only deliberately expressive UI type and keeps its measured negative tracking.

**Slide fonts** live in `packages/pptd-v2/src/font-policy.ts` and are the only faces a slide
may name: 微软雅黑, 黑体, 宋体, 楷体, 仿宋 for East Asian; Arial, Times New Roman, Georgia,
Verdana, Tahoma, Courier New for Latin. Both are faces that Office and WPS already ship, so
the canvas and the exported PPTX match without embedding. `content.fontFamily` is a
`{latin, ea}` pair written separately; a face outside the list is rewritten to the closest
match and `write_page` reports the change in `fontNotes`. Decks saved before this policy keep
whatever they named. Product chrome keeps its own stack and never reads the slide table.

Chinese/English labels, provider names, model ids, versions, counts, and percentages must be
tested with real mixed-script strings. Versions, page counts, zoom percentages, and numeric
status use tabular figures. Critical text wraps or exposes a full-view path; it must not rely
only on truncation or a browser-native title.

## Layout

- Create Hub: centered column, prompt and reference area capped at 768 px.
- Editor: stable insertion commands, compact page rail, canvas fitted to remaining space,
  and a labelled selected-object inspector. The 2026-09-06 canvas workflow below supersedes
  the old frozen-placement comparison for editor chrome.
- Frozen editor comparison viewport: official host 1600 x 1000; captured child image
  1576 x 892. Fidelity comparisons use the same state and normalized pixel dimensions.
- Fixed editor chrome uses stable control dimensions. The slide scales within the available
  work field; persistent controls must remain visible.
- The normal page must not introduce horizontal document scrolling at 320 px. At narrow
  widths, task priority is Create prompt → provider access → result; the full editor may
  scale its fixed canvas but may not cover the primary controls.

## Elevation & Depth

Use borders and tonal separation before shadow. Shadows are allowed only for floating
objects: prompt card, menus, dialogs, tooltips, context bars, and the editor insert pill.
Do not combine large soft shadows with heavy borders.

## Shapes

- Compact controls and menu rows use rounded.sm.
- Tool panels and ordinary floating surfaces use rounded.md.
- The main prompt uses rounded.lg.
- Pills and circular icon buttons use rounded.full.
- Do not over-round page rails, canvas, tables, or structural editor regions.

## Components

### Shared tooltip

The product-owned tooltip replaces browser-native title paint for visual parity. It uses a
dark rounded rectangle, directional triangle, viewport clamping, short hover delay, focus
support, and aria-describedby. Dynamic controls update their text in place. Critical state
explanations must also be visible in the relevant panel or state copy; hover cannot be the
only recovery path.

### Icon button

Every icon-only action is a semantic button or link with an accessible name. Required states:
default, hover, focus-visible, active/pressed, and disabled where applicable. Icons use the
existing product icon family/source; do not introduce emoji, text-glyph substitutes, CSS art,
or a second icon style.

### Prompt card

The Create prompt contains the style-reference cue, multiline brief input, attachments,
output/layout choices, exact selected provider, and one primary send action. The normal
surface never exposes Template Mode, legacy LLM selection, or host-directed generation.

### Provider panel

The panel is supplier-scoped. It supports BYOK and provider-supported OAuth, never echoes
secrets, shows the exact current provider/auth kind, explains unsupported methods, and keeps
login errors next to the recovery action.

### Agent timeline

Timeline rows reflect real DSH session/tool events and page progress. Running, paused, failed, resumed,
and successful states use truthful language. A success card appears only after independent
generation provenance passes.

### Live-generation handoff

Once the server has created the project identity, Create hands the user directly to the
editor's live, read-only generation view; it does not keep a second decorative preview on
the Hub. The left panel opens its durable action record by default and exposes the request,
current verifiable action, committed output, check result, and retry/failure evidence. It
does not claim to expose a model's private reasoning. Until the run reaches a terminal
state, edit, export, comment, and Agent-modification controls are unavailable; the canvas
and page rail remain for observation only.

### Editor chrome

Title/version/export/play/fullscreen, rail controls, zoom, edit/comment modes, insert actions,
versions, comments, notes, and local messages follow the frozen reference geometry and
state behavior where evidence exists. Every clickable control has an oracle row or an
explicit product-only rationale.

## Do's and Don'ts

Do:

- Match the frozen reference before inventing a new visual choice.
- Keep product branding Open SlideStudio and production runtime Kimi-free.
- Prefer spacing/alignment over extra borders or cards.
- Provide hover, focus, active, disabled, loading, error, success, and long-text states.
- Keep every core control functional, keyboard reachable, and visibly responsive.
- Preserve editable PPTD/PPTX material honesty.

Don't:

- Do not ship an official Kimi iframe, CDN, logo, or trademark claim.
- Do not display old output, simulated timers, templates, or host-painted pages as generation.
- Do not introduce browser-native tooltip bubbles as the parity implementation.
- Do not add complete page/deck templates to the normal product.
- Do not use full-page raster PPTX as an export shortcut.
- Do not claim Phase G or complete 1:1 parity while documented states remain open.

## Agent Execution Rules

- Read this file before changing product UI.
- Treat docs/editor-oracle/baselines/kimi-v1-2026-08-20/ as the v1 visual truth.
- Reuse existing tokens and shared controls before creating one-offs.
- Update this contract before adding a persistent token or component rule.
- Use only the repository-pinned Playwright runtime for automated browser evidence.
- Run the relevant local UI QA and preserve screenshots for every changed visible state.

## Request Anchor

> **Kernel note (post-ADR-0009):** Where this file says "Pi is the sole Agent
> Kernel" or describes Pi-authored design contracts, a rendered full-deck
> overview, and a grounded nine-axis taste review as frozen requirements, that
> vocabulary is Pi-era. The production kernel is now native DSH
> (`docs/adr/0009`), and the revised `docs/adr/0008` removed the design-contract
> visa / deck-overview / taste-review ceremony — the DSH tool surface has no
> `render_deck` / `review_deck`. The fail-closed, no-template-substitution, and
> provenance rules below still stand.

- Original user request: Finish the abandoned project as an independent AI-generated PPT
  platform comparable to Kimi, using OpenKimi as reference but no iframe or official shell.
- Latest user override: Full visual/interaction parity including tooltips and micro-buttons;
  Pi is the sole Agent Kernel; product login is provider BYOK/OAuth; normal generation must
  fail closed; Template Mode is development/test only; prove the deck is truly agent-designed;
  restore OpenKimi's complete taste inputs and enforce a full-deck visual critique before export.
- Deliverable: Local web product from Create Hub through real Pi generation, editable PPTD
  editor, versions/comments/play/attachments, and editable native PPTX.
- Primary audience: A local creator/operator who wants Kimi-level speed and interaction
  without Kimi account, shell, or vendor lock-in.
- Core job to be done: Turn a brief and optional references into a newly designed,
  auditable, editable presentation in one normal product flow.
- Success criteria: Same screenshot family and interactions as the frozen reference where
  captured; real selected-provider Pi run; exact selected design text and preview delivery;
  Pi-authored design contract; per-page and full-deck write/render/review/compose provenance;
  no template substitution; editable canvas and PPTX.
- Non-goals: Official account/queue/payment, Google Slides, cloud ACL, multi-user realtime,
  long-document output, and 4:3 in this release.
- Must preserve: YAML PPTD v2 disk SSOT, zero production Kimi dependency, OpenKimi pinned
  reference, provider secret privacy, failure checkpoints, and existing editable exporter.
- Validation must check against: frozen hashes and controls; five official tooltip strings;
  product kernel/fail-closed assertions; rendered UI states; authentic external Pi run; PPTX
  object editability.

## Decision Snapshot

| Choice | Frozen decision |
|---|---|
| Product | Local-first, single-user web product |
| Visual target | Frozen Kimi v1 reference, including small controls and tooltips |
| Agent runtime | Repository-pinned kernel only in normal product — now DSH `dsh-v0.1.5-rc.2` (ADR-0009; was Pi) |
| Login | Supplier-scoped BYOK and OAuth; reuse existing Pi auth in development |
| Failure | Pause/fail/checkpoint; never host-finish or template fallback |
| Template Mode | Explicit development/test/fixture CLI only |
| Design material | Primitives, fonts, icons, tokens, and examples allowed; complete pages/decks forbidden |
| Timeline | Kimi-aligned visible plan/tools/progress plus full auditable Pi trace |
| First vertical slice | Normal UI → real Pi → new PPTD → editable canvas |
| Export | Hybrid editable PPTX; full-page raster is failure |
| Search/vision | Do not artificially disable capabilities offered by the selected Pi model |
| Acceptance | Hard provenance plus selected-reference and plan-coverage gates (ADR-0008 revised: design-contract visa, full-deck overview, and taste-review ceremony removed) |

## Content Model

- **User intent:** Create or refine a presentation without leaving the local workbench.
- **Message hierarchy:** what to make → references/style intent → provider readiness →
  agent work/progress → authentic result → edit/export.
- **Primary action meaning:** Send starts a real external provider run; it may incur provider
  usage and only creates a success result after provenance passes.
- **Voice and tone:** concise Chinese product language, calm and factual; never imitate a
  cloud capability that the local product does not have.
- **Canonical terms:** 幻灯片, 页面, 元素, 版本, 参考资料, 供应商, Agent, 生成进度.
- **Avoid:** 模板生成, 离线 AI, 官方同款, 已完成 when the run is only partial.
- **State language:** loading says the current work; failure names cause and recovery; paused
  explains resume; disabled explains why and what enables it; success names the next action.
- **Content risk:** model calls send user text/attachments to the selected provider and must
  require explicit QA consent outside the normal user-initiated product action.

## OKF Preflight

### Active OKF Concepts

- design-okf/governance/request-integrity.md
- design-okf/digital/accessibility-usability.md
- design-okf/digital/responsive-interaction.md
- design-okf/governance/design-to-code-governance.md
- design-okf/systems/typography-system.md
- design-okf/content/state-language.md
- design-okf/content/semantic-binding.md
- design-okf/foundations/necessary-design-judgment.md
- design-okf/systems/taste-engine.md
- design-okf/systems/type-personality.md
- design-okf/production/presentation-deck.md

### Support References

- ultimate-design/references/pro-mode.md
- ultimate-design/references/branch-web-product.md
- ultimate-design/references/content-model.md
- ultimate-design/references/audit-polish.md
- ultimate-design/references/design-contract.md
- ultimate-design/references/visual-verification.md
- ultimate-design/references/quality-gates.md
- Product Design image-to-code and design-qa workflows

### Execution Mode

single-agent: the task has one product surface and one visual truth; repository rules do not
authorize delegated subagents.

### Decision Record

- Constraints extracted: strict frozen-reference match, no Kimi production dependency,
  no fake generation, existing product system first, accessible dynamic tooltip, fail closed.
- Deliberate exceptions: Open SlideStudio branding and local-only equivalents replace
  Kimi cloud/account surfaces; excluded official services are not visually fabricated.
- Verification hooks: baseline hash/control verifier, local hover/state QA, same-state
  screenshot comparison, keyboard/focus checks, provenance gate, editable exporter tests.
- Editor chart contract: a manually inserted chart owns an opaque chart-area surface; non-pie
  legends name series, reserve plot width, and never overlap marks; active dark-toolbar toggles
  use selected blue with white glyphs rather than near-white unlabeled blocks.
- Rendered rule-to-text contract: a horizontal rule may never intersect text and must leave at
  least 14 slide pixels before the following text. The browser-measured v8 layout gate blocks
  both direct intersections and unsafe scaled clearance before compose/export.
- Product-only recovery: `chat-close` has no frozen cloud-oracle counterpart; it is an explicit
  local-workspace escape control, and the bottom AI button also toggles the panel closed.

## OKF Decision Bindings

| Reference | Decision | Artifact target | Verification |
|---|---|---|---|
| request-integrity.md | Keep parity and authentic-generation requirements separate and visible | Request Anchor, status docs, final acceptance | Drift check against Q1-Q18 and ADR-0002..0007 |
| accessibility-usability.md | Native controls, visible focus, names, recovery, reduced motion | Hub/editor buttons, provider form, tooltips, dialogs | Browser interaction and accessibility assertions |
| responsive-interaction.md | Preserve fixed editor task controls while scaling content; every action has feedback | Create Hub, menus, editor chrome, canvas | Desktop/narrow screenshots and no horizontal page overflow |
| design-to-code-governance.md | Shared tokens/tooltips and regression scripts, no untracked one-off patterns | CSS roots, tooltip module, QA scripts | Contract diff plus local UI gates |
| typography-system.md | Compact mixed-script UI with explicit overflow, tabular numbers, and at least 14 slide pixels between a rule and following text | Labels, provider/model text, versions, counts, zoom, generated slide sections | Same-state screenshots, long-text checks, and rendered rule-to-text gate |
| state-language.md | Every async/disabled/failure state explains current state and recovery | Generate flow, provider panel, disabled Docs/4:3 | Local fail-closed/attachment/provider QA |
| semantic-binding.md | Critical meaning is visible; helper/error text and tooltips bind semantically | Forms, disabled wrappers, icon buttons, shared tooltip | DOM checks for names, aria-describedby, keyboard focus |
| necessary-design-judgment.md | Remove arbitrary decoration and require hierarchy, craft, honesty, and scene fit to be stated before page planning | Pi-authored runtime design contract | Contract validation plus rendered critique |
| taste-engine.md | Bind taste dials, anti-default locks, layout-family budget, visual memory, and full-deck critique to each strict run | Design contract, slide plan, overview review | Ledger blockers and grounded nine-axis review |
| type-personality.md | Separate title/body/data roles and record mixed Chinese/Latin posture instead of accepting generic typography | Runtime design contract and PPTD pages | Contract checks plus overview/page review |
| presentation-deck.md | Require claim/evidence/action, narrative roles, evidence grammar, and delivery-scene density | Slide plan, todo, PPTD, native PPTX | Structural, overview, and editable-export checks |

## Information Architecture

1. Create Hub: brief, references, output constraints, style intent, provider readiness, send.
2. Agent screen: live plan/tools/page progress, pause/failure/retry, authentic result.
3. Editor: pages, canvas, contextual editing, comments, versions, play, export.

Primary CTA is Send on Create and Edit on a successful result. Export is primary only inside
the editor. Local-only or excluded cloud features must explain their boundary instead of
pretending to complete it.

## Taste Signature

- **Design read:** strict quiet-workbench recreation.
- **Taste dials:** high functional density, low decoration, restrained elevation, quiet motion.
- **Category defaults avoided:** generic AI template gallery, glowing gradients, glass cards,
  oversized onboarding copy, decorative blobs.
- **Layout-family budget:** one centered Create column, one linear Agent timeline, one editor
  workbench; repeated cards appear only for actual repeated references/projects.
- **Visual memory feature:** centered prompt-to-work transition and the compact floating
  edit/insert pill beneath the slide.
- **Type personality:** utility-first; wordmark is the only expressive moment.
- **Asset policy:** use captured/source assets and existing icon family; do not approximate
  visible assets with CSS/SVG inventions.

### Generated deck taste execution

- Every fresh strict run reads the complete selected OpenKimi `design.md` and receives its
  matching exact preview image. A local color, type, ratio, or layout hint is an override,
  not evidence that the user supplied a complete design system.
- Pi commits a task-specific, non-renderable design contract before `write_todo`: audience,
  scene, design read, necessary judgment, taste dials, type roles, palette-area rules, grid,
  density, chart grammar, visual memory, anti-default locks, layout families, slide plan,
  reference use, and verbatim user overrides.
- For decks with six or more pages, the plan uses at least four layout families and does not
  repeat one family on more than two adjacent pages. Cards are not a default layout family.
- After every current page passes full-size visual and deterministic checks, Pi receives one
  full-deck overview and records a grounded review of hierarchy, composition, typography,
  color, evidence legibility, variety, rhythm, reference fidelity, and remaining AI defaults.
- The host can reject missing/stale/vacuous evidence. It cannot choose a style, alter PPTD
  geometry, improve a score, or paint a page.

## Page And State Specs

### Create Hub

- Goal: begin an authentic Agent run with the exact selected supplier.
- Required states: empty, attachments parsing/failed/recorded, provider logged out/ready/error,
  disabled Docs/4:3 with visible explanation, send loading/failure.
- Responsive: prompt remains primary; style references may reflow but never become templates.

### Agent Screen

- Goal: make real work inspectable and preserve recovery.
- Required states: starting, planning, tool running, page progress, paused, retrying, failed,
  authentic success. Simulated timers and old-result injection are forbidden.
- Accessibility: important status changes use readable text and an appropriate live region.

### Editor

- Goal: direct editing and editable export without losing the PPTD document.
- Required states: rail open/closed/preview, edit/comment, selection/context, menus/dialogs,
  version preview/restore, notes, play, full screen, zoom, export progress/success/error.
- Fidelity: captured official controls/tooltips are exact; product-only controls remain quiet
  and must have an oracle/rationale row.

## Quality Gates

- Request Anchor: no iframe, fake generation, host fallback, dual IR, or template substitution.
- Visual: same-state comparison against frozen baseline; fix all P0/P1 and easy P2; reject
  line-text intersections and rule-to-following-text clearance below 14 slide pixels.
- Accessibility: keyboard reachability, visible focus, names, contrast, reduced motion, status.
- Responsive: Create path at 320/375/768/1024/1440; editor controls remain reachable.
- Interaction: core menus, hover/tooltips, disabled states, gestures, versions, play, export.
- Production: pinned browser runtime; zero Kimi production resources; secret redaction.
- Export: supported PPTX objects editable; degradations disclosed.
- Generated-deck taste: exact selected design text and preview; current-context contract receipt;
  contract-bound slide plan; current full-deck overview; grounded nine-axis pass; no unresolved
  AI-default list; any page or contract revision invalidates downstream evidence.
- Contract: local validator passes and artifact/code decisions match this file.

## Implementation And Governance

- CSS architecture: native Hub/editor styles with shared tooltips.css; root variables are
  the code token layer.
- Component naming: user-facing purpose, not oracle internals.
- State naming: is-* for visual states; status payloads use explicit running/paused/failed/ready.
- Theme: light only for this parity release.
- Dark mode: not in the frozen target.
- Visual regression: frozen manifest plus same-state comparison evidence.
- Rendered UI audit: project browser QA is authoritative; Ultimate Design semantic-zone audit
  may supplement it after sparse data-ud-check markers are added.
- CI: local gates are required; external-provider QA remains consent-gated.

## Assumptions

- The frozen 2026-08-20 capture remains the v1 parity target even if kimi.com changes later.
- Official cloud-only controls are replaced only when the local product has an honest equivalent.
- Existing MiSans files and current icon sources are licensed/retained as inherited project assets;
  a separate release-license audit is still needed before public distribution.

## Open Questions

- Real selected-provider quality remains model-variable, but the consented MiniMax-M3 path is
  now verified with a public 4-page teaching brief, four passing native rasters, and a valid
  editable PPTX export.
- The captured comment-mode editor state now matches the frozen geometry and background paint;
  exact pixel parity remains open for uncaptured menu/dialog combinations and icon glyph geometry.
- Vision capability is currently reported as unavailable in local health; structural render QA
  must not be described as the model visually reviewing the page.

## Review Log

| Version | Date | Change | Reason | Reviewer |
|---|---|---|---|---|
| 0.1 | 2026-08-04 | Bootstrap legacy contract | Initial monorepo kickoff | prior agents |
| 0.2 | 2026-08-20 | Freeze current product decisions, Pi-only runtime, parity evidence, tooltip/state rules, and verification boundary | User Q1-Q18 and takeover audit | Codex |
| 0.3 | 2026-08-20 | Calibrate editor chrome, rail, canvas, PPTD gradient/text paint, comment state, and tooltip interactions to the frozen same-state evidence | Combined reference/implementation Design QA | Codex |
| 0.4 | 2026-08-21 | Add exact selected visual reference, Pi-authored runtime design contract, layout-family planning, full-deck overview, and grounded taste-review gates | User rejected the technically valid but generic first real deck | Codex |
| 0.5 | 2026-08-23 | Repair editor insert/context toolbars: opaque chart surface, collision-free series legend, visible active toggles, closable AI panel, ordered formula insertion, and pinned-browser interaction matrices | User demonstrated untested toolbar states and incomplete interactions | Codex |
| 0.6 | 2026-08-31 | Add rendered line-text intersection and 14-pixel clearance gates; repair all nine unsafe rule/text pairs in the active 12-page board deck | User showed rules visually crossing labels after scaled rendering | Codex |
| 0.7 | 2026-08-31 | Expand acceptance to eight common office genres and the full governed editor control surface; add scene-specific routing, chart/data editing QA, readable palette gates, explicit page-count precedence, current-product visual checks, and native PPTX/PNG delivery evidence | User required management reports, teaching/sharing, performance review, work reports, and every editor tool to be genuinely accepted | Codex |
| 0.8 | 2026-08-31 | Make `write_page` an enforced whole-page replacement contract, reject element fields spilled to page level, and lock a revision after deterministic layout passes unless an exact page/deck review says `revise` | A real MiniMax regression showed that repeated partial writes could replace a valid page after it had already passed layout QA | Codex |

## Office PPT Acceptance Override — 2026-08-31

This section is the latest request override for generated content and editor acceptance.

- Required primary genres: management / operating report, teaching courseware, internal
  knowledge sharing, personal performance review, and team / project work report.
- Additional governed genres: project proposal, office training / operating guide, and
  academic defense. Each genre has an intentional brief kind, intent, director structure,
  and compatible catalog-pack family; negated document types must never reroute the brief.
- An explicit user page count wins over genre defaults in director guidance and compose
  minimums. Defaults apply only when the brief omits a count. Accepted Chinese forms include
  `4 页`, `约 7 页`, `16 页左右`, and `页数 12`.
- Generated slides must pass deterministic full-slide checks for text contrast, clipping,
  text collisions, line/text intersection, and line/text clearance. The editor must not hide
  a failed state by clipping or recoloring text.
- `write_page` is a complete whole-page replacement, never element append. Each call must carry
  the full `elements[]` array with style and geometry inside the owning element. A current page
  revision is immutable after its native layout status passes; it can be rewritten only when
  current structural review names that page as failing, or an image-backed page review / matching
  current deck review explicitly returns `revise`.
- Every enabled editor control is governed by the editor oracle. Acceptance covers page and
  history operations; text, shape, line, icon, image, table, chart, SmartArt, theme, selection,
  arrange, comments, notes, AI refine, version, presentation, reload, and native export flows.
- Chart acceptance includes creation, direct cell editing, tabular paste, invalid-value
  recovery, row/column growth, type changes, series color, axes, chart title, data labels,
  legend, persistence, and editable PPTX export.
- Visual screenshots are review evidence, not a pass by themselves. A pass also requires
  persisted PPTD state, clean browser/runtime diagnostics, and a readable native export.
- Disabled or intentionally unsupported rows remain explicit: Google Slides export,
  animation authoring, 4:3 layout, multi-user realtime, and OS-level fullscreen automation.
  They must not masquerade as enabled controls.

## Editor Human Workflow Refactor — 2026-09-05

### Request Anchor and Decision Snapshot

- Latest user override: audit every small editor control and Agent interaction on the latest GitHub version, collect duplicate/broken flows, and refactor them together.
- Audience/job: a person authoring an office presentation who changes focus, switches pages, undoes actions, collaborates with an Agent, and exports without losing work.
- Deliverable: the existing native editor with consistent actions, regression tests, a control coverage ledger, and current rendered evidence.
- Preserve: YAML PPTD v2 as disk truth, native editable PPTX, real Pi provider behavior, version recovery, existing visual tokens and compact canvas layout.
- Direction: clarity-first; keep the quiet light workbench and existing utility typography. No new visual theme or decorative layout. Fix action semantics and recovery before cosmetic changes.
- Primary action hierarchy: bottom toolbar owns insertion; contextual toolbar owns selected-object editing; AI button owns Agent workspace; composer owns attachments; export format selects, Download executes.
- Duplicate policy: remove redundant same-purpose entries within adjacent chrome; keep contextual shortcuts only when they carry an explicit target and share the same implementation.
- Data rule: visible pending text, table, and notes edits must settle before navigation, versioning, export, or Agent mutation. Undo/redo must always leave a valid page and selection.
- Export copy: PPTX means the whole editable deck; PNG means the current page. Font options apply only to PPTX. Format changes must never initiate download.
- Agent rule: display target and progress; preserve failed input; distinguish unavailable provider, failure, stopped and complete. Test doubles prove UI contracts only, never authentic model generation.
- Acceptance: all discovered controls accounted for as exercised, removed duplicate, intentionally disabled, or explicitly blocked; test action results and persistence, not just clicks/file chooser opening.
- Boundaries: local checkout and scratch projects only; no remote publication or changes to other running checkouts.

### OKF Decision Bindings

| Reference | Decision | Artifact target | Verification |
|---|---|---|---|
| governance/request-integrity | Retain all-controls and Agent scope through repair | audit ledger and this override | compare uncovered controls before final acceptance |
| digital/accessibility-usability | Name icon controls and distinguish selection from execution; expose failures | editor toolbar/composer/export | keyboard and rendered control checks |
| digital/responsive-interaction | Keep controls reachable when workspace and contextual panels share space | editor chrome at desktop/narrow sizes | viewport screenshots and overflow checks |

Support references: Pro mode, web-product branch, content-model, design-contract, visual-verification, quality-gates. Existing DESIGN.md tokens remain authoritative. Root owns design integration; Luna workers own bounded implementation/tests with a single writer per production file.

### Integrated Review Record

The 2026-09-05 integrated run exercised all 102 editor semantic action IDs in 15 office steps, with no browser errors. The separate human boundary suite passed 10 cases, Agent suite passed 9 explicitly classified real-local/test-double cases, and shell/version/export suite passed 10 cases (including close/save/reopen notes). Native package tests passed 767 cases and native-web passed 23. The root independently inspected export and narrow-screen renders and used native CUA for text/table persistence, Agent failure recovery, real text attachment upload/refresh/removal, export format semantics, and historical-page navigation with isolated read-only notes. See `docs/qa/editor-human-audit-2026-09-05.md` for the final scope and evidence. Credentialed Agent output, OS clipboard interoperability, real IME composition, and native Office reopening remain outside the proven result.

## Editor Canvas Workflow — 2026-09-06

### Request Anchor and Decision Snapshot

The user requests every main and secondary editor action be tested and the canvas redesigned
for real editing. Confirmed requirement: comments bind concrete elements and instruct the Agent
to modify those elements. This supersedes the prior floating-context-toolbar placement and
local-only deployment boundary; acceptance includes the independent running SlideStudio.

- Keep existing neutral tokens, editable PPTD, undo/history and all supported editing functions.
- Insertion has stable named controls: 文本、形状、图片、表格、图表. Selection never changes their meaning.
- Selection properties belong in a labelled, collapsible inspector, grouped by content, appearance
  and arrangement. Opacity is labelled 不透明度 and must not reuse the table icon.
- Shared object properties (including alignment and opacity) apply to charts as well; the
  previous chart-only omission has no underlying capability constraint and is removed.
- 批注 has one primary entry. Show selected page and element targets before submission; page-level
  feedback is an explicit choice. Do not require a second click on the canvas to guess scope.
- Entering annotation mode transfers the current selection to comment targets, then clears editing
  selection and handles. Picking targets or opening saved comments must not reselect editable objects.
- Persist immutable page ID, element IDs, revision and SHA with each comment. Agent execution reads
  persisted scope; stale/deleted targets fail with a recovery action. Completion requires verified
  target changes, with no changes outside the authorized scope.
- The AI conversation can collapse after generation. User edits prioritize canvas area; opening
  Agent work retains history and target context. Progress is readable and errors preserve input.
- Popovers remain inside the viewport; Escape closes the active overlay and focus returns to its
  trigger. Narrow layouts use drawers without losing access to canvas or primary actions.
- Do not remove supported functions to simplify the UI. Remove duplicate entry points and retain
  their single underlying command. Every enabled control has an oracle row.

### Content and States

Order: what is selected → what can change → action feedback. Use visible Chinese labels for
major commands and settings; tooltips provide supplemental detail. Distinguish element feedback
from page feedback. Pending, working, failed, stopped and verified-applied are separate states.
Unavailable actions explain their prerequisite. Undo or confirmation protects destructive actions.

### OKF Preflight and Decision Bindings

Execution: root integrates design and performs native browser acceptance; user-authorized Luna
workers implement bounded frontend, backend and control-inventory changes. Support references:
Pro mode, web-product branch, content-model, design-contract, visual-verification and quality-gates.

| Active reference | Decision | Artifact target | Verification |
|---|---|---|---|
| digital/accessibility-usability | Major actions have visible names, one comment entry, recoverable stale-target errors | insert toolbar, inspector, comment form | native keyboard/selection flow and API negative cases |
| digital/responsive-interaction | Fit panels to available width and preserve canvas access | page rail, inspector, Agent pane, menus | desktop/narrow screenshots, actual menu bounds, Escape/focus checks |

### Acceptance and Evidence

Baseline screenshots: `output/editor-canvas-audit/01-before-empty-selection.png` through
`04-before-comment-target.png`. Confirmed baseline: opacity uses a table-like grid icon;
selection toolbar and opacity popover overflow at 1100px; contextual and bottom comment entries
duplicate one mode toggle; selected-element comment click shows mode onboarding rather than a
bound feedback form. These are findings, not evidence of successful repair.

Acceptance ledger must cover no selection, text, shape, line, image, table, chart and multi-select;
all nested commands; actual state changes, undo, reload/persistence; comment scope and a real Agent
edit; errors and viewport states. A selector count or passing worker report alone does not pass.
Preserve the user's completed eight-page deck by using scratch projects for intrusive testing.

## Agent-first Correction Workflow — 2026-09-06

### Request Anchor and Decision Snapshot

The user's latest clarification makes the Agent the primary author. Human editing is the final,
lightweight correction layer. Completion is measured by reliable correction journeys, not feature
count or full PowerPoint parity. Preserve supported editing tools without expanding into unrelated
animation or complex authoring features.

- Primary journey: inspect output → locate/select problem → choose direct adjustment or bound Agent
  instruction → inspect changed result → recover if needed → export the editable document.
- Human correction tasks: change wording or a number, adjust font/color/position, replace/crop an
  image, fix a table/chart value, copy/reorder a page, and undo an unwanted edit.
- Agent correction tasks: selected object(s), current page, or the whole deck. The visible scope and
  server-authorized scope must agree; failed or stale requests retain the user's instruction.
- Current task and current outcome lead the Agent workspace. Historical trace and raw technical
  payloads remain available as secondary detail, without overwhelming the current correction.
- The canvas keeps priority when the Agent workspace is open. On constrained widths, temporarily
  collapse optional object properties; retain a visible expansion control and respect an explicit
  user expansion for that workspace session. Selecting after opening Agent must follow the same rule.
- Keyboard and context-menu clipboard operations share one ownership contract. External plain text
  inserts as text; expired object markers prompt a fresh copy instead of becoming slide content.
- Selecting, typing, clipboard, navigation, undo, versions and Agent execution must compose safely.
  Editing text must not accidentally delete its object or run canvas keyboard shortcuts.
- Keep the quiet light canvas, utility typography, fixed insertion controls and object inspector.
  No new decorative theme. Primary visual memory is the selected object connected to its comment.

### Active OKF Decision Bindings

| Reference | Decision | Artifact target | Verification |
|---|---|---|---|
| digital/accessibility-usability | Keep selection, instruction target, errors and recovery explicit | canvas selection, comment composer, version/undo | keyboard, real Agent scope, negative/recovery scenarios |
| digital/responsive-interaction | Keep correction tools reachable across pane and overlay states | inspector, Agent workspace, secondary menus | width/state matrix, focus/Escape and native screenshot checks |

Support references: Pro mode, web-product branch, content-model, design-contract,
visual-verification, quality-gates. Existing approved visual tokens remain unchanged.

### Acceptance Contract

Every previously disclosed gap is assigned an explicit outcome: exercised successfully, repaired
and re-exercised, intentionally unavailable with truthful UI, or blocked with a concrete tool or
platform reason. Headless composition events are not evidence of native macOS IME; file input
cancellation is not evidence of the native picker. Real model multi-object/page/deck acceptance is
separate from deterministic guard tests. Do not mark the overall result complete while any known
P0/P1 correction-flow defect remains.

## Coherent Inspector Rework — 2026-09-06

Request Anchor: repeated user findings show that functional control coverage did not establish a usable editor. Deliver the implementation in `docs/plans/editor-coherent-correction-2026-09-06.md`, not only explanations of existing buttons.

Decision: clarity-first, compact utility inspector with explicit sections and stable common actions. Keep light neutral surfaces, existing font tokens, and selection-blue emphasis. The intended visual memory is an obvious connection between the selected object, its editable properties, and the Agent target. No decorative cards within cards, no generic More dumping ground, no duplicated layer commands within the same inspector.

Content hierarchy: type-specific properties first; text-box behavior separate from text formatting; object position/arrangement separate from text alignment; appearance separate from actions. Common text formatting is directly visible and compact. Position fields use a two-column grid. Low-frequency sections may collapse; preserve section/focus state through ordinary edits. The fixed action row is compact and does not cover scrolling content. Type-specific image/table/chart/line/icon controls remain available under meaningful sections.

Terminology: 文本对齐 refers to text inside the box; 对象对齐 states page or selection reference; 框内自动换行 is a real on/off control and makes no promise about automatic height or font size. Whole-box links remain explicitly described. No replacement for unknown features with a similarly shaped but unrelated icon.

Active OKF bindings remain digital/accessibility-usability and digital/responsive-interaction: named groups, programmatic toggle states, keyboard/focus/validation, truthful disabled/busy states, and 1100/1375/1440/1920 width-state acceptance. Root reviews rendered results; Luna implementation and independent QA evidence are candidates until integrated live acceptance.

## Left Agent Chat — Composer State Machine and Stream Entry — 2026-09-15

Request Anchor: the editor sidebar is an agent chat. The user must never see two
action buttons at once, and assistant thinking/answer text must arrive as a
stream, not as dropped-in blocks. Reference behavior: DSH chat composer and
dsh-better-display Reader.

Decision (composer): exactly one morphing control, `.composer-send`. Idle it is
a send arrow. While a generation is locked and the textarea is empty the same
button renders the stop square (`.is-stopping`, hover red); typing steer text
flips it back to the send arrow and submit routes to `steer: true`. There is no
separate stop button in the DOM. Stop-pending disables the control.

Decision (corrected 2026-09-16): reasoning and answer text comes from DSH's
native agent/assistant-stream frames, subscribed globally and filtered by the
bound product session. Never infer provider streaming support from the final
session journal; it intentionally stores settlement separately from live frames.
Never animate a completed block to claim token streaming. Native deltas are
coalesced for at most 40ms into idempotent public-text snapshots. The latest
reasoning card stays open during a live task; manual disclosure and selection
win. Reading follow motion is scroll assistance only, not manufactured output.
Use the existing neutral 14px/24px reader typography and a consistent pale card
for short and long thoughts; no decorative breathing overlay obscures text.
History hydration and reconnect do not replay text. Reduced motion preserves
all received content without movement.

Active binding: digital/responsive-interaction | Real stream growth without
layout replacement or forced scrolling while reading | sidebar reasoning and
answer nodes | actual GLM-low session, stable node identity, select/wheel handoff,
reconnect prefix, terminal reconciliation and reduced-motion checks.
Taste/necessity: quiet reading UI, one thought-card family, stable step labels;
no new palette or editor redesign. The visual distinction must communicate
reasoning versus answer, not disguise delayed delivery with animation.

Tokens/visual: composer control stays 31px circle on #17181a; stop hover
#dc2626; no additional accent colors. Readability rules (14px chat body, 24px
reason line-height) are unchanged.

Verification: DOM asserts one submit control; generating+empty has is-stopping,
typing removes it; a freshly mounted thought grows between samples; submit with
text posts steer and clears the box; submit empty stops. Reduced motion skips
reveal. Regression: generation-process-dom tests.


## Continuous AI collaboration — 2026-09-20

Request anchor: the user wants one assistant to discuss, generate, preview and refine a PPT, with usable manual detail editing. The existing light neutral chrome, MiSans and editable YAML/PPTX remain the baseline. No new visual theme. Single-agent implementation.

Decision snapshot: the same project and DSH session survive generation and subsequent turns. “先讨论” is read-only at the tool boundary; “修改文稿” uses existing verified scopes and rollback. User messages and assistant replies form chronological, persistent history. Recent projects are visible across browser sessions. At desktop widths conversation and canvas sit side by side; narrow windows offer an explicit canvas return. Unselected inspector space is reclaimed.

| Active OKF | Decision | Target | Verification |
|---|---|---|---|
| digital/accessibility-usability | Visible mode, target and recoverable errors; keyboard-addressable project links | composer and history | two discussion turns, scoped edit, reload, rollback |
| digital/responsive-interaction | One conversation scroll area and usable canvas space | editor panels | native screenshots at 877 and 1440, selection and text editing |
| governance/request-integrity | Prove the user's whole create-discuss-edit-export journey | product route and acceptance report | real provider, unchanged-page hashes and editable PPTX |

Support: Pro mode, web-product, content-model, design-contract, visual-verification, quality-gates. Taste checkpoint: quiet working canvas, existing utility typography and neutral palette; no decorative cards or artificial streaming. Acceptance is live interaction plus persisted document evidence, never source/build alone.


## 批注统一从对话发送 · 2026-09-20

用户明确要求消除左右两处 AI 提交入口，按“批注附到对话，再统一发送”的交互执行。沿用现有字体、颜色和面板，不增加装饰或第二个主要操作。

- 右侧仅添加、编辑、附选、解决批注；新增批注自动附到左侧对话，添加动作不请求 AI。
- 左侧发送是唯一 AI 执行入口，一次点击提交所有附带批注及补充说明，沿用所选模型、范围保护与版本恢复。失败保留附件，从同一个发送按钮重试。
- 右侧没有逐条 AI 提交、重试、停止或二次确认卡片。编辑草稿保留，发送前保存所选批注的最新文字。
- accessibility-usability：唯一主操作与清晰状态绑定到批注面板/对话输入框；DOM 断言无右侧执行按钮，单次发送仅有一个 turn。
- responsive-interaction：附选后确保对话入口可见；添加时不抢输入焦点，窄屏保持可收起的对话面板；原生浏览器与固定 Chromium 验证。

## 光标旁批注浮卡 · 2026-09-20

Decision Snapshot：用户要求批注直接在点击位置附近完成，取消右侧常驻面板。单人实现，保留现有中性色与工具字体；唯一浮层承载当前任务，不把完整侧栏缩成一张大卡。默认只显示当前对象的批注输入；点编号查看一条批注；“全部批注”按需切入跨页列表。添加仍只附到左侧对话，AI 发送入口不变。

### Active OKF Concepts

| Reference | Decision | Artifact target | Verification |
| --- | --- | --- | --- |
| accessibility-usability | 非模态 dialog、有标题和输入标签、Esc/关闭恢复焦点、关闭不丢草稿 | comment-panel 浮卡、批注编号 | DOM 键盘、草稿与文稿不变测试 |
| responsive-interaction | 光标旁定位，空间不足换边并夹在可视范围内；随画布缩放滚动更新；不占画布布局宽度 | 固定浮层与定位函数 | 1440/877/375 宽渲染及边界、画布尺寸断言 |

### Support References

Pro mode、web-product、content-model、design-contract、visual-verification、quality-gates。内容层级为目标→意见→添加到对话；列表、选择范围是次要操作。静态出现，不增加动画。验收包含添加/查看/编辑/收起/跨页附选及唯一发送回归。

浮卡验收：输入、单条记录与列表分开展示；删除重复目标提示和编号 hover tooltip。DOM 与三种宽度的渲染检查通过，浮卡不占画布布局宽度。原生浏览器验证光标附近输入、外部点击收起、原有批注打开。无未解决的阻断项；375 宽下允许临时覆盖部分画布，用收起恢复操作。详见 `docs/acceptance/2026-09-20-comment-popover.md`。

## 批注即对话上下文 · 2026-09-20

最新用户覆盖：对齐 Codex 批注操作，删除勾选、全部批注、保存/解决的管理流程。依据官方 Browser 文档的 Annotation mode → click/drag → write/save → chat send；没有把本机 Codex 界面读取受限时的推测声称为像素对齐。

Decision Snapshot：批注只有待发送意见一种用户语义。点击对象或拖框即确定范围，浮卡只含目标、输入与添加（已有意见为更新/移除）；添加后收起，可以继续标记。每条意见自动出现在左侧输入框上方，点击可回到目标、叉号可移除，最终一次发送。取消列表/勾选/全选/解决入口，保留后台范围锁与恢复记录。恢复项目时恢复未发送意见，失败保持可重试。

Active OKF：accessibility-usability → 输入标签、快捷键、焦点、移除可撤销，验收真实点击与键盘；responsive-interaction → 就地浮卡不挤压画布，附件列表限高、窄屏换边，验收 1440/877/375 与跨页回归。单人实现，沿用中性工具界面；无新增动效。Support 为此前已读 Pro/web-product/content-model/design-contract/visual-verification/quality-gates。

最终验收：9 项范围/交互测试、跨页发送 15 步、无会话边界 8 项通过；1440/877/375 边缘截图与实际 55201 页面已复核。记录见 `docs/acceptance/2026-09-20-comment-context.md`。此前“全部批注/附选/解决”条款由本节覆盖。

## 批注框选与真实执行 · 2026-09-20

Request Anchor：用户要求用真实模型完成批量批注闭环，并专业判断框选是否保留。保留“一个范围、一条共同意见”：单击指向一个对象，直接拖动圈住多个对象，Shift 点击增减，Esc 取消当前拖动或退出批注。批注模式持续显示精简操作提示，拖动时实时显示命中数量，松手在光标旁输入；每个命中对象有独立轮廓。空框不创建批注；背景层不纳入对象范围。桌面沿用现有中性字体和色彩，无额外工具开关或常驻面板。

Active OKF：accessibility-usability → 模式可见、范围数量与键盘退出 → 画布提示和浮卡 → 原生拖框与 DOM 状态/落盘验证。responsive-interaction → 提示不占画布宽度，窄屏自动换行 → stage 浮层 → 375/877/1440 截图检查。Support 为既有 Pro、web-product、content-model、design-contract、visual-verification、quality-gates。

协议：editorEdit.pages 为去重后的页面授权；reviewScope.items 为逐条意见，同页可有多条且顺序不限。每条均核对自身页面修订和 hash，保留自身目标，不把同页对象并集复制到每条意见。验收必须经过真实 Host 解析、真实模型写入、UI 完成态、PPTD 差异与非目标内容不变。

## 发送即离开草稿 · 2026-09-20

Request Anchor：用户指出已发送的批注仍留在输入框，要求明确、自然的状态反馈。Decision Snapshot：服务端接收请求就是草稿与消息的分界；AI 完成不是清空输入的时机。沿用现有对话气泡和工具字体，不增加面板、发送入口或装饰动画。失败恢复留在原消息，输入框始终属于下一条草稿。本节覆盖此前“失败保留附件并再次从输入框发送”的条款。

- 接收前失败：原草稿保留；接收成功：提交的文字与批注立即从输入框清除，并进入对话。
- 处理中：原消息下显示“已发送 · 正在修改”；完成后显示“已完成”。以范围校验结果为准，不以模型口头答复作为成功依据。
- 接收后失败或停止：原消息下说明结果并提供“重试”；不自动填回输入框。重试使用原意见，保留用户的新草稿。
- 用户在发送等待和模型执行期间输入的新文字，不能被旧请求清除。刷新后从持久的发送回执恢复消息与结果；旧批注缓存不能重新附入草稿。

Active OKF：accessibility-usability → 状态跟随原消息、失败有恢复操作、避免覆盖输入 → 消息回执和重试按钮 → 接收前失败/接收后失败/重复点击/刷新测试。responsive-interaction → 状态和长错误在气泡内换行、焦点不跳走、无新增动效 → 同一对话列 → 桌面和窄屏验证。

参考 Apple HIG [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)：反馈应清楚、一致，并贴近相关操作。具体发送和恢复状态为本产品的设计决定。

本节验收：20 步发送/失败/重试状态回归通过，375/877 宽下恢复入口不溢出；独立真实 DeepSeek 回合完成“批注发送→输入清空→保留新草稿→真实标题改色→刷新→可编辑 PPTX 导出”。截图和机器证据见 [发送状态验收](docs/acceptance/2026-09-20-comment-send-state.md)。无本次发送状态问题的未解决阻断项。


## 框选范围确认与工作区适配 · 2026-09-20

Decision Snapshot：保留框选，以“划过可见对象即选中”符合用户眼前的范围。拖动时显示框与命中轮廓，松手后撤下大框、只留逐个对象轮廓和编号；浮卡显示可移除的对象名单，点击 × 或 Shift 点击画布增减。添加批注即确认当前名单，不增加第二个确认弹窗。移除最后一项后禁用添加，不能自动变成整页批注；空文本、隐藏与全页背景不进入对象名单。保留输入中的意见。

工作区沿用中性色与字体；版本标签随内容宽度且不换行。对话输入优先，模式选择并入底部工具行，空闲时撤掉重复提示；真实编辑范围和错误仍清楚显示。标题栏、工具栏、缩略图根据编辑区实际宽度调整，所有插入工具可达。窄窗口继续可看画布和聊天，手机在二者之间切换。

Active OKF：accessibility-usability → 编号、可读名称、逐项取消、焦点连续 → 画布轮廓与目标名单 → 实际指针/键盘/持久范围测试。responsive-interaction → 编辑区宽度决定工具栏布局、缩略图真实尺寸一致 → header/composer/rail/popover → 1920/1440/1024/877/720/375 像素与短窗口截图、无遮挡测量。验收以原生复现和独立测试项目落盘为准，用户原稿 hash 必须不变。

本节验收：原生 4→3 框选确认通过；9 项范围/上下文测试、5 项连续对话 DOM 测试、20 步批注发送回归、7 种尺寸及同页动态缩放全部通过。浮卡在有空间时避让选中内容，用户原稿三份文件 hash 不变。本节覆盖旧的中心点/半面积框选规则。证据与边界见 [框选确认与适配验收](docs/acceptance/2026-09-20-annotation-selection.md)。


## 细形状绘制坐标 · 2026-09-20

用户截图指出细装饰的绘制位置与选中轮廓错开。测得 64×6 形状的 SVG 在约 46% 缩放时比元素边界向下偏 4.845px，原因为行内 SVG 的文字基线。Decision Snapshot：图形绘制必须贴合 PPTD 元素边界，不用挪动批注框或修改文稿坐标补偿；共享画布、缩略图、播放页和渲染页遵循同一几何规则。用薄矩形、普通形状、旋转形状、多尺寸/缩放的实际 SVG/path 边界和批注轮廓比对验收。

同次视觉复核发现播放容器按未缩放宽高居中、画布却沿左上角缩放，导致页面偏移裁切；播放视图使用中心缩放，补充整页在屏幕内且中心一致的断言。

本节验收通过：9 组实际绘制几何检查最大偏差 0；批注操作回归通过，实际文稿 hash 不变。证据见 [细装饰绘制偏移修复](docs/acceptance/2026-09-20-shape-alignment.md)。


## 2026-09-20 · 对话无需模式选择

Decision Snapshot：用户只输入需求。首页和编辑器都移除“讨论/修改/自动”选择器；所选模型结合最近对话与文稿状态判断此轮是讨论、生成还是修改。意图判断不直接授予写权限，讨论仍受 Host 只读工具约束，修改仍经过既有版本和范围保护。明确“先别改、只给建议”必须保持只读。判断失败保留草稿并显示可重试错误，不降级成无边界写入。

回复正文使用正常段落和有语义的列表。去掉普通回复前的过程圆点，粗体必须可见；外层事件列表的滚动样式不得影响正文列表，不出现整段横向滚动。过程仍可展开，最终回复持续可读。

输入和回复并行：按 Enter 发送、Shift+Enter 换行，中文候选确认不发送；聊天输入不触发画布快捷键。服务器接收后只清除本次提交的草稿，焦点回到输入框；用户已开始输入的新草稿不能被旧请求的接收或完成覆盖。生成完成通过对话状态表达，不在输入时弹出旧的完成 toast。

验收覆盖：真实模型对上下文短句和风格修改的判断、只读讨论、窄栏正文的粗体/列表/换行、连续打字及 IME、发送回执前后新草稿、刷新后历史和模型选择恢复。


本节验收完成：真实 DeepSeek 完成两页生成、续聊、指定页标题修改和修改后的可编辑 PPTX 导出；讨论哈希稳定，指定页修改仅一行标题，新草稿保留。1440/877/390 宽度通过。完整证据及测试边界见 [对话输入与回复验收](docs/acceptance/2026-09-20-assistant-chat.md)。


## 2026-09-20 · 单一对话与准确页面范围

Request Anchor：用户明确要求“1、2 两页都把背景色改成白色”，并要求删除回复下重复的执行/完成卡片。Decision Snapshot：模型结合原话和上下文输出一次结构化意图；客户端只验证真实页码、选区与文稿上下文，不用关键词再次覆盖页码。明确页码集合始终保留原集合，即使恰好覆盖全文。版本锁和未授权页面保护继续生效。

对话只有一条时间线。执行状态使用现有行内进度，最终结果由模型回复承载；完成后在该回复旁提供“查看修改前”文字操作，不再增加完成卡片、结果卡片或完成 toast。错误与重试跟随原请求，输入框始终属于新草稿。刷新后版本仍可从标题栏的历史版本恢复。沿用中性色与工具字体，不新增装饰或动画；单人实现。

| Active OKF | Decision | Artifact | Verification |
| --- | --- | --- | --- |
| necessary-design-judgment | 移除重复完成提示、双滚动区和重复项目标题 | 对话时间线、回复操作 | 原生截图中只有一列回复和一个输入框 |
| accessibility-usability | 状态与错误靠近原请求；停止、重试、版本恢复可达 | 对话进度、原消息操作 | 真实修改、失败回归、版本预览、输入草稿保留 |
| responsive-interaction | 回复与操作在同一滚动流自然换行 | 390/877/1440 宽工作区 | 无横向溢出、输入命中与截图检查 |

验收要求：同一句多页请求的模型决策、锁和执行授权均为第 1、2 页；逐页背景实际改变；无关内容和未授权页 hash 不变。明确排除页、无效页、选区必须继续受限。

本节验收通过：真实 DeepSeek 按原句修改两页，逐属性只变背景；46 项相关回归、三种宽度和原生浏览器检查通过。原稿遗漏的第 1 页已本地补齐且保留快照；证据见 [单一对话与准确页码验收](docs/acceptance/2026-09-20-unified-chat-and-page-scope.md)。

### 2026-09-20 · Agent questions stay in the conversation

Decision snapshot: sending a clear whole-deck instruction immediately places the message in the left conversation and clears only that draft. Intent routing and version protection share the conversation's waiting status; there is no whole-deck confirmation dialog. Recoverable snapshots and scope verification remain mandatory.

Missing information uses DSH's native ask_user_question and user-questions/request waterfall. Questions are chronological left-chat entries, with single choice, multi-select, and custom text. Answers return to the same waiting tool. Pending questions survive page reload; abandoned Host requests are labelled interrupted. Cancel and stop never imply approval. Human waiting time is excluded from the edit watchdog. Failed sends and answers stay on their original message and never overwrite newer drafts.

Acceptance: immediate send; no modal; native question -> answer -> continued real edit; failed-answer retry; stale/duplicate answers; cancel/stop; 1440/877/390 px; history after reload. Model acceptance uses a synthetic project.


### 2026-09-20 · 稳定的对话记录与阅读位置

Request Anchor：刷新丢失版本入口，完成时对话跳动，要求达到原生 DSH 的连续阅读体验。Decision Snapshot：用户原话、模型输出和版本关系均有持久来源；版本入口从快照中的请求标识重建，不能依赖浏览器临时 Map。既有快照只在保存的对话前缀与原生授权事实共同证明关系时恢复入口。每一轮拥有自己的过程展开状态，后续回合不能展开全部历史。用户上翻阅读时保存可见消息与像素偏移；只有跟随末尾时才跟随新增内容，浏览器布局导致的滚动不能算作用户输入。完成时保留正在阅读的过程。沿用当前单一对话列、字体和中性色，不新增结果区或完成动画。

Active OKF / Decision Bindings：responsive-interaction → 持续输出、完成与容器变宽均保留阅读锚点 → conversation-scroll → 多轮流式、上翻、完成和窄屏实测；accessibility-usability → 每轮键盘可展开、持久版本入口、刷新恢复 → conversation timeline 与 snapshot metadata → 刷新前后同一回复/版本、点击预览返回、文本选择不丢失。Support References：Pro mode、web-product、content-model、design-contract、visual-verification、quality-gates。验收以真实对话及固定 Chromium 复现为准。

本轮补充：校验及事务收尾前不发布版本结果入口；工作状态与回复下的版本动作共用底部空间，避免结束时正文移动。实测阅读、完成以及跟随末尾的正文位移均为 0px。该条覆盖旧的全局过程收起规则。


## Warm workbench refresh · 2026-09-23

Request Anchor: the user judged the whole UI "太老土太原始" and asked for a UI/UX pass across
Hub and editor with a sense of material quality, **functionality unchanged**. Pro-mode decisions
(user-confirmed): direction = refined neutral workbench; accent = warm, in the spirit of Claude's
clay palette (no Anthropic marks or names); light theme only, with every colour tokenised so a
dark theme is one more variable block later.

This section supersedes the visual tokens of the frozen 2026-08-20 reference and the
"no new visual theme" lines in earlier sections. Interaction behaviour, control placement,
geometry (widths, heights, paddings, breakpoints), copy and oracle rows are still governed by
those sections and were not changed.

### Decision Snapshot

- **Palette:** `apps/native-web/public/tokens.css` is the single token source for both pages.
  Primitive ramps are warm neutral `--n-*`, clay accent `--a-*` (brand `#D97757`; text-safe
  `#B5573A`, 4.8:1 on white), sage success `--s-*`, crimson danger `--d-*` (kept apart from
  clay) and amber warning `--w-*`. Semantic roles (`--text*`, `--line*`, `--bg-*`, `--accent*`,
  `--primary-*`, `--shadow-*`) are what new rules consume.
- **Legacy colours:** about 600 literals in `styles.css`, `hub.css` and `tooltips.css` were
  converted mechanically to the nearest ramp step at the same OKLab lightness, so every
  existing contrast relationship holds. Blue selection/info became clay, green became sage,
  red became crimson. Protected (document-owned) paint: `.slide` background, `.el-table`
  defaults, the white `.thumb-frame` page ground, `.present-layer`, snap-guide magenta,
  the adjust-handle yellow and the crop dim.
- **Surfaces:** chrome `#FDFCFA`, chat panel `#FAF9F5`, work field `#F1EFE8` with an 18px
  dot grid at 7.5% (the only texture). The slide is the one bright plane and gets a layered
  `--shadow-slide`. Floating surfaces share `--shadow-lg` plus a `--line-soft` hairline.
- **Type:** UI stays Inter/MiSans. The Hub wordmark is the one expressive moment, set in
  the vendored Unna serif (28 KB) at 56px. There is no new CJK web font.
- **Emphasis:** exactly one clay moment per surface. On the Hub that is the send button;
  in the editor it is chat send, the active page ring, and whichever mode or popover is
  currently open (AI 助手, 批注 mode, an open insert popover). Export is the editor's primary
  action (dark ink). Toolbar toggles use a neutral pressed state, never clay.
- **UX repairs made in the same pass (functionality otherwise unchanged):**
  tooltips no longer reopen over the menu their click just opened (focus from a pointer is
  not `:focus-visible`; an anchor with `aria-expanded="true"` never shows its tip); the shape
  gallery no longer clips its fourth/fifth columns and tabs; the Hub model picker is an inset
  section instead of overflowing the prompt card; the 批注 pill visibly shows annotation mode;
  inspector "selected" and "delete" no longer share the same pink fill; the undefined
  `--error` / `--border` variables are defined; project delete buttons are quiet until row
  hover/focus (always visible on touch); native selects use the product chevron.

### Active OKF Concepts

| Reference | Decision | Artifact target | Verification |
|---|---|---|---|
| digital/accessibility-usability | Lightness-preserving colour migration, AA text roles, visible focus, tooltips never obscure the popup they belong to | tokens.css, legacy conversion, tooltips.js | contrast calc for new roles; `verify-tooltips` 18/18; `verify-hover-chrome` hover/tooltip checks 19/19 |
| digital/responsive-interaction | Visual layer only, with no geometry changes, so tested layout contracts hold | refresh layers at the end of styles.css / hub.css | native-web suite 170/170; screenshots at 1440/1100/877/390/375 |
| governance/design-to-code-governance | One shared token file; converted literals point at ramp steps; new rules use semantic roles | tokens.css + both stylesheets | undefined-variable scan clean; `oracle:validate` OK |
| systems/taste-engine | Warm workbench; anti-defaults: no gradients-as-decoration, no glass cards, no second accent | Hub, editor chrome | before/after screenshot review (same state, same viewport) |

Support references: Pro mode, web-product branch, visual-verification, quality-gates.

### Evidence and boundaries

Browser suite `apps/native-web` 170/170 (one earlier full-suite run hit the known timing-sensitive
`assistant-edit-scope-dom` flake; it passes in isolation). `oracle:validate`,
`verify:no-kimi-runtime`, `verify:no-fake-path`, `scan-secrets`, `verify-tooltips`: pass.
`verify-hover-chrome` passes end to end. Its table step had exposed a pre-existing server bug:
on a project with no saved version, the first edit's V1 baseline was persisted through the
`default` tab session instead of the browser's own tab, so every first edit answered 409 and
never created V1. `ensureInitialVersion` now receives the command's `tabId`; regression test
`apps/native-web/src/first-edit-tab-session.test.mjs`. A 14-step live walkthrough on a scratch copy
(open, page switch, insert text, undo/redo, table, shape, zoom, annotation, version, editable PPTX
export, present, reload) passed with every edit checked on disk and no browser errors. Not visually re-verified in a live run: the in-progress
live-generation panel and the paused/steer composer. Their colours come from the same
mechanical conversion.

## Minimal Hub and instant launch · 2026-09-23

Request Anchor: the user found the Hub still busy ("不够极简"), wanted a colder, more premium
first screen with more whitespace, questioned showing model capabilities up front, and found
the wait between Send and the generation view unresponsive.

Decision Snapshot:
- **First screen = wordmark + one prompt.** Settings sits top-right in text weight; the tagline
  is small, letter-spaced and faint. The prompt card uses a hairline with a soft, low ambient
  shadow and 16 px input text.
- **Style reference** is a quiet pill in the action row (22×14 thumbnail + name; name hidden
  under 600 px), keyboard-operable (`role="button"`, Enter/Space, `aria-expanded`). Its panel
  opens below the card. The toggle now actually closes on a second click.
- **Capabilities** ("这次能用的能力") live inside the model panel, where the choice they
  describe is made. The element ids are unchanged, so QA recorders still read them.
- **Recent work** is a plain hairline list starting well below the fold, with no card,
  shadow or subtitle. Hovering a row colours its title in the accent colour.
- **Instant launch:** Send validates, stores the request (sessionStorage, `launch-flow.js`) and
  navigates at once to `index.html?launch=<id>`. The editor shows the message and truthful
  progress ("正在让模型理解你的需求…" → "正在建立可编辑文稿…"), runs the intent read and
  session creation, then rewrites the URL to the live route with `history.replaceState` and
  boots normally. There is no reload and no second session on reload. Generation polling is
  paused while a launch is unbound, so a previous session is never painted. Failure keeps the
  message, shows the cause (`role="alert"`), offers 重试 while no session exists, and
  "回首页修改" restores the draft on the Hub. Measured on the live stack (grok-4.6): click →
  editor with message 104 ms, previously about 4–6 s on the Hub. The session was bound in place
  at 4.4 s.

Active OKF: responsive-interaction → feedback at input start, with no blocking wait on a model
round-trip → launch view + `hub-launch-dom.test.mjs` (the intent call is held open and the editor
must already show the message). accessibility-usability → focusable style control, alert on
failure, draft never lost → DOM tests and the retry/back path. necessary-design-judgment →
remove capability chips, card chrome and the thumbnail tile from the first screen → 1440/390
screenshots.

## Readable agent column, no share, annotation exits · 2026-09-24

Request Anchor: the user found the left column still hard to read during a run (a flat stream
of 思考 cards and "Write · todo" rows) and asked to learn from dsh-better-display's automatic
folding. They also noted that an intranet product must not offer sharing, and that after
adding a comment the dashed hover outline remained, as if annotation mode never exited.

Decision Snapshot (overrides the "添加后收起，可以继续标记" rule of 2026-09-20 and the
always-expanded live process of earlier sections):
- **Live fold** (dsh-better-display rule, `conversationProcessRows`): in the running turn, once a
  newer reasoning step arrives, every earlier reasoning / narration / tool row of that turn folds
  behind one counted row (`思考×N · 输出×M · 工具×K`). Only the current step stays open. Before
  there is anything to fold, the turn stays open. A finished turn folds its whole process behind the
  same counted row and keeps the answer. A manual open/close choice always wins. A row holding
  the reader's text selection is not folded until the selection is released.
- **Tool rows** show the Chinese action (`displayTitle`, e.g. 安排页面制作任务 / 撰写页面) and a
  target only when it names something real (page, reference, query). Host-invented targets
  (todo, deck, capabilities, references, export) are omitted, and English verbs are no longer shown.
- **No sharing:** the share pill, the share dialog, its handlers and styles are removed. QA
  scripts now assert that no share entry exists.
- **Annotation exits after adding.** A saved comment closes the card, leaves annotation mode,
  and clears hover/draft outlines and the gesture hint. The comment waits above the chat input.
  批注 or the comment's "open" link re-enters the mode with its pin. Closing a card with × still
  keeps the mode, so the user can pick another target.

Active OKF: responsive-interaction → the reader sees only the current step while the run
streams → live fold + `assistant-artifacts.test.mjs` chain test + real-session replay
screenshots (live: 79 rows → 1 fold row + current step). accessibility-usability → the fold row is a
button with `aria-expanded` and a spoken summary; the annotation mode state is visible and exits
predictably → comment DOM tests (pointer resting on the target draws nothing after adding).
necessary-design-judgment → remove the share feature that has no intranet meaning, and English
tool verbs.

## Themes, paged questions, workspace cover · 2026-09-24

Request Anchor: (1) multi-question cards were too long — learn DeepSeek Harness and answer one
question per page; (2) entering the editor showed the slide jumping in size — cover it with a
full-screen preparing state and lay groundwork for future queueing; (3) judge whether the warm
design is too designed for a tool, and try the O.O.P.S ink design
(`/Users/wu/Documents/ChatGPT/oops-dsh/apps/oops-product/DESIGN.md`) with Windows/macOS
consistency. Decision: ship both designs as themes and pick the standard after using them.

Decision Snapshot:
- **Themes** (`tokens.css`, `theme.js`, `theme-boot.js`): `warm` (default, this file's earlier
  sections) and `ink` (水墨 · OOPS: paper #F5F2EB / ink #141410 / line #CEC7B9, monochrome accent,
  4–12px radii, short shadows, no canvas dots, Maple Mono UI). Settings → 外观 switches per
  browser. The render-blocking `theme-boot.js` applies it before first paint; inline scripts
  are forbidden by the page CSP. Slides keep their own fonts and colours in every theme.
  Cross-platform note: Maple Mono **Latin** is bundled; its CJK face is only used when installed
  locally (Maple Mono NF CN), otherwise MiSans. The ink theme therefore renders identically on
  Windows only after bundling a CJK Maple (about 20 MB TTF per weight). Decide on that when
  ink is chosen as the standard.
- **Paged questions** (`assistant-questions.js`, DSH QuestionFlow parity): one question per page
  with `问题 n/N` eyebrow, numbered options, 推荐 badge parsed from the label suffix (the answer
  keeps the original label), single choice auto-advances, multi-select and free text wait for
  下一题, 跳过本题, `‹ n/N ›` pager, 提交 on the last page. An incomplete set jumps to the first
  unanswered question with an explanation (the primary button stays enabled). Collapse or
  放弃整组问题 from the header. Answered sets become a compact Q → A summary in the
  conversation, which remains the durable record (unlike DSH's composer seat).
- **Workspace cover** (`workspace-cover.js`): static markup covers the editor from the first frame
  and lifts only after fonts, first render and three steady frames of `.slide-card` (bounded 1.6 s).
  Measured at 1440/1100/877: every size change happens under the cover, one size after. Launches
  show the request, steps 理解需求 → 建立文稿 → 准备工作区, and failures with 重试 /
  回首页修改. It is never shown on `render=1` raster pages (they screenshot `#slide`).
- **Queue contract** (`launch-flow.js`): `POST /slides/sessions` carries `clientRequestId`. A future
  server may answer `202 { queued: true, position, retryAfterMs }`. The cover then shows
  "排队中 · 前面还有 N 个任务" and re-posts the same body. Today's server never queues, so no
  queue UI appears.

Active OKF: responsive-interaction → no visible layout jump; one question per viewport →
cover + stability trace, paged card screenshots at 420 px. accessibility-usability → radio /
checkbox roles with `aria-checked`, visible error on incomplete submit, cover role status /
alert, keyboard-reachable recovery → `assistant-questions-dom` and `hub-launch-dom` tests.
necessary-design-judgment → keep brand moments out of the tool surface when the ink theme is
chosen; the theme split lets the owner judge it in use.

## Hub 模型选择与能力提示 · 2026-09-30

Decision Snapshot：首页只负责选模型，登录和 Key 统一放在右上角「设置」。
用户确认采用按钮旁的轻量浮动菜单，直接按供应商分组列出可用模型，不再内嵌下拉框。
菜单约 300px 宽，长列表内部滚动；选择模型后收起，思考档位使用分段单选且不收起。
移除标题和两栏网格，输入卡片高度不随菜单变化。首页间距由下方「Hub 连续工作区」覆盖。
能力收成「看图 / 联网 / 搜图 / 生图」一行，可用项点亮，悬停及键盘聚焦解释原因。
「模型」「订阅登录」「外观」保留；自定义工具导航隐藏，在模型设置中标注以后开发。
已有工具配置和后端不删除。本节覆盖此前首页登录入口和大能力卡的约定。

沿用 warm/ink 主题、字体及语义颜色；不增加卡片、图标体系或动画。内容顺序为模型、
可选思考档位、能力提示；无可用模型时给出设置路径，网络失败时说明重新打开面板重试。
选择保存沿用原 localStorage 键，暂时空列表不能清除偏好；启动请求结束不能关闭已打开的面板。
单人实现，不涉及 wiki、视频或编辑器改版。

数据约定：`GET /slides/models` 的模型 ID、名称、输入模态来自 DSH 当前适配器；
思考档位来自其模型元数据。可用状态由隔离 home 的凭据与运行失败状态共同确定，
模型选择、health 与发送校验共用同一目录。实时目录缺项或为空时不补旧模型。
只有未提供目录 API 的旧 runtime/单测可回退本地配置；没有模态声明就不声称能看图。
DSH 未提供原生联网元数据，现有供应商联网路由表保留；搜图、生图仍按实际执行工具配置判断。

| Active OKF | Decision | Artifact target | Verification |
| --- | --- | --- | --- |
| accessibility-usability | listbox 与 roving tabindex、方向键/Home/End/Enter/Space；思考档位 radiogroup；Esc 返回，Tab 离开与点外部收起 | Hub 浮动菜单 | 键盘、无模型禁发、错误重试及设置回程 |
| responsive-interaction | 按钮下方浮层，窄屏夹在视口内、短窗口换到上方；不撑开输入卡片，不被加载自动关闭 | Hub 菜单定位与模型列表 | 1440/390 两主题截图，320 与短窗口边界，长列表和延迟加载回归 |

Support：Pro mode、web-product、content-model、design-contract、visual-verification、quality-gates。
验收区分模拟凭据的交互回归与真实服务目录检查；不将二者描述为真实模型生成或 OAuth 登录成功。

Taste checkpoint：紧凑工具菜单，沿用 warm/ink 的语义色和工具字体。一个模型一行，
选中项用原有勾选图标；不增加标题卡、登录入口或新的强调色。空态解释放在列表位置。

## Hub 连续工作区 · 2026-09-30

Request Anchor：用户指出输入框到「继续协作」的大块空白不和谐，要求实际修复。
Decision Snapshot：创建和继续项目属于同一个工作区，不再用接近整屏的间距隔开。
保留输入优先、现有宽度、warm/ink 字体与语义色、纯列表以及已完成的模型菜单。

- 输入卡片到最近项目固定 48px，600px 以下为 32px，不再随窗口高度增长。
- 顶部间距为 `clamp(80px, 12vh, 128px)`；窄屏 72px，600px 以下短窗口 64px。
- 说明文字到输入卡片 32px，窄屏 24px。底部留 64px，避免无内容的超长尾部。
- 不新增卡片、装饰、动画或折叠入口。普通窗口首屏能看到最近项目，长列表自然滚动。
- 本节覆盖 Minimal Hub 的“最近项目远低于首屏”以及此前首页间距不变的边界。
  编辑器几何和业务功能不变；空态与菜单仍沿用已有语义。

| Active OKF | Decision | Artifact target | Verification |
| --- | --- | --- | --- |
| responsive-interaction | 顶部空白有上限，最近项目与创建区相邻；菜单浮层不改变文档流 | home-screen / home-purpose / projects-panel | 两主题 1920/1440/1024/390/320 及短窗口；间距、首行可见、无横向滚动、菜单边界 |

Taste checkpoint：安静而连续的工作区，工具字体不变。保留输入与历史的层级，
删除用空白制造“两屏”的分隔；以 32/48px 的节奏分组，不靠新边框或装饰补空。
Support：已读 Pro mode、web-product、visual-verification、quality-gates。单人实现。

验收：两主题多尺寸回归通过，native-web 181/181、Hub 三轮 95/95。
1000px 高桌面实测输入框到最近项目 48px、顶部 120px，窄屏为 32px/72px。
短窗口优先输入，最近项目自然滚动。证据见 `docs/acceptance/2026-09-30-hub-spacing.md`。

## 2026-10-05 会话入口修复

Request Anchor：PPT 生成记录不应淹没工作列表，也不应允许用户从普通工作输入框绕过编辑器。保留现有产品样式，使用官方 Workspace 分组与 conversation.composer 扩展槽。

决策：新会话使用稳定的数据目录与「演示文稿 · SlideStudio」标题；旧会话只按原始 cwd 登记，保留用户已有名称；工作输入区显示说明和打开原 PPT 的唯一主操作，失败显示具体错误。服务端在模型执行前拒绝工作界面的 RPC 编辑消息。

验证：带 Personal 与独立入口分别验证跳转到准确的项目；普通会话保留输入框；旧会话登记幂等，失效目录不阻断其他会话。真实桌面验收与离线夹具分别记录，不混为模型生成证据。

恢复约定：误入工作界面发送过消息后，编辑器的新指令仍可继续；服务端只检查本次最新用户输入，不因历史中的工作消息永久锁住稿件。
