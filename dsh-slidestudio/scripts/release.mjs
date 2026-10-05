/** Build the self-contained desktop tgz: the whole SlideStudio runtime inside
 * one installable package, mirroring dsh-personal-entry's release flow. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginDir, "..");
const output = join(pluginDir, ".local", "release");
const manifest = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
if (manifest.name !== "dsh-slidestudio") {
  throw new Error("expected the dsh-slidestudio package");
}

const version = manifest.version ?? "0.1.0";
const RUNTIME_PACKAGES = [
  "pptd-v2",
  "canvas-session",
  "exporter-native",
  "project-store",
  "presentation-run",
  "dsh-slides-host",
];
const BUNDLED_NODE_MODULES = [
  "yaml",
  "zod",
  "fonteditor-core",
  "@xmldom/xmldom",
  "jszip",
  "lie",
  "pako",
  "readable-stream",
  "setimmediate",
  "https",
  "image-size",
  "pptxgenjs",
  ...RUNTIME_PACKAGES.map((p) => `@open-slidestudio/${p}`),
];

// The official local installer records the archive path as a file dependency.
// Keep earlier archives: deleting them can break its next add/remove operation.
// Only this run's temporary stage is removed below.
mkdirSync(output, { recursive: true });
const stage = mkdtempSync(join(output, "stage-"));
const pkg = join(stage, "package");
mkdirSync(pkg, { recursive: true });

const cleanRuntimeFile = src => !src.split(/[\\/]/).some(part =>
  [".git", "node_modules", ".versions", "_agent", ".DS_Store"].includes(part));
const copy = (rel, { filter } = {}) => {
  const from = join(repoRoot, rel);
  if (!existsSync(from)) throw new Error(`missing runtime input: ${rel}`);
  cpSync(from, join(pkg, rel), { recursive: true, filter: src => cleanRuntimeFile(src) && (!filter || filter(src)) });
};

copy("apps/native-web/src", {
  filter: (src) => !src.endsWith(".test.mjs"),
});
copy("apps/native-web/public");
for (const name of RUNTIME_PACKAGES) {
  copy(`packages/${name}/package.json`);
  copy(`packages/${name}/dist`);
}
copy("packages/exporter-native/assets");
copy("packages/pptd-v2/src/data");
copy("packages/agent-harness/reference/openkimi-source-manifest.v1.json");
copy("packages/agent-harness/reference/openkimi-visual-manifest.v1.json");
copy("vendor/open-kimi-ppt/skill-1.2.0");
copy("vendor/open-kimi-ppt/git-pre-wipe");
// Use the separately managed pinned browser runtime; never copy a browser into the plugin.
copy("scripts/lib");
copy("LICENSE");
copy("fixtures/okp-yu7-ppt");
for (const rel of ["lib", "locale", "README.md"]) {
  const from = join(pluginDir, rel);
  if (existsSync(from)) cpSync(from, join(pkg, rel), { recursive: true });
}

writeFileSync(
  join(pkg, "cordis.patch.yml"),
  "- insert:\n    - id: dsh-slidestudio\n      name: dsh-slidestudio\n",
);

// Copy the complete production dependency closure, including transitive packages.
// Resolve from each parent so differing dependency versions cannot be flattened incorrectly.
const bundledVersions = {};
function bundlePackage(name, source, destination, ancestors = new Set()) {
  if (ancestors.has(source)) throw new Error(`cyclic bundled dependency: ${name}`);
  const metadata = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const next = new Set([...ancestors, source]);
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: s => {
      const rel = s.slice(source.length);
      return !rel.split(/[\\/]/).some(part => ["node_modules", ".git", "test", "tests", "src"].includes(part))
        && !s.endsWith(".tsbuildinfo");
    },
  });
  // The geometry interpreter reads this runtime XML beside its compiled code.
  if (name === "@open-slidestudio/pptd-v2") {
    cpSync(join(source, "src/data"), join(destination, "src/data"), { recursive: true });
  }
  const require = createRequire(join(source, "package.json"));
  const children = [];
  for (const [child, range] of Object.entries(metadata.dependencies ?? {})) {
    if (child.startsWith("@deepseek-ai/") || child.startsWith("@open-slidestudio/")) continue;
    const childManifest = require.resolve.paths(`${child}/package.json`)
      ?.map(base => join(base, child, "package.json"))
      .find(file => existsSync(file));
    if (!childManifest) throw new Error(`missing production dependency: ${child} from ${name}`);
    bundlePackage(child, dirname(childManifest), join(destination, "node_modules", child), next);
    children.push(child);
  }
  metadata.bundleDependencies = children;
  delete metadata.devDependencies;
  delete metadata.scripts;
  writeFileSync(join(destination, "package.json"), JSON.stringify(metadata, null, 2) + "\n");
  return metadata.version;
}
for (const name of BUNDLED_NODE_MODULES) {
  const source = name.startsWith("@open-slidestudio/")
    ? join(repoRoot, "packages", name.split("/")[1])
    : join(repoRoot, "node_modules", name);
  if (!existsSync(source)) throw new Error(`missing dependency: ${name}`);
  bundledVersions[name] = bundlePackage(name, source, join(pkg, "node_modules", name));
}

const published = {
  ...manifest,
  private: false,
  publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
  dependencies: bundledVersions,
  files: [
    "lib",
    "apps",
    "packages",
    "vendor",
    "scripts/lib",
    "LICENSE",
    "fixtures",
    "cordis.patch.yml",
    "locale",
    "README.md",
  ],
  bundleDependencies: BUNDLED_NODE_MODULES,
  dsh: {
    ...(manifest.dsh ?? {}),
    bundle: { patch: "./cordis.patch.yml" },
  },
};
delete published.scripts;
delete published.devDependencies;
await writeFileSync(join(pkg, "package.json"), JSON.stringify(published, null, 2) + "\n");

mkdirSync(output, { recursive: true });
const packed = JSON.parse(
  execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], {
    cwd: pkg,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }),
)[0];
const bytes = readFileSync(join(output, packed.filename));
writeFileSync(
  join(output, "SHA256SUMS"),
  `${createHash("sha256").update(bytes).digest("hex")}  ${packed.filename}\n`,
);
rmSync(stage, { recursive: true, force: true });
const verification = JSON.parse(execFileSync(process.execPath, [
  join(pluginDir, "scripts/verify-release.mjs"), join(output, packed.filename),
], { encoding: "utf8", maxBuffer: 1024 * 1024 }));
console.log(JSON.stringify({ file: join(output, packed.filename), version, verification }, null, 2));
