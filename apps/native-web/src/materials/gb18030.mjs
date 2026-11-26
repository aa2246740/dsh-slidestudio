/**
 * GB18030 encoding without a dependency: Node can decode GB18030 but cannot
 * encode it, so the reverse map is derived once from the runtime decoder —
 * every valid two-byte pair is decoded and keyed by character. Characters the
 * runtime cannot round-trip are a hard error, never silent mojibake.
 */

/** @type {Map<string, Buffer>|undefined} */
let reverseMap;

/** @returns {Map<string, Buffer>} */
function gb18030ReverseMap() {
  if (reverseMap) return reverseMap;
  const decoder = new TextDecoder("gb18030");
  const map = new Map();
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      const bytes = Uint8Array.of(lead, trail);
      try {
        const ch = decoder.decode(bytes, { stream: false });
        if (!map.has(ch)) map.set(ch, Buffer.from(bytes));
      } catch {
        // Not a valid pair in this runtime's mapping — skip.
      }
    }
  }
  for (let ascii = 0x00; ascii <= 0x7f; ascii += 1) {
    const ch = String.fromCharCode(ascii);
    if (!map.has(ch)) map.set(ch, Buffer.from([ascii]));
  }
  reverseMap = map;
  return map;
}

/**
 * Encode a string as GB18030 (two-byte forms cover the common CJK set).
 * @param {string} text
 */
export function encodeGb18030(text) {
  const map = gb18030ReverseMap();
  const pieces = [];
  for (const ch of text) {
    const encoded = map.get(ch);
    if (!encoded) throw new Error(`character cannot be encoded as GB18030: ${JSON.stringify(ch)}`);
    pieces.push(encoded);
  }
  return Buffer.concat(pieces);
}
