/**
 * Pi login as Pi itself does it:
 *   1. Product path: Hub writes ~/.pi/agent/auth.json (API key or OAuth)
 *   2. Developer last resort: provider env vars (GEMINI_API_KEY, ANTHROPIC_API_KEY, …)
 * The host LLM key (SLIDESTUDIO_LLM_API_KEY) is not Pi. Never map it.
 * Never log or return secret values.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PiAuthKind = "oauth" | "api_key" | "none";
export type PiAuthSource = "auth.json" | "env" | "none";

export type PiStoredAuth = {
  providerId: string;
  type: "oauth" | "api_key";
};

export type PiAuthStatus = {
  ready: boolean;
  kind: PiAuthKind;
  source: PiAuthSource;
  provider?: string;
  note: string;
};

/** Env keys Pi's built-in providers already read. Do not invent new names. */
const PROVIDER_ENV_KEYS: Record<string, readonly string[]> = {
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  xai: ["XAI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
};

export function piAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.SLIDESTUDIO_PI_AUTH_PATH?.trim();
  if (explicit) return explicit;
  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) return path.join(agentDir, "auth.json");
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  return path.join(home, ".pi", "agent", "auth.json");
}

/**
 * Provider ids + auth type only. Drops key / access / refresh.
 */
export function listPiStoredAuth(env: NodeJS.ProcessEnv = process.env): PiStoredAuth[] {
  const file = piAuthPath(env);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const out: PiStoredAuth[] = [];
    for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!providerId.trim() || !value || typeof value !== "object") continue;
      const type = (value as { type?: unknown }).type;
      if (type === "oauth" || type === "api_key") {
        out.push({ providerId, type });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function envHasProviderKey(env: NodeJS.ProcessEnv, provider: string): boolean {
  const keys = PROVIDER_ENV_KEYS[provider] ?? [];
  return keys.some((name) => Boolean(env[name]?.trim()));
}

/**
 * Provider for `pi --provider`.
 * Explicit env wins. Else Hub /login store (OAuth first). Else a native Pi env key.
 * Do not infer from the host LLM chat URL — that is not Pi.
 */
export function inferPiProvider(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.SLIDESTUDIO_PI_PROVIDER?.trim();
  if (explicit) return explicit;
  const stored = listPiStoredAuth(env);
  const oauth = stored.filter((row) => row.type === "oauth");
  const grok = oauth.find((row) => row.providerId === "xai-auth" || row.providerId === "xai");
  if (grok) return grok.providerId;
  if (oauth[0]) return oauth[0]!.providerId;
  if (stored[0]) return stored[0].providerId;
  for (const [provider, keys] of Object.entries(PROVIDER_ENV_KEYS)) {
    if (keys.some((name) => Boolean(env[name]?.trim()))) return provider;
  }
  return undefined;
}

export function resolvePiAuth(env: NodeJS.ProcessEnv = process.env): PiAuthStatus {
  const stored = listPiStoredAuth(env);
  const provider = inferPiProvider(env);
  const storedHit = provider ? stored.find((row) => row.providerId === provider) : stored[0];
  if (storedHit) {
    return {
      ready: true,
      kind: storedHit.type,
      source: "auth.json",
      provider: storedHit.providerId,
      note:
        storedHit.type === "oauth"
          ? `Pi /login OAuth (${storedHit.providerId})`
          : `Pi /login API key (${storedHit.providerId})`,
    };
  }
  const viaEnv = provider && envHasProviderKey(env, provider);
  if (viaEnv && env.SLIDESTUDIO_PI_ALLOW_ENV === "1") {
    return {
      ready: true,
      kind: "api_key",
      source: "env",
      provider,
      note: `开发者环境变量（${provider}）。不是产品登录。`,
    };
  }
  return {
    ready: false,
    kind: "none",
    source: "none",
    provider,
    note: "未登录。请在创建页登录。",
  };
}

/** Resolve the credential for the provider the user actually selected. */
export function resolvePiAuthForProvider(
  providerId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PiAuthStatus {
  const id = providerId?.trim();
  if (!id) return resolvePiAuth(env);
  const stored = listPiStoredAuth(env).find((row) => row.providerId === id);
  if (stored) {
    return {
      ready: true,
      kind: stored.type,
      source: "auth.json",
      provider: stored.providerId,
      note:
        stored.type === "oauth" ? `Pi /login OAuth (${stored.providerId})` : `Pi /login API key (${stored.providerId})`,
    };
  }
  if (env.SLIDESTUDIO_PI_ALLOW_ENV === "1" && envHasProviderKey(env, id)) {
    return {
      ready: true,
      kind: "api_key",
      source: "env",
      provider: id,
      note: `开发者环境变量（${id}）。不是产品登录。`,
    };
  }
  return {
    ready: false,
    kind: "none",
    source: "none",
    provider: id,
    note: `供应商 ${id} 尚未登录。`,
  };
}

/** Hub / health: a stranger is logged in only after BYOK or OAuth wrote auth.json. */
export function productPiAuth(auth: PiAuthStatus): PiAuthStatus {
  if (auth.source === "auth.json" && auth.ready) return auth;
  return {
    ready: false,
    kind: "none",
    source: "none",
    note: "未登录。请在创建页登录。",
  };
}

/**
 * Env passed into `pi --mode rpc`.
 * Never copy SLIDESTUDIO_LLM_API_KEY onto GEMINI_API_KEY.
 * Native GEMINI_* stay only when a developer opts in (`SLIDESTUDIO_PI_ALLOW_ENV=1`).
 * Product generate reads Hub auth.json.
 */
export function piAuthEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  delete next.SLIDESTUDIO_LLM_API_KEY;
  if (env.SLIDESTUDIO_PI_ALLOW_ENV !== "1") {
    delete next.GEMINI_API_KEY;
    delete next.GOOGLE_API_KEY;
  }
  return next;
}

/** Product generate: Hub wrote auth.json. Env is opt-in for developers. */
export function piProductLoginReady(auth: PiAuthStatus, env: NodeJS.ProcessEnv = process.env): boolean {
  if (auth.source === "auth.json" && auth.ready) return true;
  return env.SLIDESTUDIO_PI_ALLOW_ENV === "1" && auth.source === "env" && auth.ready;
}

/** Product generate must authenticate the selected provider, not merely any provider. */
export function piProviderLoginReady(providerId: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return piProductLoginReady(resolvePiAuthForProvider(providerId, env), env);
}

export function formatPiAuthChip(available: boolean, auth: PiAuthStatus): string {
  if (!available) return "Pi · 未安装";
  if (auth.kind === "oauth") return "Pi · OAuth";
  if (auth.kind === "api_key" && auth.source === "auth.json") return "Pi · API 登录";
  if (auth.kind === "api_key" && auth.source === "env") return "Pi · 环境变量";
  return "Pi · 未登录";
}
