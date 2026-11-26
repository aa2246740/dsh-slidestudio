import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { deliveryComponents, withComponentRefs } from "./delivery-components.js";
import type { DeliveryLayout } from "./delivery-layouts.js";
import { recordLayoutRevision } from "./layout-ledger.js";
import { recordTemplateComponentUsed } from "./template-component-ledger.js";
import { ensureRunLedger, readRunLedger, recordPageRevision } from "./run-ledger.js";

const context = { commandId: "delivery-components", contextEpochId: "components-epoch" };
const KIT = "k".repeat(64);
const ARC = "material:tpl#cover.arc-1";
const HEADER = "material:tpl#body.header";
const LOGO = "material:tpl#body.logo-1";

function ledgerProject(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-components-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  ensureRunLedger(root, {
    manifestSha256: "d".repeat(64),
    requirementsId: "components",
    requirements: [],
  });
  return root;
}

/** Commits a page whose body differs per `variant`, so each call after the first is a new revision. */
function commitPage(root: string, pageId: string, variant = "v1"): number {
  const page = {
    id: pageId,
    elements: [
      {
        elementId: "t",
        elementType: "text",
        bounds: [0, 0, 100, 40],
        content: { text: variant, fontSize: 20 },
      },
    ],
  };
  return recordPageRevision(root, context, pageId, page).revision;
}

function usePage(root: string, ref: string, pageId: string, revision: number): void {
  recordTemplateComponentUsed(root, {
    contextEpochId: context.contextEpochId,
    ref,
    kitSha256: KIT,
    pageId,
    revision,
  });
}

function commitLayout(root: string, layoutId: string, layoutSha256: string): number {
  return recordLayoutRevision(root, context, {
    scope: "layout",
    layoutId,
    layoutSha256,
    source: "agent",
  }).revision;
}

function useLayout(root: string, ref: string, layoutId: string, revision?: number): void {
  recordTemplateComponentUsed(root, {
    contextEpochId: context.contextEpochId,
    ref,
    kitSha256: KIT,
    layoutId,
    ...(revision === undefined ? {} : { revision }),
  });
}

const build = (root: string, pageIds: readonly string[], layoutIds: readonly string[] = []) =>
  deliveryComponents(readRunLedger(root)!, pageIds, layoutIds);

test("VAL-KIT-008: components list each referenced ref with its pages in deck order, from facts only", (t) => {
  const root = ledgerProject(t);
  for (const pageId of ["1_cover", "2_body", "3_body"]) commitPage(root, pageId);
  usePage(root, HEADER, "3_body", 1);
  usePage(root, ARC, "1_cover", 1);
  usePage(root, HEADER, "2_body", 1);
  assert.deepEqual(build(root, ["1_cover", "2_body", "3_body"]), [
    { ref: ARC, pages: ["1_cover"] },
    { ref: HEADER, pages: ["2_body", "3_body"] },
  ]);
});

test("VAL-KIT-008: a rewritten page keeps only the components its current revision referenced", (t) => {
  const root = ledgerProject(t);
  assert.equal(commitPage(root, "1_cover", "v1"), 1);
  usePage(root, ARC, "1_cover", 1);
  assert.equal(commitPage(root, "1_cover", "v2"), 2);
  assert.deepEqual(build(root, ["1_cover"]), []);
  usePage(root, ARC, "1_cover", 2);
  assert.deepEqual(build(root, ["1_cover"]), [{ ref: ARC, pages: ["1_cover"] }]);
});

test("VAL-KIT-008: a page that is not in the sealed deck is not listed", (t) => {
  const root = ledgerProject(t);
  commitPage(root, "9_draft");
  usePage(root, ARC, "9_draft", 1);
  assert.deepEqual(build(root, ["1_cover"]), []);
});

test("VAL-KIT-008: a layout use is bound to the layout's current revision and to a layout some page shows", (t) => {
  const root = ledgerProject(t);
  const first = commitLayout(root, "body", "a".repeat(64));
  useLayout(root, HEADER, "body", first);
  useLayout(root, LOGO, "body", first);
  const other = commitLayout(root, "closing", "b".repeat(64));
  useLayout(root, ARC, "closing", other);
  assert.deepEqual(build(root, [], ["body"]), [
    { ref: HEADER, pages: [], layoutId: "body" },
    { ref: LOGO, pages: [], layoutId: "body" },
  ]);
  // The layout is rewritten without the logo: only the reference made at the new revision counts.
  const second = commitLayout(root, "body", "c".repeat(64));
  assert.equal(second, first + 1);
  useLayout(root, HEADER, "body", second);
  assert.deepEqual(build(root, [], ["body"]), [{ ref: HEADER, pages: [], layoutId: "body" }]);
});

test("VAL-KIT-008: a layout fact without a revision cannot be shown to be current and is not listed", (t) => {
  const root = ledgerProject(t);
  commitLayout(root, "body", "a".repeat(64));
  useLayout(root, HEADER, "body");
  assert.deepEqual(build(root, [], ["body"]), []);
});

test("VAL-KIT-008: a page use and a layout use of the same ref stay separate entries", (t) => {
  const root = ledgerProject(t);
  commitPage(root, "2_body");
  usePage(root, HEADER, "2_body", 1);
  useLayout(root, HEADER, "body", commitLayout(root, "body", "a".repeat(64)));
  assert.deepEqual(build(root, ["2_body"], ["body"]), [
    { ref: HEADER, pages: ["2_body"] },
    { ref: HEADER, pages: [], layoutId: "body" },
  ]);
});

test("VAL-KIT-008: a kit read alone, with no component fact, lists nothing", (t) => {
  const root = ledgerProject(t);
  commitPage(root, "1_cover");
  assert.deepEqual(build(root, ["1_cover"], []), []);
});

test("VAL-KIT-008: withComponentRefs fills each layout's componentRefs from its own entries", () => {
  const layouts: DeliveryLayout[] = [
    { scope: "layout", id: "body", name: "正文", pages: ["2_body"], media: [], componentRefs: [] },
    {
      scope: "layout",
      id: "cover",
      name: "封面",
      pages: ["1_cover"],
      media: [],
      componentRefs: [],
    },
  ];
  const filled = withComponentRefs(layouts, [
    { ref: ARC, pages: ["1_cover"] },
    { ref: HEADER, pages: [], layoutId: "body" },
    { ref: LOGO, pages: [], layoutId: "body" },
  ]);
  assert.deepEqual(
    filled.map((layout) => [layout.id, layout.componentRefs]),
    [
      ["body", [HEADER, LOGO]],
      ["cover", []],
    ],
  );
  assert.deepEqual(layouts[0]!.componentRefs, [], "the input is not mutated");
});
