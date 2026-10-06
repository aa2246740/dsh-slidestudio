# OOP-28 — Pure-native parity phases (locked)

**Issue:** Order the pure-native parity phases  
**Roll-up of:** OOP-19…27, 29…31  

This is the **implementation order** once wayfinding ends. Exit criteria are gates; do not claim 1:1 until **Phase G**.

---

## Phase map (overview)

```text
A Foundation
B PPTD I/O + project versions
C Hybrid export (offline)
D Oracle capture toolchain + S0 fixtures
E Native canvas + editor sections S1→S12 (Discover→Verify)
F Product shell + harness + brain
G 1:1 claim (full self-test)
H Post-1:1 (deferred)
```

Phases **A–D** may partially overlap when dependencies allow; **E sections are sequential** per OOP-31; **F** can start after **B** has stable PPTD I/O but must not ship editor controls without oracle rows.

---

## Phase A — Foundation

**Goal:** Repo law + vendor pin + legacy freeze.

| Work | Exit |
|------|------|
| Vendor-pin `open-kimi-ppt` skill + `pptd.md` + design_system under `vendor/` | Offline readable, version recorded |
| Apply OOP-27: skeleton new packages; mark legacy non-SSOT | Documented in README/AGENTS |
| CI: schema validate empty editor-oracle tree | Green |
| Install open-kimi skill on dev machines | `serve` smoke works (dev only) |

---

## Phase B — PPTD I/O

**Goal:** YAML PPTD v2 is the only write path.

| Work | Exit |
|------|------|
| `pptd-v2` parse / validate / serialize | Round-trip open-kimi example projects lossless for supported fields |
| `project-store` create / open / version snapshot | V1/V2 restore works on disk trees |
| Optional: one-shot importer from legacy TS decks | Or explicit drop of legacy samples |

---

## Phase C — Hybrid export (offline)

**Goal:** No Kimi writer; Edit Data path exists.

| Work | Exit |
|------|------|
| Deck shell export (text/shape/image/table) | PowerPoint opens, objects editable |
| Chart package layer + embedded xlsx | At least bar/line/pie (or first claimed set) **Edit Data** works |
| `ExportReport` + fail/degrade policy | Matches OOP-24 |
| Offline CI export smoke on fixtures | No network |

---

## Phase D — Oracle toolchain + S0

**Goal:** Dual-channel capture is operational.

| Work | Exit |
|------|------|
| Fixture registration (`okp-*`, `syn-*`) | `fixtures/manifest.json` non-empty |
| Capture playbook / optional automation | Can produce `specified` row with shots + PPTD diff |
| S0 complete | OOP-31 S0 checklist done |

---

## Phase E — Native editor (S1 → S12)

**Goal:** Kimi-aligned editor, section by section.

For **each** section S1…S12:

1. **Discover** → all controls in `catalog/index.yaml` as `discovered`  
2. **Capture** → dual-channel → `specified`  
3. **Implement** on self canvas → `implemented`  
4. **Verify** self-test → `verified`  

| Gate | Rule |
|------|------|
| Section done | All non-`wont-port` rows `verified` |
| No dead buttons | OOP-29/30 |
| Same renderer | thumbnails / play / QA shots (OOP-25) |

**S13** (animation/keyboard residual): complete before claim if iframe shows them as core; else explicit `wont-port` list for 1:1 carve-out (must be listed in claim notes).

---

## Phase F — Product shell + harness + brain

**Goal:** Full product path offline-capable.

| Work | Exit |
|------|------|
| Create Hub + attach + generate entry | OOP-19 product surface |
| Harness ToolBus + versions + pin/refine | OOP-26 |
| Brain compose writes PPTD only | Valid projects open in native editor |
| Structure-first QA gate | Invalid PPTD cannot go `ready` without repair/fail |
| Design systems bundled | Named presets work offline |
| LLM via config (intranet/local) | No public SaaS hardcode (OOP-20) |

May proceed in parallel with later **E** sections once editor can open/edit core types (text/shape at minimum), but **1:1 claim waits for E**.

---

## Phase G — 1:1 claim

All of OOP-19 checklist, including:

1. Production build: zero Kimi/Moonshot network  
2. Editor S0–S12 non-`wont-port` **`verified`**  
3. Create → agent → workspace → refine/pins/versions/play/export  
4. PPTD v2 only  
5. Export Edit Data on claimed chart types  
6. Full self-test record green  
7. OOP-20 hard checklist  

**Deliverable:** signed claim doc + test matrix export (e.g. all `EO-*` statuses).

---

## Phase H — After “1:1 declared” (explicitly deferred)

| Item | Notes |
|------|--------|
| Unique non-Kimi branding / UI redesign | OOP-19/29 |
| Desktop shell wrapper | Optional |
| Shipping local model weights in installer | Optional |
| Realtime multiplayer ACL | Out of map scope |
| Expanding beyond iframe-observed animation universe | Optional |
| Public SaaS multi-tenant cloud | Out of scope for this effort |

---

## Dependency sketch

```text
A → B → C
A → D → E(S1…S12)
B → F
C → F (export button)
E + F → G → H
```

---

## What this phase plan is not

- Not a schedule with calendar dates  
- Not permission to skip oracle rows for demos  
- Not permission to keep production iframe “temporarily” after G  
