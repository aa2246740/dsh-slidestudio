import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_FROM_SCRIPT = path.resolve(SCRIPT_DIR, "../..");

export const PRODUCE_GATE_REL_FILES = [
  "packages/presentation-run/dist/produce-gates.js",
  "packages/presentation-run/dist/domain/layout-qa.js",
  "packages/presentation-run/dist/domain/compose-ir.js",
  "packages/presentation-run/dist/domain/theme-pack.js",
  "packages/presentation-run/dist/domain/agent-tools.js",
  "packages/presentation-run/dist/domain/run-ledger.js",
  "packages/presentation-run/dist/capabilities.js",
  "packages/dsh-slides-host/dist/write-page.js",
  "packages/dsh-slides-host/dist/director-brief.js",
  "packages/pptd-v2/dist/parse.js",
  "packages/pptd-v2/dist/theme.js",
  "packages/exporter-native/dist/export-pptd.js",
];

// Packages whose dist must be mirrored into the DSH slides profile. Only
// include what the kernel loads — the native-web sidecar imports workspace
// dist directly, so canvas-session/agent-harness stay out (they are not
// profile deps; listing them leaves profilePackageMetadataStale permanently
// true and dsh-profile-init recursing forever).
const BUILD_PACKAGES = [
  "pptd-v2",
  "project-store",
  "exporter-native",
  "presentation-run",
  "slides-tools",
  "slides-runtime",
  "dsh-slides-host",
  "dsh-slides-client",
  "dsh-slides-bundle",
  "oss-oauth-login",
];

function newestMtime(dir) {
  let max = 0;
  if (!fs.existsSync(dir)) return 0;
  const walk = (current) => {
    const st = fs.statSync(current);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(current)) walk(path.join(current, name));
      return;
    }
    max = Math.max(max, st.mtimeMs);
  };
  walk(dir);
  return max;
}

function ensurePackageBuilt(root, pkg) {
  const src = path.join(root, "packages", pkg, "src");
  const dist = path.join(root, "packages", pkg, "dist");
  const marker = path.join(dist, "index.js");
  if (fs.existsSync(marker) && newestMtime(dist) >= newestMtime(src)) return false;
  execFileSync("npm", ["run", "build", "-w", `@open-slidestudio/${pkg}`], {
    cwd: root,
    stdio: "inherit",
  });
  return true;
}

function profilePackageDir(home, pkg) {
  return path.join(home, "profiles", "slides", "node_modules", "@open-slidestudio", pkg);
}

function workspaceToProfile(home, rel) {
  const parts = rel.split("/");
  const pkg = parts[1];
  const rest = parts.slice(2).join("/");
  return path.join(profilePackageDir(home, pkg), rest);
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Vendored `file:` deps land in the profile under their real package names
// (scoped pi-ai adapter, unscoped oauth plugin). Their package.json must be
// hashed alongside the workspace packages so a pin bump triggers a reinstall —
// otherwise the profile keeps the old peer range and the kernel refuses the
// plugin as incompatible.
const VENDOR_PROFILE_PACKAGES = [
  ["vendor/dsh-llm-pi-ai", "@deepseek-ai/dsh-llm-pi-ai"],
  ["vendor/dsh-oauth-login", "dsh-oauth-login"],
];

export function profilePackageMetadataStale(root, home, packages = BUILD_PACKAGES) {
  for (const pkg of packages) {
    const workspace = path.join(root, "packages", pkg, "package.json");
    const profile = path.join(profilePackageDir(home, pkg), "package.json");
    if (!fs.existsSync(workspace) || !fs.existsSync(profile)) return true;
    if (hashFile(workspace) !== hashFile(profile)) return true;
  }
  for (const [srcRel, installedName] of VENDOR_PROFILE_PACKAGES) {
    const workspace = path.join(root, srcRel, "package.json");
    const profile = path.join(home, "profiles", "slides", "node_modules", ...installedName.split("/"), "package.json");
    if (!fs.existsSync(workspace) || !fs.existsSync(profile)) return true;
    if (hashFile(workspace) !== hashFile(profile)) return true;
  }
  return false;
}

function profileThemeGateStale(home) {
  const themeJs = workspaceToProfile(home, "packages/pptd-v2/dist/theme.js");
  const officialColorJs = workspaceToProfile(home, "packages/pptd-v2/dist/official-color.js");
  if (!fs.existsSync(themeJs)) return true;
  const themeBody = fs.readFileSync(themeJs, "utf8");
  const colorBody = fs.existsSync(officialColorJs) ? fs.readFileSync(officialColorJs, "utf8") : themeBody;
  if (!themeBody.includes("elementFillPaint")) return true;
  if (/if\s*\(\s*!v\.startsWith\(\s*["']#["']\s*\)\s*\)\s*return fallback/.test(colorBody)) return true;
  if (!themeBody.includes("officialPptdColorKind") || !themeBody.includes("InvalidPptdColorError")) return true;
  return !/kind === ["']theme["']/.test(colorBody);
}

export function profileGateFilesStale(root, home) {
  if (profilePackageMetadataStale(root, home)) return true;
  for (const rel of PRODUCE_GATE_REL_FILES) {
    const workspace = path.join(root, rel);
    const profile = workspaceToProfile(home, rel);
    if (!fs.existsSync(workspace) || !fs.existsSync(profile)) return true;
    if (hashFile(workspace) !== hashFile(profile)) return true;
  }
  const qa = workspaceToProfile(home, "packages/presentation-run/dist/domain/layout-qa.js");
  const body = fs.readFileSync(qa, "utf8");
  if (
    !body.includes("pageHasVisibleContent") ||
    !body.includes("isWritePageCloser") ||
    !body.includes("composedPageLeftoverIssues")
  )
    return true;
  const parseJs = workspaceToProfile(home, "packages/pptd-v2/dist/parse.js");
  const parseBody = fs.readFileSync(parseJs, "utf8");
  if (/pages:\s*\[\s*["']pages\/1_cover\.page["']/.test(parseBody)) return true;
  const exportJs = workspaceToProfile(home, "packages/exporter-native/dist/export-pptd.js");
  if (!fs.existsSync(exportJs)) return true;
  const exportBody = fs.readFileSync(exportJs, "utf8");
  if (/if\s*\(\s*!fill\s*\)\s*return\s*\{\s*color:\s*["']FFFFFF["']\s*\}/.test(exportBody)) return true;
  if (!exportBody.includes("elementFillPaint")) return true;
  if (profileThemeGateStale(home)) return true;
  if (/hex\(\s*st\.color\b/.test(exportBody)) return true;
  if (!exportBody.includes("colorHex")) return true;
  return false;
}

function copyPackageDist(root, home, pkg) {
  const src = path.join(root, "packages", pkg, "dist");
  const dest = path.join(profilePackageDir(home, pkg), "dist");
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function copySlidesPresetYaml(root, home) {
  const src = path.join(root, "packages", "dsh-slides-bundle", "presets", "slides");
  const dest = path.join(home, ".agent-presets", "slides");
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ["agent.cordis.yml", "preset.yml"]) {
    const from = path.join(src, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, name));
  }
}

function stripNativeWebForbidInSlidesHome(home) {
  const files = [
    path.join(home, "profiles", "slides", "cordis.patch.yml"),
    path.join(home, ".agent-presets", "slides", "agent.cordis.yml"),
  ];
  const forbid = /Do not call web_search or web_fetch[^.]*\.?/g;
  const route = /those DSH tools are not available on this route\.?/g;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, "utf8");
    const after = before.replace(forbid, "").replace(route, "");
    if (after !== before) fs.writeFileSync(file, after);
  }
}

function runProfileNpmInstall(root, home) {
  if (process.env.OSS_PROFILE_INIT_ACTIVE === "1") {
    // dsh-profile-init already ran npm install inside this call stack and the
    // metadata is still stale — that is a real divergence, not a reason to
    // recursively spawn init forever.
    throw new Error(
      "slides profile package metadata still stale after profile init — refusing to recurse into dsh-profile-init again",
    );
  }
  const init = path.join(root, "scripts", "dsh-profile-init.mjs");
  execFileSync(process.execPath, [init], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DSH_HOME: home, OSS_PROFILE_INIT_ACTIVE: "1" },
  });
}

/**
 * Build workspace dist if needed, then copy it into the DSH slides profile.
 * `--install-links` copies packages; this recopy is what stops Hub serving a frozen 02:44 dist.
 */
export function ensureSlidesProfileCurrent(root = ROOT_FROM_SCRIPT, home) {
  const dshHome = home || process.env.DSH_HOME || path.join(root, ".dsh", "home");
  for (const pkg of BUILD_PACKAGES) ensurePackageBuilt(root, pkg);
  if (profilePackageMetadataStale(root, dshHome)) {
    runProfileNpmInstall(root, dshHome);
  }
  for (const pkg of BUILD_PACKAGES) copyPackageDist(root, dshHome, pkg);
  copySlidesPresetYaml(root, dshHome);
  stripNativeWebForbidInSlidesHome(dshHome);
  if (profileGateFilesStale(root, dshHome)) {
    throw new Error(
      "slides profile dist is still missing pageHasVisibleContent after sync. Hub generate refused. Did not fall back to Gemini.",
    );
  }
  return { home: dshHome, stale: false };
}
