import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runPostTurnHooks, SlideToolArgsError, type PostTurnHook } from "./contract.js";
import { SLIDES_DIRECTOR_PERSONA, SLIDES_DIRECTOR_PERSONA_LINES } from "./persona.js";
import { compileParameterSpec, SchemaDslError } from "./schema-dsl.js";
import { listCanonicalSlideTools, toolSchemasSnapshot } from "./suite.js";
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
