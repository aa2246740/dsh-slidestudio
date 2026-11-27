import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runPostTurnHooks, SlideToolArgsError, type PostTurnHook } from "./contract.js";
import { SLIDES_DIRECTOR_PERSONA, SLIDES_DIRECTOR_PERSONA_LINES } from "./persona.js";
import { compileParameterSpec, SchemaDslError } from "./schema-dsl.js";
import { listCanonicalSlideTools, slideToolSetSchemaBytes, toolSchemasSnapshot } from "./suite.js";
import { applyProduceStagePolicy, applyProjectEditScopes, MATERIAL_SLIDE_TOOL_NAMES } from "./tool-allowlist.js";
import { makeProject, textPage } from "./testkit.js";
import { CANONICAL_SLIDE_TOOL_NAMES, READ_ONLY_SLIDE_TOOL_NAMES } from "./tool-names.js";

const GOLDEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/tool-schemas.v1.json");

test("the canonical suite freezes all 29 tool names in registration order", () => {
  assert.deepEqual(
    listCanonicalSlideTools().map((tool) => tool.name),
    [...CANONICAL_SLIDE_TOOL_NAMES],
  );
  assert.equal(CANONICAL_SLIDE_TOOL_NAMES.length, 29);
  assert.equal(new Set(CANONICAL_SLIDE_TOOL_NAMES).size, 29);
});

test("tool schemas match the golden contract snapshot", () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8")) as Record<string, unknown>;
  assert.deepEqual(toolSchemasSnapshot(), golden);
  assert.deepEqual(Object.keys(golden), [...CANONICAL_SLIDE_TOOL_NAMES]);
});

test("read-only classification matches the published read-only set", () => {
  for (const tool of listCanonicalSlideTools()) {
    assert.equal(tool.readOnly, READ_ONLY_SLIDE_TOOL_NAMES.has(tool.name), tool.name);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} has an object-rooted schema`);
  }
  for (const name of ["write_page", "write_layout", "batch_remove_footers", "commit_design", "export_deck"]) {
    assert.equal(READ_ONLY_SLIDE_TOOL_NAMES.has(name), false, `${name} mutates the project`);
  }
});

test("every definition exposes a pure validator hosts can run before resolving the project", () => {
  const writeTodo = listCanonicalSlideTools().find((tool) => tool.name === "write_todo");
  assert.ok(writeTodo?.validate);
  assert.throws(
    () => writeTodo.validate!({ items: [{ elementType: "component", ref: "material:a#b" }] }),
    (error: unknown) => error instanceof SlideToolArgsError && /不接受模板组件引用/.test(error.message),
  );
});

test("the parameter DSL compiles to standard JSON Schema", () => {
  assert.deepEqual(
    compileParameterSpec({
      title: { type: "string", required: true, description: "Deck title" },
      payload: { type: "json" },
      rows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { id: { type: "integer", required: true }, kind: { type: "string", enum: ["a", "b"] } },
        },
      },
    }),
    {
      type: "object",
      properties: {
        title: { type: "string", description: "Deck title" },
        payload: {},
        rows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { id: { type: "integer" }, kind: { type: "string", enum: ["a", "b"] } },
            required: ["id"],
          },
        },
      },
      required: ["title"],
    },
  );
  assert.throws(() => compileParameterSpec({ open: { type: "object" } }), SchemaDslError);
  assert.throws(() => compileParameterSpec({ bad: { type: "string", minItems: 1 } }), SchemaDslError);
});

test("PostTurnHook seam is empty by default, ordered, and contains hook failures", async () => {
  assert.deepEqual(
    await runPostTurnHooks([], {
      projectId: "p",
      projectRoot: "/tmp/p",
      caller: { kind: "mcp", id: "mcp:x" },
      toolNames: [],
    }),
    [],
  );
  const seen: string[] = [];
  const hooks: PostTurnHook[] = [
    { name: "first", run: async (ctx) => void seen.push(`first:${ctx.toolNames.join(",")}`) },
    {
      name: "broken",
      run: async () => {
        throw new Error("overlay failed");
      },
    },
    { name: "note", run: async () => ({ note: "checked", changed: false }) },
  ];
  const results = await runPostTurnHooks(hooks, {
    projectId: "p",
    projectRoot: "/tmp/p",
    caller: { kind: "hub-run", id: "hub-run:s" },
    toolNames: ["write_page"],
  });
  assert.deepEqual(seen, ["first:write_page"]);
  assert.deepEqual(results, [
    { name: "first", ok: true },
    { name: "broken", ok: false, error: "overlay failed" },
    { name: "note", ok: true, result: { note: "checked", changed: false } },
  ]);
  const aborted = new AbortController();
  aborted.abort();
  const skipped = await runPostTurnHooks(hooks, {
    projectId: "p",
    projectRoot: "/tmp/p",
    caller: { kind: "mcp", id: "mcp:x" },
    toolNames: [],
    signal: aborted.signal,
  });
  assert.deepEqual(skipped, []);
});

test("the director persona is a single host-neutral source", () => {
  assert.equal(SLIDES_DIRECTOR_PERSONA, SLIDES_DIRECTOR_PERSONA_LINES.join("\n"));
  assert.match(SLIDES_DIRECTOR_PERSONA, /^You are the DSH SlideStudio slides director/);
  assert.match(SLIDES_DIRECTOR_PERSONA, /never wrap them in an arguments object/);
});

/** The tools a Hub generation turn offers before stage slimming (no vision, image or editor scopes). */
const PRODUCE_GENERATION_TOOLS = [
  "open_project",
  "inspect_capabilities",
  "list_references",
  "read_reference",
  "list_materials",
  "read_material",
  "query_material",
  "commit_design",
  "write_todo",
  "read_page",
  "batch_remove_footers",
  "delete_pages",
  "write_page",
  "write_layout",
  "render_page",
  "review_pages",
  "compose_deck",
  "export_deck",
];

test("produce stage slimming keeps generation tool schemas inside the context budget", () => {
  const before = slideToolSetSchemaBytes(PRODUCE_GENERATION_TOOLS);
  assert.ok(before > 100_000, `unslimmed produce schemas are ${before} bytes`);
  const withMaterials = applyProduceStagePolicy(new Set(PRODUCE_GENERATION_TOOLS), undefined, { hasAttachments: true });
  const withoutMaterials = applyProduceStagePolicy(new Set(PRODUCE_GENERATION_TOOLS), undefined, {
    hasAttachments: false,
  });
  for (const allowed of [withMaterials, withoutMaterials]) {
    assert.equal(allowed.has("write_layout"), false, "write_layout leaves normal generation");
    assert.equal(allowed.has("patch_page_elements"), true, "patches ride with write_page");
  }
  assert.ok(withMaterials.has("read_material"));
  for (const name of MATERIAL_SLIDE_TOOL_NAMES) assert.equal(withoutMaterials.has(name), false, name);
  const omitted = applyProduceStagePolicy(new Set(PRODUCE_GENERATION_TOOLS), undefined);
  assert.ok(omitted.has("query_material"), "an omitted hasAttachments keeps material tools");
  const withBytes = slideToolSetSchemaBytes(withMaterials);
  const withoutBytes = slideToolSetSchemaBytes(withoutMaterials);
  assert.ok(withBytes <= 72 * 1024, `with materials: ${withBytes} bytes`);
  assert.ok(withoutBytes <= 66 * 1024, `without materials: ${withoutBytes} bytes`);
  assert.ok(before - withoutBytes >= 40_000, `saved ${before - withoutBytes} bytes`);
});

test("layout work keeps write_layout and withholds patches with write_page", () => {
  assert.ok(applyProduceStagePolicy(new Set(["write_layout"]), undefined, { layouts: true }).has("write_layout"));
  const noWrite = applyProduceStagePolicy(new Set(["read_page", "patch_page_elements"]), undefined);
  assert.equal(noWrite.has("patch_page_elements"), false, "no write_page, no patch");
  const optedOut = applyProduceStagePolicy(new Set(["write_page"]), undefined, { patchPageElements: false });
  assert.equal(optedOut.has("patch_page_elements"), false);
  const layout = {
    id: "body",
    name: "正文",
    elements: [{ elementId: "rule", elementType: "line", bounds: [40, 80, 880, 0] }],
  };
  const withLayouts = makeProject(
    [{ file: "2_body.page", page: textPage("2_body", [] as never, { layoutId: "body" }) }],
    [layout] as never,
  );
  assert.ok(applyProduceStagePolicy(new Set(["write_layout"]), withLayouts).has("write_layout"));
  const plain = makeProject([{ file: "2_body.page", page: textPage("2_body", [] as never) }]);
  assert.equal(applyProduceStagePolicy(new Set(["write_layout"]), plain).has("write_layout"), false);
  // Without a produce policy the edit scopes behave exactly as before.
  const legacy = applyProjectEditScopes(new Set(["write_page", "write_layout"]), plain);
  assert.deepEqual([...legacy].sort(), ["write_layout", "write_page"]);
  const staged = applyProjectEditScopes(new Set(["write_page", "write_layout", "read_material"]), plain, {
    hasAttachments: false,
  });
  assert.deepEqual([...staged].sort(), ["patch_page_elements", "write_page"]);
});
