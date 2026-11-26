import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SlideToolArgsError, type SlideToolDefinition } from "./contract.js";
import { acquireProjectLease, releaseProjectLease, WRITER_LEASE_FILE } from "./project-lease.js";
import { createSlideTools } from "./suite.js";
import { contextFor, makeProject, recordingPresentation, runtimeDeps, textPage } from "./testkit.js";
import type { SlideToolRuntimeDeps } from "./tool-kit.js";

function tools(deps: SlideToolRuntimeDeps): Map<string, SlideToolDefinition> {
  return new Map(createSlideTools(deps).map((tool) => [tool.name, tool]));
}

/** A strict stand-in for a host JSON Schema validator: required keys and closed roots only. */
function strictValidator(schema: Record<string, unknown>, value: unknown): string[] {
  const rec = (value ?? {}) as Record<string, unknown>;
  const issues = ((schema.required ?? []) as string[])
    .filter((key) => !(key in rec))
    .map((key) => `"${key}" is required`);
  if (schema.additionalProperties === false) {
    const known = Object.keys((schema.properties ?? {}) as Record<string, unknown>);
    issues.push(
      ...Object.keys(rec)
        .filter((key) => !known.includes(key))
        .map((key) => `"${key}" is not allowed`),
    );
  }
  return issues;
}

const page = textPage("1_cover", [
  { elementId: "title", elementType: "text", bounds: [80, 80, 800, 80], content: { text: "封面" } },
] as never);

test("a mutating tool refuses with lease-conflict and never reaches the domain while another owner writes", async () => {
  const root = makeProject([{ file: "1_cover.page", page }]);
  acquireProjectLease(root, { kind: "hub-run", ownerId: "hub-run:session-9", label: "Hub run" });
  const { presentation, calls } = recordingPresentation();
  const suite = tools(runtimeDeps(presentation, { validateSchema: strictValidator }));
  const before = fs.readFileSync(path.join(root, "pages", "1_cover.page"), "utf8");
  const refused = await suite.get("compose_deck")!.execute({ title: "Deck" }, contextFor(root));
  assert.equal(refused.isError, true);
  assert.equal(refused.data.outcome, "lease-conflict");
  assert.equal(refused.data.painted, false);
  assert.deepEqual(refused.data.holder, {
    kind: "hub-run",
    ownerId: "hub-run:session-9",
    label: "Hub run",
    expiresAt: (refused.data.holder as { expiresAt: string }).expiresAt,
  });
  assert.deepEqual(calls, [], "presentation-run was not called");
  assert.equal(fs.readFileSync(path.join(root, "pages", "1_cover.page"), "utf8"), before);
});

test("read-only tools never need the writer lease", async () => {
  const root = makeProject([{ file: "1_cover.page", page }]);
  acquireProjectLease(root, { kind: "hub-run", ownerId: "hub-run:session-9" });
  const { presentation, calls } = recordingPresentation();
  const suite = tools(runtimeDeps(presentation));
  const ctx = contextFor(root);
  const read = await suite.get("read_page")!.execute({ pageId: "1_cover" }, ctx);
  assert.equal(read.data.id, "1_cover");
  await suite.get("list_materials")!.execute({}, ctx);
  await suite.get("read_material")!.execute({ materialId: "m1", part: "rows" }, ctx);
  await suite.get("query_material")!.execute({ materialId: "m1", measures: [{ op: "count", as: "n" }] }, ctx);
  await suite.get("list_references")!.execute({}, ctx);
  assert.deepEqual(
    calls.map((call) => call.name),
    ["list_materials", "read_material", "query_material", "list_references"],
  );
  assert.deepEqual(calls[2]!.args, { materialId: "m1", measures: [{ op: "count", as: "n" }] });
});

test("editor-human preemption makes the next MCP write fail closed with lease-preempted-by-editor", async () => {
  const root = makeProject([{ file: "1_cover.page", page }]);
  const { presentation, calls } = recordingPresentation();
  const suite = tools(runtimeDeps(presentation));
  const mcp = contextFor(root, { kind: "mcp", id: "mcp:client-a", label: "Desktop" });
  const first = await suite.get("review_pages")!.execute({}, mcp);
  assert.equal(first.isError, undefined);
  acquireProjectLease(root, { kind: "editor-human", ownerId: "editor-human:tab-1", label: "Editor" });
  const blocked = await suite.get("review_pages")!.execute({}, { ...mcp, callId: "after-preempt" });
  assert.equal(blocked.data.outcome, "lease-preempted-by-editor");
  assert.equal(calls.length, 1, "only the pre-preemption call reached the domain");
  releaseProjectLease(root, "editor-human:tab-1");
  const stillBlocked = await suite.get("review_pages")!.execute({}, { ...mcp, callId: "after-release" });
  assert.equal(stillBlocked.data.outcome, "lease-preempted-by-editor", "an explicit re-acquire is required");
  acquireProjectLease(root, { kind: "mcp", ownerId: "mcp:client-a", reacquire: true });
  const resumed = await suite.get("review_pages")!.execute({}, { ...mcp, callId: "after-reacquire" });
  assert.equal(resumed.isError, undefined);
  assert.equal(calls.length, 2);
});

test("invalid arguments are rejected before the writer lease or the domain is touched", async () => {
  const root = makeProject([{ file: "1_cover.page", page }]);
  const { presentation, calls } = recordingPresentation();
  const suite = tools(runtimeDeps(presentation, { validateSchema: strictValidator }));
  await assert.rejects(
    suite.get("compose_deck")!.execute({ title: "Deck", extra: true }, contextFor(root)),
    (error: unknown) => error instanceof SlideToolArgsError && /extra/.test(error.message),
  );
  await assert.rejects(
    suite.get("delete_pages")!.execute({}, contextFor(root)),
    (error: unknown) => error instanceof SlideToolArgsError && /pageIds/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(root, WRITER_LEASE_FILE)), false);
  assert.deepEqual(calls, []);
});

test("a mutating call by the lease holder renews the lease and runs", async () => {
  const root = makeProject([{ file: "1_cover.page", page }]);
  const { presentation, calls } = recordingPresentation((command) =>
    command.name === "write_layout" ? { payload: { scope: "master", layoutId: "main" } } : {},
  );
  const suite = tools(runtimeDeps(presentation));
  const ctx = contextFor(root, { kind: "hub-run", id: "hub-run:s1" });
  const out = await suite
    .get("write_layout")!
    .execute({ scope: "master", id: "main", name: "Main", elements: [] }, ctx);
  assert.equal(out.data.ok, true);
  assert.equal(calls[0]?.name, "write_layout");
  const lease = JSON.parse(fs.readFileSync(path.join(root, WRITER_LEASE_FILE), "utf8"));
  assert.equal(lease.holder.ownerId, "hub-run:s1");
});

test("open_in_editor returns the local editor URL without touching the project", async () => {
  const root = makeProject([{ file: "1_cover.page", page }]);
  const { presentation, calls } = recordingPresentation();
  const suite = tools(runtimeDeps(presentation, { editorBaseUrl: "http://127.0.0.1:55200/" }));
  const out = await suite.get("open_in_editor")!.execute({}, { ...contextFor(root), projectId: "decks/月报 1" });
  assert.deepEqual(out.data, {
    ok: true,
    projectId: "decks/月报 1",
    url: `http://127.0.0.1:55200/?project=${encodeURIComponent("decks/月报 1")}`,
  });
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(root, WRITER_LEASE_FILE)), false);
});

test("open_project uses the host project port and writes the slice runtime", async () => {
  const root = makeProject([]);
  const { presentation } = recordingPresentation();
  const suite = tools(
    runtimeDeps(presentation, {
      projects: {
        open: () => ({
          created: true,
          projectId: "slides/demo",
          projectRoot: root,
          displayRoot: "slides/demo",
          design: { kind: "self-directed" },
        }),
      },
    }),
  );
  const out = await suite.get("open_project")!.execute({ title: "  " }, { ...contextFor(root), projectRoot: "" });
  assert.deepEqual(out.data, { outcome: "created", projectRoot: "slides/demo", title: "DSH SlideStudio slice" });
  const runtime = JSON.parse(fs.readFileSync(path.join(root, "_agent", "dsh-runtime.json"), "utf8"));
  assert.equal(runtime.editorBaseUrl, "http://127.0.0.1:55200");
  assert.equal(runtime.strictExecution, true);
  assert.equal(fs.existsSync(path.join(root, "_agent", "runtime.json")), true);
});
