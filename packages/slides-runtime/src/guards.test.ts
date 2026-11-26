/**
 * A/B parity: the recorded fixture holds DSH-journal event sequences and the
 * trips, fault codes and backoff values the dsh-slides-host guards produced
 * for them. The runtime's host-neutral guards must reproduce them exactly
 * (dsh-slides-host re-records the same fixture in its own parity test).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { PostTurnHook } from "@open-slidestudio/slides-tools";
import { classifyFault, parseRetryAfterMs, rateLimitWaitMs } from "./faults.js";
import type { GuardEvent } from "./guard-events.js";
import { ProgressGuard } from "./progress-guard.js";
import type { PersistentProductSnapshot } from "./progress-snapshot.js";
import { createSlidesRuntime } from "./runtime.js";
import { ScriptedLlm, PACKAGE_ROOT, tempDir, testPresentation } from "./testkit.js";
import { ToolInvalidArgsLoopGuard } from "./tool-loop-guard.js";

type JournalEvent = { type: string; data: Record<string, unknown> };
type Scenario = {
  name: string;
  events: JournalEvent[];
  snapshots: string[];
  expected: { toolLoop: Record<string, unknown>[]; progress: Record<string, unknown>[] };
};
type Fixture = {
  now: number;
  snapshotTable: Record<string, PersistentProductSnapshot>;
  scenarios: Scenario[];
  faults: { input: unknown; expected: { code: string; detail: string } }[];
  retries: { input: unknown; expected: number | null }[];
  waits: { attempt: number; retryAfterMs?: number; expected: number }[];
};

const fixture = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "fixtures", "guard-ab.v1.json"), "utf8")) as Fixture;

/** Translate one recorded DSH journal event into the host-neutral guard vocabulary. */
function toGuardEvent(event: JournalEvent): GuardEvent {
  const data = event.data;
  if (event.type === "turn/start" || event.type === "turn/end") return { type: event.type, turn: Number(data.turn) };
  if (event.type === "tool/call") {
    return { type: "tool/call", callId: String(data.callId), toolName: String(data.name), step: Number(data.step) };
  }
  if (event.type !== "tool/result") return { type: "other" };
  const message = data.message as { content: { toolCallId: string; content: { type: string; text: string }[] }[] };
  const block = message.content[0]!;
  const error = data.error as { code: string; name: string } | undefined;
  return {
    type: "tool/result",
    callId: block.toolCallId,
    step: Number(data.step),
    texts: block.content.filter((item) => item.type === "text").map((item) => item.text),
    ...(error ? { error: { code: error.code, name: error.name } } : {}),
  };
}

function replay(scenario: Scenario) {
  const loop = new ToolInvalidArgsLoopGuard();
  let cursor = 0;
  const progress = new ProgressGuard({
    sample: () => fixture.snapshotTable[scenario.snapshots[cursor++] ?? scenario.snapshots.at(-1)!]!,
  });
  const toolLoop: Record<string, unknown>[] = [];
  const progressTrips: Record<string, unknown>[] = [];
  scenario.events.forEach((journal, index) => {
    const event = toGuardEvent(journal);
    const trip = loop.observe("s", event);
    if (trip) toolLoop.push({ index, code: trip.code, toolName: trip.toolName, count: trip.count });
    const turn = typeof journal.data.turn === "number" ? journal.data.turn : undefined;
    const ptrip = progress.observe("s", "/unused", event, turn);
    if (ptrip) {
      progressTrips.push({
        index,
        code: ptrip.code,
        count: ptrip.count,
        limit: ptrip.limit,
        ...(ptrip.toolName ? { toolName: ptrip.toolName } : {}),
      });
    }
  });
  return { toolLoop, progress: progressTrips };
}

for (const scenario of fixture.scenarios) {
  test(`A/B guard parity: ${scenario.name}`, () => {
    assert.deepEqual(replay(scenario), scenario.expected);
  });
}

test("A/B fault classification, Retry-After parsing and backoff match the host", () => {
  for (const row of fixture.faults) {
    const input =
      (row.input as { error?: string }).error !== undefined
        ? new Error((row.input as { error: string }).error)
        : row.input;
    assert.deepEqual(classifyFault(input), row.expected, JSON.stringify(row.input));
  }
  for (const row of fixture.retries) {
    assert.equal(parseRetryAfterMs(row.input, fixture.now) ?? null, row.expected, JSON.stringify(row.input));
  }
  for (const row of fixture.waits) assert.equal(rateLimitWaitMs(row.attempt, row.retryAfterMs), row.expected);
});

test("fault details are redacted before they leave the guard", () => {
  const fault = classifyFault({ detail: "Bearer sk-fake-abcdefghijklmnopqrstu api_key=fake-hunter22 failed" });
  assert.doesNotMatch(fault.detail, /sk-fake-abcdefghijklmnop|fake-hunter22/);
});

test("PostTurnHook seam: hooks run in order after each turn and a failing hook is contained", async () => {
  const seen: string[][] = [];
  const hooks: PostTurnHook[] = [
    { name: "record", run: async (ctx) => void seen.push([...ctx.toolNames]) },
    {
      name: "broken",
      run: async () => {
        throw new Error("overlay failure");
      },
    },
  ];
  const llm = new ScriptedLlm([
    () => ({ calls: [{ name: "open_project", args: { title: "钩子" } }] }),
    () => ({ text: "完成" }),
  ]);
  const runtime = createSlidesRuntime({
    llm,
    dataRoot: tempDir("hooks"),
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
    postTurnHooks: hooks,
  });
  const results: unknown[] = [];
  runtime.subscribe((event) => event.type === "post-turn" && results.push(event.results));
  const result = await runtime.prompt("建一个项目");
  assert.equal(result.status, "completed");
  assert.deepEqual(seen, [["open_project"]]);
  assert.deepEqual(results, [
    [
      { name: "record", ok: true },
      { name: "broken", ok: false, error: "overlay failure" },
    ],
  ]);
  const quiet = createSlidesRuntime({
    llm: new ScriptedLlm([() => ({ text: "无钩子" })]),
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  let fired = false;
  quiet.subscribe((event) => {
    if (event.type === "post-turn") fired = true;
  });
  await quiet.prompt("你好");
  assert.equal(fired, false, "core ships no post-turn hooks by default");
});

test("the runtime trips the short loop on three identical invalid write_page calls and pauses", async () => {
  const broken = { id: "p01", pageType: "content", elements: [{ elementId: "t", elementType: "text" }] };
  const llm = new ScriptedLlm(
    Array.from({ length: 6 }, (_, index) =>
      index === 0
        ? () => ({ calls: [{ name: "open_project", args: { title: "循环" } }] })
        : () => ({ calls: [{ name: "write_page", args: broken }] }),
    ),
  );
  const runtime = createSlidesRuntime({
    llm,
    dataRoot: tempDir("loop"),
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  const result = await runtime.prompt("写一页");
  assert.equal(result.status, "paused");
  assert.equal(result.fault?.code, "tool-invalid-args-loop");
  assert.equal(llm.requests.length, 4, "no further model request after the trip");
});
