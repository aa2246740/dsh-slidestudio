# OOP-20 — Offline / intranet runtime constraints (locked)

**Issue:** Lock offline and airgap runtime constraints  
**Product claim:** usable in **intranet / offline-from-public-internet** environments after parity  
**Dev exception:** current development environment may use public net + Kimi iframe until 100% editor recreation (OOP-29)

---

## 1. Network (production / customer deploy)

| Rule | Locked |
|------|--------|
| **Public internet** | **Must not be required** for any core path: open app, edit, save, export, play, run agent against configured LLM |
| **Kimi / Moonshot / statics.moonshot.cn** | **Forbidden** in production runtime |
| **Customer intranet** | **Allowed**: private LLM gateway, private package/asset mirror, private auth |
| **Total airgap** (no network at all) | **Supported mode** if LLM is local or pre-bundled and no external calls; not the only mode |

**Answer Q1:** Not “public SaaS only.” Production = **no public egress required**; **internal-only** endpoints OK; full airgap OK when LLM/assets local.

---

## 2. LLM

| Rule | Locked |
|------|--------|
| Default assumption | Customer provides **OpenAI-compatible HTTPS endpoint on intranet** (or localhost) |
| Local models | **Supported** configuration (same API shape or adapter); product does not hardcode cloud vendor |
| Shipping weights in installer | **Not required** for 1:1 claim; optional packaging later |
| Dev | Any model; iframe oracle independent of product LLM |

**Answer Q2:** **Intranet gateway and/or local models** — both first-class; no dependency on public OpenAI/xAI/Kimi APIs for production claim.

---

## 3. Assets (fonts, icons, media, themes)

| Rule | Locked |
|------|--------|
| Runtime fonts / icon sets / design_system used by editor | **Bundled** in install artifact or loaded only from **customer-controlled** internal base URL |
| Google Fonts / public CDNs | **Forbidden** in production |
| User media in PPTD `media/` | Local paths / data in project dir only |
| Capture-phase remote images in fixtures | Allowed in **dev** fixtures; production projects should embed or local media |

**Answer Q3:** **All product assets bundled** (or internal mirror); no public asset CDN.

---

## 4. Client shape

| Rule | Locked |
|------|--------|
| Primary | **Local / LAN web application** (browser against localhost or internal host) |
| Desktop shell | **Optional later** (wrapper around same web stack); not required for 1:1 claim |
| Mobile-first Kimi app parity | **Out of scope** for this map unless discovered as required by oracle for desktop editor |

**Answer Q4:** **Local web app (LAN)** primary; desktop shell optional post-claim.

---

## 5. Updates inside the wall

| Channel | Locked approach |
|---------|-----------------|
| App binary/web build | Customer **internal package mirror** / offline installer drop |
| Themes / oracle goldens / skill text | Versioned with app release; no live pull from public GitHub at runtime |
| Models | Customer ops (local files or internal model store); app only needs endpoint config |
| open-kimi skill | Dev dependency for capture; **not** production runtime |

**Answer Q5:** **Offline/internal package updates** — no runtime phone-home to public registries.

---

## 6. Hard checklist (architecture must pass)

Every production design must answer **YES**:

1. [ ] Can run with **DNS blocked** to public internet (except optional customer intranet hosts listed in config).  
2. [ ] Zero calls to `kimi.com` / `moonshot.cn` / related CDNs.  
3. [ ] LLM base URL + API key (or local) are **configuration**, not compile-time public SaaS.  
4. [ ] Fonts/icons/themes needed for Kimi-aligned UI are **in the package**.  
5. [ ] Export path is **native OOXML** (no browser official writer).  
6. [ ] Editor oracle goldens used in CI are **in-repo files**, not live iframe.  

---

## 7. Dev vs production (do not confuse)

| | Development (until 100% editor) | Production (1:1 claim) |
|--|--------------------------------|-------------------------|
| Kimi iframe | **Allowed / required for capture** | **Forbidden** |
| Public net | Allowed on this machine | Not required |
| Oracle rows | Written continuously | Consumed offline |
