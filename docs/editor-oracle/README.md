# Editor oracle (canonical)

**Decision:** Editor oracle artifact schema (OOP-30)  
**Method:** Native editor rebuild method via iframe-as-oracle (OOP-29)

This tree is the **only** place reverse-engineered official-editor controls are recorded.  
Production runtime **must not** load Kimi iframe/CDN. Dev may use open-kimi host + official editor until claimed 100% parity.

| Path | Role |
|------|------|
| `schema/` | Locked field definitions (this decision) |
| `catalog/` | Living surface checklist (see OOP-31 order) |
| `fixtures/` | PPTD projects and export goldens used as preconditions |
| `rows/` | One directory per interaction row |
| `runs/` | Optional machine-generated capture session logs |
| `baselines/kimi-v1-2026-08-20/` | Frozen current official v1 surface, live hover evidence, and integrity manifest |

**Law (from OOP-29):**

1. Dual-channel evidence: **document/export effects** + **screenshots**.  
2. No clickable native control without a row in `status: specified|implemented|verified`.  
3. Free capture/compare until 100% parity; goldens accumulate here for later airgap CI.  
4. Full self-test of recorded rows before handoff.
