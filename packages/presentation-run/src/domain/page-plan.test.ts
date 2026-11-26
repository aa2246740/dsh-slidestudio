import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCanonicalPagePlan } from "./page-plan.js";

const page = {
  pageId: "pages/01_cover.page",
  title: "One idea",
  layoutFamily: "content",
  exhibits: [] as string[],
};

test("a complete single-page plan preserves its metadata and canonical identity", () => {
  const before = JSON.stringify(page);
  const plan = parseCanonicalPagePlan([page]);
  assert.deepEqual(plan, [{ ...page, pageId: "1_cover" }]);
  assert.equal(JSON.stringify(page), before);
});

test("absent and ID-only metadata is never synthesized into a complete plan", () => {
  for (const value of [
    undefined,
    [],
    [{ pageId: "1_cover" }],
    [{ ...page, title: "" }],
    [{ ...page, layoutFamily: undefined }],
    [{ ...page, exhibits: undefined }],
  ]) {
    assert.throws(() => parseCanonicalPagePlan(value));
  }
});

test("two raw IDs cannot silently collapse into one planned page", () => {
  assert.throws(() => parseCanonicalPagePlan([page, { ...page, pageId: "1_cover" }]), /duplicate canonical/);
});

test("exhibits are validated rather than guessed, coerced or silently filtered", () => {
  for (const exhibits of [["chart"], [42], [{ kind: "photo" }], ["none", "chart:bar"]]) {
    assert.throws(() => parseCanonicalPagePlan([{ ...page, exhibits }]));
  }
  assert.deepEqual(parseCanonicalPagePlan([{ ...page, exhibits: ["table", "photo"] }])[0]?.exhibits, [
    "table",
    "photo",
  ]);
});

test("planned image materials are explicit ids: prefix stripped, de-duplicated, never inferred", () => {
  const [planned] = parseCanonicalPagePlan([{ ...page, materials: ["img-a", " material:img-b ", "img-a"] }]);
  assert.deepEqual(planned?.materials, ["img-a", "img-b"]);
  const [plain] = parseCanonicalPagePlan([page]);
  assert.equal("materials" in (plain ?? {}), false, "a plan without materials keeps its old shape");
  const [empty] = parseCanonicalPagePlan([{ ...page, materials: [] }]);
  assert.equal("materials" in (empty ?? {}), false, "an empty list is the same as no list");
});

test("materials must be a list of non-empty ids", () => {
  for (const materials of ["img-a", [42], [""], [{ id: "img-a" }], [null]]) {
    assert.throws(
      () => parseCanonicalPagePlan([{ ...page, materials }]),
      /plan\[0\]\.materials/,
      JSON.stringify(materials),
    );
  }
});
