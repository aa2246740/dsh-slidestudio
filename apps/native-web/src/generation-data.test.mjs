import assert from "node:assert/strict";
import { test } from "node:test";
import { INVALID_REPLY, brief, isRecord, objectFrom, record, records, text } from "../public/generation-data.js";

test("record helpers accept plain objects only and never fabricate fields", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord("x"), false);
  const source = { a: 1 };
  assert.equal(record(source), source, "a record passes through unchanged");
  assert.deepEqual(record([1, 2]), {});
  assert.deepEqual(record(undefined), {});
  assert.deepEqual(records([{ a: 1 }, null, [], "x", { b: 2 }]), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(records("not a list"), []);
});

test("text keeps strings and drops every other value", () => {
  assert.equal(text("标题"), "标题");
  assert.equal(text(42), "");
  assert.equal(text(undefined), "");
});

test("objectFrom parses journal JSON, tolerates an omitted-image suffix and rejects arrays", () => {
  assert.deepEqual(objectFrom('{"page":2}'), { page: 2 });
  assert.deepEqual(objectFrom(' {"page":3} [image content omitted]'), { page: 3 });
  assert.deepEqual(objectFrom({ page: 4 }), { page: 4 });
  assert.deepEqual(objectFrom("[1,2]"), {});
  assert.deepEqual(objectFrom("plain text"), {});
  assert.deepEqual(objectFrom(7), {});
});

test("brief collapses whitespace and clips to the limit", () => {
  assert.equal(brief("a  b\n\tc"), "a b c");
  assert.equal(brief("abcdef", 3), "abc");
  assert.equal(brief(null), "");
  assert.equal(typeof INVALID_REPLY, "string");
  assert.ok(INVALID_REPLY.length > 0);
});
