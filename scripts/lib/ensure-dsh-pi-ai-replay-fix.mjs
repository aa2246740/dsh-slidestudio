import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const MARKER = 'default: return { type: "text" }';

const PEERS = [
  ["@deepseek-ai/cordis", ["node_modules/@deepseek-ai/cordis"]],
  ["@deepseek-ai/dsh-attachment", ["node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-attachment"]],
  ["@deepseek-ai/dsh-credentials", ["node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-credentials"]],
  ["@deepseek-ai/dsh-fs", ["node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-fs"]],
  ["@deepseek-ai/dsh-settings", ["node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-settings"]],
  ["@deepseek-ai/dsh-timeout", ["node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-timeout"]],
  ["@deepseek-ai/dsh-llm", ["node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm"]],
  [
    "@deepseek-ai/dsh-launch-environment",
    ["node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-launch-environment"],
  ],
  ["@deepseek-ai/dsh-brand", ["node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-brand"]],
  ["@deepseek-ai/dsh-util-values", ["node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-util-values"]],
  [
    "@deepseek-ai/schemastery",
    ["node_modules/@deepseek-ai/schemastery", "node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery"],
  ],
  ["@earendil-works/pi-ai", ["node_modules/@earendil-works/pi-ai"]],
];

function real(p) {
  return fs.realpathSync(p);
}

function linkPeers(root) {
  const nm = path.join(root, "vendor", "dsh-llm-pi-ai", "node_modules");
  fs.mkdirSync(path.join(nm, "@deepseek-ai"), { recursive: true });
  fs.mkdirSync(path.join(nm, "@earendil-works"), { recursive: true });
  for (const [name, candidates] of PEERS) {
    const dest = path.join(nm, name);
    const src = candidates.map((rel) => path.join(root, rel)).find((p) => fs.existsSync(p));
    if (!src) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let existing = null;
    try {
      existing = fs.lstatSync(dest);
    } catch {
      // dest does not exist yet
    }
    // npm nests a real copy here when the root hoists an incompatible major
    // (root pi-ai 1.x for slides-runtime, vendor pin ^0.87.1); keep that copy.
    if (existing && !existing.isSymbolicLink()) continue;
    if (existing) fs.rmSync(dest, { recursive: true, force: true });
    fs.symlinkSync(src, dest, "dir");
  }
}

export function assertDshPiAiReplayPin(root) {
  const vendorLib = path.join(root, "vendor", "dsh-llm-pi-ai", "lib", "index.js");
  if (!fs.existsSync(vendorLib)) {
    throw new Error(`missing durable pin ${vendorLib}`);
  }
  const vendorText = fs.readFileSync(vendorLib, "utf8");
  if (!vendorText.includes(MARKER)) {
    throw new Error(`durable pin lacks replay stub: ${vendorLib}`);
  }
  linkPeers(root);
  const dshBasePkg = [
    path.join(root, "node_modules", "@deepseek-ai", "dsh-base", "package.json"),
    path.join(root, "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-base", "package.json"),
  ].find((candidate) => fs.existsSync(candidate));
  if (!dshBasePkg) {
    throw new Error("isolated Host cannot resolve @deepseek-ai/dsh-base");
  }
  const require = createRequire(dshBasePkg);
  const resolved = require.resolve("@deepseek-ai/dsh-llm-pi-ai");
  const resolvedReal = real(resolved);
  const vendorReal = real(vendorLib);
  if (resolvedReal !== vendorReal) {
    throw new Error(`live dsh-llm-pi-ai is not the vendor pin: resolved ${resolvedReal} vendor ${vendorReal}`);
  }
  return { resolved: resolvedReal, vendor: vendorReal };
}

export function ensureDshPiAiReplayFix(root) {
  return assertDshPiAiReplayPin(root);
}

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const result = assertDshPiAiReplayPin(path.resolve(here, "../.."));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
