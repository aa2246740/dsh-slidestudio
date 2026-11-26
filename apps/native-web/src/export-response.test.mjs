import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { test } from "node:test";
import { exportFilenameFromDisposition } from "../public/export-degradation-labels.js";
import {
  asciiFallbackFilename,
  contentDisposition,
  encodeRfc5987Value,
  sendExportResponse,
} from "./export-response.mjs";

test("download HTTP preserves exact bytes, RFC 6266 filename and public report metadata", async () => {
  const bytes = Buffer.from([0x00, 0xc3, 0xa9, 0xff, 0x50]);
  const server = http.createServer((_request, response) => {
    sendExportResponse(response, {
      contentType: "image/png",
      filename: "季度's KPI (1)*.png",
      body: bytes,
      report: { ok: true, slideCount: 1, bytes: 5, fonts: ["微软雅黑"] },
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = /** @type {import("node:net").AddressInfo} */ (server.address());
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-length"), "5");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const disposition = response.headers.get("content-disposition");
    assert.equal(
      disposition,
      `attachment; filename="_'s KPI (1)*.png"; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%27s%20KPI%20%281%29%2A.png`,
    );
    assert.equal(exportFilenameFromDisposition(disposition, "deck.png"), "季度's KPI (1)*.png");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const header = response.headers.get("x-export-report") ?? "";
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), {
      ok: true,
      slideCount: 1,
      bytes: 5,
      fonts: ["微软雅黑"],
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("RFC 5987 encoding escapes the characters encodeURIComponent leaves alone", () => {
  assert.equal(encodeRfc5987Value("a'b(c)d*e"), "a%27b%28c%29d%2Ae");
  assert.equal(encodeRfc5987Value("报告 v2.pptx"), "%E6%8A%A5%E5%91%8A%20v2.pptx");
});

test("the ASCII fallback keeps the extension and never carries quotes or percent signs", () => {
  assert.equal(asciiFallbackFilename("季度报告.pptx"), "export.pptx");
  assert.equal(asciiFallbackFilename('Q3 "final" 100%.pdf'), "Q3 _final_ 100_.pdf");
  assert.equal(asciiFallbackFilename("Deck-p2.png"), "Deck-p2.png");
  assert.equal(asciiFallbackFilename("年报 2026.pdf"), "_ 2026.pdf");
});

test("control characters and path separators never reach the header", () => {
  const header = contentDisposition("../evil\r\nSet-Cookie: x=1.pptx");
  assert.equal(/[\r\n]/.test(header), false);
  assert.equal(header.includes("/"), false);
  assert.match(header, /^attachment; filename="\.\._evil__Set-Cookie: x=1\.pptx"; filename\*=UTF-8''/);
  assert.equal(contentDisposition("", "inline"), `inline; filename="export"; filename*=UTF-8''export`);
});

test("the client reads filename* first, then the quoted fallback, then its own default", () => {
  assert.equal(
    exportFilenameFromDisposition(`attachment; filename="x.pptx"; filename*=UTF-8''%E6%8A%A5.pptx`, "d"),
    "报.pptx",
  );
  assert.equal(exportFilenameFromDisposition(`attachment; filename="a \\"b\\".pdf"`, "d"), 'a "b".pdf');
  assert.equal(exportFilenameFromDisposition("attachment; filename=plain.png", "d"), "plain.png");
  assert.equal(exportFilenameFromDisposition(`attachment; filename*=UTF-8''%E0%A4%A`, "d.pdf"), "d.pdf");
  assert.equal(exportFilenameFromDisposition(null, "deck.pptx"), "deck.pptx");
});
