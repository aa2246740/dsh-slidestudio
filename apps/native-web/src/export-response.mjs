// Download responses for exports (PPTX / PDF / PNG). Zero dependencies.
// Content-Disposition follows RFC 6266 with the RFC 5987 / RFC 8187 extended
// parameter: an ASCII `filename` fallback for old clients plus the exact UTF-8
// name in `filename*`.

const FALLBACK_STEM = "export";

/**
 * Remove characters no filename may carry: control characters (header
 * injection) and path separators (a name never selects a directory).
 * @param {string} name
 */
function cleanFilename(name) {
  let out = "";
  for (const ch of String(name ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f || ch === "/" || ch === "\\" ? "_" : ch;
  }
  return out.trim() || FALLBACK_STEM;
}

/**
 * RFC 5987 `attr-char` encoding: encodeURIComponent leaves `'()*` unescaped,
 * which the ABNF does not allow.
 * @param {string} value
 */
export function encodeRfc5987Value(value) {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Printable-ASCII approximation of a filename for the quoted `filename`
 * parameter. Non-ASCII runs become `_`; quote, backslash and `%` (which some
 * clients percent-decode) are replaced too. The extension is kept.
 * @param {string} name already cleaned
 */
export function asciiFallbackFilename(name) {
  const ascii = cleanFilename(name)
    .replace(/[^\x20-\x7e]+/g, "_")
    .replace(/["\\%]/g, "_");
  const dot = ascii.lastIndexOf(".");
  const stem = dot > 0 ? ascii.slice(0, dot) : ascii;
  const ext = dot > 0 ? ascii.slice(dot) : "";
  return /[A-Za-z0-9]/.test(stem) ? ascii : `${FALLBACK_STEM}${ext}`;
}

/**
 * `attachment; filename="<ascii>"; filename*=UTF-8''<pct-encoded>`.
 * @param {string} filename
 * @param {"attachment" | "inline"} [disposition]
 */
export function contentDisposition(filename, disposition = "attachment") {
  const name = cleanFilename(filename);
  return `${disposition}; filename="${asciiFallbackFilename(name)}"; filename*=UTF-8''${encodeRfc5987Value(name)}`;
}

/**
 * Base64url JSON for the `X-Export-Report` header: keeps non-ASCII font names
 * HTTP-safe. Decoded in the browser by `decodeExportReport`
 * (public/export-degradation-labels.js).
 * @param {Record<string, unknown>} report
 */
export function encodeExportReportHeader(report) {
  return Buffer.from(JSON.stringify(report), "utf8").toString("base64url");
}

/**
 * Send exported bytes as a non-cacheable download carrying its public report.
 * @param {import("node:http").ServerResponse} res
 * @param {{contentType: string, filename: string, body: Uint8Array, report: Record<string, unknown>}} download
 */
export function sendExportResponse(res, { contentType, filename, body, report }) {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": contentDisposition(filename),
    "Content-Length": String(body.byteLength),
    "X-Export-Report": encodeExportReportHeader(report),
  });
  return res.end(body);
}
