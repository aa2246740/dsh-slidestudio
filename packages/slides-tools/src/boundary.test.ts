import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) ? [file] : [];
  });
}

const sources = sourceFiles(path.join(PACKAGE_ROOT, "src"));
const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as Record<
  string,
  unknown
>;
// Built from parts so this guard file does not match its own pattern.
const HOST_SCOPE = ["@deep", "seek-ai/"].join("");

test("slides-tools has zero host SDK references in src/** and package.json", () => {
  assert.ok(sources.length > 20, "the scan sees the package sources");
  const offenders = sources.filter((file) => fs.readFileSync(file, "utf8").includes(HOST_SCOPE));
  assert.deepEqual(
    offenders.map((file) => path.relative(PACKAGE_ROOT, file)),
    [],
  );
  assert.equal(JSON.stringify(manifest).includes(HOST_SCOPE), false);
});

test("sharp is never a startup import or a declared dependency", () => {
  const staticSharp = /(?:from\s+["']sharp["']|import\(\s*["']sharp["']\s*\)|require\(\s*["']sharp["']\s*\))/;
  const offenders = sources.filter((file) => staticSharp.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(
    offenders.map((file) => path.relative(PACKAGE_ROOT, file)),
    [],
  );
  for (const field of ["dependencies", "peerDependencies", "devDependencies", "bundleDependencies"]) {
    const deps = manifest[field];
    assert.equal(Boolean(deps && typeof deps === "object" && "sharp" in deps), false, `${field} lists sharp`);
  }
});

test("runtime dependencies stay host-neutral and pure JS", () => {
  assert.deepEqual(Object.keys((manifest.dependencies ?? {}) as Record<string, string>).sort(), [
    "@open-slidestudio/pptd-v2",
    "@open-slidestudio/presentation-run",
    "fflate",
  ]);
});
