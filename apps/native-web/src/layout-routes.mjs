/**
 * Editor layout-mode (母版/版式) commands (masters-layouts §5, architecture §3.20). The canvas
 * session owns every rule and refusal. This module only checks the request shape, names the oracle
 * control, adds the rail miniatures to the model, records the editor's layout revisions in the run
 * ledger so compose accepts editor-made layouts, and serves an injectable route.
 *
 * Two ways to wire it into the editor server:
 *  - `/api/command`: spread `LAYOUT_MUTATING_COMMANDS` into PROJECT_MUTATING_COMMANDS, run
 *    `layoutCommandAction(native, body, s, cmd)` for an otherwise unknown cmd, wrap liveModel with
 *    `withLayoutPreviews`, and call `recordEditorLayoutRevisions` after a persisted command.
 *  - `handleLayoutRoutes(context)`: a self-contained `POST /api/layout/command` with the same
 *    request and response shapes, which calls the injected `guardWrite` before any disk write.
 */
import path from "node:path";
import {
  inspectRunLedger,
  readRunLedger,
  recordLayoutRevision,
  stableSha256,
} from "@open-slidestudio/presentation-run";

/** Oracle control ids of the eight layout-mode controls (masters §5.3). */
export const LAYOUT_CONTROL = Object.freeze({
  apply: "theme.layout.apply",
  enter: "theme.layout.enter",
  exit: "theme.layout.exit",
  select: "theme.layout.select",
  create: "theme.layout.create",
  rename: "theme.layout.rename",
  delete: "theme.layout.delete",
  pageNumber: "insert.pagenumber",
});

/** The controls the editor session must allow (append to the server's ORACLE_CONTROLS). */
export const LAYOUT_CONTROL_IDS = Object.freeze(Object.values(LAYOUT_CONTROL));

/** Commands that change the deck; the rest only move the editor between surfaces. */
export const LAYOUT_MUTATING_COMMANDS = Object.freeze([
  "layoutCreate",
  "layoutRename",
  "layoutDelete",
  "layoutApply",
  "insertPageNumber",
]);

/** Every command this module answers. */
export const LAYOUT_COMMANDS = Object.freeze([
  "layoutEnter",
  "layoutExit",
  "layoutSelect",
  ...LAYOUT_MUTATING_COMMANDS,
]);

/** The route `handleLayoutRoutes` serves. */
export const LAYOUT_COMMAND_PATH = "/api/layout/command";

/** Commands that still run while an AI review lock protects the project (the server's set). */
const REVIEW_SAFE_COMMANDS = new Set(["goToPage", "zoom", "pageRail", "notes", "present", "select", "tabSelect"]);

/** The master and layout keys the agent hashes (layout-hand.ts `definitionOf`), in the same order. */
const MASTER_KEYS = ["id", "name", "background", "elements"];
const LAYOUT_KEYS = ["id", "name", "masterId", "showMasterElements", "background", "elements", "slots", "archetype"];

/**
 * @typedef {{ kind: "layout", layoutId: string } | { kind: "master" }} LayoutTarget
 * @typedef {{
 *   enterMaster: (session: any, controlId: string, elementId?: string) => void,
 *   enterLayout: (session: any, controlId: string, layoutId: string, elementId?: string) => void,
 *   exitLayout: (session: any, controlId: string) => void,
 *   selectLayoutSurface: (session: any, controlId: string, target: LayoutTarget) => void,
 *   createLayout: (session: any, controlId: string, name?: string) => string,
 *   renameLayout: (session: any, controlId: string, layoutId: string, name: string) => void,
 *   deleteLayout: (session: any, controlId: string, layoutId: string, confirmed?: boolean) => void,
 *   applyPageLayout: (session: any, controlId: string, layoutId: string | null) => void,
 *   insertPageNumber: (session: any, controlId: string) => string,
 *   renderModel: (session: any) => any,
 *   renderAllPages: (session: any) => unknown,
 * }} LayoutCanvas the canvas-session functions this module calls
 * @typedef {{ canvas: LayoutCanvas }} LayoutNative
 * @typedef {{ masters?: any[], layouts?: any[] }} LayoutDeck
 * @typedef {{
 *   inspectRunLedger: (root: string, epoch: string | undefined, env: NodeJS.ProcessEnv, ledger: any) =>
 *     { initialized: boolean, contextEpochId?: string },
 *   readRunLedger: (root: string) => any,
 *   recordLayoutRevision: (root: string, context: { commandId: string, contextEpochId: string },
 *     input: { scope: "master" | "layout", layoutId: string, layoutSha256: string, source: "editor" }) => unknown,
 *   stableSha256: (value: unknown) => string,
 * }} LayoutLedgerApi the presentation-run functions that record editor layout revisions
 */

/** @type {LayoutLedgerApi} */
const DEFAULT_LEDGER = {
  inspectRunLedger: /** @type {LayoutLedgerApi["inspectRunLedger"]} */ (inspectRunLedger),
  readRunLedger,
  recordLayoutRevision,
  stableSha256,
};

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label}不能为空`);
  return value;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalText(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The command table for one candidate session. Each action changes `session` in place, exactly like
 * the other command handlers in server.mjs.
 * @param {LayoutNative} native
 * @param {Record<string, unknown>} body
 * @param {any} session
 * @returns {[string, () => void][]}
 */
export function layoutCommandActions(native, body, session) {
  const canvas = native.canvas;
  const layoutId = () => requiredText(body.layoutId, "版式编号");
  const master = body.scope === "master";
  return [
    [
      "layoutEnter",
      () =>
        master
          ? canvas.enterMaster(session, LAYOUT_CONTROL.enter, optionalText(body.elementId))
          : canvas.enterLayout(session, LAYOUT_CONTROL.enter, layoutId(), optionalText(body.elementId)),
    ],
    ["layoutExit", () => canvas.exitLayout(session, LAYOUT_CONTROL.exit)],
    [
      "layoutSelect",
      () =>
        canvas.selectLayoutSurface(
          session,
          LAYOUT_CONTROL.select,
          master ? { kind: "master" } : { kind: "layout", layoutId: layoutId() },
        ),
    ],
    ["layoutCreate", () => void canvas.createLayout(session, LAYOUT_CONTROL.create, optionalText(body.name))],
    [
      "layoutRename",
      () => {
        const id = layoutId();
        canvas.renameLayout(session, LAYOUT_CONTROL.rename, id, requiredText(body.name, "版式名称"));
      },
    ],
    ["layoutDelete", () => canvas.deleteLayout(session, LAYOUT_CONTROL.delete, layoutId(), body.confirmed === true)],
    [
      "layoutApply",
      () => {
        const next = body.layoutId === null || body.layoutId === "" ? null : layoutId();
        canvas.applyPageLayout(session, LAYOUT_CONTROL.apply, next);
      },
    ],
    ["insertPageNumber", () => void canvas.insertPageNumber(session, LAYOUT_CONTROL.pageNumber)],
  ];
}

/**
 * The action for one layout command, or undefined when `cmd` is not a layout command. Lets the
 * `/api/command` switch fall through to layout mode from its `default:` branch.
 * @param {LayoutNative} native
 * @param {Record<string, unknown>} body
 * @param {any} session
 * @param {unknown} cmd
 * @returns {(() => void) | undefined}
 */
export function layoutCommandAction(native, body, session, cmd) {
  if (typeof cmd !== "string" || !LAYOUT_COMMANDS.includes(cmd)) return undefined;
  return new Map(layoutCommandActions(native, body, session)).get(cmd);
}

/**
 * Adds a miniature render model of the master and of each layout for the 母版/版式 rail, in list
 * order. Only a layout or master surface lists them, so a page model keeps its shape.
 * @param {{ renderModel: (session: any) => any }} canvas
 * @param {any} session
 * @param {Record<string, unknown>} model the page or layout model the command returns
 * @returns {Record<string, unknown>}
 */
export function withLayoutPreviews(canvas, session, model) {
  if (!session?.surface || session.surface.kind === "page") return model;
  const presentation = session.project.presentation;
  const master = presentation.masters?.[0];
  const surfaces = [
    ...(master ? [{ scope: "master", id: master.id, surface: { kind: "master" } }] : []),
    ...(presentation.layouts ?? []).map((/** @type {any} */ layout) => ({
      scope: "layout",
      id: layout.id,
      surface: { kind: "layout", layoutId: layout.id },
    })),
  ];
  const layoutPreviews = surfaces.map(({ scope, id, surface }) => ({
    scope,
    id,
    model: canvas.renderModel({ ...session, surface, selection: { kind: "none" } }),
  }));
  return { ...model, layoutPreviews };
}

/**
 * The fields of a master or layout that the agent hashes; undefined when the entry is absent.
 * @param {string} scope
 * @param {any} entry
 * @returns {Record<string, unknown> | undefined}
 */
export function picked(scope, entry) {
  if (entry === undefined) return undefined;
  const keys = scope === "master" ? MASTER_KEYS : LAYOUT_KEYS;
  /** @type {Record<string, unknown>} */
  const fields = {};
  for (const key of keys) {
    if (entry[key] !== undefined) fields[key] = entry[key];
  }
  return fields;
}

/**
 * The masters and layouts this command added or changed, in presentation order.
 * @param {LayoutDeck | undefined} before
 * @param {LayoutDeck | undefined} after
 * @returns {{scope: "master" | "layout", entry: any}[]}
 */
export function changedDefinitions(before, after) {
  /** @type {Map<string, any>} */
  const prior = new Map();
  for (const entry of before?.masters ?? []) prior.set(`master/${entry.id}`, entry);
  for (const entry of before?.layouts ?? []) prior.set(`layout/${entry.id}`, entry);
  /** @type {{scope: "master" | "layout", entry: any}[]} */
  const current = [
    ...(after?.masters ?? []).map((entry) => ({ scope: /** @type {const} */ ("master"), entry })),
    ...(after?.layouts ?? []).map((entry) => ({ scope: /** @type {const} */ ("layout"), entry })),
  ];
  return current.filter(({ scope, entry }) => {
    const previous = prior.get(`${scope}/${entry.id}`);
    return JSON.stringify(picked(scope, previous)) !== JSON.stringify(picked(scope, entry));
  });
}

/**
 * Records one `layout.revision-committed {source:"editor"}` for every master or layout that this
 * command added or changed; an unchanged hash keeps the latest fact. A project without a generation
 * ledger, or whose ledger has no revision yet to name a context epoch, records nothing: the first
 * agent run starts that history.
 * @param {string} projectRoot
 * @param {LayoutDeck | undefined} before presentation before the command
 * @param {LayoutDeck | undefined} after presentation after the command
 * @param {LayoutLedgerApi} [ledgerApi] injectable for tests
 * @returns {Promise<number>} how many definitions were offered to the ledger
 */
export async function recordEditorLayoutRevisions(projectRoot, before, after, ledgerApi = DEFAULT_LEDGER) {
  const changed = changedDefinitions(before, after);
  if (changed.length === 0) return 0;
  const root = path.resolve(projectRoot);
  const ledger = ledgerApi.readRunLedger(root);
  if (!ledger) return 0;
  const inspection = ledgerApi.inspectRunLedger(root, undefined, process.env, ledger);
  const contextEpochId = optionalText(inspection.contextEpochId);
  if (!inspection.initialized || !contextEpochId) return 0;
  for (const { scope, entry } of changed) {
    ledgerApi.recordLayoutRevision(
      root,
      { commandId: `editor-layout:${scope}:${entry.id}`, contextEpochId },
      { scope, layoutId: entry.id, layoutSha256: ledgerApi.stableSha256(picked(scope, entry)), source: "editor" },
    );
  }
  return changed.length;
}

/**
 * @typedef {{ session: any, diskRevision: string | null }} LiveEntry
 * @typedef {object} LayoutRouteContext what server.mjs passes in; every helper is its own
 * @property {import("node:http").IncomingMessage} req
 * @property {import("node:http").ServerResponse} res
 * @property {URL} url
 * @property {LayoutNative} native the loaded runtime (`native.canvas` is canvas-session)
 * @property {(res: import("node:http").ServerResponse, status: number, body: unknown) => void} json
 * @property {(req: import("node:http").IncomingMessage) => Promise<any>} readBody
 * @property {(url: URL, body: any, opts?: { strict?: boolean }) => string} projectForRequest
 *   throws an error with `statusCode: 404` for a strict hint that does not resolve
 * @property {(url: URL, body: any) => string} tabIdFor
 * @property {(native: any, projectRoot: string, pageHint: number | undefined, tabId: string) => any} ensureSession
 * @property {(projectRoot: string, tabId: string) => LiveEntry} liveEntryFor
 * @property {(projectRoot: string) => { pagePath?: string } | null | undefined} activeReviewAiLock
 * @property {(projectRoot: string, tabId: string) => void | Promise<void>} guardWrite called before
 *   any layout write touches disk; throw an error carrying `statusCode` (and optional `code`) to refuse
 * @property {(native: any, session: any, projectRoot: string, tabId: string) => unknown} [ensureInitialVersion]
 * @property {(native: any, session: any, projectRoot: string, base: any, tabId: string) => void} persistLiveSession
 * @property {(native: any, session: any) => Record<string, unknown>} liveModel
 * @property {(session: any, projectRoot: string) => void} [rememberPage]
 * @property {LayoutLedgerApi} [ledgerApi] tests only
 */

/**
 * @param {unknown} error
 * @returns {{ statusCode?: unknown, code?: unknown }}
 */
function errorFields(error) {
  return error && typeof error === "object" ? /** @type {any} */ (error) : {};
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} message
 * @param {number} statusCode
 * @param {string} [code]
 */
function routeError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}

/**
 * Reads and checks the request: JSON body, layout cmd, project and tab.
 * @param {LayoutRouteContext} context
 * @returns {Promise<{ body: Record<string, unknown>, cmd: string, projectRoot: string, tabId: string }>}
 */
async function layoutRequest(context) {
  const { req, url } = context;
  /** @type {any} */
  let body;
  try {
    body = await context.readBody(req);
  } catch {
    throw routeError("invalid JSON body", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw routeError("invalid JSON body", 400);
  const cmd = body.cmd;
  if (typeof cmd !== "string" || !LAYOUT_COMMANDS.includes(cmd)) {
    throw routeError(`unknown layout cmd: ${String(cmd)}`, 400, "LAYOUT_COMMAND_UNKNOWN");
  }
  let projectRoot;
  try {
    projectRoot = context.projectForRequest(url, body, { strict: true });
  } catch (error) {
    throw routeError(errorMessage(error), Number(errorFields(error).statusCode) || 404);
  }
  return { body, cmd, projectRoot, tabId: context.tabIdFor(url, body) };
}

/**
 * The refusals that come before any change: the AI review lock (423) and a stale base (409).
 * @param {LayoutRouteContext} context
 * @param {{ body: Record<string, unknown>, cmd: string, projectRoot: string, tabId: string }} request
 * @returns {{ status: number, body: Record<string, unknown> } | undefined}
 */
function preflightRefusal(context, { body, cmd, projectRoot, tabId }) {
  const reviewLock = context.activeReviewAiLock(projectRoot);
  if (reviewLock && !REVIEW_SAFE_COMMANDS.has(cmd)) {
    return {
      status: 423,
      body: {
        error: "AI 正在按批注修改文稿；当前版本已受保护。",
        code: "AI_REVIEW_LOCKED",
        pagePath: reviewLock.pagePath,
      },
    };
  }
  if (!LAYOUT_MUTATING_COMMANDS.includes(cmd)) return undefined;
  const expected = optionalText(typeof body.baseRevision === "string" ? body.baseRevision.trim() : undefined);
  const current = context.liveEntryFor(projectRoot, tabId).diskRevision;
  if (expected && current && expected !== current) {
    return {
      status: 409,
      body: {
        error: "base revision mismatch — reload the deck and retry",
        code: "BASE_REVISION_STALE",
        revision: current,
      },
    };
  }
  return undefined;
}

/**
 * @param {LayoutRouteContext} context
 * @param {any} session
 */
function modelFor(context, session) {
  return withLayoutPreviews(context.native.canvas, session, context.liveModel(context.native, session));
}

/**
 * Runs one layout command on a private candidate and commits it: a deck change persists (after the
 * write guard), a surface move replaces the live session.
 * @param {LayoutRouteContext} context
 * @param {{ body: Record<string, unknown>, cmd: string, projectRoot: string, tabId: string }} request
 * @param {any} baseSession
 */
async function commitLayoutCommand(context, { body, cmd, projectRoot, tabId }, baseSession) {
  const { native } = context;
  const mutates = LAYOUT_MUTATING_COMMANDS.includes(cmd);
  if (mutates) {
    await context.guardWrite(projectRoot, tabId);
    context.ensureInitialVersion?.(native, baseSession, projectRoot, tabId);
  }
  // Mutate a private candidate so a refusal leaves no half-applied state in the live session.
  const session = structuredClone(baseSession);
  layoutCommandAction(native, body, session, cmd)?.();
  if (mutates) {
    context.persistLiveSession(native, session, projectRoot, baseSession, tabId);
    await recordEditorLayoutRevisions(
      projectRoot,
      baseSession.project?.presentation,
      session.project?.presentation,
      context.ledgerApi,
    );
  } else {
    const entry = context.liveEntryFor(projectRoot, tabId);
    if (entry.session !== baseSession) {
      throw routeError("editor session changed while command was running; retry the edit", 409);
    }
    entry.session = session;
  }
  context.rememberPage?.(session, projectRoot);
  return session;
}

/**
 * `POST /api/layout/command` — body `{ cmd, project?, tabId?, baseRevision?, ...args }`, answering
 * `{ ok, revision, model, thumbs }` like `/api/command`. 400 for a bad body or a canvas refusal,
 * 404 for an unknown project, 409 for a stale base or a concurrent edit, 423 under the AI review
 * lock, and the guard's own status when `guardWrite` refuses.
 * @param {LayoutRouteContext} context
 * @returns {Promise<boolean>} true when this module answered the request
 */
export async function handleLayoutRoutes(context) {
  const { req, res, url } = context;
  if (req.method !== "POST" || url.pathname !== LAYOUT_COMMAND_PATH) return false;
  const reply = (/** @type {number} */ status, /** @type {unknown} */ body) => {
    context.json(res, status, body);
    return true;
  };
  let request;
  try {
    request = await layoutRequest(context);
  } catch (error) {
    const fields = errorFields(error);
    return reply(Number(fields.statusCode) || 400, {
      error: errorMessage(error),
      ...(fields.code ? { code: fields.code } : {}),
    });
  }
  const refusal = preflightRefusal(context, request);
  if (refusal) return reply(refusal.status, refusal.body);
  const { projectRoot, tabId } = request;
  const baseSession = await context.ensureSession(context.native, projectRoot, undefined, tabId);
  try {
    const session = await commitLayoutCommand(context, request, baseSession);
    return reply(200, {
      ok: true,
      revision: context.liveEntryFor(projectRoot, tabId).diskRevision,
      model: modelFor(context, session),
      thumbs: context.native.canvas.renderAllPages(session),
    });
  } catch (error) {
    const fields = errorFields(error);
    const status = Number(fields.statusCode);
    const errorSession = context.liveEntryFor(projectRoot, tabId).session ?? baseSession;
    return reply([409, 403, 423, 503].includes(status) ? status : 400, {
      error: errorMessage(error),
      ...(fields.code ? { code: fields.code } : {}),
      revision: context.liveEntryFor(projectRoot, tabId).diskRevision,
      model: modelFor(context, errorSession),
    });
  }
}
