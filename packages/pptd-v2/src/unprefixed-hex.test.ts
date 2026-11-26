import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InvalidPptdColorError, elementFillPaint, officialPptdColorKind, toCssColor, toRgbHex } from "./theme.js";

describe("EDITH unprefixed hex inversion", () => {
  it("official PPTD Color lists #RRGGBB not RRGGBB; 0E0807 and E8DED7 never become 000000", () => {
    assert.equal(officialPptdColorKind("0E0807"), "unprefixed");
    assert.equal(officialPptdColorKind("E8DED7"), "unprefixed");
    assert.equal(officialPptdColorKind("#0E0807"), "hash");
    assert.equal(officialPptdColorKind("#E8DED7"), "hash");
    assert.equal(toRgbHex("#0E0807"), "#0E0807");
    assert.equal(toRgbHex("#E8DED7"), "#E8DED7");
    const samples = ["0E0807", "E8DED7"] as const;
    for (const raw of samples) {
      let parsed: string | undefined;
      try {
        parsed = toRgbHex(raw);
      } catch (error) {
        assert.equal(error instanceof InvalidPptdColorError, true);
        assert.match(String((error as Error).message), /must not become #000000/);
        parsed = undefined;
      }
      if (parsed) {
        assert.equal(parsed.toUpperCase(), `#${raw}`);
      }
      assert.notEqual(parsed?.replace("#", "").toUpperCase(), "000000");
      assert.notEqual(parsed?.replace("#", "").toUpperCase(), "FFFFFF");
    }
  });

  it("Hub SVG / fill paint does not invent black from unprefixed shape fill", () => {
    try {
      const paint = elementFillPaint("shape", { type: "solid", color: "0E0807" });
      if (paint.type === "solid") {
        assert.equal(paint.hex.toUpperCase(), "#0E0807");
        assert.notEqual(paint.hex.toUpperCase(), "#000000");
      }
    } catch (error) {
      assert.equal(error instanceof InvalidPptdColorError, true);
    }
    try {
      const css = toCssColor("E8DED7");
      assert.equal(css.toUpperCase(), "#E8DED7");
    } catch (error) {
      assert.equal(error instanceof InvalidPptdColorError, true);
    }
  });

  it("unresolved $nope never becomes #000000; existing $primary still resolves", () => {
    assert.equal(officialPptdColorKind("$nope"), "theme");
    assert.equal(officialPptdColorKind("$primary"), "theme");
    assert.equal(toRgbHex("$primary", { colors: { primary: "#2563EB" } }), "#2563EB");
    let parsed: string | undefined;
    try {
      parsed = toRgbHex("$nope");
    } catch (error) {
      assert.equal(error instanceof InvalidPptdColorError, true);
      assert.match(String((error as Error).message), /must not become #000000/);
      parsed = undefined;
    }
    assert.equal(parsed, undefined);
  });
});
