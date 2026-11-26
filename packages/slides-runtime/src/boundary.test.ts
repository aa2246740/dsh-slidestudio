import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { PACKAGE_ROOT } from "./testkit.js";

const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");

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
const FORBIDDEN = [
  ["@deep", "seek-ai/"].join(""),
  ["pi-coding", "-agent"].join(""),
  ["pi-dur", "able"].join(""),
  ["intranet", "-compat"].join(""),
  ["SLIDESTUDIO_INTRANET", "_COMPAT"].join(""),
  ["55", ".120."].join(""),
];
const NATIVE_CODECS = [["sh", "arp"].join(""), ["@napi-rs/", "canvas"].join("")];

const relative = (files: readonly string[]) => files.map((file) => path.relative(PACKAGE_ROOT, file));

test("slides-runtime has zero host SDK, coding-agent, durable-loop and internal references", () => {
  assert.ok(sources.length >= 15, "the scan sees the package sources");
  for (const needle of FORBIDDEN) {
    const offenders = sources.filter((file) => fs.readFileSync(file, "utf8").includes(needle));
    assert.deepEqual(relative(offenders), [], needle);
    assert.equal(manifestText.includes(needle), false, `package.json mentions ${needle}`);
  }
});

test("no native image codec is imported or declared", () => {
  for (const codec of NATIVE_CODECS) {
    const pattern = new RegExp(`["'\`]${codec.replace(/[/]/g, "\\/")}["'\`/]`);
    const offenders = sources.filter((file) => pattern.test(fs.readFileSync(file, "utf8")));
    assert.deepEqual(relative(offenders), [], codec);
    assert.equal(manifestText.includes(`"${codec}"`), false, `package.json declares ${codec}`);
  }
});

test("dependencies are exactly the pinned pi loop plus core workspace packages; typescript is never declared", () => {
  assert.deepEqual(manifest.dependencies, {
    "@earendil-works/pi-agent-core": "1.6.1",
    "@earendil-works/pi-ai": "1.6.1",
    "@open-slidestudio/pptd-v2": "0.1.0",
    "@open-slidestudio/presentation-run": "0.1.0",
    "@open-slidestudio/slides-tools": "0.1.0",
  });
  assert.deepEqual(manifest.devDependencies, { "@types/node": "^22.10.0" });
});

test("every import resolves to node built-ins, the pinned pi packages, core packages or local modules", () => {
  const allowed =
    /^(?:node:|\.\/|@earendil-works\/pi-(?:agent-core|ai)(?:$|\/)|@open-slidestudio\/(?:pptd-v2|presentation-run|slides-tools)(?:$|\/))/;
  for (const file of sources) {
    const specifiers = [...fs.readFileSync(file, "utf8").matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map(
      (match) => match[1]!,
    );
    const offenders = specifiers.filter((specifier) => !allowed.test(specifier));
    assert.deepEqual(offenders, [], path.relative(PACKAGE_ROOT, file));
  }
});

test("the public-repo intranet scanner finds nothing in this package", async () => {
  const scanner = (await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "verify-no-intranet.mjs")).href)) as {
    collectIntranetHits(root: string, files: readonly string[]): string[];
  };
  const files = [...sources, path.join(PACKAGE_ROOT, "package.json")].map((file) => path.relative(REPO_ROOT, file));
  assert.deepEqual(scanner.collectIntranetHits(REPO_ROOT, files), []);
});
