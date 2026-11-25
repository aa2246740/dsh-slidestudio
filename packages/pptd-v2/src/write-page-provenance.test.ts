import assert from "node:assert/strict";
import test from "node:test";
import { canonicalWritePageIssues, isCanonicalWritePageArgs, writePageJsonSchema } from "./write-page-schema.js";
import { canonicalProvenanceIssues, parseProvenanceDeclaration } from "./write-page-provenance.js";

const validPage = (provenance?: unknown) => ({
  id: "p07",
  pageType: "content",
  elements: [
    {
      elementId: "t1",
      elementType: "text",
      bounds: [80, 80, 800, 60],
      content: { text: "2026年1-9月 达标率 89.64%", fontSize: 24 },
    },
  ],
  ...(provenance === undefined ? {} : { provenance }),
});

test("VAL-PROV-008: a valid provenance declaration passes the canonical write_page schema", () => {
  const args = validPage({
    basis: "material",
    materials: [{ materialId: "m-feb", pages: "1-2" }],
    quoted: [{ value: "89.64%", sourcePage: 1, sourcePeriod: "2026年1-2月" }],
    note: "数字来自资料第 1 页",
  });
  assert.deepEqual(canonicalWritePageIssues(args), []);
  assert.equal(isCanonicalWritePageArgs(args), true);
});

test("VAL-PROV-008: an invalid basis value is rejected with a Chinese schema error", () => {
  assert.deepEqual(canonicalProvenanceIssues({ basis: "copied" }), [
    "$.provenance.basis 必须是 material、mock、mixed、own 之一",
  ]);
  assert.deepEqual(canonicalProvenanceIssues({ basis: 123 }), [
    "$.provenance.basis 必须是 material、mock、mixed、own 之一",
  ]);
  const issues = canonicalWritePageIssues(validPage({ basis: "copied" }));
  assert.deepEqual(issues, ["$.provenance.basis 必须是 material、mock、mixed、own 之一"]);
});

test("VAL-PROV-008: malformed provenance shapes get Chinese schema errors", () => {
  assert.deepEqual(canonicalProvenanceIssues("mock"), ["$.provenance 必须是一个对象"]);
  assert.deepEqual(canonicalProvenanceIssues({ basis: "mock", materials: "m-feb" }), [
    "$.provenance.materials 必须是数组",
  ]);
  assert.deepEqual(canonicalProvenanceIssues({ basis: "mock", quoted: [{ value: "" }] }), [
    "$.provenance.quoted[0].value 必须是非空字符串",
  ]);
  assert.deepEqual(canonicalProvenanceIssues({ basis: "own", note: 3 }), ["$.provenance.note 必须是字符串"]);
  assert.deepEqual(canonicalProvenanceIssues(undefined), []);
  assert.deepEqual(canonicalProvenanceIssues(null), []);
});

test("VAL-PROV-008: provenance participates in the published JSON Schema", () => {
  const schema = writePageJsonSchema() as {
    properties: Record<string, { properties: Record<string, unknown> }>;
  };
  const provenance = schema.properties.provenance;
  assert.ok(provenance, "writePageJsonSchema must publish provenance");
  assert.deepEqual(Object.keys(provenance.properties).sort(), ["basis", "materials", "note", "quoted"]);
});

test("VAL-PROV-008: parseProvenanceDeclaration returns the typed declaration or undefined", () => {
  const declaration = parseProvenanceDeclaration({
    basis: "mixed",
    materials: [{ materialId: "m-feb" }],
    quoted: [{ value: "89.64%", sourcePage: 1 }],
    note: "结构沿用资料，数字为示意",
  });
  assert.deepEqual(declaration, {
    basis: "mixed",
    materials: [{ materialId: "m-feb" }],
    quoted: [{ value: "89.64%", sourcePage: 1 }],
    note: "结构沿用资料，数字为示意",
  });
  assert.equal(parseProvenanceDeclaration(undefined), undefined);
  assert.equal(parseProvenanceDeclaration({ basis: "copied" }), undefined);
});

test("VAL-PROV-008: pages without provenance still validate unchanged", () => {
  assert.deepEqual(canonicalWritePageIssues(validPage()), []);
});
