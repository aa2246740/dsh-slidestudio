#!/usr/bin/env node
/**
 * Re-record packages/slides-runtime/fixtures/guard-ab.v1.json from the DSH host
 * guards (tool-loop-guard, product-progress-guard, agent-fault). Build
 * dsh-slides-host first, then run `node scripts/record-guard-ab-fixture.mjs`.
 * guard-parity.test.ts in dsh-slides-host replays the result live.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = (file) => import(pathToFileURL(path.join(root, "packages/dsh-slides-host/dist", file)).href);
const { ToolInvalidArgsLoopGuard } = await host("tool-loop-guard.js");
const { ProductProgressSessionGuard } = await host("product-progress-guard.js");
const { classifyAgentError, parseRetryAfterMs, rateLimitWaitMs } = await host("agent-fault.js");
const { stableSha256 } = await import(pathToFileURL(path.join(root, "packages/presentation-run/dist/index.js")).href);

const fp = (label) => stableSha256({ label });
const snap = (phase, page, evidence = []) => {
  const sorted = [...new Set(evidence)].sort();
  return {
    phase,
    pageRevisionFingerprint: fp(page),
    completionEvidence: sorted,
    completionEvidenceFingerprint: stableSha256({ schemaVersion: 1, evidence: sorted }),
    pageCount: phase === "production" ? 1 : 0,
    ledgerRevisions: [],
    diskPages: [],
  };
};
let n = 0;
const call = (name, step) => {
  const callId = `c${++n}`;
  return { callId, event: { type: "tool/call", data: { turn: 1, step, callId, name, arguments: "{}" } } };
};
const result = (callId, step, text, invalid) => ({
  type: "tool/result",
  data: {
    turn: 1,
    step,
    message: {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text }] }],
    },
    ...(invalid ? { error: { code: "INVALID_ARGS", name: "ToolArgsError" } } : {}),
  },
});

function scenario(name, build) {
  n = 0;
  const events = [{ type: "turn/start", data: { turn: 1 } }];
  const snapshots = [];
  build({
    pair(tool, step, text, { invalid = false, snapshot } = {}) {
      const c = call(tool, step);
      events.push(c.event);
      snapshots.push(snapshot);
      events.push(result(c.callId, step, text, invalid));
      snapshots.push(snapshot);
    },
    parallel(tool, step, count, text, { invalid = false, snapshot } = {}) {
      const calls = Array.from({ length: count }, () => call(tool, step));
      for (const c of calls) {
        events.push(c.event);
        snapshots.push(snapshot);
      }
      for (const c of calls) {
        events.push(result(c.callId, step, text, invalid));
        snapshots.push(snapshot);
      }
    },
  });
  events.push({ type: "turn/end", data: { turn: 1 } });
  return { name, events, snapshots };
}

const P0 = snap("planning", "empty");
const W1 = snap("production", "p1-r1", ["todo:committed"]);
const W2 = snap("production", "p1-r2", ["todo:committed"]);
const bad = "invalid arguments: elements[0].bounds must be an array; elements[3].bounds must be an array";
const bad2 = "invalid arguments: id is required";
const rejected = JSON.stringify({ outcome: "rejected", reason: "page-not-in-todo", pageId: "p09" });
const scenarios = [
  scenario("invalid-args-short-loop-across-steps", (s) => {
    for (let step = 1; step <= 4; step += 1) s.pair("write_page", step, bad, { invalid: true, snapshot: W1 });
  }),
  scenario("parallel-siblings-are-one-decision", (s) => {
    s.parallel("write_page", 1, 3, bad, { invalid: true, snapshot: W1 });
    s.parallel("write_page", 2, 2, bad, { invalid: true, snapshot: W1 });
    s.pair("write_page", 3, bad, { invalid: true, snapshot: W1 });
  }),
  scenario("new-category-resets-the-streak", (s) => {
    s.pair("write_page", 1, bad, { invalid: true, snapshot: W1 });
    s.pair("write_page", 2, bad, { invalid: true, snapshot: W1 });
    s.pair("write_page", 3, bad2, { invalid: true, snapshot: W1 });
    s.pair("write_page", 4, bad2, { invalid: true, snapshot: W1 });
    s.pair("read_page", 5, JSON.stringify({ ok: true }), { snapshot: W1 });
    s.pair("write_page", 6, bad2, { invalid: true, snapshot: W1 });
    s.pair("write_page", 7, bad2, { invalid: true, snapshot: W1 });
    s.pair("write_page", 8, bad2, { invalid: true, snapshot: W1 });
  }),
  scenario("repeated-business-rejection", (s) => {
    for (let step = 1; step <= 4; step += 1) {
      s.pair("write_page", step, rejected, { snapshot: W1 });
      s.pair("list_references", step, JSON.stringify({ ok: true }), { snapshot: W1 });
    }
  }),
  scenario("repeated-invalid-args-progress-limit", (s) => {
    for (let step = 1; step <= 9; step += 1) s.pair("edit_elements", step, bad2, { invalid: true, snapshot: W1 });
  }),
  scenario("production-no-progress-budget", (s) => {
    for (let step = 1; step <= 34; step += 1)
      s.pair("read_page", step, JSON.stringify({ ok: true, step }), { snapshot: W1 });
  }),
  scenario("planning-no-progress-budget", (s) => {
    for (let step = 1; step <= 66; step += 1)
      s.pair("list_references", step, JSON.stringify({ ok: true, step }), { snapshot: P0 });
  }),
  scenario("page-revision-resets-the-budget", (s) => {
    for (let step = 1; step <= 20; step += 1)
      s.pair("read_page", step, JSON.stringify({ ok: true, step }), { snapshot: W1 });
    s.pair("write_page", 21, JSON.stringify({ outcome: "written" }), { snapshot: W2 });
    for (let step = 22; step <= 60; step += 1)
      s.pair("read_page", step, JSON.stringify({ ok: true, step }), { snapshot: W2 });
  }),
];

for (const sc of scenarios) {
  const loop = new ToolInvalidArgsLoopGuard();
  let cursor = 0;
  const progress = new ProductProgressSessionGuard({ sample: () => sc.snapshots[cursor] ?? sc.snapshots.at(-1) ?? P0 });
  const toolLoop = [];
  const prog = [];
  sc.events.forEach((event, index) => {
    const trip = loop.observe("s", event);
    if (trip) toolLoop.push({ index, code: trip.code, toolName: trip.toolName, count: trip.count });
    if (event.type === "turn/start") cursor = 0;
    const ptrip = progress.observe("s", "/unused", event);
    if (event.type === "tool/call" || event.type === "tool/result") cursor += 1;
    if (ptrip)
      prog.push({
        index,
        code: ptrip.code,
        count: ptrip.count,
        limit: ptrip.limit,
        ...(ptrip.toolName ? { toolName: ptrip.toolName } : {}),
      });
  });
  sc.expected = { toolLoop, progress: prog };
}
// turn/start samples once too: the host samples before the first tool event, so prepend the first snapshot.
for (const sc of scenarios) sc.snapshots = [sc.snapshots[0], ...sc.snapshots];

const faultInputs = [
  { code: "429", message: "Too Many Requests" },
  new Error("Provider returned error"),
  { code: "PI_AI_ERROR", message: "Provider returned error 503" },
  { code: "PI_AI_ERROR", message: "Provider returned error: 401 invalid api key" },
  { message: "You exceeded your current quota, RESOURCE_EXHAUSTED" },
  { code: 401, message: "Unauthorized" },
  { message: "MiniMax error 2056: Token Plan 用量上限" },
  { code: "SERVER", message: "upstream" },
  { message: '{"code": 503, "status": "UNAVAILABLE"}' },
  { message: "Converting circular structure to JSON at path messages[3] type Socket" },
  { detail: "Bearer sk-fake-abcdefghijklmnopqrstu used api_key=fake-secret123 failed" },
  "plain string failure",
  { code: "WEIRD", message: "something else" },
];
const faults = faultInputs.map((input) => ({
  input: input instanceof Error ? { error: input.message } : input,
  expected: classifyAgentError(input),
}));
const now = Date.parse("2026-11-26T00:00:00Z");
const retryInputs = [
  { headers: { "Retry-After": "12" } },
  { headers: { "retry-after": "Thu, 26 Nov 2026 00:01:00 GMT" } },
  { retryAfterMs: 4500 },
  { retryAfter: 3 },
  { retry_after_seconds: 9 },
  '{"retry_after_seconds": 30}',
  "please retry in 2m",
  "retry in 45s",
  '"retryDelay": "17s"',
  '"Retry-After": "20"',
  42,
  60000,
  { detail: "retry-after: 99999" },
  "nothing here",
];
const retries = retryInputs.map((input) => ({ input, expected: parseRetryAfterMs(input, now) ?? null }));
const waits = [0, 1, 2, 3, 4, 5, 9]
  .map((attempt) => ({ attempt, expected: rateLimitWaitMs(attempt) }))
  .concat([{ attempt: 0, retryAfterMs: 5000, expected: rateLimitWaitMs(0, 5000) }]);
const table = { P0, W1, W2 };
const keyOf = (value) => Object.keys(table).find((key) => table[key] === value);
for (const sc of scenarios) sc.snapshots = sc.snapshots.map(keyOf);
const out = {
  version: 1,
  snapshotTable: table,
  recordedFrom: "packages/dsh-slides-host (tool-loop-guard, product-progress-guard, agent-fault)",
  now,
  scenarios,
  faults,
  retries,
  waits,
};
const file = path.join(root, "packages/slides-runtime/fixtures/guard-ab.v1.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out) + "\n");
console.log(
  `recorded ${scenarios.length} scenarios, ${faults.length} faults, ${retries.length} retry hints -> ${path.relative(root, file)}`,
);
