/**
 * Derivatives as earlier builds wrote them. The regressions use them to prove that the current
 * code still reads and publishes stored copies; the current parsers never write these shapes.
 */
import { buildDerivative } from "../derivative.mjs";

/**
 * An `image-sharp-v1` derivative from before the orientation word and the style profile: the
 * numeric EXIF orientation is kept, and width and height are already display-oriented.
 * @param {{materialId: string, source: object, summary: {zh: string}, orientation: number,
 *   payload: {format: string, width: number, height: number, hasAlpha: boolean, frames: number,
 *   dominant: string, palette: string[], normalized: object}}} input
 */
export function legacyImageDerivative({ materialId, source, summary, orientation, payload }) {
  const { format, width, height, hasAlpha, frames, dominant, palette, normalized } = payload;
  return buildDerivative({
    materialId,
    kind: "image",
    source: /** @type {import("../derivative.mjs").Derivative["source"]} */ (source),
    parserId: "image-sharp-v1",
    engine: "sharp",
    durationMs: 0,
    summary,
    payload: {
      format,
      width,
      height,
      hasAlpha,
      frames,
      orientation,
      dominant,
      palette,
      normalized,
    },
  });
}

/**
 * A PDF derivative whose vector style profile reports `pagesScanned` pages. Copies stored
 * before the 1..30 page window was enforced reported 0 for vector-less files.
 * @param {import("../../attachments.mjs").StoredDerivative} derivative
 * @param {number} pagesScanned
 */
export function withPdfPagesScanned(derivative, pagesScanned) {
  const copy = structuredClone(derivative);
  const profile = copy.document?.styleProfile;
  if (!profile) throw new Error("the PDF has no style profile to age");
  profile.pagesScanned = pagesScanned;
  return copy;
}

/**
 * A one-page PDF with a filled rectangle and two text runs: enough vector
 * paint for the PDF parser to measure a style profile over one page.
 * @returns {Buffer}
 */
export function styledReportPdf() {
  const content = [
    "0.2 0.4 0.8 rg 50 600 300 120 re f",
    "BT /F1 24 Tf 72 700 Td (Quarterly report styled heading) Tj ET",
    "BT /F1 12 Tf 72 560 Td (Body text line one with enough words to count as text.) Tj ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  /** @type {number[]} */
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
