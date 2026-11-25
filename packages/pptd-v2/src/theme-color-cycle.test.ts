import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { colorRefusal } from "./color-refusal.js";
import { InvalidPptdColorError, resolveThemeColor, toRgbHex } from "./theme.js";

/*
 * A theme colour reference cycle (`$a -> $b -> $a`) is unresolvable. Decks saved before the
 * write refusal (M5-SCR-005) can hold one. resolveThemeColor used to recurse without a bound, so
 * the export saw a RangeError instead of the InvalidPptdColorError an unknown token raises.
 */
const cyclic = {
  colors: { a: "$b", b: "$a", self: "$self", ok: "#112233", chain: "$ok" },
};

describe("theme colour reference cycles", () => {
  it("returns a cycle unchanged, so the cyclic value stays unresolvable", () => {
    assert.equal(resolveThemeColor("$a", cyclic, ""), "$a");
    assert.equal(resolveThemeColor("$b", cyclic, ""), "$b");
    assert.equal(resolveThemeColor("$self", cyclic, ""), "$self");
  });

  it("refuses a cycle with InvalidPptdColorError, never a RangeError", () => {
    for (const value of ["$a", "$b", "$self"]) {
      assert.throws(
        () => toRgbHex(value, cyclic),
        (error: unknown) => error instanceof InvalidPptdColorError,
        value,
      );
    }
  });

  it("treats a token that names an Object.prototype member as an unknown token", () => {
    const named = { colors: { ok: "#112233" } };
    for (const value of ["$constructor", "$toString", "$__proto__"]) {
      assert.equal(resolveThemeColor(value, named, ""), value, value);
      assert.throws(
        () => toRgbHex(value, named),
        (error: unknown) => error instanceof InvalidPptdColorError,
        value,
      );
    }
  });

  it("still resolves a chain that ends in a literal colour", () => {
    assert.equal(resolveThemeColor("$chain", cyclic, ""), "#112233");
    assert.equal(toRgbHex("$chain", cyclic), "#112233");
  });

  it("names the cycle in the write refusal", () => {
    assert.match(colorRefusal("$a", cyclic) ?? "", /循环/);
    assert.match(colorRefusal("$self", cyclic) ?? "", /循环/);
  });
});
