import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { proxyToSidecar, startEditorSidecar } from "./editor-sidecar.js";
import { resolveDataDirectory } from "./data-directory.js";
import { waitForEditor } from "./sidecar-ready.js";
import type { ChildProcess } from "node:child_process";
import { apply as applySlidesHost } from "@open-slidestudio/dsh-slides-host";
import { logger } from "./logger.js";
import { registerSlidesPreset } from "./slides-preset.js";

/** Cross-package Context shape; cordis is shared at runtime, types differ. */
const applySlidesHostAny = applySlidesHost as unknown as (ctx: Context, config: {
  workspaceRoot?: string;
  dataRoot?: string;
  editorBaseUrl?: string;
  personal?: boolean;
}) => void;

export const name = "dsh-slidestudio";
// slides-host services are injected through this wrapper so activation ordering
// keeps `webServer`/`agents`/`llm` ready before the slice API mounts.
export const inject = [
  "webServer",
  "connection",
  "tools",
  "agents",
  "attachments",
  "llm",
];

// Local service surface — the dev cordis package lacks the Host's augmentations,
// so declare the ones this entry touches.
declare module "@deepseek-ai/cordis" {
  interface Context {
    webServer: {
      /** The listening port (set once the service has activated). */
      readonly port?: number;
      register(route: {
        kind: "exact" | "prefix";
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
      }): () => void;
    };
  }
}

type ConnectionLike = {
  requestRejection?: (req: IncomingMessage) => number | undefined;
};

const EDITOR_PORT = Number(process.env.SLIDES_EDITOR_PORT ?? "56200");
const SIDECAR_RESTART_COOLDOWN_MS = 2_000;

type StartSidecar = (repoRoot: string, dataRoot: string, port: number) => ChildProcess | undefined;
type WaitSidecar = (origin: string) => Promise<boolean>;

export type EditorSupervisor = {
  origin: () => string;
  ensure: () => Promise<boolean>;
  stop: () => Promise<void>;
};

const SIDECAR_KILL_GRACE_MS = 200;

/** `killed` only means a signal was delivered. A child that ignores SIGTERM is still alive. */
function processAlive(proc: ChildProcess | undefined): proc is ChildProcess {
  return proc != null && proc.exitCode == null && proc.signalCode == null;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Restart the editor after an unexpected exit instead of latching the first failure. */
export function createEditorSupervisor(options: {
  repoRoot: string;
  dataRoot: string;
  port: number;
  cooldownMs?: number;
  killGraceMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  start?: StartSidecar;
  wait?: WaitSidecar;
}): EditorSupervisor {
  const cooldownMs = options.cooldownMs ?? SIDECAR_RESTART_COOLDOWN_MS;
  const killGraceMs = options.killGraceMs ?? SIDECAR_KILL_GRACE_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const start = options.start ?? startEditorSidecar;
  const wait = options.wait ?? ((origin: string) => waitForEditor(origin));
  let child: ChildProcess | undefined;
  let port = options.port;
  let origin = `http://127.0.0.1:${port}`;
  let pending: Promise<boolean> | undefined;
  let cooldownUntil = 0;
  let ticket = 0;
  let launching: Promise<boolean> | undefined;
  let disposed = false;
  let cooldownAbort: AbortController | undefined;
  const owned = new Set<ChildProcess>();
  const reaping = new Map<ChildProcess, Promise<void>>();

  const resetPort = () => {
    port = options.port;
    origin = `http://127.0.0.1:${port}`;
  };
  const armCooldown = () => {
    cooldownUntil = now() + cooldownMs;
  };
  const releaseCurrent = (proc: ChildProcess) => {
    if (child === proc) child = undefined;
    pending = undefined;
    resetPort();
    armCooldown();
  };
  const exitedWithin = (proc: ChildProcess, ms: number) => new Promise<boolean>((resolve) => {
    if (!processAlive(proc)) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      resolve(!processAlive(proc));
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    proc.once("exit", onExit);
  });
  const reap = (proc: ChildProcess | undefined): Promise<void> => {
    if (!proc) return Promise.resolve();
    const existing = reaping.get(proc);
    if (existing) return existing;
    const job = (async () => {
      if (!processAlive(proc)) return;
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      if (processAlive(proc) && !await exitedWithin(proc, killGraceMs)) {
        if (processAlive(proc)) {
          try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        }
        await exitedWithin(proc, killGraceMs);
      }
    })().finally(() => {
      reaping.delete(proc);
      owned.delete(proc);
      if (child === proc) child = undefined;
    });
    reaping.set(proc, job);
    return job;
  };
  const launch = (): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    resetPort();
    const spawned = start(options.repoRoot, options.dataRoot, port);
    if (disposed) {
      if (spawned) {
        owned.add(spawned);
        void reap(spawned);
      }
      return Promise.resolve(false);
    }
    if (!spawned) {
      armCooldown();
      pending = undefined;
      return Promise.resolve(false);
    }
    child = spawned;
    owned.add(spawned);
    const mine = ++ticket;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolveLaunch(ok);
    };
    let resolveLaunch: (ok: boolean) => void = () => {};
    const result = new Promise<boolean>((resolve) => {
      resolveLaunch = resolve;
    });
    spawned.on("exit", () => {
      owned.delete(spawned);
      if (!disposed && mine === ticket) releaseCurrent(spawned);
      finish(false);
    });
    void wait(origin).then(async (ok) => {
      if (settled) return;
      if (disposed || mine !== ticket) {
        finish(false);
        if (processAlive(spawned)) await reap(spawned);
        return;
      }
      if (ok) {
        finish(true);
        return;
      }
      ticket += 1;
      releaseCurrent(spawned);
      await reap(spawned);
      finish(false);
    });
    pending = result;
    return result;
  };

  return {
    origin: () => origin,
    ensure() {
      if (disposed) return Promise.resolve(false);
      if (processAlive(child) && pending) return pending;
      if (launching) return launching;
      const epoch = ticket;
      const controller = new AbortController();
      cooldownAbort = controller;
      launching = (async () => {
        const delay = cooldownUntil - now();
        if (delay > 0) await sleep(delay, controller.signal);
        if (disposed || epoch !== ticket || controller.signal.aborted) return false;
        if (processAlive(child) && pending) return pending;
        return launch();
      })().finally(() => {
        if (cooldownAbort === controller) cooldownAbort = undefined;
        launching = undefined;
      });
      return launching;
    },
    stop() {
      disposed = true;
      ticket += 1;
      cooldownAbort?.abort();
      cooldownAbort = undefined;
      const procs = new Set<ChildProcess>(owned);
      if (child) procs.add(child);
      for (const proc of reaping.keys()) procs.add(proc);
      child = undefined;
      pending = undefined;
      resetPort();
      return Promise.all([...procs].map((proc) => reap(proc))).then(() => undefined);
    },
  };
}

function editorUnavailable(res: ServerResponse) {
  res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
  res.end("SlideStudio editor is restarting. Retry this request.");
}

export function apply(ctx: Context) {
  // Packaged install: <pkg>/lib/dsh-slidestudio.js ships apps/, packages/,
  // vendor/ inside the package root. Dev checkout: <plugin>/lib/… is one level
  // below the repo root, so fall back to the parent directory.
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const checkoutRoot = fileURLToPath(new URL("../..", import.meta.url));
  const repoRoot = resolve(
    existsSync(join(packageRoot, "apps/native-web/src/server.mjs"))
      ? packageRoot
      : checkoutRoot,
  );
  const editorOrigin = `http://127.0.0.1:${EDITOR_PORT}`;
  const home = (ctx.get("profileContext") as { home?: string } | undefined)?.home
    || process.env.DSH_HOME || join(homedir(), ".dsh");
  const dataRoot = resolveDataDirectory(repoRoot, home, process.env.SLIDESTUDIO_DATA_DIR);

  registerSlidesPreset(ctx);
  applySlidesHostAny(ctx, {
    workspaceRoot: repoRoot,
    dataRoot,
    editorBaseUrl: editorOrigin,
    personal: true,
  });

  const supervisor = createEditorSupervisor({
    repoRoot,
    dataRoot,
    port: EDITOR_PORT,
  });
  ctx.effect(() => () => {
    supervisor.stop();
  });

  ctx.effect(() => {
    const connection = ctx.get("connection") as ConnectionLike | undefined;
    const stops: Array<() => void> = [];
    // The real create hub and editor live on the sidecar; expose them under the
    // same-origin /app, /media, /runtime prefixes the product shell uses, so the
    // Personal feature can frame hub.html without cross-origin CSP issues.
    for (const prefix of ["/app", "/media", "/runtime"]) {
      stops.push(
        ctx.webServer.register({
          kind: "prefix",
          path: prefix,
          handler: async (req: IncomingMessage, res: ServerResponse) => {
            logger.observe(req, res);
            const rejection = connection?.requestRejection?.(req);
            if (rejection !== undefined) {
              res.writeHead(rejection);
              res.end("Access denied");
              return;
            }
            if (!await supervisor.ensure()) {
              editorUnavailable(res);
              return;
            }
            if (req.destroyed || res.destroyed) return;
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            // /app is the product-shell prefix the sidecar does not know; strip
            // it. /media and /runtime are real sidecar routes — forward intact.
            const rest = prefix === "/app" ? url.pathname.slice(prefix.length) || "/" : url.pathname;
            req.url = `${rest}${url.search}`;
            proxyToSidecar(req, res, supervisor.origin());
          },
        }),
      );
    }
    stops.push(
      ctx.webServer.register({
        kind: "exact",
        path: "/personal/slides/editor",
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          logger.observe(req, res);
          const rejection = connection?.requestRejection?.(req);
          if (rejection !== undefined) {
            res.writeHead(rejection);
            res.end("Access denied");
            return;
          }
          if (!await supervisor.ensure()) {
            editorUnavailable(res);
            return;
          }
          const url = new URL(req.url ?? "/personal/slides/editor", "http://127.0.0.1");
          const project = url.searchParams.get("project") ?? "";
          const target = new URL("/index.html", supervisor.origin());
          target.searchParams.set("workspace", "1");
          if (project) target.searchParams.set("project", project);
          res.writeHead(302, { location: target.href });
          res.end();
        },
      }),
    );
    return () => {
      for (const stop of stops) stop();
    };
  });

  logger.log("info", "plugin_loaded");
}
