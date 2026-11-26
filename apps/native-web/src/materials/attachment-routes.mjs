/**
 * Attachment HTTP handlers for server.mjs. The server owns the store, the
 * parse pool and its body helpers; this module keeps only the route logic.
 * The editor is single-user local: there is no principal and no owner scope.
 * PDF page rendering is optional and injected (`pdf`), so this module does
 * not load the renderer itself.
 */
import { attachmentContent, attachmentPublic, parseAttachmentBuffer, TEXT_RECEIPT_PARSER } from "../attachments.mjs";
import { ingestAttachment } from "./intake.mjs";
import { textReceiptView } from "./text-receipt.mjs";
import { DEFAULT_FILE_BYTES, MAX_UPLOAD_BYTES, UPLOAD_CAP_MESSAGE, uploadSizeVerdict } from "./size-limits.mjs";

/** @typedef {import("node:http").IncomingMessage} IncomingMessage */
/** @typedef {import("node:http").ServerResponse} ServerResponse */
/** @typedef {import("../attachments.mjs").StoredRecord} StoredRecord */
/** @typedef {import("../attachments.mjs").AttachmentStore} AttachmentStore */

/**
 * What every attachment handler receives from server.mjs.
 * @typedef {{req: IncomingMessage, res: ServerResponse, url: URL,
 *   reply: (status: number, body: unknown) => void}} AttachmentRouteContext
 */

/**
 * Optional PDF page-image hooks, normally the exports of `pdf-render-store.mjs`
 * plus the shared render queue.
 * @typedef {{queue?: {available?: boolean|null},
 *   publicPdfRenderStatus?: (record: any, available: boolean|null) => unknown,
 *   enqueuePdfRender?: (input: {store: any, queue: any, record: any}) => unknown,
 *   readPdfPage?: (store: any, id: string, page: number) => {bytes: Buffer, descriptor: {sha256: string}}|undefined,
 * }} PdfHooks
 */

/** The body cap; the limit of each file type is applied after its content is detected. */
export const MAX_ATTACHMENT_BYTES = MAX_UPLOAD_BYTES;

/**
 * Stream an octet-stream body with a hard byte cap. The moment the cap is
 * crossed `onOverLimit` fires (so the route can answer 413 mid-transfer) and
 * the loop stops reading.
 * @param {AsyncIterable<unknown>} req @param {number} capBytes
 * @param {() => void} [onOverLimit] fired once, mid-stream, when the cap trips
 * @returns {Promise<{bytes: Buffer} | {overLimit: true}>}
 */
export async function readRawBodyCapped(req, capBytes, onOverLimit) {
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError("request body chunks must be buffers");
    total += chunk.length;
    if (total > capBytes) {
      onOverLimit?.();
      return { overLimit: true };
    }
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks) };
}

/**
 * The percent-encoded `X-Attachment-Name`, or the Chinese reason it is refused.
 * @param {unknown} header
 * @returns {{name: string} | {status: number, error: string, code: string}}
 */
export function attachmentNameOf(header) {
  const rawName = String(header || "");
  if (!rawName.trim()) return { status: 400, error: "缺少 X-Attachment-Name 文件名", code: "ATTACHMENT_NAME_REQUIRED" };
  let name;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return { status: 400, error: "X-Attachment-Name 不是有效的编码文件名", code: "ATTACHMENT_NAME_INVALID" };
  }
  if (name.length > 200 || name.includes("/") || name.includes("\\") || name.includes("\0") || !name.trim()) {
    return { status: 400, error: "文件名无效，请重命名后再上传", code: "ATTACHMENT_NAME_INVALID" };
  }
  return { name };
}

/**
 * @param {{
 *   store: AttachmentStore,
 *   pool: import("./intake.mjs").IntakeIo["pool"],
 *   readBody: (req: IncomingMessage) => Promise<any>,
 *   decodeDataUrl: (data: string) => Buffer,
 *   pdf?: PdfHooks,
 *   renderQueue?: import("./intake.mjs").IntakeIo["renderQueue"],
 *   pdfImages?: import("./intake.mjs").IntakeIo["pdfImages"],
 *   legacyConverter?: import("./intake.mjs").IntakeIo["legacyConverter"],
 * }} deps
 */
export function createAttachmentRoutes({
  store,
  pool,
  readBody,
  decodeDataUrl,
  pdf,
  renderQueue,
  pdfImages,
  legacyConverter,
}) {
  const io = { store, pool, renderQueue, pdfImages, legacyConverter };
  /** @param {string} name @param {Buffer} bytes @param {string} [declaredMime] */
  const ingest = (name, bytes, declaredMime) => ingestAttachment(io, { name, bytes, declaredMime });

  /** POST /api/attachments/demo — development brand files through the text-receipt store. */
  async function postApiAttachmentsDemo(/** @type {AttachmentRouteContext} */ { reply }) {
    const created = DEMO_BRAND_FILES.map((file) =>
      attachmentPublic(store.store(file.name, Buffer.from(file.text, "utf8"))),
    );
    return reply(200, { attachments: created });
  }

  /**
   * POST /api/attachments/upload — raw bytes, name in the percent-encoded
   * `X-Attachment-Name` header, optional `X-Attachment-Mime`. Every format runs
   * through the binary materials pipeline.
   * @param {AttachmentRouteContext} context
   */
  async function postApiAttachmentsUpload({ req, res, reply }) {
    const named = attachmentNameOf(req.headers["x-attachment-name"]);
    if (!("name" in named)) return reply(named.status, { error: named.error, code: named.code });
    const socket = req.socket;
    const body = await readRawBodyCapped(req, MAX_ATTACHMENT_BYTES, () => {
      // Answer mid-transfer and half-close once the 413 has flushed.
      reply(413, { error: UPLOAD_CAP_MESSAGE, code: "ATTACHMENT_TOO_LARGE" });
      res.on("finish", () => socket.end());
    });
    if ("overLimit" in body) return;
    if (!body.bytes.length) return reply(400, { error: "empty file", code: "ATTACHMENT_EMPTY" });
    const verdict = uploadSizeVerdict(named.name, body.bytes);
    if (!verdict.ok) return reply(413, { error: verdict.message, code: "ATTACHMENT_TOO_LARGE" });
    const declaredMime = String(req.headers["x-attachment-mime"] || "") || undefined;
    const { record, duplicateOf, uploadWarnings } = await ingest(named.name, body.bytes, declaredMime);
    return reply(
      200,
      publicWithPdf(store, record, pdf, { duplicateOf, ...(uploadWarnings ? { warnings: uploadWarnings } : {}) }),
    );
  }

  /**
   * POST /api/attachments — JSON `{name, data}` base64 upload. Keeps the
   * text-receipt contract: only complete UTF-8 text within the inline budget
   * is accepted (415 otherwise), stored through the materials pipeline so it
   * also carries a derivative.
   * @param {AttachmentRouteContext} context
   */
  async function postApiAttachments({ req, reply }) {
    const body = await readBody(req);
    const name = String(body?.name || "").trim();
    if (!name) return reply(400, { error: "name required" });
    const data = String(body?.data || "");
    if (!data) return reply(400, { error: "data required" });
    let buf;
    try {
      buf = decodeDataUrl(data);
    } catch {
      return reply(400, { error: "invalid data URL" });
    }
    if (!buf.length) return reply(400, { error: "empty file" });
    if (buf.length > DEFAULT_FILE_BYTES) {
      return reply(413, { error: "文件超过 20MB 上限，请压缩或拆分后再上传", code: "ATTACHMENT_TOO_LARGE" });
    }
    const parsed = parseAttachmentBuffer(name, buf);
    if (!parsed.parsed) {
      return reply(415, { error: parsed.note, code: "UNSUPPORTED_AGENT_ATTACHMENT" });
    }
    const { record, duplicateOf } = await ingest(name, buf);
    // A record without the text receipt (e.g. a renamed duplicate) falls back to the receipt store.
    const stored = record.meta.parser === TEXT_RECEIPT_PARSER ? record : store.store(name, buf);
    return reply(200, { ...attachmentPublic(stored), ...(stored === record && duplicateOf ? { duplicateOf } : {}) });
  }

  return { postApiAttachmentsDemo, postApiAttachmentsUpload, postApiAttachments };
}

/**
 * A render left queued or running by a restart is queued again on read; the
 * queue dedupes by id. Returns the freshest stored copy.
 * @param {AttachmentStore} store @param {StoredRecord} record @param {PdfHooks|undefined} pdf
 */
function refreshedRecord(store, record, pdf) {
  if (!pdf?.queue || !pdf.enqueuePdfRender || !record.derivative.parser?.id?.startsWith("pdf-unpdf-")) return record;
  const renderState = record.derivative.document?.renderState;
  if (renderState === "queued" || renderState === "running") {
    pdf.enqueuePdfRender({ store, queue: pdf.queue, record });
  }
  return store.read(record.meta.id) ?? record;
}

/** @param {StoredRecord} record @param {PdfHooks|undefined} pdf */
function pdfRenderField(record, pdf) {
  const pdfRender = pdf?.publicPdfRenderStatus?.(record, pdf.queue?.available ?? null);
  return pdfRender ? { pdfRender } : {};
}

/**
 * @param {AttachmentStore} store @param {StoredRecord} record @param {PdfHooks|undefined} pdf
 * @param {{duplicateOf?: string, warnings?: {code: string, message: string}[]}} [options]
 */
export function publicWithPdf(store, record, pdf, options) {
  const current = refreshedRecord(store, record, pdf);
  return { ...attachmentPublic(current, options), ...pdfRenderField(current, pdf) };
}

/**
 * Full read body: the materials view, plus — for a record with a text
 * receipt — the exact `utf8-full-v1` receipt fields the DSH host verifies
 * (`materialParser` keeps the derivative's parser id).
 * @param {AttachmentStore} store @param {import("../attachments.mjs").ReadRecord} record
 * @param {PdfHooks|undefined} pdf @param {{inlineTableText?: boolean}} [options]
 */
export function contentWithPdf(store, record, pdf, options) {
  const current = /** @type {import("../attachments.mjs").ReadRecord} */ (refreshedRecord(store, record, pdf));
  const receipt = current.parser === TEXT_RECEIPT_PARSER ? textReceiptView(/** @type {never} */ (current)) : {};
  return {
    ...attachmentContent(current, options),
    ...pdfRenderField(current, pdf),
    ...(current.parser === TEXT_RECEIPT_PARSER ? { materialParser: current.derivative.parser?.id ?? null } : {}),
    ...receipt,
  };
}

/** @param {unknown} error */
const messageOf = (error) => String(/** @type {{message?: unknown}} */ (Object(error)).message ?? "");

/**
 * GET /api/attachments/:id and GET /api/attachments/:id/pages/:n. Returns
 * false when the request is not an attachment read so the caller keeps
 * routing. `inlineTableText` adds the table text rendering (host reads).
 * @param {AttachmentRouteContext} context
 * @param {{store: AttachmentStore, pdf?: PdfHooks, inlineTableText?: boolean}} deps
 * @returns {boolean}
 */
export function serveAttachmentGet({ url, res, reply }, { store, pdf, inlineTableText = false }) {
  const pageMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)\/pages\/([1-9]\d{0,1})$/);
  const recordMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
  if (!pageMatch && !recordMatch) return false;
  const id = decodeURIComponent((pageMatch ?? recordMatch)?.[1] || "");
  try {
    if (pageMatch) {
      const page = pdf?.readPdfPage?.(store, id, Number(pageMatch[2]));
      if (!page) {
        reply(404, { error: "attachment page not found" });
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": String(page.bytes.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Attachment-Page-SHA256": page.descriptor.sha256,
      });
      res.end(page.bytes);
      return true;
    }
    const record = store.read(id);
    if (!record) reply(404, { error: `attachment not found: ${id}` });
    else reply(200, contentWithPdf(store, record, pdf, { inlineTableText }));
  } catch (error) {
    reply(400, { error: messageOf(error), code: pageMatch ? "invalid_attachment_page" : "invalid_attachment" });
  }
  return true;
}

/**
 * DELETE /api/attachments/:id. Returns false when the path does not match.
 * @param {AttachmentRouteContext} context @param {{store: AttachmentStore}} deps
 */
export function serveAttachmentDelete({ url, reply }, { store }) {
  const match = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
  if (!match) return false;
  const id = decodeURIComponent(match[1] || "");
  try {
    if (!store.delete(id)) reply(404, { error: `attachment not found: ${id}` });
    else reply(200, { ok: true, id });
  } catch (error) {
    reply(400, { error: messageOf(error), code: "invalid_attachment" });
  }
  return true;
}

/** Development demo reference files. */
const DEMO_BRAND_FILES = [
  {
    name: "brand-voice.md",
    text: ["# 品牌语气", "松绿主色贯穿封面与证据页", "标题必须是完整断言句", "禁止编造客户案例与外部统计", ""].join(
      "\n",
    ),
  },
  {
    name: "brand-palette.md",
    text: [
      "# 品牌色板",
      "背景留白，强调只用松绿与石墨灰",
      "证据页必须标注资料来源",
      "色值未给出时不要发明百分比",
      "",
    ].join("\n"),
  },
];
