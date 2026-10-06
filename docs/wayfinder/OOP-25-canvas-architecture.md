# OOP-25 — Offline canvas & render architecture (locked)

**Issue:** Choose offline canvas and render architecture  
**Inputs:** OOP-19 (Kimi-aligned UI 1:1), OOP-21 (PPTD YAML SSOT), OOP-29 (self-built editor via oracle, no production iframe), OOP-30/31 (interaction rows)

---

## Decision: Self-built canvas bound to PPTD (option 1)

| Option | Verdict |
|--------|---------|
| **1. Self-built web canvas/SVG** bound to PPTD | **Chosen** |
| **2. Embed OnlyOffice / Collabora / etc.** | **Rejected as primary** — cannot hit Kimi-aligned chrome/oracle row parity; license/ops heavy |
| **3. Hybrid external app roundtrip** | **Rejected as primary** — breaks in-product edit loop and dual-channel self-test |

**Rationale:** 1:1 claim requires matching **Kimi editor behaviors and UI placement** captured in oracle rows. Third-party editors optimize for OOXML, not Kimi PPTD + Kimi chrome.

---

## Architecture

```text
PPTD project (disk SSOT)
        │ load/parse
        ▼
  Document session (in-memory projection, lossless round-trip)
        │
        ├─► Renderer (DOM/SVG/Canvas)  — slide stage, WYSIWYG
        ├─► Interaction layer          — only controls with oracle rows
        ├─► Command/apply              — mutate projection → serialize PPTD
        ├─► Thumbnail pipeline         — same renderer, smaller viewport
        ├─► Play mode                  — same renderer, chrome stripped
        └─► Vision-QA screenshot       — headless or offscreen same renderer
```

| Concern | Locked |
|---------|--------|
| **Bind model** | PPTD v2 only (OOP-21); no parallel scene JSON as truth |
| **UI chrome** | Kimi-aligned during 1:1; driven by `kimiUi` fields on oracle rows |
| **Dead buttons** | Forbidden (OOP-29/30) |
| **Thumbnails** | Offline, same renderer (no Kimi image export dependency in production) |
| **Play** | Offline, same renderer |
| **Vision QA shots** | Production/offline path uses **self renderer** screenshots; dev may still compare to iframe shots in oracle |
| **Fonts/icons** | Bundled assets (OOP-20) |
| **Tech stack** | Web (LAN app per OOP-20); concrete React/SVG vs Canvas is implementation detail **after** this decision — default bias: **DOM/SVG for editability + hit testing**, canvas optional for effects |

---

## Sync with export

Renderer and exporter **share the same PPTD semantics** (geometry, theme tokens, z-order).  
Discrepancy “looks right in editor, wrong in PPTX” is a **defect**, measured against oracle dual-channel + ExportReport.

---

## Explicit non-goals

- Production dependency on official neo-ppt iframe for view or edit  
- Pixel-perfect match to PowerPoint (match **Kimi editor + PPTD**, then export fidelity per OOP-24)  
- Replacing product shell (Create Hub / agent chat) with the canvas package — shell stays separate; canvas is the **right pane editor**  
