#!/usr/bin/env node
/** Production graph must not call Pi generate, host painters, or fake generate. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PRODUCT_GLOBS = [
  "apps/native-web/src/server.mjs",
  "apps/native-web/public/hub.js",
  "apps/native-web/public/app.js",
  "packages/dsh-slides-host/src",
  "packages/dsh-slides-client/lib/client.js",
  "packages/dsh-slides-bundle/cordis.patch.yml",
  "packages/presentation-run/src",
  "packages/slides-tools/src",
  "packages/slides-mcp/src",
  "packages/slides-runtime/src",
  "scripts/dsh-slides.mjs",
];

const FORBIDDEN = [
  { re: /createPiBrain\s*\(/, label: "createPiBrain(" },
  { re: /resolveGenerateDesign\s*\(/, label: "resolveGenerateDesign(" },
  { re: /resolvePlaybookCategory\s*\(/, label: "resolvePlaybookCategory(" },
  { re: /from ["']\.\/host-produce/, label: "host-produce import" },
  { re: /hostProduce|paintExhibit/, label: "host painter" },
  { re: /runPiHand/, label: "runPiHand" },
  { re: /createRunPiHandPort/, label: "createRunPiHandPort" },
  { re: /from ["']@open-slidestudio\/agent-harness["']/, label: "agent-harness import" },
  // ADR-0012: the core loop runs on @earendil-works/pi-agent-core + pi-ai; only the
  // coding-agent product (and its createPiBrain / runPiHand ports) stays forbidden.
  { re: /@earendil-works\/pi-coding-agent/, label: "pi-coding-agent" },
];

/** Retired routes must stay tombstoned with HTTP 410 in the same handler block.
 *  Each regex binds the `410` to the route's own `return json(res, 410, …)` so a
 *  resurrected 2xx handler — or a 410 somewhere unrelated — cannot satisfy it. */
const RETIRED_ROUTES = [
  {
    label: "POST /api/generate is not 410",
    re: /url\.pathname === "\/api\/generate"\s*\)\s*\{\s*return json\(res,\s*410\b/,
  },
  {
    label: "POST /api/refine is not 410",
    re: /url\.pathname === "\/api\/refine"\s*\)\s*\{\s*return json\(res,\s*410\b/,
  },
  {
    label: "GET /api/generate-status is not 410",
    re: /url\.pathname === "\/api\/generate-status"\s*\)\s*\{\s*return json\(res,\s*410\b/,
  },
  {
    label: "/api/pi/* prefix is not 410",
    re: /url\.pathname\.startsWith\("\/api\/pi\/"\)\s*\)\s*\{\s*return json\(res,\s*410\b/,
  },
];

const PRODUCTION_PACKAGES = [
  "dsh-slides-host",
  "dsh-slides-bundle",
  "dsh-slides-client",
  "presentation-run",
  "slides-tools",
  "slides-mcp",
  "slides-runtime",
];

/** Production manifests must not depend on the frozen harness or the coding-agent product. */
function productionManifestHits(root) {
  const hits = [];
  for (const pkg of PRODUCTION_PACKAGES) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "packages", pkg, "package.json"), "utf8"));
    for (const [dep, label] of [
      ["@open-slidestudio/agent-harness", "agent-harness"],
      ["@earendil-works/pi-coding-agent", "pi-coding-agent"],
    ]) {
      if (dep in (manifest.dependencies ?? {})) hits.push(`packages/${pkg}/package.json: production dep on ${label}`);
    }
  }
  return hits;
}

export function collectFakePathHits(root) {
  const hits = [];
  const walkFrom = (target, files = []) => {
    const abs = path.join(root, target);
    if (!fs.existsSync(abs)) throw new Error(`missing ${target}`);
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      files.push(abs);
      return files;
    }
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith(".test.ts") || name.endsWith(".test.js")) continue;
      const next = path.join(abs, name);
      if (fs.statSync(next).isDirectory()) walkFrom(path.relative(root, next), files);
      else if (/\.(ts|js|mjs|yml)$/.test(name)) files.push(next);
    }
    return files;
  };

  for (const glob of PRODUCT_GLOBS) {
    for (const file of walkFrom(glob)) {
      const text = fs.readFileSync(file, "utf8");
      for (const rule of FORBIDDEN) {
        if (!rule.re.test(text)) continue;
        const rel = path.relative(root, file);
        hits.push(`${rel}: ${rule.label}`);
      }
    }
  }

  const generate = fs.readFileSync(path.join(root, "apps/native-web/src/server.mjs"), "utf8");
  for (const route of RETIRED_ROUTES) {
    if (!route.re.test(generate)) {
      hits.push(`apps/native-web/src/server.mjs: ${route.label}`);
    }
  }

  const rootManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (rootManifest.scripts?.start !== "npm run dsh:slides") {
    hits.push("package.json: start is not dsh:slides");
  }
  if (/\bagent-harness\b/.test(rootManifest.scripts?.["dsh:profile:init"] ?? "")) {
    hits.push("package.json: dsh:profile:init still builds agent-harness");
  }

  hits.push(...productionManifestHits(root));

  if (fs.existsSync(path.join(root, "packages/dsh-slides-host/src/hands.ts"))) {
    hits.push("packages/dsh-slides-host/src/hands.ts: HandsPort still present");
  }

  const freezeHands = path.join(root, "packages/agent-harness/src/pi-hands.ts");
  const freezeBrain = path.join(root, "packages/agent-harness/src/pi-brain.ts");
  if (!fs.existsSync(freezeHands) || !fs.existsSync(freezeBrain)) {
    hits.push("packages/agent-harness: freeze sources missing");
  } else {
    const hands = fs.readFileSync(freezeHands, "utf8");
    const brain = fs.readFileSync(freezeBrain, "utf8");
    if (!/export async function runPiHand/.test(hands)) {
      hits.push("packages/agent-harness: freeze runPiHand missing");
    }
    if (!/export function createPiBrain/.test(brain)) {
      hits.push("packages/agent-harness: freeze createPiBrain missing");
    }
  }
  return hits;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const hits = collectFakePathHits(ROOT);
  if (hits.length) {
    console.error(JSON.stringify({ ok: false, hits }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, scanned: PRODUCT_GLOBS.length, kernel: "dsh" }, null, 2));
}
