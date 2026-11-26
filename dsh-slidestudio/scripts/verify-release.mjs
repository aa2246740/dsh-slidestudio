/** Verify the tarball outside the checkout, supplying only official Harness peers. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const archive = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Usage: node scripts/verify-release.mjs <tgz>");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "slides-release-check-"));
try {
  execFileSync("tar", ["-xzf", archive, "-C", temp]);
  const root = fs.realpathSync(path.join(temp, "package"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "dsh-slidestudio");
  assert.equal(manifest.private, false);
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.peerDependenciesMeta["dsh-personal"].optional, true);
  assert.equal(manifest.scripts, undefined, "Consumers must not need install-time builds");
  const patch = fs.readFileSync(path.join(root, "cordis.patch.yml"), "utf8");
  assert.match(patch, /id: dsh-slidestudio\n\s+name: dsh-slidestudio/);
  const client = fs.readFileSync(path.join(root, "lib/client.js"), "utf8");
  assert.match(client, /id: "dsh-slidestudio"/, "Client Loader identity must match the installed package");
  const seen = new Set();
  function check(dir) {
    dir = fs.realpathSync(dir);
    if (seen.has(dir)) return;
    seen.add(dir);
    assert.ok(dir.startsWith(root + path.sep) || dir === root, "Dependency escaped package");
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const require = createRequire(path.join(dir, "package.json"));
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith("@deepseek-ai/")) continue;
      assert.ok(!/^(link|file):/.test(version), `Nonportable dependency ${name}`);
      const file = require.resolve
        .paths(name + "/package.json")
        ?.map((base) => path.join(base, name, "package.json"))
        .find(fs.existsSync);
      assert.ok(file, `Missing production dependency ${name}`);
      check(path.dirname(file));
    }
  }
  check(root);
  assert.ok(!fs.existsSync(path.join(root, ".runtime")), "Browser runtime must remain separately managed");
  fs.mkdirSync(path.join(temp, "node_modules"));
  fs.symlinkSync(
    fs.realpathSync(path.join(repo, "node_modules/@deepseek-ai")),
    path.join(temp, "node_modules/@deepseek-ai"),
  );
  const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
  await load("lib/dsh-slidestudio.js");
  const runtimeMod = await load("node_modules/@open-slidestudio/slides-runtime/dist/index.js");
  assert.equal(
    typeof runtimeMod.createSlidesRuntime,
    "function",
    "Packaged slides-runtime must export createSlidesRuntime",
  );
  assert.equal(typeof runtimeMod.PiAiLlmPort, "function", "Packaged slides-runtime must export PiAiLlmPort");
  for (const forbidden of ["sharp", "@napi-rs/canvas"]) {
    assert.ok(
      !fs.existsSync(path.join(root, "node_modules", forbidden)),
      `Native addon ${forbidden} must not be bundled`,
    );
  }
  const gates = await load("node_modules/@open-slidestudio/dsh-slides-host/dist/produce-gates.js");
  const report = gates.assertHubProduceGatesReady(root);
  assert.equal(report.ok, true);
  const { exportProjectToPptx, validateExportReport } = await load("packages/exporter-native/dist/index.js");
  const exported = await exportProjectToPptx(path.join(root, "fixtures/okp-yu7-ppt"));
  assert.equal(validateExportReport(exported.report).ok, true);
  assert.ok(exported.data.length > 1000);
  const { createEmptyProject, titleOnlyCoverPage } = await load("packages/pptd-v2/dist/index.js");
  for (const location of ["packages/pptd-v2", "node_modules/@open-slidestudio/pptd-v2"]) {
    const { shapeGeometry } = await load(`${location}/dist/index.js`);
    assert.ok(shapeGeometry("roundRect"), "Packaged shape geometry resources must load");
  }
  const icons = createEmptyProject(path.join(temp, "icons"), { title: "Packaged icon fidelity" });
  icons.pages = [
    {
      file: "1.yaml",
      page: {
        ...titleOnlyCoverPage("Icons"),
        elements: [
          { elementId: "arrow", elementType: "icon", iconName: "fas:arrow-right", bounds: [40, 40, 80, 80] },
          { elementId: "box", elementType: "icon", iconName: "fas:box-open", bounds: [140, 40, 80, 80] },
        ],
      },
    },
  ];
  const iconExport = await exportProjectToPptx(icons);
  assert.equal(validateExportReport(iconExport.report).ok, true);
  assert.deepEqual(iconExport.report.degradations, []);
  console.log(
    JSON.stringify({
      ok: true,
      dependencyPackages: seen.size,
      produceGates: report.ok,
      exportedSlides: exported.report.slideCount,
      bytes: exported.data.length,
      editableIcons: 2,
    }),
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
