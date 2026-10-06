# OOP-96 — Agent runtime (historical generate host)

> Superseded for normal product generation by ADR-0004 and ADR-0006, and again by ADR-0009 (kernel is now DSH). Direct LLM and offline playbook routes below remain developer/test archaeology; `/api/generate` returns 410 and Hub generate is DSH `POST /slides/sessions`.

**Issue:** 接上真正的 Agent runtime

open-kimi skill assumed a host tool loop. SlideStudio runs that loop in-process. That is not official iframe / `export_pptx.py`.

| Path | What runs |
|------|-----------|
| Intranet LLM key + chip 内网模型 | `runAgentLoop`: Think / Read / Write Todo / Research / Compose; optional `generate_image` / `write_page` / `review_pages` |
| `compose_deck` with `elements[]` | write YAML PPTD pages (`applySkillDeck`) — this is skill produce |
| `compose_deck` with role+bullets only | linear IR stamp, timeline says `IR fallback` |
| Tools 400 / no `completeTurn` | one-shot `completeJson`, then playbook |
| 429 / 408 / 5xx after retries | pause + `generate-checkpoint.json` · Hub 马上重试 / 稍后继续. Not a silent playbook deck |
| Chip 离线剧本, or no key | playbook recipes (intent-based outline) |

Research: attachments, optional `SLIDESTUDIO_RESEARCH_URL`, classroom_common, or gap. Never Gartner-from-nowhere.

Hub Freestyle remaps by intent (classroom / 开题 / 发布会 / 周报 / 旅游手册). Media is optional — the agent decides. `classroom_common` is 勾股-only.

Not claimed: official cloud agent, 1:1 tool-row pixels, public web search, “the skill ran” when compose was IR-only.
