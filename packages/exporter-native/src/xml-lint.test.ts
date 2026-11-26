import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertWellFormedXml } from "./xml-lint.js";

describe("assertWellFormedXml", () => {
  it("accepts valid XML including entity refs, nested quotes, CDATA, PI, surrogate pairs, and comments", () => {
    const validCases = [
      '<root a="1" b="2"/>',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<!-- header -->\n<a v="A &amp; B" q="O\'Reilly" s=\'Say "hi"\'>ok &#65; &#x42; <![CDATA[1 < 2 & 3]]></a>\n',
      '\uFEFF<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld/></p:sld>',
      '<root><child attr="x > y &lt; z">text &apos; &quot; 中文 \uD7FF \uFFFD \u{20000}</child></root>',
    ];
    for (const xml of validCases) {
      assert.doesNotThrow(() => assertWellFormedXml(xml, "valid.xml"), xml);
    }
  });

  it("rejects malformed attributes, duplicate attributes, and unspaced attributes", () => {
    const invalidCases: Array<[string, RegExp]> = [
      ['<a x="1" x="2"/>', /duplicate attribute/],
      ["<a foo/>", /missing =/],
      ['<a x="1"y="2"/>', /missing whitespace/],
      ["<a x=1/>", /unquoted attribute/],
      ['<a v="a & b"/>', /invalid entity/],
      ['<a v="&bogus;"/>', /invalid entity/],
      ['<a v="a < b"/>', /raw </],
      ["<a / >", /malformed attribute/],
    ];
    for (const [xml, pattern] of invalidCases) {
      assert.throws(() => assertWellFormedXml(xml, "bad-attr.xml"), pattern, xml);
    }
  });

  it("rejects raw illegal XML 1.0 characters, bad declarations, and DTDs", () => {
    const invalidCases: Array<[string, RegExp]> = [
      ["<a>\u0000</a>", /not allowed in XML 1\.0/],
      ["<a>\u0001</a>", /not allowed in XML 1\.0/],
      ["<a>line\u000Bbreak</a>", /not allowed in XML 1\.0/],
      ["<a>\uFFFE</a>", /not allowed in XML 1\.0/],
      ["<a>\uD800</a>", /not allowed in XML 1\.0/],
      ["<a>\uDC00</a>", /not allowed in XML 1\.0/],
      ["<?xml?><a/>", /malformed XML declaration/],
      ["<?xml garbage?><a/>", /malformed XML declaration/],
      ['<?XML version="1.0"?><a/>', /start of document/],
      ['<?xml version="2.0"?><a/>', /malformed XML declaration/],
      ["<!DOCTYPE a><a/>", /not allowed in OOXML/],
      ["<!doctype a><a/>", /not allowed in OOXML/],
    ];
    for (const [xml, pattern] of invalidCases) {
      assert.throws(() => assertWellFormedXml(xml, "bad-char.xml"), pattern, xml);
    }
  });

  it("rejects invalid roots, bad closing tags, invalid comments, and bad text/entities", () => {
    const invalidCases: Array<[string, RegExp]> = [
      ["", /missing root/],
      ["   \n\t  ", /missing root/],
      ["hello", /outside root/],
      ["<a/><b/>", /multiple root/],
      ["<a/>trailing", /outside root/],
      ['<a></a foo="1">', /malformed closing tag/],
      ["<a></b>", /mismatched/],
      ["<a><b></a>", /mismatched/],
      ["<a>", /unclosed elements/],
      ["<a><!-- -- --></a>", /invalid --/],
      ["<a><!-- bad---></a>", /invalid --/],
      ["<a>raw & text</a>", /invalid entity/],
      ["<a>&#0;</a>", /invalid entity/],
      ["<a>]]></a>", /stray ]]>/],
      ["<![CDATA[x]]><a/>", /CDATA outside root/],
      ['<a/><?xml version="1.0"?>', /start of document/],
    ];
    for (const [xml, pattern] of invalidCases) {
      assert.throws(() => assertWellFormedXml(xml, "bad-doc.xml"), pattern, xml);
    }
  });
});
