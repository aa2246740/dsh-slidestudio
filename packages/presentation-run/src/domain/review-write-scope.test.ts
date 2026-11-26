import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reviewWriteTargetForPage } from "./review-write-scope.js";

describe("review write scope page-id normalization", () => {
  it("resolves a batch item whose pageId uses file-name casing and leading zeros", () => {
    const guard = {
      expiresAt: Date.now() + 60_000,
      items: [
        { pagePath: "pages/01_Cover.page", scope: { kind: "page", pageId: "01_Cover" } },
        {
          pagePath: "pages/02_tips.page",
          scope: { kind: "elements", pageId: "02_tips", elementIds: ["t"] },
        },
      ],
    };
    const cover = reviewWriteTargetForPage(guard, "1_cover");
    assert.ok(cover);
    assert.equal(cover.pagePath, "pages/01_Cover.page");
    assert.ok(reviewWriteTargetForPage(guard, "2_tips"));
    assert.equal(reviewWriteTargetForPage(guard, "3_end"), undefined);
  });

  it("resolves a non-batch deck scope's targetPageIds the same way", () => {
    const guard = {
      pagePath: "pages/01_Cover.page",
      expiresAt: Date.now() + 60_000,
      scope: { kind: "deck", pageId: "01_Cover", targetPageIds: ["01_Cover", "2_tips"] },
    };
    assert.ok(reviewWriteTargetForPage(guard, "1_cover"));
    assert.ok(reviewWriteTargetForPage(guard, "02_tips"));
    assert.equal(reviewWriteTargetForPage(guard, "3_end"), undefined);
  });
});
