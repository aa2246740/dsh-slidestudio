import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { proxyToSidecar, startEditorSidecar } from "./editor-sidecar.js";
import { resolveDataDirectory } from "./data-directory.js";
import { waitForEditor } from "./sidecar-ready.js";
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

  const sidecar = startEditorSidecar(repoRoot, dataRoot, EDITOR_PORT);
  const editorReady = sidecar ? waitForEditor(editorOrigin) : Promise.resolve(false);
  ctx.effect(() => () => {
    if (sidecar && !sidecar.killed) sidecar.kill("SIGTERM");
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
            if (!await editorReady) {
              res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
              res.end("SlideStudio editor could not start. Disable and enable the plugin to retry.");
              return;
            }
            if (req.destroyed || res.destroyed) return;
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            // /app is the product-shell prefix the sidecar does not know; strip
            // it. /media and /runtime are real sidecar routes — forward intact.
            const rest = prefix === "/app" ? url.pathname.slice(prefix.length) || "/" : url.pathname;
            req.url = `${rest}${url.search}`;
            proxyToSidecar(req, res, editorOrigin);
          },
        }),
      );
    }
    stops.push(
      ctx.webServer.register({
        kind: "exact",
        path: "/personal/slides/editor",
        handler: (req: IncomingMessage, res: ServerResponse) => {
          logger.observe(req, res);
          const rejection = connection?.requestRejection?.(req);
          if (rejection !== undefined) {
            res.writeHead(rejection);
            res.end("Access denied");
            return;
          }
          const url = new URL(req.url ?? "/personal/slides/editor", "http://127.0.0.1");
          const project = url.searchParams.get("project") ?? "";
          const target = new URL("/index.html", editorOrigin);
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
