/**
 * A/B parity between the DSH host guards and the host-neutral
 * `@open-slidestudio/slides-runtime` guards over the recorded fixture. The
 * host side is replayed live here, so the fixture can never drift from the
 * guards it claims to have been recorded from.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyFault,
  ProgressGuard,
  ToolInvalidArgsLoopGuard as RuntimeLoopGuard,
  parseRetryAfterMs as runtimeRetryAfter,
  rateLimitWaitMs as runtimeWait,
  type GuardEvent,
  type PersistentProductSnapshot,
} from "@open-slidestudio/slides-runtime";
import { classifyAgentError, parseRetryAfterMs, rateLimitWaitMs } from "./agent-fault.js";
import { ProductProgressSessionGuard } from "./product-progress-guard.js";
import { ToolInvalidArgsLoopGuard } from "./tool-loop-guard.js";

type JournalEvent = { type: string; data: Record<string, unknown> };
type Trip = Record<string, unknown>;
type Scenario = {
  name: string;
  events: JournalEvent[];
  snapshots: string[];
  expected: { toolLoop: Trip[]; progress: Trip[] };
};
type Fixture = {
  now: number;
  snapshotTable: Record<string, PersistentProductSnapshot>;
  scenarios: Scenario[];
  faults: { input: unknown; expected: unknown }[];
  retries: { input: unknown; expected: number | null }[];
  waits: { attempt: number; retryAfterMs?: number; expected: number }[];
};

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../slides-runtime/fixtures/guard-ab.v1.json",
);
const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Fixture;

function neutral(event: JournalEvent): GuardEvent {
  const data = event.data;
  if (event.type === "turn/start" || event.type === "turn/end") return { type: event.type, turn: Number(data.turn) };
  if (event.type === "tool/call") {
    return { type: "tool/call", callId: String(data.callId), toolName: String(data.name), step: Number(data.step) };
  }
  const message = data.message as { content: { toolCallId: string; content: { type: string; text: string }[] }[] };
  const block = message.content[0]!;
  const error = data.error as { code: string; name: string } | undefined;
  return {
    type: "tool/result",
    callId: block.toolCallId,
    step: Number(data.step),
    texts: block.content.filter((item) => item.type === "text").map((item) => item.text),
    ...(error ? { error } : {}),
  };
}

type Observer = { loop(event: JournalEvent): Trip | undefined; progress(event: JournalEvent): Trip | undefined };

function replay(scenario: Scenario, observer: (sample: () => PersistentProductSnapshot) => Observer) {
  let cursor = 0;
  const sample = () => fixture.snapshotTable[scenario.snapshots[cursor++] ?? scenario.snapshots.at(-1)!]!;
  const guards = observer(sample);
  const toolLoop: Trip[] = [];
  const progress: Trip[] = [];
  scenario.events.forEach((event, index) => {
    const trip = guards.loop(event);
    if (trip) toolLoop.push({ index, code: trip.code, toolName: trip.toolName, count: trip.count });
    const ptrip = guards.progress(event);
    if (ptrip) {
      progress.push({
        index,
        code: ptrip.code,
        count: ptrip.count,
        limit: ptrip.limit,
        ...(ptrip.toolName ? { toolName: ptrip.toolName } : {}),
      });
    }
  });
  return { toolLoop, progress };
}

const hostGuards = (sample: () => PersistentProductSnapshot): Observer => {
  const loop = new ToolInvalidArgsLoopGuard();
  const progress = new ProductProgressSessionGuard({ sample });
  return { loop: (event) => loop.observe("s", event), progress: (event) => progress.observe("s", "/unused", event) };
};

const runtimeGuards = (sample: () => PersistentProductSnapshot): Observer => {
  const loop = new RuntimeLoopGuard();
  const progress = new ProgressGuard({ sample });
  return {
    loop: (event) => loop.observe("s", neutral(event)),
    progress: (event) => progress.observe("s", "/unused", neutral(event), event.data.turn as number | undefined),
  };
};

for (const scenario of fixture.scenarios) {
  test(`host and runtime guards trip identically: ${scenario.name}`, () => {
    const host = replay(scenario, hostGuards);
    assert.deepEqual(host, scenario.expected, "the fixture still matches the host guards");
    assert.deepEqual(replay(scenario, runtimeGuards), host);
  });
}

test("host and runtime fault classification, Retry-After and backoff agree", () => {
  for (const row of fixture.faults) {
    const raw = row.input as { error?: string };
    const input = raw.error !== undefined ? new Error(raw.error) : row.input;
    assert.deepEqual(classifyAgentError(input), row.expected);
    assert.deepEqual(classifyFault(input), classifyAgentError(input), JSON.stringify(row.input));
  }
  for (const row of fixture.retries) {
    assert.equal(parseRetryAfterMs(row.input, fixture.now) ?? null, row.expected);
    assert.equal(runtimeRetryAfter(row.input, fixture.now), parseRetryAfterMs(row.input, fixture.now));
  }
  for (const row of fixture.waits) {
    assert.equal(runtimeWait(row.attempt, row.retryAfterMs), rateLimitWaitMs(row.attempt, row.retryAfterMs));
  }
});
