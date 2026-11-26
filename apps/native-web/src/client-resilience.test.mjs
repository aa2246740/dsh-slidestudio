import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  bindGenerationLiveSse,
  bindVisibilityRecovery,
  createBoundedCache,
  createRecoverableLoader,
  createSubmitLockWatchdog,
  disconnectedActivity,
  discardUnreadBody,
  editorTabId,
  fetchJsonOrDiscard,
  fetchWithTimeout,
  isTerminalIdleEvent,
  pollBackoffDelay,
  reviewTurnTimeouts,
  safePaint,
  safeRandomUUID,
  settleResidualThinking,
  transientAiReviewStateError,
} from "../public/client-resilience.js";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Listener doubles accept any DOM-like event object (`any` keeps the fakes minimal).
/** @returns {Map<string, (ev?: any) => void>} */
const listenerMap = () => new Map();

/** @param {Map<string, (ev?: any) => void>} map @param {string} type */
function fire(map, type, ev = {}) {
  const fn = map.get(type);
  assert.ok(fn, `listener ${type} registered`);
  fn(ev);
}

describe("client resilience: ids and timeouts", () => {
  it("safeRandomUUID uses native randomUUID and degrades on non-HTTPS origins", () => {
    assert.equal(
      safeRandomUUID({ randomUUID: () => "11111111-1111-4111-8111-111111111111" }),
      "11111111-1111-4111-8111-111111111111",
    );
    const degraded = safeRandomUUID({
      getRandomValues(/** @type {Uint8Array<ArrayBuffer>} */ arr) {
        for (let i = 0; i < arr.length; i += 1) arr[i] = (i * 19 + 7) & 0xff;
        return arr;
      },
    });
    assert.match(degraded, UUID_V4_RE);
    const fallbackA = safeRandomUUID({
      randomUUID() {
        throw new Error("insecure context");
      },
    });
    const fallbackB = safeRandomUUID(undefined);
    assert.match(fallbackA, UUID_V4_RE);
    assert.match(fallbackB, UUID_V4_RE);
    assert.notEqual(fallbackA, fallbackB);
  });

  it("editorTabId persists one id per tab and falls back when storage is unavailable", () => {
    /** @type {Map<string, string>} */
    const store = new Map();
    const storage = {
      getItem: (/** @type {string} */ key) => store.get(key) ?? null,
      setItem: (/** @type {string} */ key, /** @type {string} */ value) => void store.set(key, value),
    };
    const first = editorTabId({ storage, crypto: {} });
    assert.match(first, UUID_V4_RE);
    assert.equal(editorTabId({ storage, crypto: {} }), first);
    const broken = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {},
    };
    assert.equal(editorTabId({ storage: broken }), "default");
  });

  it("reviewTurnTimeouts relaxes full-deck limits while preserving scoped limits", () => {
    assert.deepEqual(reviewTurnTimeouts(true), {
      hardTimeoutMs: 30 * 60 * 1000,
      stalledTimeoutMs: 10 * 60 * 1000,
    });
    assert.deepEqual(reviewTurnTimeouts(false), {
      hardTimeoutMs: 4 * 60 * 1000,
      stalledTimeoutMs: 2 * 60 * 1000,
    });
  });

  it("classifies transport failures as transient and caps poll backoff", () => {
    assert.equal(transientAiReviewStateError({ code: "AI_STATE_UNAVAILABLE" }), true);
    assert.equal(transientAiReviewStateError(new TypeError("fetch failed")), true);
    const timeout = new Error("late");
    timeout.name = "TimeoutError";
    assert.equal(transientAiReviewStateError(timeout), true);
    assert.equal(transientAiReviewStateError(new Error("server said no")), false);
    assert.equal(transientAiReviewStateError(null), false);
    assert.deepEqual([1, 2, 3, 4, 5, 9].map(pollBackoffDelay), [1200, 2400, 4800, 9600, 10000, 10000]);
    assert.equal(pollBackoffDelay(0), 1200);
  });

  it("disconnectedActivity keeps the activity and marks the connection lost", () => {
    const next = disconnectedActivity({ phase: "working" });
    assert.equal(next.phase, "working");
    assert.equal(next.connectionState, "disconnected");
    assert.match(next.error.detail, /正在重连/);
    assert.equal(disconnectedActivity(null).connectionState, "disconnected");
  });
});

describe("client resilience: paint, watchdog, visibility", () => {
  it("safePaint isolates rendering exceptions so polling chains continue", () => {
    const warn = mock.fn();
    const ok = safePaint(
      () => {
        throw new Error("synthetic paint fault");
      },
      null,
      { warn },
    );
    assert.equal(ok, false);
    assert.equal(warn.mock.callCount(), 1);
    assert.equal(warn.mock.calls[0]?.arguments[1], "synthetic paint fault");
    const paint = mock.fn();
    assert.equal(safePaint(paint, 7, { warn }), true);
    assert.deepEqual(paint.mock.calls[0]?.arguments, [7]);
  });

  it("createSubmitLockWatchdog unlocks after 60 s and clears cleanly on settle", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const onTimeout = mock.fn();
    const lock = createSubmitLockWatchdog({ timeoutMs: 60_000, onTimeout });
    lock.set(true);
    assert.equal(lock.active, true);
    t.mock.timers.tick(59_999);
    assert.equal(onTimeout.mock.callCount(), 0);
    t.mock.timers.tick(1);
    assert.equal(onTimeout.mock.callCount(), 1);
    assert.equal(lock.active, false);
    lock.set(true);
    t.mock.timers.tick(30_000);
    lock.set(false);
    t.mock.timers.tick(60_000);
    assert.equal(onTimeout.mock.callCount(), 1);
    lock.set(true);
    lock.clear();
    t.mock.timers.tick(60_000);
    assert.equal(onTimeout.mock.callCount(), 1);
    assert.equal(lock.active, false);
  });

  it("bindVisibilityRecovery reconnects SSE and polls immediately when visible again", () => {
    const listeners = listenerMap();
    const doc = {
      visibilityState: /** @type {DocumentVisibilityState} */ ("hidden"),
      addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => listeners.set(type, fn),
      removeEventListener: (/** @type {string} */ type) => void listeners.delete(type),
    };
    let active = true;
    const reconnect = mock.fn();
    const poll = mock.fn();
    const dispose = bindVisibilityRecovery({
      // The fake document implements only the three members the helper reads.
      doc: /** @type {any} */ (doc),
      shouldResume: () => active,
      reconnect,
      poll,
    });
    fire(listeners, "visibilitychange");
    assert.equal(reconnect.mock.callCount(), 0);
    doc.visibilityState = "visible";
    fire(listeners, "visibilitychange");
    assert.equal(reconnect.mock.callCount(), 1);
    assert.equal(poll.mock.callCount(), 1);
    active = false;
    fire(listeners, "visibilitychange");
    assert.equal(reconnect.mock.callCount(), 1);
    dispose();
    assert.equal(listeners.size, 0);
  });
});

describe("client resilience: SSE terminal idle", () => {
  it("detects terminal idle frames and settles residual thinking cards", () => {
    assert.equal(isTerminalIdleEvent({ type: "agent-status", status: "idle" }), true);
    assert.equal(isTerminalIdleEvent({ type: "agent-status", status: "busy" }), false);
    assert.equal(isTerminalIdleEvent({ agentStatus: "idle" }), true);
    assert.equal(isTerminalIdleEvent({ rows: [{ kind: "turn", name: "turn", status: "complete" }] }), true);
    assert.equal(isTerminalIdleEvent({ rows: [{ kind: "turn", name: "turn", status: "running" }] }), false);
    assert.equal(isTerminalIdleEvent("idle"), false);
    const settled = settleResidualThinking({
      agentStatus: "busy",
      events: [
        { id: "r1", kind: "reasoning", status: "running", detail: "思考中" },
        { id: "m1", kind: "message", status: "complete", detail: "完成" },
      ],
    });
    assert.equal(settled?.agentStatus, "idle");
    assert.deepEqual(
      settled?.events.map((row) => row.status),
      ["complete", "complete"],
    );
    const untouched = { events: [{ kind: "message", status: "complete" }] };
    assert.equal(settleResidualThinking(untouched), untouched);
    assert.equal(settleResidualThinking(null), null);
  });

  it("bindGenerationLiveSse schedules paints, ignores bad frames, and hands off idle", () => {
    const named = listenerMap();
    /** @type {{onmessage: any, addEventListener: (type: string, fn: any) => void}} */
    const source = {
      onmessage: null,
      addEventListener: (type, fn) => named.set(type, fn),
    };
    const schedulePaint = mock.fn();
    const onTerminalIdle = mock.fn();
    let current = true;
    bindGenerationLiveSse(source, {
      isCurrent: () => current,
      accept: (data) => Boolean(/** @type {{ rows?: unknown }} */ (data)?.rows),
      schedulePaint,
      onTerminalIdle,
    });
    source.onmessage({ data: JSON.stringify({ rows: [{ kind: "reasoning", status: "running" }] }) });
    assert.equal(schedulePaint.mock.callCount(), 1);
    source.onmessage({ data: "{not json" });
    assert.equal(schedulePaint.mock.callCount(), 1);
    source.onmessage({ data: JSON.stringify({ type: "agent-status", status: "idle" }) });
    assert.equal(onTerminalIdle.mock.callCount(), 1);
    assert.deepEqual(onTerminalIdle.mock.calls[0]?.arguments, [false]);
    fire(named, "agent-status", { data: JSON.stringify({ status: "idle" }) });
    assert.equal(onTerminalIdle.mock.callCount(), 2);
    current = false;
    source.onmessage({ data: JSON.stringify({ rows: [] }) });
    assert.equal(schedulePaint.mock.callCount(), 1);
  });
});

/** @param {number} status @param {string} body */
function streamResponse(status, body) {
  const response = new Response(body, { status });
  const cancel = mock.fn(async () => {});
  if (response.body) Object.defineProperty(response.body, "cancel", { value: cancel });
  return { response, cancel };
}

describe("client resilience: fetch timeouts and unread bodies", () => {
  it("fetchWithTimeout aborts a hung request with a TimeoutError", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    /** @type {AbortSignal | undefined} */
    let seen;
    const fetchImpl = /** @type {typeof fetch} */ (
      (_input, init) =>
        new Promise((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          seen?.addEventListener("abort", () => reject(seen?.reason));
        })
    );
    const pending = fetchWithTimeout("/slow", {}, { timeoutMs: 5000, fetchImpl });
    t.mock.timers.tick(5000);
    await assert.rejects(pending, (error) => {
      assert.equal(/** @type {Error} */ (error).name, "TimeoutError");
      assert.equal(transientAiReviewStateError(error), true);
      return true;
    });
    assert.equal(seen?.aborted, true);
  });

  it("fetchWithTimeout honours an outer abort and returns fast responses untouched", async () => {
    const ok = new Response("{}", { status: 200 });
    const fast = await fetchWithTimeout("/fast", {}, { fetchImpl: async () => ok });
    assert.equal(fast, ok);
    const outer = new AbortController();
    outer.abort(new Error("user left"));
    /** @type {typeof fetch} */
    const fetchImpl = async (_input, init) => {
      assert.equal(init?.signal?.aborted, true);
      throw init?.signal?.reason;
    };
    await assert.rejects(fetchWithTimeout("/x", { signal: outer.signal }, { fetchImpl }), /user left/);
  });

  it("cancels the unread body of a /slides/catalog 502 and recovers on the next load", async () => {
    const bad = streamResponse(502, "upstream missing");
    const calls = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (input) => {
      calls.push(String(input));
      return calls.length === 1 ? bad.response : new Response(JSON.stringify({ styles: [1] }));
    };
    const loader = createRecoverableLoader(async () => {
      const result = await fetchJsonOrDiscard("/slides/catalog", { fetchImpl });
      return result.ok ? result.data : null;
    });
    assert.equal(await loader.get(), undefined);
    assert.equal(bad.cancel.mock.callCount(), 1);
    assert.equal(loader.loaded, false);
    assert.deepEqual(await loader.get(), { styles: [1] });
    assert.equal(loader.loaded, true);
    assert.deepEqual(await loader.get(), { styles: [1] });
    assert.equal(calls.length, 2);
    loader.reset();
    assert.equal(loader.loaded, false);
  });

  it("fetchJsonOrDiscard reports network errors and invalid JSON without throwing", async () => {
    const offline = await fetchJsonOrDiscard("/x", {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    assert.deepEqual(offline, { ok: false, status: 0, data: null });
    const garbled = await fetchJsonOrDiscard("/x", { fetchImpl: async () => new Response("<html>") });
    assert.deepEqual(garbled, { ok: false, status: 200, data: null });
    await discardUnreadBody(null);
    const used = new Response("x");
    await used.text();
    await discardUnreadBody(used);
  });

  it("a throwing loader is retried rather than cached", async () => {
    let attempts = 0;
    const loader = createRecoverableLoader(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
      return "ready";
    });
    assert.equal(await loader.get(), undefined);
    assert.equal(await loader.get(), "ready");
    assert.equal(attempts, 2);
  });
});

describe("client resilience: memory budget", () => {
  it("evicts least-recently-used entries over the entry and byte budget", () => {
    /** @type {string[]} */
    const evicted = [];
    const cache = createBoundedCache({
      maxEntries: 3,
      maxBytes: 10,
      sizeOf: (/** @type {string} */ value) => value.length,
      onEvict: (key) => evicted.push(key),
    });
    cache.set("a", "1111");
    cache.set("b", "2222");
    assert.equal(cache.get("a"), "1111");
    cache.set("c", "33");
    assert.deepEqual(evicted, []);
    cache.set("d", "44");
    assert.deepEqual(evicted, ["b"]);
    assert.equal(cache.size, 3);
    cache.set("e", "5555555");
    assert.deepEqual(evicted, ["b", "a", "c"]);
    assert.equal(cache.bytes, 9);
    assert.equal(cache.get("missing"), undefined);
  });

  it("replacing a key with the same value keeps it; delete and clear release resources", () => {
    /** @type {string[]} */
    const evicted = [];
    const cache = createBoundedCache({ onEvict: (key, value) => evicted.push(`${key}=${value}`) });
    cache.set("u", "blob:1");
    cache.set("u", "blob:1");
    assert.deepEqual(evicted, []);
    cache.set("u", "blob:2");
    assert.deepEqual(evicted, ["u=blob:1"]);
    cache.set("v", "blob:3");
    cache.delete("u");
    cache.clear();
    assert.deepEqual(evicted, ["u=blob:1", "u=blob:2", "v=blob:3"]);
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
  });
});
