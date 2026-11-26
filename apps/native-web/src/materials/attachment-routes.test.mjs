import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { decodeAttachmentUpload } from "../attachments.mjs";
import {
  attachmentNameOf,
  createAttachmentRoutes,
  MAX_ATTACHMENT_BYTES,
  serveAttachmentDelete,
  serveAttachmentGet,
} from "./attachment-routes.mjs";
import { buildPptx } from "../testlib/pptx-fixture.mjs";
import { hostAcceptsTextReceipt, inThreadPool, tempStore } from "./test-fixtures/material-harness.mjs";

const sha = (/** @type {string} */ text) => crypto.createHash("sha256").update(text).digest("hex");

/** @type {{after: (fn: () => void) => void}} */
const lifetime = { after: (fn) => cleanups.push(fn) };
/** @type {(() => void)[]} */
const cleanups = [];
const { store } = tempStore(lifetime);

/** @param {http.IncomingMessage} req */
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const routes = createAttachmentRoutes({
  store,
  pool: inThreadPool,
  readBody: readJson,
  decodeDataUrl: decodeAttachmentUpload,
});

/** The wiring server.mjs is expected to do, reduced to the attachment routes. */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  /** @param {number} status @param {unknown} body */
  const reply = (status, body) => {
    if (res.headersSent) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const context = { req, res, url, reply };
  if (req.method === "POST" && url.pathname === "/api/attachments/upload")
    return routes.postApiAttachmentsUpload(context);
  if (req.method === "POST" && url.pathname === "/api/attachments/demo") return routes.postApiAttachmentsDemo(context);
  if (req.method === "POST" && url.pathname === "/api/attachments") return routes.postApiAttachments(context);
  if (req.method === "GET" && serveAttachmentGet(context, { store })) return undefined;
  if (req.method === "DELETE" && serveAttachmentDelete(context, { store })) return undefined;
  return reply(404, { error: "not found" });
});

let base = "";
before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  base = `http://127.0.0.1:${address.port}`;
});
after(() => {
  server.close();
  for (const cleanup of cleanups) cleanup();
});

/** @param {Uint8Array<ArrayBuffer>} bytes @param {string} name */
const upload = (bytes, name) =>
  fetch(`${base}/api/attachments/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Attachment-Name": encodeURIComponent(name) },
    body: bytes,
  });

/** @param {string} name @param {Uint8Array} bytes */
const jsonUpload = (name, bytes) =>
  fetch(`${base}/api/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      data: `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`,
    }),
  });

test("binary upload parses CSV and answers the public record, re-upload dedupes", async () => {
  const csv = Buffer.from("地区,销售额\n华东,1203.17\n华南,987.42\n", "utf8");
  const response = await upload(csv, "数据.csv");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.kind, "table");
  assert.equal(body.parser, "csv-v1");
  assert.equal(body.status, "parsed");
  assert.match(body.summary?.zh ?? "", /CSV · UTF-8 编码 · 逗号分隔 · 2 行/);
  assert.equal("ownerId" in body, false);
  const again = await (await upload(csv, "copy.csv")).json();
  assert.equal(again.id, body.id);
  assert.equal(again.duplicateOf, body.id);
});

test("binary upload of a PPTX is a deck template readable through GET", async () => {
  const body = await (await upload(buildPptx(), "品牌.pptx")).json();
  assert.equal(body.kind, "deck-template");
  const read = await (await fetch(`${base}/api/attachments/${encodeURIComponent(body.id)}`)).json();
  assert.equal(read.id, body.id);
  assert.equal(typeof read.derivativeSha256, "string");
  assert.equal(read.parser, "pptx-ooxml-v2");
});

test("the JSON route keeps the text-receipt contract for the host and refuses binaries with 415", async () => {
  const created = await (await jsonUpload("brief.md", Buffer.from("# 简报\n完整正文"))).json();
  assert.equal(created.parsed, true);
  assert.equal("text" in created, false);
  const read = await (await fetch(`${base}/api/attachments/${encodeURIComponent(created.id)}`)).json();
  assert.equal(hostAcceptsTextReceipt(created.id, read, sha), true, JSON.stringify(read));
  const refused = await jsonUpload("deck.pptx", buildPptx());
  assert.equal(refused.status, 415);
  assert.equal((await refused.json()).code, "UNSUPPORTED_AGENT_ATTACHMENT");
});

test("the demo route stores the brand files as text receipts", async () => {
  const body = await (await fetch(`${base}/api/attachments/demo`, { method: "POST" })).json();
  assert.equal(body.attachments.length, 2);
  for (const attachment of body.attachments) assert.equal(attachment.parsed, true);
});

test("DELETE removes a record and a second DELETE or GET is 404; bad ids are 400", async () => {
  const body = await (await upload(Buffer.from("to be removed"), "gone.txt")).json();
  const url = `${base}/api/attachments/${encodeURIComponent(body.id)}`;
  assert.equal((await fetch(url, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(url, { method: "DELETE" })).status, 404);
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await fetch(`${base}/api/attachments/not-an-id`)).status, 400);
  assert.equal((await fetch(`${url}/pages/1`)).status, 404, "pages need the injected PDF hooks");
});

test("missing or path-like names are refused before any byte is stored", async () => {
  /** @param {string} header */
  const refusalOf = (header) => /** @type {{status: number, error: string, code: string}} */ (attachmentNameOf(header));
  assert.equal(refusalOf("").status, 400);
  assert.equal(refusalOf("%E0%A4%A").status, 400);
  assert.equal(refusalOf(encodeURIComponent("a/b.txt")).status, 400);
  assert.deepEqual(attachmentNameOf(encodeURIComponent("季度.xlsx")), { name: "季度.xlsx" });
  const response = await fetch(`${base}/api/attachments/upload`, { method: "POST", body: Buffer.from("x") });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "ATTACHMENT_NAME_REQUIRED");
});

test("an over-cap body is answered 413 in Chinese before the transfer completes", async () => {
  const body = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x41);
  const response = await upload(body, "huge.txt").catch((error) => error);
  if (response instanceof Error) return; // The socket may close before the client reads the reply.
  assert.equal(response.status, 413);
  const json = await response.json();
  assert.equal(json.code, "ATTACHMENT_TOO_LARGE");
  assert.match(json.error, /50MB/);
});
