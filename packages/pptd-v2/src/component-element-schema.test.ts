import assert from "node:assert/strict";
import test from "node:test";
import { isComponentReference, writePageProviderJsonSchema } from "./component-element-schema.js";
import { canonicalWritePageIssues, writePageJsonSchema } from "./write-page-schema.js";
import { writeLayoutJsonSchema } from "./write-layout-schema.js";

const COMPONENT = {
  elementType: "component",
  ref: "material:tpl#cover.deco-1",
  bounds: [560, 220, 320, 240],
};
const TEXT = {
  elementId: "title",
  elementType: "text",
  bounds: [80, 120, 800, 64],
  content: { text: "标题", fontSize: 32 },
};

const mentionsComponentBranch = (node: unknown): boolean => JSON.stringify(node).includes('"component"');

test("a component reference is recognised by its element type only", () => {
  assert.equal(isComponentReference(COMPONENT), true);
  assert.equal(isComponentReference({ ...COMPONENT, ref: undefined }), true);
  for (const other of [TEXT, null, undefined, "component", [], { elementType: "Component" }]) {
    assert.equal(isComponentReference(other), false, JSON.stringify(other));
  }
});

test("the provider write_page schema offers the component branch; the canonical page schema does not", () => {
  const provider = writePageProviderJsonSchema();
  assert.equal(mentionsComponentBranch(provider), true);
  assert.equal(mentionsComponentBranch(writePageJsonSchema()), false);
  assert.deepEqual(
    Object.keys((provider.properties ?? {}) as Record<string, unknown>).sort(),
    Object.keys((writePageJsonSchema().properties ?? {}) as Record<string, unknown>).sort(),
    "every other page field is the canonical one",
  );
  assert.equal(provider.additionalProperties, writePageJsonSchema().additionalProperties);
});

test("the component branch requires a ref and allows only bounds and texts besides it", () => {
  const compiled = writePageProviderJsonSchema() as {
    properties: { elements: { items: unknown } };
  };
  const branches = JSON.stringify(compiled.properties.elements.items);
  assert.match(branches, /"const":"component"/);
  assert.match(branches, /"ref"/);
  assert.match(branches, /"texts"/);
});

test("a component reference may carry the elementId and layoutRole every other element carries", () => {
  type Branch = { properties?: Record<string, unknown>; required?: string[] };
  for (const schema of [writePageProviderJsonSchema(), writeLayoutJsonSchema()]) {
    const found: Branch[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (typeof node !== "object" || node === null) return;
      const branch = node as Branch;
      const type = branch.properties?.elementType as { const?: string } | undefined;
      if (type?.const === "component") found.push(branch);
      Object.values(node).forEach(visit);
    };
    visit(schema);
    assert.equal(found.length, 1, "one component branch");
    const [branch] = found;
    assert.ok(branch!.properties?.elementId, "elementId is allowed (and ignored by the Host)");
    assert.ok(branch!.properties?.layoutRole, "layoutRole is allowed (and ignored by the Host)");
    assert.deepEqual([...(branch!.required ?? [])].sort(), ["elementType", "ref"]);
  }
});

test("each texts entry is the node's text or a list of its paragraphs", () => {
  type Branch = {
    properties?: { elementType?: { const?: string }; texts?: { items?: { oneOf?: unknown[] } } };
  };
  const compiled = writePageProviderJsonSchema() as {
    properties: { elements: { items: { oneOf: Branch[] } } };
  };
  const branch = compiled.properties.elements.items.oneOf.find(
    (entry) => entry.properties?.elementType?.const === "component",
  );
  const entryBranches = branch?.properties?.texts?.items?.oneOf as
    Array<{ type: string; items?: { type: string } }> | undefined;
  assert.ok(entryBranches, "texts entries are a oneOf");
  assert.ok(
    entryBranches.some((entry) => entry.type === "string"),
    "a plain string entry",
  );
  assert.ok(
    entryBranches.some((entry) => entry.type === "array" && entry.items?.type === "string"),
    "or a list of paragraphs",
  );
});

test("a page that still carries an unexpanded component never passes the canonical page contract", () => {
  const page = { id: "page-1", pageType: "content", elements: [TEXT] };
  assert.deepEqual(canonicalWritePageIssues(page), []);
  assert.notDeepEqual(canonicalWritePageIssues({ ...page, elements: [TEXT, COMPONENT] }), []);
});

test("write_layout accepts the same component branch as write_page", () => {
  assert.equal(mentionsComponentBranch(writeLayoutJsonSchema()), true);
});
