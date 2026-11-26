import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatPiAuthChip,
  inferPiProvider,
  listPiStoredAuth,
  piAuthEnv,
  piAuthPath,
  piProviderLoginReady,
  piProductLoginReady,
  productPiAuth,
  resolvePiAuth,
  resolvePiAuthForProvider,
} from "./pi-auth.js";

function tmpStore(data: Record<string, { type: "oauth" | "api_key"; key?: string }>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auth-"));
  const file = path.join(dir, "auth.json");
  fs.writeFileSync(file, `${JSON.stringify(data)}\n`);
  return { dir, file, env: { HOME: dir, SLIDESTUDIO_PI_AUTH_PATH: file } };
}

describe("pi native login store", () => {
  it("reads provider type from auth.json and drops secrets", () => {
    const { env } = tmpStore({
      anthropic: { type: "oauth", key: "should-not-appear" },
    });
    const rows = listPiStoredAuth(env);
    assert.deepEqual(rows, [{ providerId: "anthropic", type: "oauth" }]);
    assert.equal(inferPiProvider(env), "anthropic");
    const status = resolvePiAuth(env);
    assert.equal(status.ready, true);
    assert.equal(status.kind, "oauth");
    assert.equal(status.source, "auth.json");
    assert.doesNotMatch(JSON.stringify(status), /should-not-appear/);
    assert.equal(formatPiAuthChip(true, status), "Pi · OAuth");
  });

  it("prefers Grok OAuth over Codex when both are stored", () => {
    const { env } = tmpStore({
      "openai-codex": { type: "oauth" },
      "xai-auth": { type: "oauth" },
    });
    assert.equal(inferPiProvider(env), "xai-auth");
    assert.equal(resolvePiAuthForProvider("openai-codex", env).provider, "openai-codex");
    assert.equal(piProviderLoginReady("openai-codex", env), true);
    assert.equal(piProviderLoginReady("google", env), false);
  });

  it("prefers stored OAuth over a Gemini chat URL", () => {
    const { env } = tmpStore({
      "openai-codex": { type: "oauth" },
    });
    const merged = {
      ...env,
      SLIDESTUDIO_LLM_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai",
    };
    assert.equal(inferPiProvider(merged), "openai-codex");
  });

  it("lets SLIDESTUDIO_PI_PROVIDER win over the store", () => {
    const { env } = tmpStore({ anthropic: { type: "oauth" } });
    assert.equal(inferPiProvider({ ...env, SLIDESTUDIO_PI_PROVIDER: "google" }), "google");
  });

  it("does not map the host Gemini key when /login already stored Google", () => {
    const { env } = tmpStore({ google: { type: "api_key", key: "stored" } });
    const out = piAuthEnv({
      ...env,
      SLIDESTUDIO_LLM_API_KEY: "host-key",
    });
    assert.equal(out.GEMINI_API_KEY, undefined);
    assert.equal(out.GOOGLE_API_KEY, undefined);
  });

  it("does not map the host Gemini key when the store picked Anthropic", () => {
    const { env } = tmpStore({ anthropic: { type: "oauth" } });
    const out = piAuthEnv({
      ...env,
      SLIDESTUDIO_LLM_API_KEY: "host-key",
    });
    assert.equal(out.GEMINI_API_KEY, undefined);
  });

  it("does not treat the host LLM key as Pi login", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auth-empty-"));
    const env = {
      HOME: dir,
      SLIDESTUDIO_PI_AUTH_PATH: path.join(dir, "missing.json"),
      SLIDESTUDIO_LLM_API_KEY: "host-key",
    };
    const out = piAuthEnv(env);
    assert.equal(out.GEMINI_API_KEY, undefined);
    const status = resolvePiAuth(env);
    assert.equal(status.ready, false);
    assert.equal(status.source, "none");
    assert.equal(formatPiAuthChip(true, status), "Pi · 未登录");
  });

  it("reports 未登录 when binary is present but nothing is configured", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auth-none-"));
    const status = resolvePiAuth({
      HOME: dir,
      SLIDESTUDIO_PI_AUTH_PATH: path.join(dir, "missing.json"),
    });
    assert.equal(status.ready, false);
    assert.equal(formatPiAuthChip(true, status), "Pi · 未登录");
    assert.equal(formatPiAuthChip(false, status), "Pi · 未安装");
  });

  it("treats auth.json as product login and env as opt-in only", () => {
    const { env } = tmpStore({ google: { type: "api_key", key: "stored" } });
    const loggedIn = resolvePiAuth(env);
    assert.equal(piProductLoginReady(loggedIn, env), true);
    const envOnly = resolvePiAuth({
      HOME: env.HOME,
      SLIDESTUDIO_PI_AUTH_PATH: path.join(env.HOME!, "missing.json"),
      GEMINI_API_KEY: "dev",
    });
    assert.equal(envOnly.ready, false);
    assert.equal(envOnly.source, "none");
    assert.equal(productPiAuth(envOnly).ready, false);
    assert.equal(piProductLoginReady(envOnly, {}), false);
    const envAllowed = resolvePiAuth({
      HOME: env.HOME,
      SLIDESTUDIO_PI_AUTH_PATH: path.join(env.HOME!, "missing.json"),
      GEMINI_API_KEY: "dev",
      SLIDESTUDIO_PI_ALLOW_ENV: "1",
    });
    assert.equal(envAllowed.source, "env");
    assert.equal(piProductLoginReady(envAllowed, { SLIDESTUDIO_PI_ALLOW_ENV: "1" }), true);
    assert.equal(productPiAuth(envAllowed).ready, false);
  });

  it("does not treat a host LLM key or leftover Gemini env as Hub login", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auth-host-"));
    const status = resolvePiAuth({
      HOME: dir,
      SLIDESTUDIO_PI_AUTH_PATH: path.join(dir, "missing.json"),
      SLIDESTUDIO_LLM_API_KEY: "host-key",
      GEMINI_API_KEY: "mapped-or-leftover",
    });
    assert.equal(status.ready, false);
    assert.equal(productPiAuth(status).ready, false);
    const out = piAuthEnv({
      SLIDESTUDIO_LLM_API_KEY: "host-key",
      GEMINI_API_KEY: "mapped-or-leftover",
    });
    assert.equal(out.GEMINI_API_KEY, undefined);
    assert.equal(out.SLIDESTUDIO_LLM_API_KEY, undefined);
  });

  it("honors SLIDESTUDIO_PI_AUTH_PATH", () => {
    const { file, env } = tmpStore({ groq: { type: "api_key" } });
    assert.equal(piAuthPath(env), file);
    assert.equal(resolvePiAuth(env).kind, "api_key");
    assert.equal(formatPiAuthChip(true, resolvePiAuth(env)), "Pi · API 登录");
  });
});
