import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { listCanonicalSlideTools } from "@open-slidestudio/slides-tools";
import { CliUsageError, parseCliArgs } from "./config.js";
import { resolveImportPath } from "./import-material.js";
import { prepareImportedMaterial } from "./material-derivative.js";
import { resolveExistingProject } from "./project-port.js";
import { validateJsonSchema } from "./schema-validator.js";
import { jpegBytes, pngBytes, tempDir } from "./testkit.js";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "count"],
  properties: {
    name: { type: "string", enum: ["a", "b"] },
    count: { type: "integer" },
    ratio: { type: "number" },
    flag: { type: "boolean" },
    kind: { const: "fixed" },
    list: { type: "array", items: { type: "object", required: ["x"], properties: { x: { type: "number" } } } },
    either: { oneOf: [{ type: "string" }, { type: "integer" }] },
    free: { type: "object", additionalProperties: true },
  },
};

test("the validator covers type/integer/required/properties/additionalProperties/items/enum/const/oneOf", () => {
  assert.deepEqual(validateJsonSchema(SCHEMA, { name: "a", count: 2 }), []);
  assert.deepEqual(validateJsonSchema(SCHEMA, {}), [
    'missing required property "name"',
    'missing required property "count"',
  ]);
  assert.deepEqual(validateJsonSchema(SCHEMA, { name: "c", count: 1.5, extra: 1 }), [
    '"name" must be one of ["a","b"]',
    '"count" must be an integer',
    '"extra" is not a declared property (additionalProperties: false)',
  ]);
  assert.deepEqual(
    validateJsonSchema(SCHEMA, { name: "a", count: 1, ratio: "x", flag: 1, kind: "other", list: [{}, { x: "y" }] }),
    [
      '"ratio" must be a number',
      '"flag" must be a boolean',
      '"kind" must be "fixed"',
      'missing required property "list[0].x"',
      '"list[1].x" must be a number',
    ],
  );
  assert.deepEqual(validateJsonSchema(SCHEMA, { name: "a", count: 1, either: true }), [
    '"either" must match exactly one oneOf branch (matched 0)',
  ]);
  assert.deepEqual(validateJsonSchema(SCHEMA, []), ['"arguments" must be an object']);
  assert.deepEqual(validateJsonSchema(SCHEMA, { name: "a", count: 1, free: { anything: [1] } }), []);
});

test("every canonical schema accepts its own empty-required minimum and rejects unknown fields when closed", () => {
  for (const def of listCanonicalSlideTools()) {
    const schema = def.inputSchema as { required?: string[]; additionalProperties?: unknown };
    const issues = validateJsonSchema(def.inputSchema, {});
    assert.equal(issues.length, (schema.required ?? []).length, `${def.name}: ${issues.join("; ")}`);
    if (schema.additionalProperties === false) {
      assert.ok(validateJsonSchema(def.inputSchema, { zzUnknown: 1 }).some((issue) => issue.includes("zzUnknown")));
    }
  }
});

test("CLI parsing: data root, transports, import roots, images and help", () => {
  assert.equal(parseCliArgs(["--help"], {}), "help");
  assert.throws(() => parseCliArgs([], {}), CliUsageError);
  assert.throws(() => parseCliArgs(["--data-root", "relative"], {}), /absolute/);
  assert.throws(() => parseCliArgs(["--data-root", "/d", "--bogus"], {}), /unknown argument/);
  assert.throws(() => parseCliArgs(["--data-root", "/d", "--allow-import-root", "rel"], {}), /absolute/);
  assert.throws(() => parseCliArgs(["--data-root", "/d", "--transport", "ws"], {}), /stdio or http/);
  const parsed = parseCliArgs(
    ["--data-root=/d", "--transport", "http", "--port", "8765", "--allow-import-root", "/a", "--no-images"],
    { SLIDESTUDIO_MCP_IMPORT_ROOTS: ["/b", "/a"].join(path.delimiter), SLIDESTUDIO_MCP_AUTH_TOKEN: " t " },
  );
  assert.ok(parsed !== "help");
  assert.equal(parsed.transport, "http");
  assert.equal(parsed.port, 8765);
  assert.deepEqual(parsed.allowedImportRoots, ["/a", "/b"]);
  assert.equal(parsed.acceptsImages, false);
  assert.equal(parsed.authToken, "t");
  const fromEnv = parseCliArgs([], { SLIDESTUDIO_DATA_DIR: "/data" });
  assert.ok(fromEnv !== "help");
  assert.deepEqual(fromEnv.allowedImportRoots, [], "no import root unless configured");
  assert.equal(fromEnv.transport, "stdio");
});

test("import path policy is fail-closed and canonicalizes before checking roots", () => {
  const root = tempDir("policy-root");
  const outside = tempDir("policy-outside");
  fs.writeFileSync(path.join(root, "ok.md"), "# ok\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  fs.writeFileSync(path.join(root, "tool.exe"), "MZ");
  fs.mkdirSync(path.join(root, "folder.md"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  const policy = { allowedImportRoots: [root] };
  assert.equal(resolveImportPath({ allowedImportRoots: [] }, path.join(root, "ok.md")).ok, false);
  const code = (raw: unknown) => {
    const resolved = resolveImportPath(policy, raw);
    return resolved.ok ? "ok" : resolved.error;
  };
  assert.equal(code(path.join(root, "ok.md")), "ok");
  assert.equal(code("ok.md"), "import_path_not_absolute");
  assert.equal(code(`${root}/../${path.basename(outside)}/secret.txt`), "import_path_outside_roots");
  assert.equal(code(path.join(root, "link.txt")), "import_path_outside_roots");
  assert.equal(code(path.join(root, "folder.md")), "import_path_not_file");
  assert.equal(code(path.join(root, "tool.exe")), "unsupported_material_format");
  assert.equal(code(path.join(root, "missing.md")), "import_path_not_found");
  assert.equal(resolveImportPath({ allowedImportRoots: [root] }, path.join(root, "ok.md")).ok, true);
});

test("derivatives follow material-derivative/v1 with measured image sizes and table shape", () => {
  const png = prepareImportedMaterial({ bytes: pngBytes(7, 5), extension: ".png", name: "a.png", ownerId: "mcp:x" });
  assert.equal(png.derivative.schema, "material-derivative/v1");
  assert.deepEqual((png.derivative.image as Record<string, unknown>).width, 7);
  const jpeg = prepareImportedMaterial({
    bytes: jpegBytes(640, 480),
    extension: ".jpg",
    name: "b.jpg",
    ownerId: "mcp:x",
  });
  assert.equal((jpeg.derivative.image as Record<string, unknown>).orientation, "landscape");
  const table = prepareImportedMaterial({
    bytes: Buffer.from("\uFEFFa\tb\n1\t2\n3\t4\n"),
    extension: ".tsv",
    name: "t.tsv",
    ownerId: "mcp:x",
  });
  assert.deepEqual(table.derivative.table, {
    encoding: "UTF-8 BOM",
    delimiter: "\t",
    headerRow: ["a", "b"],
    rowCount: 2,
    colCount: 2,
    rows: [
      ["1", "2"],
      ["3", "4"],
    ],
  });
  assert.throws(
    () => prepareImportedMaterial({ bytes: Buffer.from([0xff, 0xfe]), extension: ".txt", name: "x", ownerId: "o" }),
    /UTF-8/,
  );
  assert.throws(
    () => prepareImportedMaterial({ bytes: Buffer.from("{"), extension: ".json", name: "x", ownerId: "o" }),
    /JSON/,
  );
  assert.throws(
    () => prepareImportedMaterial({ bytes: Buffer.from("nope"), extension: ".png", name: "x", ownerId: "o" }),
    /PNG/,
  );
});

test("bind_project ids are folder names below output/dsh-slices only", () => {
  const dataRoot = tempDir("bind");
  const slices = path.join(dataRoot, "output", "dsh-slices");
  fs.mkdirSync(path.join(slices, "not-pptd"), { recursive: true });
  const outside = tempDir("bind-outside");
  fs.symlinkSync(outside, path.join(slices, "escape"));
  const error = (id: unknown) => {
    const resolved = resolveExistingProject(dataRoot, id);
    return resolved.ok ? "ok" : resolved.error;
  };
  for (const bad of ["../x", "a/b", "..", ".hidden", "", 7, "x".repeat(200)])
    assert.equal(error(bad), "invalid_project_id");
  assert.equal(error("missing"), "project_not_found");
  assert.equal(error("escape"), "project_outside_data_root");
  assert.equal(error("not-pptd"), "invalid_pptd_project");
});
