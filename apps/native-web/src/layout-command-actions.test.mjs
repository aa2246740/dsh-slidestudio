import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  LAYOUT_COMMANDS,
  LAYOUT_CONTROL_IDS,
  LAYOUT_MUTATING_COMMANDS,
  changedDefinitions,
  layoutCommandAction,
  layoutCommandActions,
  picked,
  recordEditorLayoutRevisions,
  withLayoutPreviews,
} from "./layout-routes.mjs";

// The pieces server.mjs wires into /api/command, against a recording canvas and ledger.
function recordingCanvas() {
  /** @type {unknown[][]} */
  const calls = [];
  const record =
    (/** @type {string} */ name) =>
    (/** @type {unknown[]} */ ...args) => {
      calls.push([name, ...args.slice(1)]);
      return "new-id";
    };
  const canvas = Object.fromEntries(
    [
      "enterMaster",
      "enterLayout",
      "exitLayout",
      "selectLayoutSurface",
      "createLayout",
      "renameLayout",
      "deleteLayout",
      "applyPageLayout",
      "insertPageNumber",
      "renderModel",
      "renderAllPages",
    ].map((name) => [name, record(name)]),
  );
  return { canvas: /** @type {any} */ (canvas), calls };
}

/** @param {Record<string, unknown>} body */
function run(body) {
  const { canvas, calls } = recordingCanvas();
  const action = layoutCommandAction({ canvas }, body, {}, body.cmd);
  assert.ok(action, String(body.cmd));
  action();
  return calls;
}

describe("layout command table", () => {
  it("names each oracle control and passes the request's arguments", () => {
    assert.deepEqual(run({ cmd: "layoutEnter", layoutId: "body", elementId: "logo" }), [
      ["enterLayout", "theme.layout.enter", "body", "logo"],
    ]);
    assert.deepEqual(run({ cmd: "layoutEnter", scope: "master" }), [["enterMaster", "theme.layout.enter", undefined]]);
    assert.deepEqual(run({ cmd: "layoutSelect", scope: "master" }), [
      ["selectLayoutSurface", "theme.layout.select", { kind: "master" }],
    ]);
    assert.deepEqual(run({ cmd: "layoutApply", layoutId: null }), [["applyPageLayout", "theme.layout.apply", null]]);
    assert.deepEqual(run({ cmd: "layoutDelete", layoutId: "x", confirmed: "yes" }), [
      ["deleteLayout", "theme.layout.delete", "x", false],
    ]);
    assert.deepEqual(run({ cmd: "insertPageNumber" }), [["insertPageNumber", "insert.pagenumber"]]);
    assert.deepEqual(run({ cmd: "layoutCreate", name: "" }), [["createLayout", "theme.layout.create", undefined]]);
  });

  it("refuses a missing layout id or name in Chinese before touching the canvas", () => {
    const { canvas, calls } = recordingCanvas();
    const enter = layoutCommandAction({ canvas }, { layoutId: " " }, {}, "layoutEnter");
    assert.throws(() => enter?.(), { message: "版式编号不能为空" });
    const rename = layoutCommandAction({ canvas }, { layoutId: "body" }, {}, "layoutRename");
    assert.throws(() => rename?.(), { message: "版式名称不能为空" });
    assert.deepEqual(calls, []);
  });

  it("answers nothing for a command that is not a layout command", () => {
    const { canvas } = recordingCanvas();
    for (const cmd of ["setBounds", undefined, 3])
      assert.equal(layoutCommandAction({ canvas }, {}, {}, cmd), undefined);
    assert.deepEqual(
      layoutCommandActions({ canvas }, {}, {}).map(([name]) => name),
      [...LAYOUT_COMMANDS],
    );
    assert.ok(LAYOUT_MUTATING_COMMANDS.every((cmd) => LAYOUT_COMMANDS.includes(cmd)));
    assert.equal(LAYOUT_CONTROL_IDS.length, 8);
  });
});

describe("layout previews and revisions", () => {
  it("keeps a page model unchanged and lists the master then each layout on a layout surface", () => {
    const { canvas } = recordingCanvas();
    const model = { id: "m" };
    assert.equal(withLayoutPreviews(canvas, { surface: { kind: "page" } }, model), model);
    const session = {
      surface: { kind: "layout", layoutId: "a" },
      project: { presentation: { masters: [{ id: "main" }], layouts: [{ id: "a" }, { id: "b" }] } },
    };
    const shown = /** @type {any} */ (withLayoutPreviews(canvas, session, model));
    assert.deepEqual(
      shown.layoutPreviews.map((/** @type {any} */ row) => [row.scope, row.id]),
      [
        ["master", "main"],
        ["layout", "a"],
        ["layout", "b"],
      ],
    );
  });

  it("picks only the hashed fields and reports added or changed definitions", () => {
    assert.deepEqual(picked("master", { id: "m", name: "M", extra: 1, slots: [] }), { id: "m", name: "M" });
    assert.equal(picked("layout", undefined), undefined);
    const before = {
      layouts: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    };
    const after = {
      masters: [{ id: "m", name: "M" }],
      layouts: [
        { id: "a", name: "A", note: 1 },
        { id: "b", name: "B2" },
      ],
    };
    assert.deepEqual(
      changedDefinitions(before, after).map(({ scope, entry }) => `${scope}/${entry.id}`),
      ["master/m", "layout/b"],
    );
  });

  it("records only when the ledger names a context epoch", async () => {
    const recordLayoutRevision = mock.fn();
    const api = (/** @type {any} */ ledger, /** @type {any} */ inspection) => ({
      readRunLedger: () => ledger,
      inspectRunLedger: () => inspection,
      recordLayoutRevision,
      stableSha256: () => "sha",
    });
    const before = { layouts: [{ id: "a", name: "A" }] };
    const after = { layouts: [{ id: "a", name: "B" }] };
    assert.equal(await recordEditorLayoutRevisions("/tmp/x", before, before, api({}, {})), 0);
    assert.equal(await recordEditorLayoutRevisions("/tmp/x", before, after, api(undefined, {})), 0);
    const noEpoch = api({}, { initialized: true });
    assert.equal(await recordEditorLayoutRevisions("/tmp/x", before, after, noEpoch), 0);
    const ready = api({}, { initialized: true, contextEpochId: "e1" });
    assert.equal(await recordEditorLayoutRevisions("/tmp/x", before, after, ready), 1);
    assert.equal(recordLayoutRevision.mock.callCount(), 1);
    assert.deepEqual(recordLayoutRevision.mock.calls[0]?.arguments.slice(1), [
      { commandId: "editor-layout:layout:a", contextEpochId: "e1" },
      { scope: "layout", layoutId: "a", layoutSha256: "sha", source: "editor" },
    ]);
  });
});
