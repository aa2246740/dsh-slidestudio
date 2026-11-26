import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { loadProject } from "@open-slidestudio/pptd-v2";
import {
  addTemplateMaterial,
  openRun,
  plan,
  readWholePart,
  runtime,
  syntheticProject,
} from "./authority-run.testkit.js";
import { effectiveCatalogPackId, readDesignAuthority } from "./domain/design-authority.js";
import { recordEditorTurn } from "./domain/editor-turn-authority.js";
import { projectPackColorContext } from "./domain/pack-color-context.js";
import { readRunLedger } from "./domain/run-ledger.js";
import { listSourceReceipts } from "./receipts.js";
import type { PresentationCommand } from "./types.js";

/**
 * A page or element edit lock does not authorize the deck theme or the style authority. The
 * Host restores the deck when a turn changes the theme outside its grant but keeps runtime.json,
 * so commit_design has to refuse such an adoption before it writes anything.
 */
const HUB_PACK = "finance/honey-orange-memo";
const BRAND_ACCENT = "#C8102E";

function adoptBrand(): PresentationCommand {
  return {
    name: "commit_design",
    args: {
      slidePlan: plan(),
      adoptedSourceIds: ["material:brand"],
      designAspects: [{ source: "material:brand", aspects: ["palette", "fonts"] }],
      designAuthority: {
        source: "material:brand",
        origin: { kind: "user-request", text: "按附件品牌的配色和字体做" },
      },
    },
  };
}

function lock(root: string, guard: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(root, "_agent", "ai-review-lock.v1.json"),
    JSON.stringify({ expiresAt: Date.now() + 60_000, pagePath: "pages/cover.page", ...guard }),
  );
  recordEditorTurn(root, { authorizationId: "scope-fixture" });
}

async function project(t: TestContext, id: string) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `restricted-adoption-${id}-`));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const root = syntheticProject(scratch, { designSystemId: HUB_PACK });
  addTemplateMaterial(root);
  const opened = await openRun(root, id, { designSystemId: HUB_PACK });
  readWholePart(root, "brand", "design", opened.epoch);
  return { root, ...opened };
}

const snapshot = (root: string) => ({
  theme: JSON.stringify(loadProject(root).presentation.theme ?? {}),
  runtime: fs.readFileSync(path.join(root, "_agent", "runtime.json"), "utf8"),
  receipts: JSON.stringify(listSourceReceipts(root)),
  todoFacts: readRunLedger(root)!.facts.filter((fact) => fact.type === "todo.committed").length,
});

const ELEMENTS_LOCK = {
  scope: { kind: "elements", pageId: "cover", elementIds: ["title"] },
};
const PAGE_LOCK = { scope: { kind: "page", pageId: "cover" } };
const COMMENT_LOCK = { commentId: "c1", scope: { kind: "page", pageId: "cover" } };
const BATCH_LOCK = {
  scope: { kind: "page", pageId: "cover" },
  items: [{ pagePath: "pages/cover.page", commentId: "c1", scope: { kind: "page", pageId: "cover" } }],
};

describe("commit_design under a page or element edit lock", () => {
  for (const [label, guard] of [
    ["an element lock", ELEMENTS_LOCK],
    ["a page lock", PAGE_LOCK],
    ["a comment lock", COMMENT_LOCK],
    ["a comment batch lock", BATCH_LOCK],
  ] as const) {
    it(`refuses to adopt a theme-changing source under ${label} and writes nothing`, async (t) => {
      const { root, run, ctx } = await project(t, `refuse-${label.replace(/\W+/g, "-")}`);
      const before = snapshot(root);
      lock(root, guard);

      const refused = await run.execute(adoptBrand(), ctx("scope-refused"));
      assert.equal(refused.ok, false, refused.detail);
      assert.equal(refused.payload.error, "review_scope_violation");
      assert.deepEqual(snapshot(root), before, "theme, runtime, receipts and plan are unchanged");
      assert.equal(readDesignAuthority(root).kind, "absent");
      assert.equal(effectiveCatalogPackId(root), HUB_PACK);
      assert.equal(runtime(root).adoptedSourceIds, undefined);
    });
  }

  it("also refuses a style authority switch to a catalog pack that leaves the theme alone", async (t) => {
    const { root, run, ctx } = await project(t, "refuse-catalog");
    const before = snapshot(root);
    lock(root, ELEMENTS_LOCK);
    const refused = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: plan(),
          designAuthority: {
            source: "consulting/pine-green-strategy",
            origin: { kind: "user-request", text: "改用松绿咨询风格" },
          },
        },
      },
      ctx("scope-refused-catalog"),
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.payload.error, "review_scope_violation");
    assert.deepEqual(snapshot(root), before);
  });

  it("lets a plan that changes neither theme nor authority through", async (t) => {
    const { root, run, ctx } = await project(t, "plain-plan");
    lock(root, ELEMENTS_LOCK);
    const plain = await run.execute({ name: "commit_design", args: { slidePlan: plan() } }, ctx("scope-plain"));
    assert.notEqual(plain.payload.error, "review_scope_violation", plain.detail);
  });

  it("keeps working under a deck lock, a rewrite lock and an explicit theme grant", async (t) => {
    for (const [id, guard] of [
      ["deck", { scope: { kind: "deck", targetPageIds: ["cover"] } }],
      ["rewrite", { scope: { kind: "deck", rewrite: true, targetPageIds: ["cover"] } }],
      ["theme", { scope: { kind: "page", pageId: "cover", editableMeta: ["theme"] } }],
    ] as const) {
      const { root, run, ctx } = await project(t, `grant-${id}`);
      const previous = JSON.stringify(loadProject(root).presentation.theme ?? {});
      lock(root, guard);
      const adopted = await run.execute(adoptBrand(), ctx(`scope-grant-${id}`));
      assert.equal(adopted.ok, true, adopted.detail);
      const theme = loadProject(root).presentation.theme;
      assert.notEqual(JSON.stringify(theme ?? {}), previous);
      assert.equal(theme?.colors?.accent1, BRAND_ACCENT);
      assert.equal(readDesignAuthority(root).kind, "valid");
    }
  });

  it("leaves authority and theme in agreement once the restricted turn is over", async (t) => {
    const { root, run, ctx } = await project(t, "after-turn");
    const before = snapshot(root);
    lock(root, ELEMENTS_LOCK);
    const refused = await run.execute(adoptBrand(), ctx("scope-after-1"));
    assert.equal(refused.ok, false);
    assert.equal(projectPackColorContext(root).adoptedPackHexes?.has(BRAND_ACCENT), false);

    fs.rmSync(path.join(root, "_agent", "ai-review-lock.v1.json"));
    recordEditorTurn(root, undefined);
    const adopted = await run.execute(adoptBrand(), ctx("scope-after-2"));
    assert.equal(adopted.ok, true, adopted.detail);
    assert.notEqual(snapshot(root).theme, before.theme);
    const reading = readDesignAuthority(root);
    assert.equal(reading.kind === "valid" && reading.authority.source, "material:brand");
    assert.equal(loadProject(root).presentation.theme?.colors?.accent1, BRAND_ACCENT);
    assert.equal(projectPackColorContext(root).adoptedPackHexes?.has(BRAND_ACCENT), true);
  });
});
