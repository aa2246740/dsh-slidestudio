# OOP-27 — Monorepo migration stance (locked)

**Issue:** Monorepo migration stance vs greenfield native core  
**Inputs:** OOP-21 (YAML PPTD SSOT, dual IR forbidden), OOP-24/25/26 native stack

---

## Decision: **B — New native core in the same monorepo; legacy archived**

| Option | Verdict |
|--------|---------|
| **A. Evolve in place** (keep TS IR as evolving SSOT) | **Rejected** — conflicts with OOP-21 |
| **B. New native core packages + archive legacy** | **Chosen** |
| **C. Greenfield separate repo** | **Rejected** — loses git/Linear continuity; unnecessary given clean package boundaries |

**Repo stays:** `kimi-slides` / open-slidestudio monorepo (name may rebrand later).  
**Truth moves:** disk **YAML PPTD v2** + new packages; old TS deck IR is not write-path SSOT.

---

## Keep (reuse / rewire)

| Asset | Stance |
|-------|--------|
| Monorepo tooling (`package.json` workspaces, scripts, CI skeleton) | Keep, adapt |
| `apps/web` product shell shape (Create / Workspace / routes) | Keep as **chrome host**; replace document backend with PPTD session |
| `apps/server` LLM proxy patterns | Keep if reconfigured for intranet/local (OOP-20); strip public-only assumptions |
| Agent **run/timeline/version** ideas in `agent-core` | Reuse concepts; reimplement against PPTD ProjectStore + ToolBus (OOP-26) |
| `design-brain` anti-slop / recipe **ideas** | Optional inspiration for Brain rules; **not** format SSOT |
| `docs/wayfinder/*`, `docs/editor-oracle/*`, `CONTEXT.md` | Keep as law |
| Git history, Linear project **slides** | Keep |

---

## New native core (create under `packages/` or `packages/native/`)

Suggested names (implementation may rename):

| Package | Role |
|---------|------|
| `pptd-v2` | Parse/serialize/validate Kimi YAML PPTD v2; lossless round-trip |
| `project-store` | PPTD dirs + version snapshots |
| `exporter-pptx` **rewrite** or `exporter-pptx-native` | Hybrid shell + chart OOXML (OOP-24); kill Kimi path |
| `canvas-editor` | Self-built renderer + interaction (OOP-25); oracle-gated controls |
| `agent-harness` | RunController, ToolBus, pin/refine (OOP-26) |
| `agent-brain` | Planner / DesignAuthority / Composer / Critic |
| `oracle-tools` (optional) | Capture helpers for iframe dual-channel rows (dev only) |

Also:

```text
vendor/open-kimi-ppt@x.y.z/     # pinned skill + pptd.md + design_system (playbook/oracle)
legacy/                        # moved old packages once replaced
```

---

## Archive / non-canonical (do not extend as SSOT)

| Asset | Stance |
|-------|--------|
| Current `@open-slidestudio/pptd` TS `Deck` IR | **Legacy** — optional one-shot importer → YAML; then freeze |
| Current `exporter-pptx` pptxgenjs-only path without chart package | Replace; do not claim 1:1 Edit Data until OOP-24 path lands |
| Mock decks that only exist as TS objects | Convert samples to PPTD projects or drop |
| Any dual-write of TS IR + YAML | **Forbidden** (OOP-21) |

---

## Oracle-only (never production runtime)

| Asset | Stance |
|-------|--------|
| open-kimi `serve` / `export_*.py` / official iframe | **Dev capture only** (OOP-29) |
| Live `kimi.com` / `statics.moonshot.cn` | Dev machine only; forbidden in prod builds (OOP-20) |
| Captured official PPTX/page goldens | In-repo under `docs/editor-oracle/` |

---

## Migration rules for implementers

1. **No new features** on legacy TS IR write path.  
2. New code **reads/writes PPTD projects only**.  
3. Product UI may keep React shell; document model is always PPTD files on disk (or session backed by them).  
4. When a legacy package is fully superseded, move to `legacy/` and remove from default workspace build if desired.  
5. Greenfield **subfolder** is fine (`packages/native/*`); greenfield **repo** is not required.

---

## Explicit non-goals

- Big-bang rewrite of every line before first PPTD round-trip works  
- Deleting git history  
- Maintaining two product brands (Open SlideStudio vs Kimi-aligned) as dual codepaths during 1:1 phase — one product, Kimi-aligned UI (OOP-19)  
