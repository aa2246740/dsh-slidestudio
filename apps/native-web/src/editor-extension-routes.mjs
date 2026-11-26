/**
 * Routes server.mjs delegates before its own dispatch: the editor-human writer
 * lease (its HTTP surface and the guard in front of every human deck write)
 * and the materials attachment pipeline (JSON text receipts, binary uploads,
 * PDF page images). The request handler calls `handle` once; it answers true
 * when the request was fully served.
 */
import { refuseEditorWrite } from "./editor-lease.mjs";
import { editorLeaseBeaconAllowed, handleEditorLeaseRoutes } from "./editor-lease-routes.mjs";
import { createAttachmentRoutes, serveAttachmentDelete, serveAttachmentGet } from "./materials/attachment-routes.mjs";

export const ATTACHMENT_UPLOAD_PATH = "/api/attachments/upload";

/** Human write routes that change the deck on disk besides mutating `/api/command` calls. */
const HUMAN_WRITE_PATHS = new Set(["/api/versions/restore", "/api/media"]);

/**
 * @typedef {import("node:http").IncomingMessage} Req
 * @typedef {import("node:http").ServerResponse} Res
 * @typedef {{
 *   json: (res: Res, status: number, body: unknown) => unknown,
 *   readBody: (req: Req) => Promise<any>,
 *   projectForRequest: (url: URL, body: unknown, opts?: { strict?: boolean }) => string,
 *   tabIdFor: (url: URL, body: unknown) => string,
 *   mutatingCommands: ReadonlySet<string>,
 *   reviewLocked: (projectRoot: string) => boolean,
 *   attachments: Omit<Parameters<typeof createAttachmentRoutes>[0], "readBody">,
 * }} EditorExtensionDeps
 */

/**
 * Bodies that are not JSON but still belong to these routes: the lease release
 * beacon (text/plain) and raw attachment bytes.
 * @param {Req} req @param {URL} url
 */
export function extensionContentTypeAllowed(req, url) {
  return editorLeaseBeaconAllowed(req, url) || (req.method === "POST" && url.pathname === ATTACHMENT_UPLOAD_PATH);
}

/**
 * The project and tab a human write acts on, or null when the request is not a
 * human deck write the lease guards. An active AI review lock answers with its
 * own 423 further down, so the guard leaves that request to the route.
 * @param {EditorExtensionDeps} deps @param {Req} req @param {URL} url
 * @returns {Promise<{projectRoot: string, tabId: string} | null>}
 */
async function humanWriteTarget(deps, req, url) {
  if (req.method !== "POST") return null;
  const isCommand = url.pathname === "/api/command";
  if (!isCommand && !HUMAN_WRITE_PATHS.has(url.pathname)) return null;
  let body;
  try {
    body = await deps.readBody(req);
  } catch {
    // The route reads the same memoized body and answers its own 400/413.
    return null;
  }
  if (isCommand && !deps.mutatingCommands.has(body?.cmd)) return null;
  let projectRoot;
  try {
    projectRoot = deps.projectForRequest(url, body, { strict: isCommand || url.pathname === "/api/versions/restore" });
  } catch {
    return null;
  }
  if (deps.reviewLocked(projectRoot)) return null;
  return { projectRoot, tabId: deps.tabIdFor(url, body) };
}

/**
 * @param {EditorExtensionDeps} deps
 */
export function createEditorExtensionRoutes(deps) {
  const attachmentRoutes = createAttachmentRoutes({ ...deps.attachments, readBody: deps.readBody });
  const { store, pdf } = deps.attachments;

  /** @param {Req} req @param {Res} res @param {URL} url */
  async function handleAttachments(req, res, url) {
    if (!url.pathname.startsWith("/api/attachments")) return false;
    const context = {
      req,
      res,
      url,
      reply: (/** @type {number} */ status, /** @type {unknown} */ body) => deps.json(res, status, body),
    };
    if (req.method === "POST" && url.pathname === "/api/attachments/demo") {
      await attachmentRoutes.postApiAttachmentsDemo(context);
      return true;
    }
    if (req.method === "POST" && url.pathname === ATTACHMENT_UPLOAD_PATH) {
      await attachmentRoutes.postApiAttachmentsUpload(context);
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/attachments") {
      await attachmentRoutes.postApiAttachments(context);
      return true;
    }
    if (req.method === "GET") return serveAttachmentGet(context, { store, pdf });
    if (req.method === "DELETE") return serveAttachmentDelete(context, { store });
    return false;
  }

  /** @param {Req} req @param {Res} res @param {URL} url */
  async function guardHumanWrite(req, res, url) {
    const target = await humanWriteTarget(deps, req, url);
    if (!target) return false;
    return refuseEditorWrite({ res, json: deps.json, ...target });
  }

  /**
   * @param {Req} req @param {Res} res @param {URL} url
   * @returns {Promise<boolean>} true when the request was answered here
   */
  async function handle(req, res, url) {
    const leaseContext = {
      req,
      res,
      url,
      json: deps.json,
      readBody: deps.readBody,
      projectForRequest: deps.projectForRequest,
      tabIdFor: deps.tabIdFor,
    };
    if (await handleEditorLeaseRoutes(leaseContext)) return true;
    if (await handleAttachments(req, res, url)) return true;
    return guardHumanWrite(req, res, url);
  }

  return { handle };
}
