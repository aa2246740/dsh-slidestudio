import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AgentFaults, readAgentError, readRateLimitWait, recordAgentError } from "./agent-fault.js";
import { resetGenerateRouteState } from "./args.js";
import { invokeSlides } from "./host-test-fixtures.js";
import type { SlidesHostRuntime } from "./routes.js";
import { RATE_LIMIT_RESUME_TEXT, SessionRecovery, type SessionRecoveryDeps } from "./session-recovery.js";
import { withSessionTransition } from "./session-transition.js";
import { SliceSessionStore } from "./slice-session.js";

function harness(providerId: string, overrides: Partial<SessionRecoveryDeps> = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "session-recovery-"));
  const store = new SliceSessionStore(workspace);
  const { binding } = store.openProject({
    dshSessionId: "s1",
    title: "Recovery",
    design: { kind: "self-directed" },
    provider: { providerId, modelId: "m1" },
  });
  const root = store.resolveRoot(binding);
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const continued: string[] = [];
  const reopened: string[] = [];
  const busy = new Set<string>();
  const recovery = new SessionRecovery({
    store,
    faults: new AgentFaults(),
    reopen: async (sessionId) => {
      reopened.push(`${sessionId}:${store.bindingFor(sessionId)!.provider.providerId}`);
    },
    continueSession: (sessionId, text) => continued.push(`${sessionId}:${text}`),
    markBusy: (sessionId) => busy.add(sessionId),
    markIdle: (sessionId) => busy.delete(sessionId),
    grokFallbackTarget: () => undefined,
    openrouterKeyPresent: () => true,
    minimaxCnKeyPresent: () => true,
    now: () => 1_000,
    schedule: (ms, fn) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
    ...overrides,
  });
  return { store, root, recovery, timers, continued, reopened, busy };
}

describe("session recovery on SlidesAgentRuntime turn outcomes", () => {
  it("pauses a 429 turn on disk, then resumes the same session once (no runtime retry)", async () => {
    const { root, recovery, timers, continued, busy } = harness("openrouter");
    recovery.onTurnEnd("s1", {
      turn: 1,
      status: "failed",
      fault: { code: "provider-rate-limit", detail: "429 slow down", retryAfterMs: 20_000 },
      toolNames: [],
    });
    assert.equal(timers.length, 1);
    assert.equal(timers[0]!.ms, 20_000, "Retry-After from the runtime fault wins");
    assert.equal(readRateLimitWait(root)?.nextRetryAt, 21_000);
    assert.equal(readAgentError(root)?.code, "provider-rate-limit");
    timers[0]!.fn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(continued, [`s1:${RATE_LIMIT_RESUME_TEXT}`]);
    assert.equal(busy.has("s1"), true);
    assert.equal(readRateLimitWait(root), undefined, "resume clears the persisted wait");
  });

  it("operator stop cancels a pending wait", () => {
    const { recovery, timers, continued } = harness("openrouter");
    recovery.onFault("s1", { code: "provider-rate-limit", detail: "429" });
    recovery.rateLimits.operatorStop("s1");
    assert.equal(timers[0]!.cancelled, true);
    timers[0]!.fn();
    assert.deepEqual(continued, []);
  });

  it("fails MiniMax CN 401 over to OpenRouter on the same session and reopens the runtime", async () => {
    resetGenerateRouteState();
    const { store, recovery, continued, reopened } = harness("minimax-cn");
    recovery.onTurnEnd("s1", {
      turn: 1,
      status: "failed",
      fault: { code: "provider-auth", detail: "401" },
      toolNames: [],
    });
    assert.equal(recovery.recovering("s1"), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.bindingFor("s1")!.provider.providerId, "openrouter");
    assert.deepEqual(reopened, ["s1:openrouter"]);
    assert.match(continued[0]!, /Continue on OpenRouter MiniMax free/);
    assert.equal(recovery.recovering("s1"), false);
    resetGenerateRouteState();
  });

  it("rolls the binding back and records the pause when the failover reopen fails", async () => {
    resetGenerateRouteState();
    const { store, root, recovery, continued, busy } = harness("minimax-cn", {
      reopen: async () => {
        throw new Error("adapter missing");
      },
    });
    recovery.onFault("s1", { code: "provider-auth", detail: "401 unauthorized" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.bindingFor("s1")!.provider.providerId, "minimax-cn");
    assert.deepEqual(continued, []);
    assert.equal(busy.has("s1"), false);
    assert.equal(readAgentError(root)?.code, "provider-auth");
    resetGenerateRouteState();
  });

  it("an operator stop result never records a provider fault", () => {
    const { root, recovery } = harness("openrouter");
    recovery.onTurnEnd("s1", {
      turn: 2,
      status: "aborted",
      fault: { code: "operator-stop", detail: "stopped" },
      toolNames: [],
    });
    assert.equal(readAgentError(root), undefined);
  });

  it("aborts an in-flight provider failover when the operator stops during async reopen", async () => {
    resetGenerateRouteState();
    let releaseReopen!: () => void;
    let clearedSteers = 0;
    const { store, root, recovery, continued, busy } = harness("minimax-cn", {
      reopen: () =>
        new Promise<void>((resolve) => {
          releaseReopen = resolve;
        }),
      clearSteers: () => {
        clearedSteers += 1;
      },
    });
    recovery.onFault("s1", { code: "provider-auth", detail: "401" });
    assert.equal(recovery.recovering("s1"), true);
    recovery.rateLimits.operatorStop("s1");
    recordAgentError(root, { code: "operator-stop", detail: "stopped" });
    releaseReopen();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(continued, [], "stopped failover must not start a fallback turn");
    assert.equal(readAgentError(root)?.code, "operator-stop", "operator-stop record must not be wiped");
    assert.equal(store.bindingFor("s1")!.provider.providerId, "minimax-cn", "binding rolls back on stop");
    assert.equal(busy.has("s1"), false);
    assert.equal(clearedSteers, 1);
    resetGenerateRouteState();
  });

  it("cancels an in-flight 429 resume if a user turn supersedes it during reopen", async () => {
    let releaseReopen!: () => void;
    const { recovery, timers, continued } = harness("openrouter", {
      reopen: () =>
        new Promise<void>((resolve) => {
          releaseReopen = resolve;
        }),
    });
    recovery.onFault("s1", { code: "provider-rate-limit", detail: "429" });
    timers[0]!.fn();
    // User sends a new turn while reopen is awaiting catalog/limits.
    recovery.onUserTurn("s1");
    releaseReopen();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(continued, [], "superseded 429 resume must not enqueue an extra continuation turn");
  });

  it("serializes provider failover through runTransition without mutating provider while locked", async () => {
    resetGenerateRouteState();
    let releaseLock!: () => void;
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => (lockAcquired = resolve));
    const held = withSessionTransition("s1", async () => {
      lockAcquired();
      await new Promise<void>((resolve) => (releaseLock = resolve));
    });
    await acquired;
    let transitionCalls = 0;
    const { store, recovery, reopened } = harness("minimax-cn", {
      runTransition: (id, fn) => {
        transitionCalls += 1;
        return withSessionTransition(id, fn);
      },
    });
    recovery.onFault("s1", { code: "provider-auth", detail: "401" });
    assert.equal(transitionCalls, 1);
    assert.equal(store.bindingFor("s1")!.provider.providerId, "minimax-cn", "must wait for active transition lock");
    releaseLock();
    await held;
    for (let i = 0; i < 100 && recovery.recovering("s1"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(store.bindingFor("s1")!.provider.providerId, "openrouter");
    assert.deepEqual(reopened, ["s1:openrouter"]);
    resetGenerateRouteState();
  });

  it("does not overwrite operator-stop when a 429 reopen rejects after stop", async () => {
    let reopenStarted!: () => void;
    let releaseReopen!: () => void;
    const started = new Promise<void>((resolve) => (reopenStarted = resolve));
    const { root, recovery, timers, continued } = harness("openrouter", {
      runTransition: withSessionTransition,
      reopen: async () => {
        reopenStarted();
        await new Promise<void>((resolve) => (releaseReopen = resolve));
        throw new Error("offline catalog failure");
      },
    });
    recovery.onFault("s1", { code: "provider-rate-limit", detail: "429" });
    timers[0]!.fn();
    await started;
    recovery.rateLimits.operatorStop("s1");
    recordAgentError(root, { code: "operator-stop", detail: "stopped by operator" });
    releaseReopen();
    for (let i = 0; i < 100 && recovery.rateLimits.isWaiting("s1"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(readAgentError(root)?.code, "operator-stop");
    assert.deepEqual(continued, []);
  });

  it("cancels queued 429 auto-resume when HTTP POST /model succeeds", async () => {
    let lockAcquired!: () => void;
    let releaseLock!: () => void;
    const acquired = new Promise<void>((resolve) => (lockAcquired = resolve));
    const held = withSessionTransition("s1", async () => {
      lockAcquired();
      await new Promise<void>((resolve) => (releaseLock = resolve));
    });
    await acquired;
    const { store, recovery, timers, continued } = harness("openrouter", {
      runTransition: withSessionTransition,
    });
    recovery.onFault("s1", { code: "provider-rate-limit", detail: "429" });
    const modelReq = invokeSlides(
      {
        store,
        agentBusy: () => false,
        cancelRateLimitWait: (id: string) => recovery.onUserTurn(id),
        switchModel: async (id: string, modelId: string, providerId?: string) => {
          store.updateProvider(id, { providerId: providerId ?? "scripted", modelId });
        },
      } as unknown as SlidesHostRuntime,
      "POST",
      "/slides/sessions/s1/model",
      { provider: "scripted", model: "explicit-new-model" },
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    timers[0]!.fn();
    releaseLock();
    const [response] = await Promise.all([modelReq, held]);
    for (let i = 0; i < 100 && recovery.rateLimits.isWaiting("s1"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(response.status, 200);
    assert.deepEqual(continued, []);
  });

  it("skips a corrupt deck.pptd during restoreWaits without crashing host startup", () => {
    const { root, recovery } = harness("openrouter");
    fs.writeFileSync(path.join(root, "deck.pptd"), "invalid: [");
    assert.doesNotThrow(() => recovery.restoreWaits());
  });

  it("lets HTTP POST /model beat an already-queued 429 timer and prevents auto-resume after restart", async () => {
    let lockAcquired!: () => void;
    let releaseLock!: () => void;
    const acquired = new Promise<void>((resolve) => (lockAcquired = resolve));
    const held = withSessionTransition("s1", async () => {
      lockAcquired();
      await new Promise<void>((resolve) => (releaseLock = resolve));
    });
    await acquired;
    const { store, root, recovery, timers, continued } = harness("openrouter", {
      runTransition: withSessionTransition,
    });
    recovery.onFault("s1", { code: "provider-rate-limit", detail: "429" });
    // Timer fires FIRST and queues on withSessionTransition while lock is held.
    timers[0]!.fn();
    await new Promise((resolve) => setTimeout(resolve, 15));
    // User sends POST /model SECOND while lock is still held.
    const modelReq = invokeSlides(
      {
        store,
        agentBusy: () => false,
        cancelRateLimitWait: (id: string) => recovery.onUserTurn(id),
        switchModel: async (id: string, modelId: string, providerId?: string) => {
          store.updateProvider(id, { providerId: providerId ?? "scripted", modelId });
        },
      } as unknown as SlidesHostRuntime,
      "POST",
      "/slides/sessions/s1/model",
      { provider: "scripted", model: "explicit-new-model" },
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    releaseLock();
    const [response] = await Promise.all([modelReq, held]);
    for (let i = 0; i < 100 && recovery.rateLimits.isWaiting("s1"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(response.status, 200);
    assert.deepEqual(continued, []);
    assert.equal(readRateLimitWait(root), undefined);

    // Simulated Host restart: restoreWaits must NOT fire auto-resume on the switched model.
    const afterRestartTimers: { ms: number; fn: () => void }[] = [];
    const restarted = new SessionRecovery({
      store,
      faults: new AgentFaults(),
      reopen: async () => undefined,
      continueSession: () => {
        throw new Error("unexpected auto-resume after model switch and restart");
      },
      markBusy: () => undefined,
      markIdle: () => undefined,
      grokFallbackTarget: () => undefined,
      openrouterKeyPresent: () => false,
      minimaxCnKeyPresent: () => false,
      schedule: (ms, fn) => {
        afterRestartTimers.push({ ms, fn });
        return { cancel: () => undefined };
      },
    });
    restarted.restoreWaits();
    assert.deepEqual(afterRestartTimers, [], "cleared rate-limit wait must not re-arm on restart");
  });

  it("preserves an armed 429 retry when HTTP POST /model is rejected with 409 attempt_conflict", async () => {
    const { store, root, recovery, timers, continued } = harness("openrouter", {
      runTransition: withSessionTransition,
    });
    recovery.onFault("s1", { code: "provider-rate-limit", detail: "429" });
    assert.equal(timers.length, 1);
    const rejected = await invokeSlides(
      {
        store,
        agentBusy: () => false,
        cancelRateLimitWait: (id: string) => recovery.onUserTurn(id),
        switchModel: async () => {
          throw new Error("switchModel must not run on attempt_conflict");
        },
      } as unknown as SlidesHostRuntime,
      "POST",
      "/slides/sessions/s1/model",
      { provider: "scripted", model: "explicit-new-model", expectedAttemptId: "stale-attempt-id" },
    );
    assert.equal(rejected.status, 409);
    assert.equal(timers[0]!.cancelled, false, "rejected /model must not cancel the pending 429 timer");
    assert.ok(readRateLimitWait(root), "rejected /model must keep rate-limit wait on disk");
    timers[0]!.fn();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(continued, [`s1:${RATE_LIMIT_RESUME_TEXT}`]);
  });

  it("preserves an armed or queued 429 retry when HTTP POST /turn rejects an invalid modelSelection", async () => {
    for (const queued of [false, true]) {
      let releaseLock!: () => void;
      let held: Promise<void> = Promise.resolve();
      if (queued) {
        let lockAcquired!: () => void;
        const acquired = new Promise<void>((resolve) => (lockAcquired = resolve));
        held = withSessionTransition("s1", async () => {
          lockAcquired();
          await new Promise<void>((resolve) => (releaseLock = resolve));
        });
        await acquired;
      }
      const { store, root, recovery, timers, continued } = harness("openrouter", {
        runTransition: withSessionTransition,
      });
      recovery.onFault("s1", { code: "provider-rate-limit", detail: "429" });
      assert.equal(timers.length, 1);
      if (queued) {
        timers[0]!.fn();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const turnReq = invokeSlides(
        {
          store,
          workspaceRoot: path.resolve(import.meta.dirname, "../../.."),
          agentBusy: () => false,
          markBusy: () => undefined,
          cancelRateLimitWait: (id: string) => recovery.onUserTurn(id),
          switchModel: async () => {
            throw new Error("model not in roster");
          },
          getAgent: () => undefined,
          resumeAgent: async () => undefined,
        } as unknown as SlidesHostRuntime,
        "POST",
        "/slides/sessions/s1/turn",
        { text: "continue", modelSelection: { provider: "scripted", model: "nonexistent-model" } },
      );
      if (queued) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        releaseLock();
      }
      const [rejected] = await Promise.all([turnReq, held]);
      assert.equal(rejected.status, 500);
      assert.equal(timers[0]!.cancelled, false, "rejected /turn must not cancel the pending 429 timer");
      if (!queued) {
        assert.ok(readRateLimitWait(root), "rejected /turn must keep rate-limit wait on disk");
        timers[0]!.fn();
      }
      for (let i = 0; i < 100 && continued.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.deepEqual(continued, [`s1:${RATE_LIMIT_RESUME_TEXT}`]);
    }
  });

  it("persists a turn-max-tokens pause fault when a turn finishes with status max-tokens and no thrown fault", () => {
    const { store, root, recovery } = harness("minimax-cn");
    recovery.onTurnEnd("s1", {
      turn: 1,
      status: "max-tokens",
      toolNames: [],
    });
    const recorded = readAgentError(root);
    assert.equal(recorded?.code, "turn-max-tokens");
    assert.match(recorded?.detail ?? "", /output limit/i);
    assert.equal(store.inspect("s1").phase.kind, "paused");
  });
});
