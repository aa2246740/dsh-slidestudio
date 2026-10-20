#!/usr/bin/env node
/**
 * ops-sentinel — evaluate config/alert-rules.json and deliver failures to the
 * configured notifier. The only notifier today is `github-issues`, which uses
 * the `gh` CLI (GH_TOKEN in Actions) to create or update one tracking issue per
 * firing rule. Runs standalone for local checks; scheduled and workflow_run
 * triggers live in .github/workflows/ops-sentinel.yml.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./source-files.mjs";

const rules = JSON.parse(readFileSync(path.join(ROOT, "config/alert-rules.json"), "utf8")).rules;
const event = process.env.GITHUB_EVENT_NAME || "manual";
const workflowConclusion = process.env.SENTINEL_WORKFLOW_CONCLUSION || "";

function baselineExpiry() {
  const file = path.join(ROOT, "config/security-baseline.json");
  const { expires } = JSON.parse(readFileSync(file, "utf8"));
  const msLeft = new Date(`${expires}T23:59:59Z`) - Date.now();
  return msLeft > 7 * 86400000 ? null : `security baseline expires ${expires} (<7d left)`;
}

function evaluate(rule) {
  if (rule.check === "workflow_run") {
    return event === "workflow_run" && workflowConclusion === "failure"
      ? `workflow "${process.env.SENTINEL_WORKFLOW_NAME || "Readiness quality"}" concluded failure`
      : null;
  }
  if (rule.check === "baseline-expiry") return baselineExpiry();
  const result = spawnSync("npm", ["run", rule.check], { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? null : `${rule.check} exited ${result.status}`;
}

function gh(args) {
  return spawnSync("gh", args, { cwd: ROOT, encoding: "utf8" });
}

function notify(rule, detail) {
  if (rule.notifier !== "github-issues") throw new Error(`unknown notifier ${rule.notifier}`);
  if (!process.env.GH_TOKEN) {
    console.log(`[ops-sentinel] ${rule.id} fired (no GH_TOKEN, not delivered): ${detail}`);
    return false;
  }
  const title = `ops-sentinel: ${rule.id}`;
  const found = gh([
    "issue",
    "list",
    "--state",
    "open",
    "--search",
    `in:title "${title}"`,
    "--json",
    "number",
    "--jq",
    ".[0].number",
  ]);
  const body = `Automated alert from \`scripts/quality/ops-sentinel.mjs\` (rule \`${rule.id}\`, notifier \`github-issues\`).\n\n${detail}\n\nResolve the underlying gate, then close this issue.`;
  if (found.status === 0 && found.stdout.trim()) {
    gh(["issue", "comment", found.stdout.trim(), "--body", body]);
    console.log(`[ops-sentinel] ${rule.id}: updated issue #${found.stdout.trim()}`);
  } else {
    const created = gh([
      "issue",
      "create",
      "--title",
      title,
      "--label",
      "bug",
      "--label",
      "P1",
      "--label",
      "area:tooling",
      "--body",
      body,
    ]);
    console.log(
      `[ops-sentinel] ${rule.id}: ${created.status === 0 ? created.stdout.trim() : `issue create failed: ${created.stderr}`}`,
    );
  }
  return true;
}

let fired = 0;
for (const rule of rules) {
  if (rule.check === "workflow_run" && event !== "workflow_run") continue;
  if (rule.check !== "workflow_run" && event === "workflow_run") continue;
  const detail = evaluate(rule);
  if (detail && notify(rule, detail)) fired += 1;
}
console.log(`[ops-sentinel] ${rules.length} rules evaluated, ${fired} alert(s) delivered`);
