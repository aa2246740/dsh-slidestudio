# OOP-19 — 1:1 acceptance bar (locked)

**Issue:** Define 1:1 acceptance bar for native offline Kimi Slides  
**Depends on:** OOP-29 method, OOP-30 oracle schema, OOP-31 surface order  
**Production constraint:** zero Kimi iframe/CDN at runtime after parity

This matrix is the **definition of done** for claiming “1:1 Kimi Slides (native offline).”  
Anything not listed as **In scope for 1:1 claim** is either deferred (post-1:1) or out of map scope.

---

## 1. Product surface

| Area | In 1:1 claim? | Measurable gate |
|------|---------------|-----------------|
| Create Hub (prompt, categories/templates, model select, attach entry) | **Yes** | PRD AC-01, AC-02 behaviors; Kimi-aligned layout during recreation phase |
| Agent run timeline (tool steps visible) | **Yes** | AC-03; tools may be native implementations, labels/flow match product |
| Result card → workspace | **Yes** | AC-04 |
| Split workspace (chat \| editor) | **Yes** | AC-05 class; resizable optional but both panes real |
| **Native editor** S0–S12 oracle rows | **Yes** | All non-`wont-port` rows **`verified`** (OOP-31) |
| Chart data edit in editor | **Yes** | AC-06; dual-channel oracle rows under S11 |
| Process / structure (SmartArt-class) | **Yes** | Expressed as PPTD shape+line+text (or native structure); AC-07-class behaviors via oracle |
| NL refine + versions | **Yes** | AC-08, AC-10 |
| Comment pins → agent batch | **Yes** | AC-09 |
| Play mode | **Yes** | Keyboard nav; chrome match during Kimi-aligned phase |
| Export PPTX (+ honest PDF/PNG convenience) | **Yes** | AC-12 class; see §3 |
| Image → editable rebuild | **Yes** | AC-11; quality must be dual-channel tested on fixtures |
| Share ACL multiplayer | **No** | Out of map scope (honest local share OK) |
| Unique non-Kimi branding UI | **No for claim** | **Post-1:1 only** (OOP-29 Q2) |

**Answer to ticket Q1:** **Full** product surface above — not a thin subset — for the 1:1 claim.

---

## 2. Document fidelity

| Requirement | Gate |
|-------------|------|
| On-disk model | **Kimi YAML PPTD v2** project layout (see OOP-21) |
| Element types | `text`, `shape`, `line`, `image`, `icon`, `table`, `chart` per open-kimi `pptd.md` |
| Shape library | Official preset surface used in oracle fixtures must round-trip; expand until fixture-driven gaps closed |
| Chart series types | **All types appearing in open-kimi pptd.md / fixtures** must be representable; no silent drop without `wont-port` row |
| Theme tokens | `$color` / textStyles / tableStyles inheritance behaviors matched on fixtures |
| Animations / notes | In scope for 1:1 **if present and used in official editor iframe** (S12–S13); otherwise `wont-port` with evidence |

**Answer to ticket Q2:** Match **open-kimi PPTD v2 element surface** fully for 1:1; chart coverage = full spec surface used by oracle, not a reduced subset.

---

## 3. Export fidelity

| Object | 1:1 requirement |
|--------|-----------------|
| Text / shape / table / image | Editable native objects in PowerPoint/WPS; no whole-page raster as default |
| Chart | **Native chart + embedded workbook; Edit Data must work** for types we claim supported |
| Icon | Editable or equivalent vector/shape; not unexplained bitmap only |
| Fonts | Best-effort embed when possible; document gaps; no public font CDN at runtime |
| Transitions | Fade or documented default; must not corrupt slide XML order |

**Answer to ticket Q3:** **Edit Data is required** for the 1:1 claim (not best-effort-only). Unsupported chart types must be explicit `wont-port` or blocked—not silently flattened.

**Gate:** Sample decks from oracle fixtures export offline; open in PowerPoint without repair storm; spot-check Edit Data on S11 verified rows.

---

## 4. Visual / generation quality

| Bar | Gate |
|-----|------|
| Editor chrome | **Kimi-aligned** during recreation (OOP-29); dual-channel screenshots vs iframe |
| Generated deck quality | Must pass structural QA + vision QA policy (once harness locked); consulting-grade target = open-kimi demo class, measured by fixture/oracle compare not slogans |
| No dead buttons | OOP-29/30 law |

**Answer to ticket Q4:** **Both** structural parity **and** high visual quality; UI/chrome track Kimi first; generation quality judged against oracle/fixtures, not “structure only forever.”

---

## 5. Chrome / branding

| Phase | Rule |
|-------|------|
| Until 1:1 claim | **Align with Kimi** (layout, control placement, labels as captured) |
| After 1:1 claim | Unique product branding allowed |

**Answer to ticket Q5:** Pixel-or-near **Kimi-aligned** for the recreation phase; not “Open-only capability chrome” during 1:1.

---

## 6. Hard claim checklist (summary)

Declare **1:1 native offline Kimi Slides** only when all are true:

1. [ ] Production build: **zero** requests to Kimi/Moonshot hosts (packet or offline test).  
2. [ ] Editor: S0–S12 non-`wont-port` rows **`verified`** (OOP-31).  
3. [ ] Product: Create → Agent → Workspace → refine/pins/versions/play/export path works.  
4. [ ] Document: PPTD v2 projects open/edit/export without dual IR.  
5. [ ] Export: editable objects + **chart Edit Data** on claimed types.  
6. [ ] Full self-test record of oracle `test.id`s green before handoff (OOP-29 Q5).  
7. [ ] Offline/intranet constraints (OOP-20) satisfied.

---

## 7. Explicitly not required for 1:1 claim

- Realtime multiplayer ACL  
- Shipping official Kimi trademark as product name  
- 100% PowerPoint animation/macro/OLE universe beyond iframe-observed surface  
- Post-1:1 unique UI redesign  
