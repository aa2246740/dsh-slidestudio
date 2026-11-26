import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { SLIDES_DIRECTOR_PERSONA, SLIDES_DIRECTOR_PERSONA_LINES } from "@open-slidestudio/slides-tools";
import { MCP_WORKFLOW, mcpInstructions } from "./instructions.js";
import { PACKAGE_ROOT } from "./testkit.js";

const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const SKILL_FILE = path.join(REPO_ROOT, "skills", "slidestudio", "SKILL.md");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) ? [file] : [];
  });
}

const sources = sourceFiles(path.join(PACKAGE_ROOT, "src"));
const manifestText = fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8");
const manifest = JSON.parse(manifestText) as Record<string, Record<string, string> | undefined>;
// Built from parts so this guard does not match itself.
const HOST_SCOPE = ["@deep", "seek-ai/"].join("");
const NATIVE_CODECS = [["sh", "arp"].join(""), ["@napi-rs/", "canvas"].join("")];
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

test("slides-mcp has zero host SDK references in src/** and package.json", () => {
  assert.ok(sources.length >= 10, "the scan sees the package sources");
  const offenders = sources.filter((file) => fs.readFileSync(file, "utf8").includes(HOST_SCOPE));
  assert.deepEqual(
    offenders.map((file) => path.relative(PACKAGE_ROOT, file)),
    [],
  );
  assert.equal(manifestText.includes(HOST_SCOPE), false);
});

test("no native image codec is referenced or declared", () => {
  for (const codec of NATIVE_CODECS) {
    const pattern = new RegExp(`["'\`]${codec.replace(/[/]/g, "\\/")}["'\`/]`);
    const offenders = sources.filter((file) => pattern.test(fs.readFileSync(file, "utf8")));
    assert.deepEqual(
      offenders.map((file) => path.relative(PACKAGE_ROOT, file)),
      [],
      codec,
    );
    assert.equal(manifestText.includes(`"${codec}"`), false, `package.json declares ${codec}`);
  }
});

test("runtime dependencies are only core workspace packages and typescript is never declared", () => {
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), [
    "@open-slidestudio/pptd-v2",
    "@open-slidestudio/presentation-run",
    "@open-slidestudio/slides-tools",
  ]);
  assert.deepEqual(manifest.devDependencies, { "@types/node": "^22.10.0" });
  assert.equal(JSON.stringify(manifest.bin), JSON.stringify({ "slides-mcp": "./dist/cli.js" }));
  assert.match(fs.readFileSync(path.join(PACKAGE_ROOT, "src", "cli.ts"), "utf8"), /^#!\/usr\/bin\/env node\n/);
});

const PERSONA_RULES = [
  "Write user-facing progress and explanations in the language of the user brief.",
  "Treat clear user instructions as authorization; do not ask for a second confirmation for a whole-deck edit or a reversible styling change.",
  "Never write YAML except through write_page.",
  "Pass every tool's declared fields directly at the top level; never wrap them in an arguments object.",
  "write_page elements use elementId, elementType, bounds [x,y,w,h], and content.text.",
  "Put fontSize, fontFamily, color, and align directly on content;",
  "Charts are data.cols + data.rows and series[].type/encode.",
  "Never omit shape fill expecting a default",
  "Use inspect_capabilities and the tools actually supplied for this session.",
  "Provider-hosted search or image tools are available only when explicitly supplied; do not infer them from a model name.",
  "update write_todo with the new pageIds before writing them; a page not in the todo is refused.",
  "Do not reuse one src as another page's full-bleed.",
  "Never invent an answer or repeat a cancelled question.",
];

test("SKILL.md carries the persona's core rules from the single source", () => {
  const skill = normalize(fs.readFileSync(SKILL_FILE, "utf8"));
  const persona = normalize(SLIDES_DIRECTOR_PERSONA);
  for (const rule of PERSONA_RULES) {
    assert.ok(persona.includes(rule), `persona no longer says: ${rule}`);
    assert.ok(skill.includes(rule), `SKILL.md lost: ${rule}`);
  }
});

test("SKILL.md frontmatter, workflow order, lease recovery and the no-ask_user_question rule", () => {
  const raw = fs.readFileSync(SKILL_FILE, "utf8");
  assert.match(raw, /^---\nname: slidestudio\ndescription: .+\n---\n/);
  const workflow = raw.slice(raw.indexOf("## Workflow"), raw.indexOf("## Rules"));
  let cursor = -1;
  for (const step of MCP_WORKFLOW) {
    for (const tool of step.match(/[a-z]+(?:_[a-z]+)+/g) ?? []) {
      const at = workflow.indexOf(`\`${tool}\``);
      assert.ok(at >= 0, `workflow misses ${tool}`);
      if (tool !== "bind_project") {
        assert.ok(at > cursor, `${tool} is out of order`);
        cursor = at;
      }
    }
  }
  for (const needle of ["lease-preempted-by-editor", "reacquire_lease", "read_page", "import_roots_not_configured"]) {
    assert.ok(raw.includes(needle), needle);
  }
  assert.match(normalize(raw), /There is no `ask_user_question` tool over MCP\. .*ask the user directly/);
  for (const host of ["Claude Code", "Codex", "Antigravity", "--transport http", "Authorization: Bearer"]) {
    assert.ok(raw.includes(host), host);
  }
});

test("SKILL.md has zero Kimi branding and no internal deployment artifacts", async () => {
  const raw = fs.readFileSync(SKILL_FILE, "utf8");
  assert.equal(/kimi|moonshot/i.test(raw), false);
  const scanner = (await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "verify-no-intranet.mjs")).href)) as {
    collectIntranetHits(root: string, files: readonly string[]): string[];
  };
  assert.deepEqual(scanner.collectIntranetHits(REPO_ROOT, ["skills/slidestudio/SKILL.md"]), []);
});

test("initialize instructions keep every persona line except the DSH ask_user_question ones", () => {
  const instructions = mcpInstructions();
  for (const line of SLIDES_DIRECTOR_PERSONA_LINES) {
    if (line.includes("ask_user_question")) continue;
    assert.ok(instructions.includes(line.replaceAll("{{cwd}}", "the SlideStudio data root of this server")), line);
  }
  assert.equal(instructions.includes("{{cwd}}"), false);
  const mentions = instructions.split("\n").filter((line) => line.includes("ask_user_question"));
  assert.deepEqual(mentions.length, 1);
  assert.match(mentions[0]!, /ask the user directly .*does not exist over MCP/);
  assert.match(instructions, /reacquire_lease/);
});
