/**
 * userColors (CAP-18, VAL-DATA-011, VAL-TPL-010/011): colours the user states, declared by the Agent
 * through commit_design/write_todo, are allowed on top of every palette restriction, with the
 * documented tints and shades. The Host never reads a colour from the brief and never rewrites the
 * theme. Every check runs through the registered tools and the four pack_color callers.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import type { PresentationRun } from "../index.js";
import { commitAdoptedDesignSources } from "./design-adoption.js";
import { writeDomainRuntime } from "./domain-hands.js";
import { packColorWriteContext } from "./theme-pack.js";

const PACK = "consulting/pine-green-strategy";
const USER_BLUE = "#1F4E9A";
const REASON = "用户要求主色换成蓝色";
const USER_COLORS = [{ hex: USER_BLUE, reason: REASON }];
/** The documented 20/40/60% white tints and black shades of USER_BLUE, worked out by hand. */
/** One channel off by 14 from USER_BLUE and by more than 8 from every tint and shade of it. */

/** One layout whose only element fills with `fill`, so the colour check is the only input. */

/** Every pack_color caller on one colour: write_page, write_layout, the agent write tool, the ledger. */

describe("userColors never change how restrictive a project is", () => {
  const rootWith = (t: TestContext, runtime: Record<string, unknown>): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "user-colors-restrict-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    createEmptyProject(root, { title: "限制" });
    writeDomainRuntime(root, { brief: "做一份说明。", ...runtime });
    return root;
  };

  it("stays unrestricted when the adopted pack has no palette to widen", (t) => {
    const withColors = rootWith(t, { userColors: USER_COLORS });
    for (const sourceIds of [[], ["consulting/no-such-pack"]]) {
      assert.deepEqual(packColorWriteContext(sourceIds, withColors), {}, sourceIds.join());
    }
  });

  it("keeps a catalog pack's own palette and lifts a colour another pack prints out of the foreign set", (t) => {
    const amber = { hex: "#FDC356", reason: "用户要求强调色用琥珀金" };
    const plain = packColorWriteContext([PACK], rootWith(t, {}));
    assert.equal(plain.otherPackHexes?.has(amber.hex), true, "the colour belongs to another pack");
    assert.equal(plain.adoptedPackHexes?.has(amber.hex), false);
    const context = packColorWriteContext([PACK], rootWith(t, { userColors: [amber] }));
    assert.equal(context.adoptedPackHexes?.has("#03522C"), true, "the pack's own palette stays");
    assert.equal(context.adoptedPackHexes?.has(amber.hex), true);
    assert.equal(context.otherPackHexes?.has(amber.hex) ?? false, false);
  });

  it("is kept when a caller commits without naming user colours, replaced and cleared otherwise", (t) => {
    const root = rootWith(t, {});
    const runtimeFile = path.join(root, "_agent", "runtime.json");
    const saved = (): unknown =>
      (JSON.parse(fs.readFileSync(runtimeFile, "utf8")) as Record<string, unknown>).userColors;
    commitAdoptedDesignSources(root, [], "first", [], USER_COLORS);
    assert.deepEqual(saved(), USER_COLORS);
    commitAdoptedDesignSources(root, [], "omitted", []);
    assert.deepEqual(saved(), USER_COLORS, "a caller that does not name them keeps the saved list");
    const orange = [{ hex: "#AA5500", reason: "强调色" }];
    commitAdoptedDesignSources(root, [], "replaced", [], orange);
    assert.deepEqual(saved(), orange);
    commitAdoptedDesignSources(root, [], "cleared", [], []);
    assert.equal(saved(), undefined);
  });
});
