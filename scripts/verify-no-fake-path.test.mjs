import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { collectFakePathHits } from "./verify-no-fake-path.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RETIRED_410_BLOCKS = `
if (req.method === "POST" && url.pathname === "/api/generate") {
  return json(res, 410, { error: "gone", kernel: "dsh" });
}
if (req.method === "POST" && url.pathname === "/api/refine") {
  return json(res, 410, { error: "gone", kernel: "dsh" });
}
if (req.method === "GET" && url.pathname === "/api/generate-status") {
  return json(res, 410, { error: "gone", kernel: "dsh" });
}
if (url.pathname.startsWith("/api/pi/")) {
  return json(res, 410, { error: "gone", kernel: "dsh" });
}
`;

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-path-"));
  const write = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  write("apps/native-web/src/server.mjs", RETIRED_410_BLOCKS);
  write("apps/native-web/public/hub.js", "");
  write("apps/native-web/public/app.js", "");
  write("packages/dsh-slides-host/src/index.ts", "");
  write("packages/dsh-slides-client/lib/client.js", "");
  write("packages/dsh-slides-bundle/cordis.patch.yml", "");
  write("packages/presentation-run/src/index.ts", "");
  write("packages/slides-tools/src/index.ts", "");
  write("packages/slides-mcp/src/index.ts", "");
  write("packages/slides-runtime/src/index.ts", "");
  write("scripts/dsh-slides.mjs", "");
  write(
    "package.json",
    JSON.stringify({
      scripts: { start: "npm run dsh:slides", "dsh:profile:init": "node scripts/x.mjs" },
    }),
  );
  for (const pkg of [
    "dsh-slides-host",
    "dsh-slides-bundle",
    "dsh-slides-client",
    "presentation-run",
    "slides-tools",
    "slides-mcp",
    "slides-runtime",
  ]) {
    write(`packages/${pkg}/package.json`, "{}");
  }
  write("packages/agent-harness/src/pi-hands.ts", "export async function runPiHand() {}\n");
  write("packages/agent-harness/src/pi-brain.ts", "export function createPiBrain() {}\n");
  return { root, write };
}

test("clean repo has no fake path", () => {
  assert.deepEqual(collectFakePathHits(REPO_ROOT), []);
});

test("compliant fixture passes (410 tombstones still satisfy the regexes)", () => {
  const { root } = makeFixture();
  assert.deepEqual(collectFakePathHits(root), []);
});

test("a resurrected 200 on /api/generate trips the 410 check", () => {
  const { root, write } = makeFixture();
  write(
    "apps/native-web/src/server.mjs",
    RETIRED_410_BLOCKS.replace(
      'url.pathname === "/api/generate") {\n  return json(res, 410,',
      'url.pathname === "/api/generate") {\n  return json(res, 200,',
    ),
  );
  const hits = collectFakePathHits(root);
  assert.ok(
    hits.some((h) => h.includes("POST /api/generate is not 410")),
    JSON.stringify(hits),
  );
});

test("a missing /api/refine tombstone trips its own check", () => {
  const { root, write } = makeFixture();
  write(
    "apps/native-web/src/server.mjs",
    RETIRED_410_BLOCKS.replace(/if \(req\.method === "POST" && url\.pathname === "\/api\/refine"\)[\s\S]*?\n\}\n/, ""),
  );
  const hits = collectFakePathHits(root);
  assert.ok(
    hits.some((h) => h.includes("POST /api/refine is not 410")),
    JSON.stringify(hits),
  );
});

test("forbidden symbols in product sources are flagged", () => {
  const { root, write } = makeFixture();
  write("packages/presentation-run/src/evil.ts", 'import { x } from "y";\ncreatePiBrain();\n');
  const hits = collectFakePathHits(root);
  assert.ok(
    hits.some((h) => h.includes("createPiBrain(")),
    JSON.stringify(hits),
  );
});

test("ADR-0012: pi-agent-core / pi-ai imports pass, pi-coding-agent imports and deps are flagged", () => {
  const { root, write } = makeFixture();
  write(
    "packages/slides-runtime/src/loop.ts",
    'import { Agent } from "@earendil-works/pi-agent-core";\nimport { createModels } from "@earendil-works/pi-ai";\n',
  );
  assert.deepEqual(collectFakePathHits(root), []);
  write("packages/slides-runtime/src/coding.ts", 'import { main } from "@earendil-works/pi-coding-agent";\n');
  write(
    "packages/slides-runtime/package.json",
    JSON.stringify({ dependencies: { "@earendil-works/pi-coding-agent": "0.80.10" } }),
  );
  const hits = collectFakePathHits(root);
  assert.ok(hits.includes("packages/slides-runtime/src/coding.ts: pi-coding-agent"), JSON.stringify(hits));
  assert.ok(
    hits.includes("packages/slides-runtime/package.json: production dep on pi-coding-agent"),
    JSON.stringify(hits),
  );
});
