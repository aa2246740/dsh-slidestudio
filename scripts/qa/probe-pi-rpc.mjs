#!/usr/bin/env node
/**
 * Prove Pi binary starts and (optionally) can complete one RPC turn.
 * Never prints secrets. Does not claim a deck was generated.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadRootEnv } from "./load-env.mjs";
import {
  piAvailable,
  piAuthEnv,
  piConfigFromEnv,
  resolvePiAuth,
  PiRpcSession,
} from "../../packages/agent-harness/dist/index.js";

loadRootEnv();

const OUT = process.env.QA_PI_RPC_OUT || "/opt/cursor/artifacts/qa-pi-rpc";
fs.mkdirSync(OUT, { recursive: true });

function redact(text) {
  return String(text || "")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted-google-key]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-key]");
}

const notes = {
  startedAt: new Date().toISOString(),
  availability: piAvailable(),
  config: {
    bin: piConfigFromEnv().bin,
    provider: piConfigFromEnv().provider || null,
    model: piConfigFromEnv().model || null,
  },
  auth: null,
  authCheck: null,
  rpc: { started: false, getState: null, prompt: null, stderr: "" },
  errors: [],
};

const cfg = piConfigFromEnv();
if (!notes.availability.available) {
  notes.errors.push(notes.availability.note);
} else {
  const authEnv = piAuthEnv(process.env);
  const auth = spawnSync(cfg.bin, ["auth", "check", "--provider", cfg.provider || "google"], {
    encoding: "utf8",
    timeout: 20_000,
    env: authEnv,
  });
  notes.authCheck = {
    status: auth.status,
    stdout: redact((auth.stdout || "").trim().slice(0, 400)),
    stderr: redact((auth.stderr || "").trim().slice(0, 400)),
  };

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-probe-"));
  const session = new PiRpcSession({
    bin: cfg.bin,
    cwd,
    model: cfg.model,
    provider: cfg.provider,
    thinking: "off",
    commandTimeoutMs: 20_000,
  });
  try {
    await session.start();
    notes.rpc.started = true;
    const state = await session.getState();
    notes.rpc.getState = {
      ok: true,
      keys: Object.keys(state).slice(0, 12),
    };
    try {
      const events = await session.promptAndWait(
        "Reply with exactly PONG and do not write any files.",
        90_000,
      );
      notes.rpc.prompt = {
        ok: true,
        eventTypes: events.map((e) => e.type).filter(Boolean).slice(0, 20),
      };
    } catch (err) {
      notes.rpc.prompt = {
        ok: false,
        error: redact(err instanceof Error ? err.message : String(err)).slice(0, 500),
      };
      notes.errors.push("Pi RPC started, get_state worked, prompt failed — binary is installed, model auth/turn is not proven.");
    }
  } catch (err) {
    notes.rpc.started = false;
    notes.errors.push(redact(err instanceof Error ? err.message : String(err)).slice(0, 500));
  } finally {
    notes.rpc.stderr = redact(session.getStderr()).slice(-800);
    await session.stop().catch(() => undefined);
  }
}

fs.writeFileSync(path.join(OUT, "notes.json"), `${JSON.stringify(notes, null, 2)}\n`);
console.log(JSON.stringify(notes, null, 2));
process.exit(notes.availability.available && notes.rpc.started ? 0 : 1);
