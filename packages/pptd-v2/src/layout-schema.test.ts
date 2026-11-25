import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  LAYOUT_ID_PATTERN,
  MAX_LAYOUT_ELEMENTS,
  MAX_LAYOUTS,
  assertLayoutSchema,
  layoutReferenceIssues,
  layoutSchemaIssues,
  pageOwnershipIssues,
} from "./layout-schema.js";
import { PptdError, createEmptyProject, listComposedPage, loadProject, saveProject } from "./parse.js";
import type { DeckLayout, DeckMaster, Page, PptdElement, Presentation } from "./types.js";

const PAGE_NUMBER: PptdElement = {
  elementId: "pageno",
  elementType: "text",
  bounds: [880, 506, 60, 22],
  layoutRole: "footer",
  content: { text: "{page}", field: "pageNumber", align: ["right", "middle"] },
};
const MAIN: DeckMaster = { id: "main", name: "母版", elements: [PAGE_NUMBER] };
const BODY: DeckLayout = {
  id: "body",
  name: "正文",
  masterId: "main",
  elements: [
    {
      elementId: "header-rule",
      elementType: "line",
      bounds: [0, 56, 960, 2],
      viewBox: [960, 2],
      points: "M0 1 L960 1",
      border: { width: 1.5, color: "#1D4ED8" },
    },
  ],
};

function rect(elementId: string): PptdElement {
  return {
    elementId,
    elementType: "shape",
    shapeName: "rect",
    bounds: [0, 0, 10, 10],
    fill: { type: "solid", color: "#1D4ED8" },
  };
}

function deck(extra: Partial<Presentation> = {}): Presentation {
  return { version: "v2", size: [960, 540], pages: [], ...extra };
}

function codes(issues: { code: string }[]): string[] {
  return issues.map((issue) => issue.code);
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pptd-layout-schema-"));
}

describe("layout schema accepts the documented shapes", () => {
  it("accepts one master with a page-number field and a layout that uses it", () => {
    assert.deepEqual(layoutSchemaIssues(deck({ masters: [MAIN], layouts: [BODY] })), []);
  });

  it("accepts a deck without masters or layouts", () => {
    assert.deepEqual(layoutSchemaIssues(deck()), []);
  });

  it("accepts exactly the limits: twelve layouts of forty elements", () => {
    const layouts: DeckLayout[] = Array.from({ length: MAX_LAYOUTS }, (_, layout) => ({
      id: `l${layout}`,
      name: `版式${layout}`,
      elements: Array.from({ length: MAX_LAYOUT_ELEMENTS }, (_, index) => rect(`e${layout}-${index}`)),
    }));
    assert.deepEqual(layoutSchemaIssues(deck({ layouts })), []);
  });

  it("accepts ids that match the documented pattern and rejects the rest", () => {
    for (const id of ["body", "a", "a-1", "x".repeat(32)]) {
      assert.match(id, LAYOUT_ID_PATTERN, id);
    }
    for (const id of ["Body", "1body", "a_b", "", "a".repeat(33), "-a"]) {
      assert.doesNotMatch(id, LAYOUT_ID_PATTERN, id);
    }
  });
});

describe("layout schema rejects invalid masters and layouts in Chinese", () => {
  it("refuses a second master", () => {
    const issues = layoutSchemaIssues(deck({ masters: [MAIN, { id: "second", name: "第二", elements: [] }] }));
    assert.deepEqual(codes(issues), ["layout_master_singleton"]);
    assert.match(issues[0]!.detail, /本轮只支持一个母版/);
  });

  it("refuses a thirteenth layout", () => {
    const layouts: DeckLayout[] = Array.from({ length: MAX_LAYOUTS + 1 }, (_, index) => ({
      id: `l${index}`,
      name: `版式${index}`,
      elements: [],
    }));
    const issues = layoutSchemaIssues(deck({ layouts }));
    assert.deepEqual(codes(issues), ["layout_limit"]);
    assert.match(issues[0]!.detail, /版式最多 12 个/);
  });

  it("refuses a forty-first element on a layout and on a master", () => {
    const forty = Array.from({ length: MAX_LAYOUT_ELEMENTS + 1 }, (_, index) => rect(`r${index}`));
    const onLayout = layoutSchemaIssues(deck({ layouts: [{ id: "body", name: "正文", elements: forty }] }));
    assert.ok(codes(onLayout).includes("layout_element_limit"));
    const onMaster = layoutSchemaIssues(deck({ masters: [{ id: "main", name: "母版", elements: forty }] }));
    assert.ok(codes(onMaster).includes("layout_element_limit"));
    assert.match(onMaster[0]!.detail, /每个母版或版式最多 40 个元素/);
  });

  const forbidden: [string, PptdElement][] = [
    [
      "a chart",
      {
        elementId: "c",
        elementType: "chart",
        bounds: [0, 0, 10, 10],
        data: { cols: [], rows: [] },
        series: [],
      },
    ],
    [
      "a table",
      {
        elementId: "t",
        elementType: "table",
        bounds: [0, 0, 10, 10],
        columnWidths: [10],
        rows: [],
      },
    ],
    [
      "a SmartArt node",
      {
        elementId: "s",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 10, 10],
        smartArt: { id: "sa-1", layout: "process", role: "node" },
      },
    ],
  ];
  for (const [label, element] of forbidden) {
    it(`refuses ${label} on a layout`, () => {
      const issues = layoutSchemaIssues(deck({ layouts: [{ id: "body", name: "正文", elements: [element] }] }));
      assert.deepEqual(codes(issues), ["layout_element_type"]);
      assert.equal(issues[0]!.detail, "版式里不能放图表、表格或 SmartArt");
    });

    it(`refuses ${label} on a master`, () => {
      const issues = layoutSchemaIssues(deck({ masters: [{ id: "main", name: "母版", elements: [element] }] }));
      assert.deepEqual(codes(issues), ["layout_element_type"]);
      assert.equal(issues[0]!.detail, "版式里不能放图表、表格或 SmartArt");
    });
  }

  it("refuses an animation on a layout", () => {
    const animated = { ...BODY, animations: [{ elementId: "header-rule", effect: "fade-in" }] };
    const issues = layoutSchemaIssues(deck({ masters: [MAIN], layouts: [animated as unknown as DeckLayout] }));
    assert.deepEqual(codes(issues), ["layout_animation"]);
    assert.equal(issues[0]!.detail, "版式和母版不能设置动画");
  });

  it("refuses an animation on a master", () => {
    const animated = { ...MAIN, animations: [{ elementId: "pageno", effect: "fade-in" }] };
    const issues = layoutSchemaIssues(deck({ masters: [animated as unknown as DeckMaster] }));
    assert.deepEqual(codes(issues), ["layout_animation"]);
    assert.equal(issues[0]!.detail, "版式和母版不能设置动画");
  });

  for (const id of ["Body", "1body", "a_b", "", "a".repeat(33)]) {
    it(`refuses the layout id ${JSON.stringify(id)}`, () => {
      const issues = layoutSchemaIssues(deck({ layouts: [{ id, name: "正文", elements: [] }] }));
      assert.deepEqual(codes(issues), ["layout_id"]);
      assert.match(issues[0]!.detail, /版式 id/);
    });
  }

  for (const id of ["Main", "1main", "a_b", "", "a".repeat(33)]) {
    it(`refuses the master id ${JSON.stringify(id)}`, () => {
      const issues = layoutSchemaIssues(deck({ masters: [{ id, name: "母版", elements: [] }] }));
      assert.deepEqual(codes(issues), ["layout_id"]);
      assert.match(issues[0]!.detail, /母版 id/);
    });
  }

  it("refuses a repeated layout id", () => {
    const issues = layoutSchemaIssues(deck({ masters: [MAIN], layouts: [BODY, { ...BODY, name: "又一个" }] }));
    assert.deepEqual(codes(issues), ["layout_id_repeated"]);
    assert.equal(issues[0]!.detail, "版式 id「body」重复");
  });

  it("refuses a repeated element id inside one layout", () => {
    const issues = layoutSchemaIssues(
      deck({ layouts: [{ id: "body", name: "正文", elements: [rect("x"), rect("x")] }] }),
    );
    assert.deepEqual(codes(issues), ["layout_element_id_repeated"]);
  });

  it("refuses a repeated element id inside one master", () => {
    const issues = layoutSchemaIssues(
      deck({ masters: [{ id: "main", name: "母版", elements: [rect("x"), rect("x")] }] }),
    );
    assert.deepEqual(codes(issues), ["layout_element_id_repeated"]);
  });

  const badNames: [string, string][] = [
    ["an empty name", ""],
    ["a blank name", "   "],
    ["a name longer than 24 characters", "长".repeat(25)],
    ["a name with <", "正<文"],
    ["a name with >", "正>文"],
    ["a name with &", "正&文"],
    ["a name with a double quote", '正"文'],
    ["a name with a single quote", "正'文"],
  ];
  for (const [label, name] of badNames) {
    it(`refuses ${label}`, () => {
      const issues = layoutSchemaIssues(deck({ layouts: [{ id: "body", name, elements: [] }] }));
      assert.deepEqual(codes(issues), ["layout_name"]);
      assert.match(issues[0]!.detail, /版式名称/);
    });
    it(`refuses ${label} on a master`, () => {
      const issues = layoutSchemaIssues(deck({ masters: [{ id: "main", name, elements: [] }] }));
      assert.deepEqual(codes(issues), ["layout_name"]);
      assert.match(issues[0]!.detail, /母版名称/);
    });
  }

  it("accepts a 24-character name", () => {
    assert.deepEqual(layoutSchemaIssues(deck({ layouts: [{ id: "body", name: "长".repeat(24), elements: [] }] })), []);
  });

  it("refuses a layout whose master does not exist", () => {
    const issues = layoutSchemaIssues(deck({ masters: [MAIN], layouts: [{ ...BODY, masterId: "nope" }] }));
    assert.deepEqual(codes(issues), ["layout_master_missing"]);
    assert.equal(issues[0]!.detail, "版式「body」引用的母版「nope」不存在");
  });

  it("refuses two different elements whose inherited ids collide", () => {
    const issues = layoutSchemaIssues(
      deck({
        layouts: [
          { id: "a", name: "甲", elements: [rect("b-c")] },
          { id: "a-b", name: "乙", elements: [rect("c")] },
        ],
      }),
    );
    assert.deepEqual(codes(issues), ["inherited_id_collision"]);
    assert.match(issues[0]!.detail, /lyt-a-b-c/);
  });

  it("refuses zero-padded page numbers in a master", () => {
    const padded: PptdElement = {
      ...PAGE_NUMBER,
      content: { text: "{page:02}", field: "pageNumber" },
    };
    const issues = layoutSchemaIssues(deck({ masters: [{ ...MAIN, elements: [padded] }] }));
    assert.deepEqual(codes(issues), ["page_number_padding"]);
    assert.equal(issues[0]!.detail, "PowerPoint 的页码域不能补零");
  });

  it("refuses a zero-padded token in master text even without the field", () => {
    const literal: PptdElement = { ...PAGE_NUMBER, content: { text: "第 {page:02} 页" } };
    const issues = layoutSchemaIssues(deck({ masters: [{ ...MAIN, elements: [literal] }] }));
    assert.deepEqual(codes(issues), ["page_number_padding"]);
    assert.equal(issues[0]!.detail, "PowerPoint 的页码域不能补零");
  });

  it("refuses an unknown text field", () => {
    const odd: PptdElement = {
      ...PAGE_NUMBER,
      content: { text: "x", field: "date" },
    } as PptdElement;
    const issues = layoutSchemaIssues(deck({ masters: [{ ...MAIN, elements: [odd] }] }));
    assert.deepEqual(codes(issues), ["text_field"]);
  });

  it("assertLayoutSchema throws a PptdError carrying the first Chinese reason", () => {
    assert.throws(
      () => assertLayoutSchema(deck({ masters: [MAIN, { id: "second", name: "第二", elements: [] }] })),
      (error) => error instanceof PptdError && /本轮只支持一个母版/.test(error.message),
    );
  });
});

describe("page ownership and layout references", () => {
  const page = (elements: PptdElement[], extra: Partial<Page> = {}): Page => ({
    elements,
    ...extra,
  });

  it("refuses an own element that uses an inherited prefix once the deck has layouts", () => {
    const issues = pageOwnershipIssues(deck({ masters: [MAIN], layouts: [BODY] }), page([rect("lyt-body-logo")]));
    assert.deepEqual(codes(issues), ["reserved_element_id"]);
    assert.match(issues[0]!.detail, /mst-/);
    assert.match(issues[0]!.detail, /lyt-/);
  });

  it("allows the same id in a deck without layouts, so old projects keep their bytes", () => {
    assert.deepEqual(pageOwnershipIssues(deck(), page([rect("lyt-body-logo")])), []);
  });

  it("ignores materialised copies, which carry the inherited marker", () => {
    const copy = {
      ...rect("lyt-body-logo"),
      inherited: { scope: "layout", ownerId: "body", elementId: "logo" },
    } as PptdElement;
    assert.deepEqual(pageOwnershipIssues(deck({ masters: [MAIN], layouts: [BODY] }), page([copy])), []);
  });

  it("refuses a zero-padded page number token in an own text element", () => {
    const padded: PptdElement = {
      elementId: "own-number",
      elementType: "text",
      bounds: [0, 0, 40, 20],
      content: { text: "{pages:02}", field: "pageNumber" },
    };
    assert.deepEqual(codes(pageOwnershipIssues(deck(), page([padded]))), ["page_number_padding"]);
  });

  it("keeps a literal padded token in an older page's text without the field", () => {
    const literal: PptdElement = {
      elementId: "own-literal",
      elementType: "text",
      bounds: [0, 0, 40, 20],
      content: { text: "{page:02}" },
    };
    assert.deepEqual(pageOwnershipIssues(deck(), page([literal])), []);
  });

  it("reports a layoutId that resolves to no layout, in Chinese and without naming a tool", () => {
    const issues = layoutReferenceIssues(deck({ layouts: [BODY] }), page([], { layoutId: "nope" }));
    assert.deepEqual(codes(issues), ["layout_missing"]);
    assert.equal(issues[0]!.detail, "版式 nope 不存在，请先定义该版式或改用已有版式");
    // Review and element turns withhold write_layout while write_page can still arrive.
    assert.doesNotMatch(issues[0]!.detail, /write_layout/);
  });

  it("accepts a layoutId that resolves, and a page without one", () => {
    assert.deepEqual(layoutReferenceIssues(deck({ layouts: [BODY] }), page([], { layoutId: "body" })), []);
    assert.deepEqual(layoutReferenceIssues(deck({ layouts: [BODY] }), page([])), []);
  });
});

describe("schema checks run on load and on save", () => {
  it("saveProject refuses an invalid deck before any file changes", () => {
    const dir = tmpDir();
    const project = createEmptyProject(dir, { title: "版式校验" });
    listComposedPage(project, "pages/01.page", { elements: [rect("title")] });
    saveProject(project);
    const before = {
      manifest: fs.readFileSync(path.join(dir, "deck.pptd"), "utf8"),
      page: fs.readFileSync(path.join(dir, "pages", "01.page"), "utf8"),
    };

    project.presentation.masters = [MAIN, { id: "second", name: "第二", elements: [] }];
    assert.throws(
      () => saveProject(project),
      (error) => error instanceof PptdError && /本轮只支持一个母版/.test(error.message),
    );
    assert.equal(fs.readFileSync(path.join(dir, "deck.pptd"), "utf8"), before.manifest);
    assert.equal(fs.readFileSync(path.join(dir, "pages", "01.page"), "utf8"), before.page);
  });

  it("saveProject refuses an own element with an inherited prefix in a deck with layouts", () => {
    const dir = tmpDir();
    const project = createEmptyProject(dir, { title: "保留前缀" });
    project.presentation.masters = [MAIN];
    project.presentation.layouts = [BODY];
    listComposedPage(project, "pages/01.page", {
      layoutId: "body",
      elements: [rect("mst-main-x")],
    });
    assert.throws(
      () => saveProject(project),
      (error) => error instanceof PptdError && /mst-/.test(error.message),
    );
  });

  it("loadProject refuses a manifest that defines two masters", () => {
    const dir = tmpDir();
    createEmptyProject(dir, { title: "读取校验" });
    const manifest = YAML.stringify({
      version: "v2",
      size: [960, 540],
      pages: [],
      masters: [MAIN, { id: "second", name: "第二", elements: [] }],
    });
    fs.writeFileSync(path.join(dir, "deck.pptd"), manifest);
    assert.throws(
      () => loadProject(dir),
      (error) => error instanceof PptdError && /本轮只支持一个母版/.test(error.message),
    );
  });
});
