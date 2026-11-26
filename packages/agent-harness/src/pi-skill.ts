/**
 * Skills Pi actually loads. Official open-kimi-ppt is the produce path.
 * This host skill overrides official export / Kimi API.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSkillRoot } from "./playbook.js";

export const HOST_SKILL_NAME = "open-slidestudio";

export function resolveHostSkillDir(start = process.cwd()): string {
  const fromModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", HOST_SKILL_NAME);
  if (fs.existsSync(path.join(fromModule, "SKILL.md"))) return fromModule;

  let dir = path.resolve(start);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "packages", "agent-harness", "skills", HOST_SKILL_NAME);
    if (fs.existsSync(path.join(candidate, "SKILL.md"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`host skill not found (expected packages/agent-harness/skills/${HOST_SKILL_NAME})`);
}

export function resolvePiSkillDirs(
  opts: {
    skillRoot?: string;
    cwd?: string;
  } = {},
): { host: string; vendor: string } {
  return {
    host: resolveHostSkillDir(opts.cwd),
    vendor: opts.skillRoot ?? resolveSkillRoot(opts.cwd),
  };
}

export function formatSkillPathsMarkdown(dirs: { host: string; vendor: string }): string {
  return [
    `# Skill paths`,
    ``,
    `- open-slidestudio: \`${dirs.host}\``,
    `- open-kimi-ppt: \`${dirs.vendor}\``,
    ``,
    `Read \`${path.join(dirs.host, "SKILL.md")}\` — that is the host execution contract.`,
    `--skill is discovery only.`,
    `Use list_references and read_reference to receive the required original OpenKimi files byte-exactly.`,
    `Inspect the selected preview with view_design_reference, then commit and follow the task-specific design contract.`,
    `Review every page image and the current full-deck overview before compose_deck.`,
    `Do not replace those sources with playbook.md, excerpts, summaries, or prior context.`,
    `Do not run official export scripts.`,
    ``,
  ].join("\n");
}
