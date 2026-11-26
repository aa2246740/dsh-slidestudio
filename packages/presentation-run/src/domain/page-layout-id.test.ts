import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCanonicalPagePlan } from "./page-plan.js";
import { parseSkillPage } from "./skill-pages.js";

const body = {
  elementId: "t1",
  elementType: "text",
  bounds: [80, 120, 800, 60],
  content: { text: "正文", fontSize: 24 },
};

/** Reads the optional field without a type import, so the behaviour assertions run before the type exists. */
const layoutIdOf = (value: unknown): unknown => (value as { layoutId?: unknown } | undefined)?.layoutId;

describe("layoutId on write_page and plan items (write_layout)", () => {
  it("keeps the write_page layoutId on the parsed page", () => {
    const page = parseSkillPage({ id: "p02", layoutId: "body", elements: [body] });
    assert.equal(layoutIdOf(page), "body");
  });

  it("omits the field for a page that names no layout", () => {
    const page = parseSkillPage({ id: "p02", elements: [body] });
    assert.equal(layoutIdOf(page), undefined);
    assert.equal("layoutId" in (page ?? {}), false);
  });

  it("keeps a plan item layoutId next to its layoutFamily", () => {
    const [item] = parseCanonicalPagePlan([
      {
        pageId: "p02",
        title: "正文",
        layoutFamily: "bullets",
        exhibits: [],
        layoutId: " body ",
      },
    ]);
    assert.equal(layoutIdOf(item), "body");
    assert.equal(item?.layoutFamily, "bullets");
  });

  it("refuses a non-text plan layoutId with the field named", () => {
    assert.throws(
      () =>
        parseCanonicalPagePlan([{ pageId: "p02", title: "正文", layoutFamily: "bullets", exhibits: [], layoutId: 3 }]),
      /plan\[0\]\.layoutId must be text/,
    );
  });
});
