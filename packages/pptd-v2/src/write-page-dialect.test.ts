import assert from "node:assert/strict";
import test from "node:test";
import { canonicalWritePageIssues, normalizeWritePageDialect } from "./write-page-schema.js";

const element = (elementType: unknown, fields: Record<string, unknown> = {}) => ({
  elementId: "synthetic-1",
  elementType,
  bounds: [0, 0, 100, 40],
  ...fields,
});
const page = (item: unknown) => ({ id: "synthetic-page", elements: [item] });

test("unknown element discriminants list allowed types without exposing unknown values", () => {
  for (const discriminant of ["synthetic-unknown", 12, null, undefined]) {
    const issues = canonicalWritePageIssues(page(element(discriminant)));
    assert.equal(issues.length, 1);
    assert.match(
      issues[0] ?? "",
      /^\$\.elements\[0\]\.elementType must be one of text, shape, image, table, chart, icon, line/,
    );
    assert.ok(!issues.join().includes("synthetic-unknown"));
  }
});

test("shape-name discriminants explain both canonical fields", () => {
  for (const name of ["rect", "ellipse", "rectangle"]) {
    const issues = canonicalWritePageIssues(page(element(name)));
    assert.match(issues.join(), /elementType "shape"/);
    assert.ok(issues.join().includes(`shapeName "${name}"`));
  }
});

test("flat text fields move losslessly to content and report each source and destination", () => {
  const fields: Record<string, unknown> = {
    text: "synthetic",
    align: ["center", "middle"],
    fontSize: 24,
    color: "#123456",
    bold: true,
    backgroundColor: "#FFFFFF",
  };
  for (const [key, value] of Object.entries(fields)) {
    const original = element("text", {
      ...(key === "text" ? {} : { content: { text: "synthetic" } }),
      [key]: value,
    });
    const args = page(original);
    const notes = normalizeWritePageDialect(args);
    assert.deepEqual(
      args,
      page(
        element("text", {
          content: { ...(key === "text" ? {} : { text: "synthetic" }), [key]: value },
        }),
      ),
    );
    assert.deepEqual(notes, [`$.elements[0].${key} -> $.elements[0].content.${key}`]);
    assert.deepEqual(canonicalWritePageIssues(args), []);
    assert.deepEqual(normalizeWritePageDialect(args), []);
  }
});

test("shape and table backgrounds become solid fill without choosing new paint", () => {
  for (const item of [
    element("shape", { shapeName: "rect", backgroundColor: "#123456" }),
    element("table", {
      columnWidths: [100],
      rows: [[{ text: "synthetic", backgroundColor: "#123456" }]],
    }),
  ]) {
    const args = page(item);
    const notes = normalizeWritePageDialect(args);
    const path = item.elementType === "table" ? "$.elements[0].rows[0][0]" : "$.elements[0]";
    assert.deepEqual(notes, [`${path}.backgroundColor -> ${path}.fill`]);
    assert.deepEqual(canonicalWritePageIssues(args), []);
    assert.ok(!JSON.stringify(args).includes("backgroundColor"));
    assert.ok(JSON.stringify(args).includes('"fill":{"type":"solid","color":"#123456"}'));
  }
});

test("element identity and layout fields inside content move to their owner", () => {
  const args = {
    id: "synthetic-page",
    elements: [
      {
        elementType: "text",
        bounds: [0, 0, 100, 40],
        content: { elementId: "synthetic-1", layoutRole: "content", text: "synthetic" },
      },
    ],
  };
  assert.deepEqual(normalizeWritePageDialect(args), [
    "$.elements[0].content.elementId -> $.elements[0].elementId",
    "$.elements[0].content.layoutRole -> $.elements[0].layoutRole",
  ]);
  assert.deepEqual(args.elements[0], {
    elementType: "text",
    bounds: [0, 0, 100, 40],
    elementId: "synthetic-1",
    layoutRole: "content",
    content: { text: "synthetic" },
  });
  assert.deepEqual(canonicalWritePageIssues(args), []);
});

test("ambiguous table-cell fontSize stays put and names its canonical limitation", () => {
  const args = page(
    element("table", {
      columnWidths: [100],
      rows: [[{ text: "synthetic", fontSize: 14 }]],
    }),
  );
  const before = structuredClone(args);
  assert.deepEqual(normalizeWritePageDialect(args), []);
  assert.deepEqual(args, before);
  assert.ok(
    canonicalWritePageIssues(args).some(
      (issue) =>
        issue.includes("$.elements[0].rows[0][0].fontSize") &&
        issue.includes("table cells have no fontSize field") &&
        issue.includes("content.fontSize"),
    ),
  );
});

test("conflicting content element fields stay put and name the owning element path", () => {
  const args = page(
    element("text", {
      content: { text: "synthetic", elementType: "text" },
    }),
  );
  const before = structuredClone(args);
  assert.deepEqual(normalizeWritePageDialect(args), []);
  assert.deepEqual(args, before);
  assert.ok(canonicalWritePageIssues(args).some((issue) => issue.includes("move to $.elements[0].elementType")));
});

test("shape content is rejected with the canonical text-element location", () => {
  const issues = canonicalWritePageIssues(
    page(element("shape", { shapeName: "rect", content: { text: "synthetic" } })),
  );
  assert.ok(issues.some((issue) => issue.includes("content belongs to text elements")));
});

test("shape aliases are not silently accepted as element types", () => {
  for (const name of ["rect", "ellipse", "rectangle"]) {
    const args = page(element(name, { bounds: [0, 0, 100, 40] }));
    const before = structuredClone(args);
    assert.deepEqual(normalizeWritePageDialect(args), []);
    assert.deepEqual(args, before);
    assert.match(
      canonicalWritePageIssues(args).join(),
      /elementType must be one of text, shape, image, table, chart, icon, line/,
    );
  }
});

test("ambiguous destinations remain byte-identical and diagnostics identify the proper path", () => {
  const cases = [
    {
      item: element("text", { fontSize: 24, content: { text: "synthetic", fontSize: 30 } }),
      target: "$.elements[0].content.fontSize",
    },
    {
      item: element("text", { bold: true, content: { text: "synthetic", bold: true } }),
      target: "$.elements[0].content.bold",
    },
    {
      item: element("text", { text: "synthetic", content: null }),
      target: "$.elements[0].content.text",
    },
    {
      item: element("shape", {
        shapeName: "rect",
        backgroundColor: "#123456",
        fill: { type: "solid", color: "#FFFFFF" },
      }),
      target: "$.elements[0].fill",
    },
    {
      item: element("table", {
        columnWidths: [100],
        rows: [[{ backgroundColor: "#123456", fill: null }]],
      }),
      target: "$.elements[0].rows[0][0].fill",
    },
  ];
  for (const { item, target } of cases) {
    const args = page(item);
    const before = JSON.stringify(args);
    assert.deepEqual(normalizeWritePageDialect(args), []);
    assert.equal(JSON.stringify(args), before);
    const issues = canonicalWritePageIssues(args);
    assert.ok(issues.some((issue) => issue.includes(`move to ${target}`)));
    assert.ok(!issues.join().includes("#123456"));
  }
});

test("every text rule preserves occupied destinations and malformed content containers", () => {
  const fields: Record<string, unknown> = {
    align: ["center", "middle"],
    fontSize: 24,
    color: "#123456",
    bold: true,
    text: "synthetic",
    backgroundColor: "#FFFFFF",
  };
  for (const [key, value] of Object.entries(fields)) {
    for (const content of [{ text: "synthetic", [key]: value }, null, [], false, "synthetic"]) {
      const args = page(element("text", { content, [key]: value }));
      const before = structuredClone(args);
      assert.deepEqual(normalizeWritePageDialect(args), []);
      assert.deepEqual(args, before);
      assert.ok(canonicalWritePageIssues(args).some((issue) => issue.includes(`move to $.elements[0].content.${key}`)));
    }
  }
});

test("mixed safe moves retain unrelated fields and nested table-cell coordinates", () => {
  const args = {
    id: "synthetic-page",
    elements: [
      element("text", { text: "synthetic", bold: false, opacity: 0, layoutRole: "content" }),
      element("table", {
        elementId: "synthetic-table",
        columnWidths: [100, 100],
        rows: [[{ text: "synthetic" }, { backgroundColor: "#FFFFFF" }]],
      }),
    ],
  };
  assert.deepEqual(normalizeWritePageDialect(args), [
    "$.elements[0].bold -> $.elements[0].content.bold",
    "$.elements[0].text -> $.elements[0].content.text",
    "$.elements[1].rows[0][1].backgroundColor -> $.elements[1].rows[0][1].fill",
  ]);
  assert.deepEqual(
    args.elements[0],
    element("text", {
      content: { text: "synthetic", bold: false },
      opacity: 0,
      layoutRole: "content",
    }),
  );
  assert.deepEqual(canonicalWritePageIssues(args), []);
});

test("unknown keys, nonempty shape content and conflicting shape names are never discarded", () => {
  for (const item of [
    element("shape", { shapeName: "rect", content: { text: "synthetic" } }),
    element("rect", { shapeName: "ellipse" }),
    element("text", { content: { text: "synthetic", textElision: true } }),
    element("synthetic-unknown", { backgroundColor: "#123456" }),
    "synthetic-placeholder",
  ]) {
    const args = page(item);
    const before = JSON.stringify(args);
    assert.deepEqual(normalizeWritePageDialect(args), []);
    assert.equal(JSON.stringify(args), before);
    assert.ok(canonicalWritePageIssues(args).length > 0);
  }
});

test("moved values are still validated, and XML unwrapping reports its own path", () => {
  const args = page(element("text", { text: 12, fontSize: { $text: "synthetic-invalid" } }));
  const notes = normalizeWritePageDialect(args);
  assert.deepEqual(notes, [
    "$.elements[0].fontSize.$text -> $.elements[0].fontSize",
    "$.elements[0].fontSize -> $.elements[0].content.fontSize",
    "$.elements[0].text -> $.elements[0].content.text",
  ]);
  assert.deepEqual(canonicalWritePageIssues(args), [
    "$.elements[0].content.text must be a string (received number)",
    "$.elements[0].content.fontSize must be a finite JSON number (received string)",
  ]);
});
