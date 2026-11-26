/**
 * Product login for Pi: Hub writes the same ~/.pi/agent/auth.json
 * that `pi /login` uses. Never returns secret values.
 */
import fs from "node:fs";
import path from "node:path";
import { listPiStoredAuth, piAuthPath, productPiAuth, resolvePiAuth, type PiAuthStatus } from "./pi-auth.js";
import { findPiSdkRoot } from "./pi-available.js";

export type PiLoginMethod = "api_key" | "oauth";

export type PiLoginProvider = {
  id: string;
  name: string;
  methods: PiLoginMethod[];
  note: string;
  /** Credential was discovered in Pi but this product does not create it. */
  existingOnly?: boolean;
};

/** Built-in Pi providers the Hub may offer. No Kimi-branded option. */
export const PI_LOGIN_PROVIDERS: readonly PiLoginProvider[] = [
  {
    id: "google",
    name: "Google Gemini",
    methods: ["api_key"],
    note: "只有 API key。Pi 没有 Gemini 网页 OAuth。",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    methods: ["api_key", "oauth"],
    note: "API key，或 Claude Pro/Max 订阅 OAuth。",
  },
  {
    id: "openai",
    name: "OpenAI",
    methods: ["api_key"],
    note: "平台 API key。ChatGPT 订阅走 Codex。",
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    methods: ["oauth"],
    note: "ChatGPT Plus/Pro 订阅。",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    methods: ["api_key", "oauth"],
    note: "Token，或 Copilot 订阅 device code。",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    methods: ["api_key"],
    note: "OpenRouter API key。",
  },
  {
    id: "xai",
    name: "xAI",
    methods: ["api_key"],
    note: "xAI 平台 API key。",
  },
  {
    id: "xai-auth",
    name: "xAI Grok",
    methods: ["oauth"],
    note: "复用 Grok CLI 登录，或使用 xAI 订阅 OAuth。",
  },
  { id: "deepseek", name: "DeepSeek", methods: ["api_key"], note: "DeepSeek API key。" },
  { id: "moonshotai", name: "Moonshot AI", methods: ["api_key"], note: "Moonshot API key。" },
  {
    id: "moonshotai-cn",
    name: "Moonshot AI 中国",
    methods: ["api_key"],
    note: "Moonshot 中国区 API key。",
  },
  { id: "minimax", name: "MiniMax", methods: ["api_key"], note: "MiniMax API key。" },
  {
    id: "minimax-cn",
    name: "MiniMax 中国",
    methods: ["api_key"],
    note: "MiniMax 中国区 API key。",
  },
  { id: "nvidia", name: "NVIDIA NIM", methods: ["api_key"], note: "NVIDIA API key。" },
  { id: "mistral", name: "Mistral", methods: ["api_key"], note: "Mistral API key。" },
  { id: "groq", name: "Groq", methods: ["api_key"], note: "Groq API key。" },
  { id: "cerebras", name: "Cerebras", methods: ["api_key"], note: "Cerebras API key。" },
  { id: "huggingface", name: "Hugging Face", methods: ["api_key"], note: "Hugging Face token。" },
  { id: "zai", name: "Z.AI", methods: ["api_key"], note: "Z.AI API key。" },
];

const STORED_PROVIDER_NAMES: Record<string, string> = {};

export function listPiLoginProviders(env: NodeJS.ProcessEnv = process.env): PiLoginProvider[] {
  const rows = PI_LOGIN_PROVIDERS.map((row) => ({ ...row, methods: [...row.methods] }));
  const known = new Set(rows.map((row) => row.id));
  for (const stored of listPiStoredAuth(env)) {
    if (known.has(stored.providerId)) continue;
    rows.push({
      id: stored.providerId,
      name: STORED_PROVIDER_NAMES[stored.providerId] ?? stored.providerId,
      methods: [stored.type],
      note: "复用这台电脑上已有的 Pi 登录。",
      existingOnly: true,
    });
  }
  return rows;
}

function readAuthFile(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return { ...(raw as Record<string, unknown>) };
  } catch {
    return {};
  }
}

function writeAuthFile(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function savePiApiKey(providerId: string, key: string, env: NodeJS.ProcessEnv = process.env): PiAuthStatus {
  const id = providerId.trim();
  const offer = PI_LOGIN_PROVIDERS.find((row) => row.id === id);
  if (!offer) throw new Error(`unknown Pi provider: ${id}`);
  if (!offer.methods.includes("api_key")) {
    throw new Error(`${id} does not accept an API key — use OAuth`);
  }
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is empty");
  const file = piAuthPath(env);
  const data = readAuthFile(file);
  data[id] = { type: "api_key", key: trimmed };
  writeAuthFile(file, data);
  return resolvePiAuth(env);
}

export function logoutPiProvider(providerId: string, env: NodeJS.ProcessEnv = process.env): PiAuthStatus {
  const id = providerId.trim();
  const file = piAuthPath(env);
  const data = readAuthFile(file);
  delete data[id];
  writeAuthFile(file, data);
  return resolvePiAuth(env);
}

export function piLoginSnapshot(env: NodeJS.ProcessEnv = process.env): {
  auth: PiAuthStatus;
  stored: ReturnType<typeof listPiStoredAuth>;
  providers: PiLoginProvider[];
  authPath: string;
  oauthAvailable: boolean;
} {
  return {
    auth: productPiAuth(resolvePiAuth(env)),
    stored: listPiStoredAuth(env),
    providers: listPiLoginProviders(env),
    authPath: piAuthPath(env),
    oauthAvailable: Boolean(findPiSdkRoot(env)),
  };
}
