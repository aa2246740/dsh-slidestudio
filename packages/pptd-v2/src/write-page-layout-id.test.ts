import assert from "node:assert/strict";
import test from "node:test";
import { canonicalWritePageIssues, isCanonicalWritePageArgs, writePageJsonSchema } from "./write-page-schema.js";

const page = (extra: Record<string, unknown> = {}) => ({
  id: "p02",
  elements: [
    {
      elementId: "t1",
      elementType: "text",
      bounds: [80, 120, 800, 60],
      content: { text: "正文", fontSize: 24 },
    },
  ],
  ...extra,
});

test("write_page accepts an optional layoutId that names a deck layout", () => {
  const args = page({ layoutId: "body" });
  assert.deepEqual(canonicalWritePageIssues(args), []);
  assert.equal(isCanonicalWritePageArgs(args), true);
});

test("write_page layoutId must be a string in the published JSON schema", () => {
  const schema = writePageJsonSchema() as {
    properties: Record<string, { type?: string }>;
  };
  assert.equal(schema.properties.layoutId?.type, "string");
  assert.ok(canonicalWritePageIssues(page({ layoutId: 7 })).some((issue) => /layoutId/.test(issue)));
});
