# OOP-21 — Canonical document format (locked)

**Issue:** Choose canonical document format for the native stack  
**Alignment:** open-kimi PPTD v2 + editor oracle fixtures + offline native export

---

## Decision

**Option A wins: Kimi YAML PPTD v2 on disk is the single source of truth.**

```text
project/
  <name>.pptd          # manifest: version v2, size, theme, pages[]
  pages/
    *.page             # one page per file
  media/               # local assets (relative paths only)
```

| Concern | Rule |
|---------|------|
| **On-disk SSOT** | YAML PPTD v2 project tree only |
| **Agent writes** | `.pptd` / `.page` / `media/*` (open-kimi skill compatible) |
| **Canvas / editor bind** | Load/parse PPTD → view model; **save always serializes back to YAML PPTD** |
| **Export input** | Same project tree → native OOXML exporter |
| **Dual IR** | **Forbidden as two truths.** No long-lived parallel “TS deck JSON” that can diverge |
| **In-memory types** | Allowed: typed parse layer (may live in a package formerly called `@open-slidestudio/pptd` **only if** it is a **projection of YAML PPTD**, round-trip lossless for supported surface) |
| **Legacy monorepo IR** | **Non-canonical.** May import once via adapter into PPTD projects; must not remain write-path SSOT |

---

## Why A (not B or C)

| Option | Rejected because |
|--------|------------------|
| **B TS IR SSOT** | Fights open-kimi fixtures, skill, and iframe capture (all YAML); recreates dual-stack pain |
| **C New IR** | Extra migration cost; still need YAML interop for oracle; delays 1:1 |
| **A YAML PPTD** | Matches oracle fixtures, open-kimi skill, Binaryify reverse-engineering surface; agent-friendly |

---

## Normative references

1. open-kimi `skills/open-kimi-ppt/reference/pptd.md` (format definition)  
2. open-kimi example projects (goldens)  
3. `docs/editor-oracle/` rows (behavior on that format)  
4. Acceptance: `docs/wayfinder/OOP-19-acceptance-bar.md`

Pin a **vendor copy** of pptd.md (and skill version) under repo when implementation starts (e.g. `vendor/open-kimi-ppt@x.y.z/`) so airgap builds do not depend on GitHub at compile time.

---

## Round-trip law

```text
PPTD files ──parse──► memory model ──edit──► memory model ──serialize──► PPTD files
                              │
                              └──export──► .pptx
```

Any feature that cannot round-trip through YAML PPTD is either incomplete or must be `wont-port` with reason.

---

## Legacy handling (feeds OOP-27)

| Artifact | Action |
|----------|--------|
| `@open-slidestudio/pptd` command IR | Retire as SSOT; optional: reimplement as PPTD parser/serializer |
| Existing sample decks in TS | One-shot migrate to YAML projects or discard |
| `exporter-pptx` | Retarget to PPTD project input |

---

## Explicit non-goals

- Inventing a third “Open SlideStudio proprietary deck format” for 1:1 phase  
- Keeping agent output as JSON outline **without** materializing PPTD files  
- Production dependence on Kimi servers to interpret PPTD  
