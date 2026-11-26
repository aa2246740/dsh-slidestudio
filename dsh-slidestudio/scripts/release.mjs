/** Build the self-contained desktop tgz: the whole SlideStudio runtime inside
 * one installable package, mirroring dsh-personal-entry's release flow. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  "slides-tools",
  "slides-mcp",
  "slides-runtime",
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
  // Pure-JS unzip & PDF extraction used by canonical slide tools and native-web materials; sharp/@napi-rs/canvas stay unbundled.
  "fflate",
  "unpdf",
  // Host-agnostic core agent loop dependencies (hoisted once to keep ESM identity and tarball size clean).
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  ...RUNTIME_PACKAGES.map((p) => `@open-slidestudio/${p}`),
];

const cleanRuntimeFile = (src) =>
  !src.split(/[\\/]/).some((part) => [".git", "node_modules", ".versions", "_agent", ".DS_Store"].includes(part));

export const PUBLISHED_FILES = [
  "lib",
  "apps",
  "packages",
  "vendor",
  "scripts/lib",
  "config",
  "LICENSE",
  "fixtures",
  "cordis.patch.yml",
  "locale",
  "README.md",
];

export function copyPackagedConfig(destinationRoot) {
  const from = join(repoRoot, "config");
  if (!existsSync(from)) throw new Error("missing runtime input: config");
  cpSync(from, join(destinationRoot, "config"), {
    recursive: true,
    filter: (src) => cleanRuntimeFile(src),
  });
}

async function main() {
  // The official local installer records the archive path as a file dependency.
  // Keep earlier archives: deleting them can break its next add/remove operation.
  // Only this run's temporary stage is removed below.
  mkdirSync(output, { recursive: true });
  const stage = mkdtempSync(join(output, "stage-"));
  const pkg = join(stage, "package");
  mkdirSync(pkg, { recursive: true });

  const copy = (rel, { filter } = {}) => {
    const from = join(repoRoot, rel);
    if (!existsSync(from)) throw new Error(`missing runtime input: ${rel}`);
    cpSync(from, join(pkg, rel), {
      recursive: true,
      filter: (src) => cleanRuntimeFile(src) && (!filter || filter(src)),
    });
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
  copyPackagedConfig(pkg);
  copy("LICENSE");
  copy("fixtures/okp-yu7-ppt");
  for (const rel of ["lib", "locale", "README.md"]) {
    const from = join(pluginDir, rel);
    if (existsSync(from)) cpSync(from, join(pkg, rel), { recursive: true });
  }

  writeFileSync(join(pkg, "cordis.patch.yml"), "- insert:\n    - id: dsh-slidestudio\n      name: dsh-slidestudio\n");

  // Copy the complete production dependency closure, including transitive packages.
  // Hoist each unique resolved package once into pkg/node_modules (O(V+E) even for
  // diamond DAGs like @aws-sdk/@smithy), nesting only conflicting versions so
  // every package resolves its exact dependency without exponential duplication.
  const bundledVersions = {};
  const bundledNames = [];
  const hoisted = new Map();
  const rootNodeModules = join(repoRoot, "node_modules");

  function copyPackageFiles(name, source, destination) {
    cpSync(source, destination, {
      recursive: true,
      dereference: true,
      filter: (s) => {
        const rel = s.slice(source.length);
        return (
          !rel.split(/[\\/]/).some((part) => ["node_modules", ".git", "test", "tests", "src"].includes(part)) &&
          !s.endsWith(".tsbuildinfo")
        );
      },
    });
    // The geometry interpreter reads this runtime XML beside its compiled code.
    if (name === "@open-slidestudio/pptd-v2") {
      cpSync(join(source, "src/data"), join(destination, "src/data"), { recursive: true });
    }
  }

  function bundlePackage(name, source, destination, ancestors = new Set(), ancestorOverrides = new Map()) {
    const realSource = realpathSync(source);
    if (ancestors.has(realSource)) throw new Error(`cyclic bundled dependency: ${name}`);
    const metadata = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    const nextAncestors = new Set([...ancestors, realSource]);
    copyPackageFiles(name, source, destination);

    const require = createRequire(join(source, "package.json"));
    const nestedChildren = [];
    const childEntries = [];
    for (const child of Object.keys(metadata.dependencies ?? {})) {
      if (child.startsWith("@deepseek-ai/") || child.startsWith("@open-slidestudio/")) continue;
      const childManifest = require.resolve
        .paths(`${child}/package.json`)
        ?.map((base) => join(base, child, "package.json"))
        .find((file) => existsSync(file));
      if (!childManifest) throw new Error(`missing production dependency: ${child} from ${name}`);
      childEntries.push([child, dirname(childManifest), realpathSync(dirname(childManifest))]);
    }

    // Reserve nested overrides for this level before recursing so grandchildren
    // know whether an ancestor shadows a hoisted top-level version.
    const nextOverrides = new Map(ancestorOverrides);
    const toNested = [];
    const toHoist = [];
    for (const [child, childDir, childReal] of childEntries) {
      const visibleSource = ancestorOverrides.has(child) ? ancestorOverrides.get(child) : hoisted.get(child);
      if (visibleSource === childReal) continue;
      const isRootHoisted =
        childReal === (existsSync(join(rootNodeModules, child)) ? realpathSync(join(rootNodeModules, child)) : null);
      if (!ancestorOverrides.has(child) && !hoisted.has(child) && isRootHoisted) {
        hoisted.set(child, childReal);
        toHoist.push([child, childDir]);
      } else if (!ancestorOverrides.has(child) && !hoisted.has(child)) {
        // Non-root copy with no root conflict yet: nest under parent if a root
        // copy of the same package exists in the repo, otherwise hoist safely.
        if (existsSync(join(rootNodeModules, child, "package.json"))) {
          nextOverrides.set(child, childReal);
          toNested.push([child, childDir]);
        } else {
          hoisted.set(child, childReal);
          toHoist.push([child, childDir]);
        }
      } else {
        nextOverrides.set(child, childReal);
        toNested.push([child, childDir]);
      }
    }

    for (const [child, childDir] of toHoist) {
      const childVersion = bundlePackage(child, childDir, join(pkg, "node_modules", child), nextAncestors, new Map());
      bundledVersions[child] = childVersion;
      bundledNames.push(child);
    }
    for (const [child, childDir] of toNested) {
      bundlePackage(child, childDir, join(destination, "node_modules", child), nextAncestors, nextOverrides);
      nestedChildren.push(child);
    }

    metadata.bundleDependencies = nestedChildren;
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
    hoisted.set(name, realpathSync(source));
  }
  for (const name of BUNDLED_NODE_MODULES) {
    const source = name.startsWith("@open-slidestudio/")
      ? join(repoRoot, "packages", name.split("/")[1])
      : join(repoRoot, "node_modules", name);
    bundledVersions[name] = bundlePackage(name, source, join(pkg, "node_modules", name));
    bundledNames.push(name);
  }

  const published = {
    ...manifest,
    private: false,
    publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
    dependencies: bundledVersions,
    files: PUBLISHED_FILES,
    bundleDependencies: bundledNames,
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
  const verification = JSON.parse(
    execFileSync(process.execPath, [join(pluginDir, "scripts/verify-release.mjs"), join(output, packed.filename)], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }),
  );
  console.log(JSON.stringify({ file: join(output, packed.filename), version, verification }, null, 2));
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) await main();
