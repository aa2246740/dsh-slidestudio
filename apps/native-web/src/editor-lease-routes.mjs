/**
 * HTTP surface of the editor-human writer lease:
 *   GET  /api/lease          read-only holder view for the request's project
 *   POST /api/lease/acquire  take or renew this tab's lease (409/503 refusals)
 *   POST /api/lease/release  drop this tab's lease; accepts navigator.sendBeacon
 *                            bodies sent as text/plain JSON
 */
import { editorLeaseView, guardEditorWrite, releaseEditorLease } from "./editor-lease.mjs";

export const EDITOR_LEASE_PATH = "/api/lease";
export const EDITOR_LEASE_ACQUIRE_PATH = "/api/lease/acquire";
export const EDITOR_LEASE_RELEASE_PATH = "/api/lease/release";

/**
 * @typedef {import("node:http").IncomingMessage} Req
 * @typedef {import("node:http").ServerResponse} Res
 * @typedef {{
 *   req: Req,
 *   res: Res,
 *   url: URL,
 *   readBody: (req: Req) => Promise<unknown>,
 *   json: (res: Res, status: number, body: unknown) => unknown,
 *   projectForRequest: (url: URL, body: unknown, opts?: { strict?: boolean }) => string,
 *   tabIdFor: (url: URL, body: unknown) => string,
 * }} EditorLeaseRouteContext
 */

/**
 * The content-type guard admits only JSON bodies; a sendBeacon release is sent
 * as a CORS-safelisted text/plain Blob. Same-origin checks still apply to it.
 * @param {{ method?: string, headers?: Record<string, unknown> }} req
 * @param {URL} url
 * @returns {boolean}
 */
export function editorLeaseBeaconAllowed(req, url) {
  if (req.method !== "POST" || url.pathname !== EDITOR_LEASE_RELEASE_PATH) return false;
  const type = String(req.headers?.["content-type"] || "").toLowerCase();
  return type.startsWith("text/plain");
}

/**
 * @param {EditorLeaseRouteContext} ctx
 * @returns {Promise<{ ok: true, body: Record<string, unknown> | null } | { ok: false }>}
 */
async function readLeaseBody(ctx) {
  try {
    const body = await ctx.readBody(ctx.req);
    return { ok: true, body: body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body) : null };
  } catch (error) {
    const status = Number(/** @type {{ statusCode?: number }} */ (error)?.statusCode) || 400;
    ctx.json(ctx.res, status, { error: "invalid JSON body", code: "INVALID_JSON" });
    return { ok: false };
  }
}

/**
 * @param {EditorLeaseRouteContext} ctx
 * @param {Record<string, unknown> | null} body
 * @returns {string | null}
 */
function strictProject(ctx, body) {
  try {
    return ctx.projectForRequest(ctx.url, body, { strict: true });
  } catch (error) {
    const status = Number(/** @type {{ statusCode?: number }} */ (error)?.statusCode) || 400;
    const message = error instanceof Error ? error.message : String(error);
    ctx.json(ctx.res, status, { error: message, code: "PROJECT_NOT_FOUND" });
    return null;
  }
}

/** @param {EditorLeaseRouteContext} ctx */
function handleView(ctx) {
  const projectRoot = strictProject(ctx, null);
  if (!projectRoot) return;
  ctx.json(ctx.res, 200, editorLeaseView(projectRoot, { tabId: ctx.tabIdFor(ctx.url, null) }));
}

/** @param {EditorLeaseRouteContext} ctx */
async function handleAcquire(ctx) {
  const read = await readLeaseBody(ctx);
  if (!read.ok) return;
  const projectRoot = strictProject(ctx, read.body);
  if (!projectRoot) return;
  const result = guardEditorWrite(projectRoot, { tabId: ctx.tabIdFor(ctx.url, read.body) });
  if (!result.ok) {
    ctx.json(ctx.res, result.status, result.body);
    return;
  }
  ctx.json(ctx.res, 200, result);
}

/** @param {EditorLeaseRouteContext} ctx */
async function handleRelease(ctx) {
  const read = await readLeaseBody(ctx);
  if (!read.ok) return;
  const projectRoot = strictProject(ctx, read.body);
  if (!projectRoot) return;
  const result = releaseEditorLease(projectRoot, { tabId: ctx.tabIdFor(ctx.url, read.body) });
  if (!result.ok) {
    ctx.json(ctx.res, result.status, result.body);
    return;
  }
  ctx.json(ctx.res, 200, { ok: true, released: result.released });
}

/**
 * Serve the lease routes. Returns false for any other request so the caller
 * keeps routing.
 * @param {EditorLeaseRouteContext} ctx
 * @returns {Promise<boolean>}
 */
export async function handleEditorLeaseRoutes(ctx) {
  const { req, url } = ctx;
  if (req.method === "GET" && url.pathname === EDITOR_LEASE_PATH) {
    handleView(ctx);
    return true;
  }
  if (req.method === "POST" && url.pathname === EDITOR_LEASE_ACQUIRE_PATH) {
    await handleAcquire(ctx);
    return true;
  }
  if (req.method === "POST" && url.pathname === EDITOR_LEASE_RELEASE_PATH) {
    await handleRelease(ctx);
    return true;
  }
  return false;
}
