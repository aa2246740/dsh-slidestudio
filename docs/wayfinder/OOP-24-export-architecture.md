# OOP-24 — Native PPTX export architecture (locked)

**Issue:** Choose native export architecture (no Kimi writer)  
**Inputs:** OOP-19 (Edit Data required), OOP-20 (offline), OOP-21 (YAML PPTD SSOT), OOP-23 research recommendation

---

## Decision: Hybrid native exporter

```text
PPTD project (YAML v2)
        │
        ▼
┌───────────────────────────────┐
│  Native Export Pipeline       │
│  1. Parse/validate PPTD       │
│  2. Deck shell via PptxGenJS  │  text, shapes, images, tables,
│     (or equivalent MIT lib)   │  basic geometry, notes
│  3. Chart package injector    │  hand-authored OOXML:
│     (surgical)                │  ppt/charts/* + embeddings/*.xlsx
│                               │  + relationships (Edit Data)
│  4. Post-pass                 │  transitions, content types,
│                               │  integrity checks
│  5. Coverage report           │  per-element native | degraded | fail
└───────────────────────────────┘
        │
        ▼
   .pptx  (offline, no Kimi iframe)
```

| Choice | Locked |
|--------|--------|
| **vs pure library** | Library alone cannot guarantee **Edit Data** for all claimed chart types |
| **vs pure hand OOXML** | Full hand-roll too slow; shell library for non-chart objects |
| **vs LibreOffice/POI primary** | Rejected as primary author (fidelity/ops) |
| **vs official Kimi writer** | **Forbidden** in production (OOP-20) |
| **python-pptx** | **Secondary** escape hatch / sidecar if TS chart path misses kill-gates; not default |

---

## Chart Edit Data strategy

| Rule | Locked |
|------|--------|
| Claimed chart types | Must export **native chart + embedded workbook** openable via PowerPoint **Edit Data** |
| Implementation | Dedicated **chart package layer** (build/inject DrawingML + xlsx + rels), not “hope PptxGenJS is enough” |
| Unclaimed / blocked types | Explicit `wont-port` or fail export with report — **no silent whole-page raster** as default |
| Raster fallback | Allowed only per-element with `coverage.kind = degraded` and reason; cannot be majority of deck for 1:1 claim |

---

## Oracle / CI diff policy

| Artifact | Role |
|----------|------|
| `docs/editor-oracle/` export goldens | Optional per-row `export/before|after.pptx` from capture |
| Fixture PPTD → native export | Primary offline regression input |
| Captured “official writer” PPTX (dev-only) | **Oracle reference** for structure/editability tests — stored in repo, **not** runtime |
| Diff policy | (1) ZIP/OOXML structural checks (2) Edit Data openability smoke (3) optional visual page render offline later |
| Live Kimi export in CI | **Not required** for production CI; airgap uses stored goldens only |

---

## Failure reporting (gate)

Every export returns:

```text
ExportReport {
  ok: boolean
  nativeCoverage: number   // 0–1 of elements with full native editability
  degradations: [{ slide, elementId, kind, reason }]
  editDataCharts: { ok: string[], failed: string[] }
}
```

| Gate | Rule |
|------|------|
| Product “Export success” for 1:1 claim decks | `ok` and **no** hard degradations on claimed types; all claimed charts in `editDataCharts.ok` |
| Dev export of WIP | May succeed with warnings; UI must show report |

---

## Module boundary (feeds monorepo)

Suggested package name (implementation later): e.g. `@…/exporter-pptx` retargeted to **PPTD project in → pptx + report out**, no Kimi network.

---

## Non-goals

- Shipping iframe writer “until hybrid is ready” in production  
- Treating screenshot-in-slide as chart fidelity  
- Bit-identical PPTX vs official writer (behavior/editability parity, not byte identity)  
