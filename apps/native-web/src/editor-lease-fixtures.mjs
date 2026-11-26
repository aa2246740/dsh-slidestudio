/** Test fixtures for the editor-human writer lease: real temp PPTD projects. */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { WRITER_LEASE_FILE, WRITER_LEASE_LOCK_DIR } from "@open-slidestudio/slides-tools";

/** @type {string[]} */
const created = [];

/**
 * A fresh, empty PPTD project in its own temp directory.
 * @param {string} [prefix]
 * @returns {string}
 */
export function tempLeaseProject(prefix = "editor-lease") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  created.push(dir);
  const root = path.join(dir, "deck");
  createEmptyProject(root, { title: prefix });
  return root;
}

/** @param {string} prefix */
export function tempDirectory(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  created.push(dir);
  return dir;
}

export function removeLeaseFixtures() {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** @param {string} root */
export function leaseFileText(root) {
  return fs.readFileSync(path.join(root, WRITER_LEASE_FILE), "utf8");
}

/**
 * Simulate a live process stuck inside the lease lock (`<root>/_agent/.pptd-write.lock`).
 * @param {string} root
 * @returns {() => void} release
 */
export function holdLeaseLock(root) {
  const dir = path.join(root, WRITER_LEASE_LOCK_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "owner.json"),
    `${JSON.stringify({ pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString() })}\n`,
  );
  return () => fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * A page write the way an agent would land it (inside the PPTD project dir).
 * @param {string} root
 * @param {string} text
 */
export function writeAgentPage(root, text) {
  const file = path.join(root, "pages", "agent-note.txt");
  fs.writeFileSync(file, `${text}\n`);
  return file;
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<unknown>}
 */
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Mirrors the editor server's project resolution: an explicit project that
 * does not exist is a 404 under `strict`.
 * @param {URL} url
 * @param {unknown} body
 * @param {{ strict?: boolean }} [opts]
 */
function projectFor(url, body, opts = {}) {
  const fromBody = body && typeof body === "object" ? /** @type {{ project?: unknown }} */ (body).project : undefined;
  const hint = String(url.searchParams.get("project") ?? fromBody ?? "");
  if (hint && fs.existsSync(hint)) return path.resolve(hint);
  const error = Object.assign(new Error(`project not found: ${hint}`), { statusCode: opts.strict ? 404 : 400 });
  throw error;
}

/**
 * @param {URL} url
 * @param {unknown} body
 */
function tabFor(url, body) {
  const fromBody = body && typeof body === "object" ? /** @type {{ tabId?: unknown }} */ (body).tabId : undefined;
  const raw = String(url.searchParams.get("tab") ?? fromBody ?? "");
  return /^[\w-]{1,64}$/.test(raw) ? raw : "default";
}

/**
 * A loopback server wired like the editor server: the JSON content-type guard
 * (with the sendBeacon exemption) in front of the lease routes.
 * @param {{
 *   handle: (ctx: import("./editor-lease-routes.mjs").EditorLeaseRouteContext) => Promise<boolean>,
 *   beaconAllowed: (req: import("node:http").IncomingMessage, url: URL) => boolean,
 * }} routes
 */
export async function startLeaseServer(routes) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const type = String(req.headers["content-type"] || "").toLowerCase();
    if (req.method === "POST" && !type.includes("application/json") && !routes.beaconAllowed(req, url)) {
      return sendJson(res, 415, { error: "mutating requests require application/json" });
    }
    const ctx = {
      req,
      res,
      url,
      readBody: readJsonBody,
      json: sendJson,
      projectForRequest: projectFor,
      tabIdFor: tabFor,
    };
    if (!(await routes.handle(ctx))) sendJson(res, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}
