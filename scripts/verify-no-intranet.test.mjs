import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectIntranetHits, gitTrackedFiles } from "./verify-no-intranet.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("tracked repo files have no concrete intranet deployment artifacts", () => {
  assert.deepEqual(collectIntranetHits(REPO_ROOT, gitTrackedFiles(REPO_ROOT)), []);
});

test("flags deployment flags, kit paths, endpoints, and leaked addresses", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "no-intranet-"));
  const write = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  write("src/flag.ts", 'const on = process.env.SLIDESTUDIO_INTRANET_COMPAT === "1";\n');
  write("src/compat.ts", 'import "./intranet-compat.js";\n');
  write("src/palette.ts", "export const colors = intranetSemanticPaletteHexes();\n");
  write("src/gate.ts", "export const enabled = isIntranetCompatEnabled();\n");
  write("docs/kit.md", "see scripts/service-package and scripts/intranet-kit\n");
  write("src/ops.ts", "process.env.SLIDESTUDIO_ADMIN_OPS_ACCESS\n");
  write("src/api.ts", 'const url = "/integrations/v1/decks";\n');
  write("src/addr.ts", 'const host = "55.120.71.31";\n');
  write("notes.md", "intranet/local LLM via config stays public.\n");
  write("assets/logo.png", "SLIDESTUDIO_INTRANET_COMPAT");
  const hits = collectIntranetHits(root, [
    "src/flag.ts",
    "src/compat.ts",
    "src/palette.ts",
    "src/gate.ts",
    "docs/kit.md",
    "src/ops.ts",
    "src/api.ts",
    "src/addr.ts",
    "notes.md",
    "assets/logo.png",
  ]);
  assert.equal(hits.length, 9, JSON.stringify(hits));
  assert.ok(hits.every((hit) => !hit.startsWith("notes.md") && !hit.startsWith("assets/logo.png")));
});

test("detects a forbidden marker in an untracked non-ignored file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "no-intranet-untracked-"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "leak.ts"), 'process.env.SLIDESTUDIO_INTRANET_COMPAT = "1";\n');
  const files = gitTrackedFiles(root);
  assert.ok(files.includes("leak.ts"), JSON.stringify(files));
  const hits = collectIntranetHits(root, files);
  assert.ok(
    hits.some((hit) => hit.startsWith("leak.ts") && hit.includes("SLIDESTUDIO_INTRANET_COMPAT")),
    JSON.stringify(hits),
  );
  fs.rmSync(root, { recursive: true, force: true });
});
