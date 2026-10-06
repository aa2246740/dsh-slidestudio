# OOP-26 — Offline agent harness & brain split (locked)

**Issue:** Shape offline agent harness and brain split  
**Inputs:** OOP-19 product path, OOP-20 offline LLM, OOP-21 PPTD SSOT, open-kimi SKILL as playbook source, PRD tool list

---

## Decision overview

```text
User brief + attachments + template/theme id
        │
        ▼
┌──────────── Harness (orchestration, no taste) ────────────┐
│  Run state machine · tool bus · version snapshots           │
│  Project I/O (PPTD dirs only) · pin-batch · cancel/retry  │
└────────────┬──────────────────────────────────────────────┘
             │ invokes
             ▼
┌──────────── Brain (policies + LLM) ───────────────────────┐
│  Planner · DesignAuthority · Composer · Critic/Repairer   │
│  Playbook = open-kimi SKILL + reference (content only)    │
└────────────┬──────────────────────────────────────────────┘
             │ writes
             ▼
        PPTD project  ──►  Renderer / Exporter (native)
```

**Harness does not invent layouts. Brain does not own versions or export gates.**

---

## 1. Harness modules & tools

| Module | Responsibility |
|--------|----------------|
| `RunController` | `draft → planning → researching → composing → validating → ready` (+ failed / needs_input / cancelled) |
| `ToolBus` | Emit started/progress/completed/failed for UI timeline |
| `ProjectStore` | Create/open PPTD trees; version snapshots (directory copy or git-like) |
| `PinBatch` | Collect pins → one brain run → apply PPTD patches → version if any ok |
| `Refine` | NL instruction + scope → brain edit → version |
| `ValidateGate` | Schema validate PPTD; optional structural lint; export coverage when exporting |
| `LlmPort` | Configured intranet/local endpoint only (OOP-20) |

**Tool names (product-visible, PRD-aligned):**

| Tool | Role |
|------|------|
| `think` / `plan` | Todo graph, assumptions |
| `read_file` | Parse attachments into text/structure for brain |
| `research` | Optional; offline may be stub or internal corpus only |
| `extract_theme` | From refs or named design_system id |
| `compose_deck` | Write full PPTD project |
| `edit_slide` | Scoped PPTD patches |
| `render` | Thumbnails via native renderer (OOP-25) |
| `vision_qa` | See §4 |
| `validate_editability` | Export report / schema |
| `version_snapshot` | Immutable version label |
| `export_pptx` | Native exporter (OOP-24) |

---

## 2. Brain modules (rules vs LLM)

| Module | Owns | LLM? | Rules? |
|--------|------|------|--------|
| **Planner** | Story map, page count, page roles | Yes (content) | Hard caps, language, offline policy |
| **DesignAuthority** | Theme id, density, anti-slop constraints | Soft hints | **Loads offline design_system**; forbids freeform brand drift when preset named |
| **Composer** | Writes `.pptd` / `.page` / `media` | Yes | **Must emit valid PPTD v2**; parallel page writes OK |
| **Critic / Repairer** | Structural lint + vision findings → patches | Optional VLM | Schema bounds, overflow heuristics, oracle-informed checks |

**Split law:** LLM may propose; **invalid PPTD never becomes ready** without repair or fail.

---

## 3. open-kimi SKILL as playbook

| Locked | Detail |
|--------|--------|
| **Yes — content only** | Vendor-pin open-kimi `SKILL.md` + `reference/*` (scenarios, design_system, pptd.md) as **agent instructions** |
| **Not runtime** | Do not execute `export_pptx.py` / iframe host in production |
| **Version pin** | Ship a frozen skill tree under e.g. `vendor/open-kimi-ppt@x.y.z/` for airgap |
| **Overrides** | OOP-19/20/21/24/25/29 always win over skill text when conflicting (e.g. no Kimi export) |

---

## 4. Vision QA (offline)

| Mode | When | Locked approach |
|------|------|-----------------|
| **A. Structure-first (default offline)** | Always | Bounds, overlap, empty text, theme contrast heuristics, schema — **required** before ready |
| **B. Local / intranet VLM** | If configured | Screenshot via **native renderer** (OOP-25); same check list as open-kimi step4 visual items |
| **C. Human gate** | Optional ops | Allowed; must not be the only path for automated CI |
| **Cloud multimodal public API** | Production | **Not required**; forbidden if it breaks OOP-20 public-net rule |

**Dev capture phase** may still use any multimodal model to fill oracle rows; that is not the production harness.

---

## 5. Design systems offline

| Rule | Locked |
|------|--------|
| Ship | Bundle design system markdown/tokens used by DesignAuthority **inside the install** |
| Source | Prefer **open-kimi `design_system/` adapted clean-room** (copy text contracts, replace any non-redistributable binaries) |
| Preset naming | Keep stable ids (e.g. `pine-green-strategy`) for skill/playbook compatibility |
| Legal | Do not claim official Kimi brand; treat as reverse-engineered **style contracts** for 1:1 recreation phase |
| Runtime network | No fetch of themes from public CDN |

---

## 6. I/O contract

Brain and harness **only** materialize:

```text
project/*.pptd
project/pages/*.page
project/media/*
```

No second deck JSON SSOT (OOP-21).

---

## Non-goals

- Embedding official Kimi agent cloud  
- Harness that paints pixels without PPTD  
- Requiring public web research for every deck in airgap mode (research tool degrades gracefully)  
