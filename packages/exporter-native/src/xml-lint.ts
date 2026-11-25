/**
 * Strict XML 1.0 well-formedness checker for exported OOXML parts.
 * Enforces legal XML 1.0 character ranges, strict XML declaration syntax,
 * forbidden DTD/DOCTYPE (ECMA-376 OPC), balanced tags, strict attribute
 * grammar, valid entity/char references, and single-root document structure.
 */

const XML_WS = "[ \\t\\r\\n]";
const XML_NAME = "[\\p{L}_:][\\p{L}\\p{N}_.:-]*";
const OPEN_TAG_HEAD_RE = new RegExp(`^<(${XML_NAME})`, "u");
const CLOSE_TAG_RE = new RegExp(`^</(${XML_NAME})${XML_WS}*>`, "u");
const ATTR_NAME_RE = new RegExp(`^(${XML_NAME})`, "u");
const PI_TARGET_RE = new RegExp(`^<\\?(${XML_NAME})(?=${XML_WS}|\\?>)`, "u");
const XML_DECL_RE = new RegExp(
  `^<\\?xml${XML_WS}+version${XML_WS}*=${XML_WS}*(?:"1\\.0"|'1\\.0')` +
    `(?:${XML_WS}+encoding${XML_WS}*=${XML_WS}*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?` +
    `(?:${XML_WS}+standalone${XML_WS}*=${XML_WS}*(?:"(?:yes|no)"|'(?:yes|no)'))?${XML_WS}*\\?>$`,
);
const WS_ONLY_RE = new RegExp(`^${XML_WS}*$`);
const LEADING_WS_RE = new RegExp(`^${XML_WS}+`);
const NAMED_ENTITY_RE = /^(?:amp|lt|gt|quot|apos);/;
const DEC_CHAR_REF_RE = /^#([0-9]+);/;
const HEX_CHAR_REF_RE = /^#x([0-9a-fA-F]+);/;

type FailFn = (msg: string) => never;

type ParseState = {
  stack: string[];
  rootCount: number;
};

export function assertWellFormedXml(xml: string, part: string): void {
  const input = xml.startsWith("\uFEFF") ? xml.slice(1) : xml;
  checkLegalXmlChars(input, part);
  const state: ParseState = { stack: [], rootCount: 0 };
  let i = 0;
  const fail: FailFn = (msg) => {
    throw new Error(`${part}@${i}: ${msg}`);
  };
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      checkTextChunk(input.slice(i), state.stack.length > 0, fail);
      break;
    }
    if (lt > i) {
      checkTextChunk(input.slice(i, lt), state.stack.length > 0, fail);
      i = lt;
    }
    const skipped = skipMarkup(input, i, state, fail);
    if (skipped !== undefined) {
      i = skipped;
      continue;
    }
    i = readElement(input, i, state, fail);
  }
  if (state.stack.length > 0) fail(`unclosed elements: ${state.stack.join(",")}`);
  if (state.rootCount !== 1) fail(state.rootCount === 0 ? "missing root element" : "multiple root elements");
}

function isValidXmlCharCode(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

function checkLegalXmlChars(input: string, part: string): void {
  for (let idx = 0; idx < input.length;) {
    const code = input.codePointAt(idx)!;
    if (!isValidXmlCharCode(code)) {
      const hex = code.toString(16).toUpperCase().padStart(4, "0");
      throw new Error(`${part}@${idx}: character U+${hex} is not allowed in XML 1.0`);
    }
    idx += code > 0xffff ? 2 : 1;
  }
}

function hasInvalidEntity(text: string): boolean {
  let idx = text.indexOf("&");
  while (idx !== -1) {
    const tail = text.slice(idx + 1);
    if (NAMED_ENTITY_RE.test(tail)) {
      idx = text.indexOf("&", idx + 1);
      continue;
    }
    const dec = DEC_CHAR_REF_RE.exec(tail);
    if (dec) {
      if (!isValidXmlCharCode(Number.parseInt(dec[1]!, 10))) return true;
      idx = text.indexOf("&", idx + 1);
      continue;
    }
    const hex = HEX_CHAR_REF_RE.exec(tail);
    if (hex) {
      if (!isValidXmlCharCode(Number.parseInt(hex[1]!, 16))) return true;
      idx = text.indexOf("&", idx + 1);
      continue;
    }
    return true;
  }
  return false;
}

function checkTextChunk(text: string, insideRoot: boolean, fail: FailFn): void {
  if (!insideRoot) {
    if (!WS_ONLY_RE.test(text)) fail("non-whitespace text outside root element");
    return;
  }
  if (text.includes("]]>")) fail("stray ]]> in text");
  if (hasInvalidEntity(text)) fail("raw & or invalid entity in text");
}

function skipComment(xml: string, i: number, fail: FailFn): number {
  const end = xml.indexOf("-->", i + 4);
  if (end === -1) fail("unterminated comment");
  const body = xml.slice(i + 4, end);
  if (body.includes("--") || body.endsWith("-")) fail("invalid -- inside comment");
  return end + 3;
}

function skipCdata(xml: string, i: number, insideRoot: boolean, fail: FailFn): number {
  if (!insideRoot) fail("CDATA outside root element");
  const end = xml.indexOf("]]>", i + 9);
  if (end === -1) fail("unterminated CDATA");
  return end + 3;
}

function skipPi(xml: string, i: number, fail: FailFn): number {
  const end = xml.indexOf("?>", i + 2);
  if (end === -1) fail("unterminated PI");
  const full = xml.slice(i, end + 2);
  const targetMatch = PI_TARGET_RE.exec(full);
  if (!targetMatch) fail("malformed processing instruction");
  const target = targetMatch[1]!;
  if (target.toLowerCase() === "xml") {
    if (i !== 0 || target !== "xml") fail("XML declaration is only allowed as <?xml at start of document");
    if (!XML_DECL_RE.test(full)) fail("malformed XML declaration");
  }
  return end + 2;
}

function skipMarkup(xml: string, i: number, state: ParseState, fail: FailFn): number | undefined {
  if (xml.startsWith("<!--", i)) return skipComment(xml, i, fail);
  if (xml.startsWith("<![CDATA[", i)) return skipCdata(xml, i, state.stack.length > 0, fail);
  if (xml.startsWith("<?", i)) return skipPi(xml, i, fail);
  if (xml.startsWith("<!", i)) fail("DTD/DOCTYPE declarations are not allowed in OOXML");
  return undefined;
}

function readElement(xml: string, i: number, state: ParseState, fail: FailFn): number {
  if (xml.startsWith("</", i)) return readClosingTag(xml, i, state, fail);
  const head = OPEN_TAG_HEAD_RE.exec(xml.slice(i, i + 256));
  if (!head) fail("malformed start tag");
  const name = head![1]!;
  if (state.stack.length === 0) {
    state.rootCount++;
    if (state.rootCount > 1) fail("multiple root elements");
  }
  const afterName = i + head![0].length;
  const gt = findTagEnd(xml, afterName, fail);
  const rawBody = xml.slice(afterName, gt);
  const selfClose = rawBody.endsWith("/");
  const attrBody = selfClose ? rawBody.slice(0, -1) : rawBody;
  scanAttributes(attrBody, name, fail);
  if (!selfClose) state.stack.push(name);
  return gt + 1;
}

function readClosingTag(xml: string, i: number, state: ParseState, fail: FailFn): number {
  const gt = xml.indexOf(">", i + 2);
  if (gt === -1) fail("unterminated closing tag");
  const slice = xml.slice(i, gt + 1);
  const match = CLOSE_TAG_RE.exec(slice);
  if (!match || match[0].length !== slice.length) fail(`malformed closing tag ${slice}`);
  const name = match![1]!;
  const top = state.stack.pop();
  if (top !== name) fail(`mismatched </${name}> (open: ${top ?? "none"})`);
  return gt + 1;
}

function findTagEnd(xml: string, start: number, fail: FailFn): number {
  let quote: string | null = null;
  for (let pos = start; pos < xml.length; pos++) {
    const ch = xml[pos]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === "<") fail("raw < inside attribute value");
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "<") fail("unexpected < inside tag");
    else if (ch === ">") return pos;
  }
  fail("unterminated tag");
}

function scanAttributes(attrBody: string, tagName: string, fail: FailFn): void {
  const seen = new Set<string>();
  let pos = 0;
  while (pos < attrBody.length) {
    const tail = attrBody.slice(pos);
    if (WS_ONLY_RE.test(tail)) return;
    const ws = LEADING_WS_RE.exec(tail);
    if (!ws) fail(`missing whitespace before attribute in <${tagName}>`);
    pos += ws![0].length;
    const nameMatch = ATTR_NAME_RE.exec(attrBody.slice(pos));
    if (!nameMatch) fail(`malformed attribute name in <${tagName}>`);
    const attrName = nameMatch![1]!;
    if (seen.has(attrName)) fail(`duplicate attribute "${attrName}" in <${tagName}>`);
    seen.add(attrName);
    pos += attrName.length;
    pos = readAttributeValue(attrBody, pos, tagName, attrName, fail);
  }
}

function readAttributeValue(attrBody: string, start: number, tagName: string, attrName: string, fail: FailFn): number {
  let pos = skipWhitespace(attrBody, start);
  if (attrBody[pos] !== "=") fail(`missing = for attribute "${attrName}" in <${tagName}>`);
  pos = skipWhitespace(attrBody, pos + 1);
  const quote = attrBody[pos];
  if (quote !== '"' && quote !== "'") fail(`unquoted attribute "${attrName}" in <${tagName}>`);
  const close = attrBody.indexOf(quote, pos + 1);
  if (close === -1) fail(`unterminated attribute "${attrName}" in <${tagName}>`);
  const value = attrBody.slice(pos + 1, close);
  if (hasInvalidEntity(value)) fail(`raw & or invalid entity in attribute "${attrName}" of <${tagName}>`);
  return close + 1;
}

function skipWhitespace(text: string, start: number): number {
  let pos = start;
  while (pos < text.length && (text[pos] === " " || text[pos] === "\t" || text[pos] === "\r" || text[pos] === "\n")) {
    pos++;
  }
  return pos;
}
