#!/usr/bin/env node
// feishu-ticket.mjs — thin Feishu Base (Bitable) ticket CLI for agents.
//
// Config resolution (first wins per key): env vars, then
// .devin/feishu.local.json (gitignored):
//   { "appId": "cli_...", "appSecret": "...", "baseAppToken": "...",
//     "tableId": "tbl..." }
// Env names: FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_APP_TOKEN /
//            FEISHU_TABLE_ID / FEISHU_DOMAIN (default https://open.feishu.cn)
//
// Commands:
//   whoami                                    verify app credentials
//   tables                                    list tables in the base
//   list [--status <v>] [--json]              list ticket records
//   get <record_id>                           show one record
//   create --title <t> [--status Todo] [--labels a,b] [--priority medium]
//          [--branch b] [--pr url] [--summary s] [--source who]
//   update <record_id> [--status v] [--labels a,b] [--priority v]
//          [--branch b] [--pr url] [--summary s] [--source who]
//
// Field names on the `tickets` table (created by the setup flow):
//   标题 text · 状态 select · 标签 multi-select · 优先级 select ·
//   分支 text · PR text · 摘要 text · 来源 text

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const localConfigPath = join(repoRoot, '.devin', 'feishu.local.json');

function loadConfig() {
  const file = existsSync(localConfigPath)
    ? JSON.parse(readFileSync(localConfigPath, 'utf8'))
    : {};
  const cfg = {
    appId: process.env.FEISHU_APP_ID ?? file.appId,
    appSecret: process.env.FEISHU_APP_SECRET ?? file.appSecret,
    baseAppToken: process.env.FEISHU_BASE_APP_TOKEN ?? file.baseAppToken,
    tableId: process.env.FEISHU_TABLE_ID ?? file.tableId,
    domain: process.env.FEISHU_DOMAIN ?? file.domain ?? 'https://open.feishu.cn',
  };
  return cfg;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let cachedToken;
async function token(cfg) {
  if (cachedToken) return cachedToken;
  const res = await fetch(`${cfg.domain}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`tenant_access_token: ${JSON.stringify(data)}`);
  cachedToken = data.tenant_access_token;
  return cachedToken;
}

async function api(cfg, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${cfg.domain}/open-apis${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${await token(cfg)}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
  return data.data;
}

function buildFields() {
  const f = {};
  const set = (k, v) => { if (v !== undefined) f[k] = v; };
  set('标题', arg('title'));
  set('状态', arg('status'));
  set('标签', arg('labels')?.split(',').map((s) => s.trim()).filter(Boolean));
  set('优先级', arg('priority'));
  set('分支', arg('branch'));
  set('PR', arg('pr'));
  set('摘要', arg('summary'));
  set('来源', arg('source'));
  return f;
}

function printRecord(r) {
  const f = r.fields ?? {};
  const val = (v) => (Array.isArray(v) ? v.map((x) => x?.text ?? x).join(',') : v ?? '');
  console.log(`${r.record_id}\t${val(f['状态'])}\t${val(f['标签'])}\t${val(f['标题'])}`);
}

const cmd = process.argv[2];
const cfg = loadConfig();

try {
  if (!cmd || cmd === 'help') {
    console.log('commands: whoami | tables | list | get <id> | create --title T | update <id>');
    process.exit(0);
  }
  if (!cfg.appId || !cfg.appSecret) {
    console.error('missing credentials: set .devin/feishu.local.json or FEISHU_APP_ID/FEISHU_APP_SECRET');
    process.exit(2);
  }

  switch (cmd) {
    case 'whoami': {
      await token(cfg);
      console.log('ok: tenant_access_token acquired');
      break;
    }
    case 'tables': {
      if (!cfg.baseAppToken) throw new Error('missing baseAppToken');
      const d = await api(cfg, `/bitable/v1/apps/${cfg.baseAppToken}/tables?page_size=100`);
      for (const t of d.items ?? []) console.log(`${t.table_id}\t${t.name}`);
      break;
    }
    case 'list': {
      if (!cfg.baseAppToken || !cfg.tableId) throw new Error('missing baseAppToken/tableId');
      const status = arg('status');
      const params = new URLSearchParams({ page_size: '100' });
      if (status) params.set('filter', `CurrentValue.[状态]="${status}"`);
      const d = await api(cfg, `/bitable/v1/apps/${cfg.baseAppToken}/tables/${cfg.tableId}/records?${params}`);
      if (arg('json') !== undefined || process.argv.includes('--json')) {
        console.log(JSON.stringify(d.items ?? [], null, 2));
      } else {
        for (const r of d.items ?? []) printRecord(r);
      }
      break;
    }
    case 'get': {
      const id = process.argv[3];
      if (!id) throw new Error('usage: get <record_id>');
      const d = await api(cfg, `/bitable/v1/apps/${cfg.baseAppToken}/tables/${cfg.tableId}/records/${id}`);
      console.log(JSON.stringify(d.record, null, 2));
      break;
    }
    case 'create': {
      const fields = buildFields();
      if (!fields['标题']) throw new Error('create requires --title');
      const d = await api(cfg, `/bitable/v1/apps/${cfg.baseAppToken}/tables/${cfg.tableId}/records`, {
        method: 'POST',
        body: { fields },
      });
      console.log(d.record.record_id);
      break;
    }
    case 'update': {
      const id = process.argv[3];
      if (!id) throw new Error('usage: update <record_id> [--status ...]');
      const fields = buildFields();
      const d = await api(cfg, `/bitable/v1/apps/${cfg.baseAppToken}/tables/${cfg.tableId}/records/${id}`, {
        method: 'PUT',
        body: { fields },
      });
      console.log(d.record.record_id);
      break;
    }
    default:
      console.log('commands: whoami | tables | list | get <id> | create --title T | update <id>');
      process.exit(cmd ? 2 : 0);
  }
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}
