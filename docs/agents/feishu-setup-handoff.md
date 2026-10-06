# Feishu ticket backend — setup / re-provisioning

Status: **done 2026-10-06** (app `dsh-slides-bot`, base `dsh-openslides
tickets`, table `tickets`). This file is the runbook for re-provisioning on a
new machine or rotating the app — keep every identifier as a placeholder; this
repo is public.

Goal: a **Feishu Base (多维表格)** as the ticket queue for this repo. The
steps below need an account that can create apps in the tenant; the agent
handles repo-side config and schema once credentials exist.

## What the operator must do

1. **Create a self-built app**
   - https://open.feishu.cn → 开发者后台 → 创建企业自建应用
   - Name suggestion: `dsh-slides-bot`
   - 凭证与基础信息 → copy **App ID** (`cli_...`) and **App Secret**.

2. **Grant scopes** (权限管理 → 添加权限)
   - `bitable:app` — 多维表格读写 (required)
   - `docx:document` — 文档读写 (optional, for future spec write-ups)

3. **Publish a version** (版本管理与发布 → 创建版本 → 发布)
   - Scopes only take effect after a published version. On small tenants the
     creator is admin, so approval is instant.

4. **Create the ticket Base**
   - In Feishu: 云文档 → 新建 → 多维表格, name `dsh-openslides tickets`.
   - Share it with the app: 分享 → 搜索 `dsh-slides-bot` → add as
     **可编辑** collaborator. (Without this every API call 403s — the most
     common failure.)
   - Copy the URL: `https://<tenant>.feishu.cn/base/<appToken>?table=<tableId>`.

   Fallback if the app is not searchable in the share dialog: hand the agent a
   `folder_token` for a drive folder instead; it can create an app-owned Base
   via `POST /bitable/v1/apps`.

5. **Write credentials locally** — two files, both gitignored:

   `.devin/feishu.local.json` (used by `scripts/feishu-ticket.mjs`):
   ```json
   {
     "appId": "cli_...",
     "appSecret": "...",
     "baseAppToken": "...",
     "tableId": "tbl..."
   }
   ```

   `.devin/mcp_config.local.json` (used by Devin CLI sessions):
   ```json
   {
     "mcpServers": {
       "feishu": {
         "command": "npx",
         "args": ["-y", "@larksuiteoapi/lark-mcp", "mcp",
                  "-a", "cli_...", "-s", "..."]
       }
     }
   }
   ```

   `tableId` may be omitted — `node scripts/feishu-ticket.mjs tables` lists
   table IDs once `appId`/`appSecret`/`baseAppToken` are set.

## Verify

```bash
node scripts/feishu-ticket.mjs whoami   # prints "ok: tenant_access_token acquired"
node scripts/feishu-ticket.mjs tables   # lists tables in the base
```

## What the agent does after credentials land

- Build the `tickets` table schema via API:
  - `标题` text (primary) · `状态` select (Todo / In Progress / In Review /
    Done / Won't Do) · `标签` multi-select (needs-triage, needs-info,
    ready-for-agent, ready-for-human, wontfix) · `优先级` select ·
    `分支` text · `PR` text · `摘要` text · `来源` text
- Smoke test: create + read + update one record.
- Rewrite `docs/agents/issue-tracker.md` and `triage-labels.md` for the Feishu
  scheme, update the `AGENTS.md` tracker section, and mark Linear as retired.
- Keep `OOP-n` as the local numbering convention for wayfinder/spec filenames;
  no Linear sync.

## Gotchas

- Re-publish the app version after any scope change.
- `tenant_access_token` (app identity) suffices for Base records — no OAuth
  user login needed.
- Feishu rate limits are per-app and far above what Linear-via-orca hit; no
  shared pool.
