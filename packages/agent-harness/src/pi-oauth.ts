/**
 * Drive Pi's own OAuth login (ModelRuntime.login) from the Hub.
 * Events go to the browser; secrets stay in auth.json.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { piAuthPath, resolvePiAuth, type PiAuthStatus } from "./pi-auth.js";
import { PI_LOGIN_PROVIDERS } from "./pi-login.js";
import { findPiSdkRoot } from "./pi-available.js";
import { resolveXaiAuthExtension } from "./pi-rpc.js";

export type PiOAuthPrompt = {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
};

export type PiOAuthEvent = {
  type: string;
  message?: string;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
};

export type PiOAuthSessionView = {
  id: string;
  providerId: string;
  status: "running" | "need_input" | "done" | "error";
  events: PiOAuthEvent[];
  prompt?: PiOAuthPrompt;
  error?: string;
  auth?: PiAuthStatus;
};

type Pending = {
  providerId: string;
  events: PiOAuthEvent[];
  status: PiOAuthSessionView["status"];
  prompt?: PiOAuthPrompt;
  error?: string;
  resolvePrompt?: (value: string) => void;
  rejectPrompt?: (err: Error) => void;
  abort: AbortController;
};

const sessions = new Map<string, Pending>();

async function loadModelRuntime(env: NodeJS.ProcessEnv, providerId: string) {
  const root = findPiSdkRoot(env);
  if (!root) {
    throw new Error("Repository-pinned Pi SDK is unavailable — run npm install, then npm run pi:verify");
  }
  const href = pathToFileURL(path.join(root, "dist", "index.js")).href;
  const mod = (await import(href)) as {
    ModelRuntime: {
      create: (opts: { authPath: string; refreshOnCreate?: boolean; allowModelNetwork?: boolean }) => Promise<{
        registerProvider: (providerId: string, config: unknown) => void;
        refresh: (options: { allowNetwork: boolean }) => Promise<unknown>;
        getProvider: (providerId: string) => unknown;
        login: (
          providerId: string,
          type: "oauth",
          interaction: {
            signal: AbortSignal;
            prompt: (p: Record<string, unknown>) => Promise<string>;
            notify: (event: Record<string, unknown>) => void;
          },
        ) => Promise<unknown>;
      }>;
    };
  };
  const modelRuntime = await mod.ModelRuntime.create({
    authPath: piAuthPath(env),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  if (providerId === "xai-auth") {
    const extension = resolveXaiAuthExtension(env);
    if (!extension) {
      throw new Error("xAI OAuth extension is unavailable — install pi-xai-oauth first");
    }
    const loaderHref = pathToFileURL(path.join(root, "dist", "core", "extensions", "loader.js")).href;
    const loader = (await import(loaderHref)) as {
      loadExtensions: (
        paths: string[],
        cwd: string,
      ) => Promise<{
        errors: Array<{ error?: string }>;
        runtime: {
          pendingProviderRegistrations: Array<{
            name: string;
            config: unknown;
          }>;
        };
      }>;
    };
    const loaded = await loader.loadExtensions([extension], process.cwd());
    if (loaded.errors.length) {
      const detail = loaded.errors.map((row) => row.error || "unknown extension error").join("; ");
      throw new Error(`xAI OAuth extension failed to load: ${detail}`);
    }
    for (const registration of loaded.runtime.pendingProviderRegistrations) {
      modelRuntime.registerProvider(registration.name, registration.config);
    }
    loaded.runtime.pendingProviderRegistrations = [];
    await modelRuntime.refresh({ allowNetwork: false });
    if (!modelRuntime.getProvider(providerId)) {
      throw new Error("xAI OAuth extension did not register provider xai-auth");
    }
  }
  return modelRuntime;
}

function viewOf(id: string, env: NodeJS.ProcessEnv): PiOAuthSessionView {
  const row = sessions.get(id);
  if (!row) {
    return { id, providerId: "", status: "error", events: [], error: "unknown oauth session" };
  }
  return {
    id,
    providerId: row.providerId,
    status: row.status,
    events: row.events,
    prompt: row.prompt,
    error: row.error,
    auth: resolvePiAuth(env),
  };
}

export function getPiOAuthSession(id: string, env: NodeJS.ProcessEnv = process.env): PiOAuthSessionView {
  return viewOf(id, env);
}

export function cancelPiOAuth(id: string): void {
  const row = sessions.get(id);
  if (!row) return;
  row.abort.abort();
  row.rejectPrompt?.(new Error("cancelled"));
  sessions.delete(id);
}

export function answerPiOAuth(id: string, value: string): PiOAuthSessionView {
  const row = sessions.get(id);
  if (!row) throw new Error("unknown oauth session");
  if (!row.resolvePrompt) throw new Error("oauth session is not waiting for input");
  const answer = value.trim();
  if (!answer) throw new Error("empty oauth answer");
  const resolve = row.resolvePrompt;
  row.resolvePrompt = undefined;
  row.rejectPrompt = undefined;
  row.prompt = undefined;
  row.status = "running";
  resolve(answer);
  return viewOf(id, process.env);
}

export async function startPiOAuth(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PiOAuthSessionView> {
  const id = providerId.trim();
  const offer = PI_LOGIN_PROVIDERS.find((row) => row.id === id);
  if (!offer) throw new Error(`unknown Pi provider: ${id}`);
  if (!offer.methods.includes("oauth")) {
    throw new Error(`${id} has no OAuth — use an API key`);
  }
  const sessionId = randomUUID();
  const abort = new AbortController();
  const pending: Pending = {
    providerId: id,
    events: [],
    status: "running",
    abort,
  };
  sessions.set(sessionId, pending);

  const run = async () => {
    try {
      const runtime = await loadModelRuntime(env, id);
      await runtime.login(id, "oauth", {
        signal: abort.signal,
        notify(event) {
          const rec = event as PiOAuthEvent;
          pending.events.push({
            type: String(rec.type || "info"),
            message: typeof rec.message === "string" ? rec.message : undefined,
            url: typeof rec.url === "string" ? rec.url : undefined,
            instructions: typeof rec.instructions === "string" ? rec.instructions : undefined,
            userCode: typeof rec.userCode === "string" ? rec.userCode : undefined,
            verificationUri: typeof rec.verificationUri === "string" ? rec.verificationUri : undefined,
          });
        },
        prompt(p) {
          return new Promise<string>((resolve, reject) => {
            if (abort.signal.aborted) {
              reject(new Error("cancelled"));
              return;
            }
            pending.status = "need_input";
            pending.prompt = {
              type: (p.type as PiOAuthPrompt["type"]) || "text",
              message: String(p.message || "Continue"),
              placeholder: typeof p.placeholder === "string" ? p.placeholder : undefined,
              options: Array.isArray(p.options) ? (p.options as PiOAuthPrompt["options"]) : undefined,
            };
            pending.resolvePrompt = resolve;
            pending.rejectPrompt = reject;
            abort.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
              once: true,
            });
          });
        },
      });
      pending.status = "done";
      pending.prompt = undefined;
    } catch (err) {
      pending.status = "error";
      pending.error = err instanceof Error ? err.message : String(err);
    }
  };
  void run();
  return viewOf(sessionId, env);
}
