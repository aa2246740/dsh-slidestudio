import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logoutPiProvider, piLoginSnapshot, savePiApiKey } from "./pi-login.js";
import { resolvePiAuth } from "./pi-auth.js";

describe("pi product login", () => {
  it("writes an API key into Pi auth.json and can log out", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-login-"));
    const file = path.join(dir, "auth.json");
    const env = { HOME: dir, SLIDESTUDIO_PI_AUTH_PATH: file };
    const after = savePiApiKey("google", "test-key-not-real", env);
    assert.equal(after.ready, true);
    assert.equal(after.kind, "api_key");
    assert.equal(after.source, "auth.json");
    assert.equal(after.provider, "google");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      google?: { type?: string; key?: string };
    };
    assert.equal(raw.google?.type, "api_key");
    assert.equal(raw.google?.key, "test-key-not-real");
    const snap = piLoginSnapshot(env);
    assert.doesNotMatch(JSON.stringify(snap.auth), /test-key-not-real/);
    // OAuth capability follows the shipped/discovered Pi SDK, not the test auth store.
    assert.equal(typeof snap.oauthAvailable, "boolean");
    logoutPiProvider("google", env);
    assert.equal(resolvePiAuth(env).ready, false);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).google, undefined);
    const leftover = piLoginSnapshot({
      ...env,
      GEMINI_API_KEY: "leftover",
      SLIDESTUDIO_LLM_API_KEY: "host-key",
    });
    assert.equal(leftover.auth.ready, false);
    assert.equal(leftover.auth.source, "none");
  });

  it("refuses OAuth-only providers on the API-key path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-login-"));
    const env = { SLIDESTUDIO_PI_AUTH_PATH: path.join(dir, "auth.json") };
    assert.throws(() => savePiApiKey("openai-codex", "x", env), /OAuth/);
  });

  it("matches the shipped Pi auth methods for common providers", () => {
    const snap = piLoginSnapshot({ SLIDESTUDIO_PI_AUTH_PATH: "/not-present" });
    const methods = (id: string) => snap.providers.find((row) => row.id === id)?.methods;
    assert.deepEqual(methods("xai"), ["api_key"]);
    assert.deepEqual(methods("xai-auth"), ["oauth"]);
    assert.deepEqual(methods("openai-codex"), ["oauth"]);
    assert.deepEqual(methods("openrouter"), ["api_key"]);
    assert.deepEqual(methods("deepseek"), ["api_key"]);
  });

  it("exposes xAI OAuth as a supported login without leaking its credential", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-login-existing-"));
    const file = path.join(dir, "auth.json");
    fs.writeFileSync(file, `${JSON.stringify({ "xai-auth": { type: "oauth", access: "secret" } })}\n`);
    const snap = piLoginSnapshot({ HOME: dir, SLIDESTUDIO_PI_AUTH_PATH: file });
    const xai = snap.providers.find((row) => row.id === "xai-auth");
    assert.equal(xai?.existingOnly, undefined);
    assert.equal(xai?.methods[0], "oauth");
    assert.doesNotMatch(JSON.stringify(snap), /secret/);
  });
});
