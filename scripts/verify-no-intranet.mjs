#!/usr/bin/env node
/**
 * Public-repo boundary: fail if a tracked or untracked non-ignored file still
 * carries a concrete internal deployment artifact. The generic English word
 * "intranet" is allowed in architecture comments. This scanner is excluded
 * from itself so the patterns below are not a hit.
 *
 * Excluded paths:
 * - scripts/verify-no-intranet.mjs (this file)
 * - scripts/verify-no-intranet.test.mjs (positive fixtures)
 * - binary files (NUL byte or a binary extension)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const INTRANET_EXCLUDED_FILES = new Set([
  "scripts/verify-no-intranet.mjs",
  "scripts/verify-no-intranet.test.mjs",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".icns",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".xlsx",
  ".xls",
  ".pptx",
  ".docx",
  ".mp3",
  ".mp4",
  ".wav",
  ".wasm",
]);

/** Concrete flags, kit paths, endpoints, and leaked addresses. Not the word "intranet". */
export const INTRANET_RULES = [
  { label: "SLIDESTUDIO_INTRANET_COMPAT", re: /SLIDESTUDIO_INTRANET_COMPAT/ },
  { label: "intranet-compat", re: /intranet-compat/ },
  { label: "intranetSemanticPaletteHexes", re: /intranetSemanticPaletteHexes/ },
  { label: "isIntranetCompatEnabled", re: /isIntranetCompatEnabled/ },
  { label: "scripts/service-package", re: /scripts\/service-package/ },
  { label: "scripts/intranet-kit", re: /scripts\/intranet-kit/ },
  { label: "SLIDESTUDIO_ADMIN_OPS_ACCESS", re: /SLIDESTUDIO_ADMIN_OPS_ACCESS/ },
  { label: "/integrations/v1/", re: /\/integrations\/v1\// },
  { label: "55.120.x.x", re: /\b55\.120\.\d+\.\d+\b/ },
];

function normalize(rel) {
  return rel.split(path.sep).join("/");
}

function isBinaryPath(rel) {
  return BINARY_EXTENSIONS.has(path.posix.extname(normalize(rel)).toLowerCase());
}

export function gitTrackedFiles(root = ROOT) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "buffer",
  });
  const seen = new Set();
  const files = [];
  for (const rel of out.toString("utf8").split("\0")) {
    const trimmed = rel.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    if (!fs.existsSync(path.join(root, trimmed))) continue;
    seen.add(trimmed);
    files.push(trimmed);
  }
  return files;
}

export function collectIntranetHits(root, relativeFiles, { excludeSelf = true } = {}) {
  const hits = [];
  for (const rel of relativeFiles) {
    const normalized = normalize(rel);
    if (excludeSelf && INTRANET_EXCLUDED_FILES.has(normalized)) continue;
    if (isBinaryPath(normalized)) continue;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const bytes = fs.readFileSync(abs);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    for (const rule of INTRANET_RULES) {
      if (rule.re.test(text)) hits.push(`${normalized}: ${rule.label}`);
    }
  }
  return hits;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const hits = collectIntranetHits(ROOT, gitTrackedFiles(ROOT));
  if (hits.length) {
    console.error(JSON.stringify({ ok: false, hits }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, intranetArtifacts: false }, null, 2));
}
