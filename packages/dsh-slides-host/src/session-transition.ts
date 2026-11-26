import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SliceError } from "./protocol.js";
import { readAgentError, recordAgentError } from "./agent-fault.js";

const ATTEMPT_REL = path.join("_agent", "attempt.v1.json");

export type SessionTransitionPriority = "user" | "auto";

type TransitionQueue = {
  running: boolean;
  readonly user: Array<() => void>;
  readonly auto: Array<() => void>;
};

const queues = new Map<string, TransitionQueue>();

export class SessionTransitionConflict extends Error {
  readonly status = 409 as const;
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type AttemptRecord = Readonly<{
  attemptId: string;
  startedAt: string;
  recoveringFrom?: string;
}>;

export type ModelSelectionInput = Readonly<{
  provider: string;
  model: string;
  reasoningEffort?: string;
}>;

export function attemptPath(projectRoot: string): string {
  return path.join(projectRoot, ATTEMPT_REL);
}

export function readAttempt(projectRoot: string): AttemptRecord | undefined {
  const file = attemptPath(projectRoot);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AttemptRecord>;
    if (typeof parsed.attemptId === "string" && parsed.attemptId && typeof parsed.startedAt === "string") {
      return {
        attemptId: parsed.attemptId,
        startedAt: parsed.startedAt,
        ...(typeof parsed.recoveringFrom === "string" ? { recoveringFrom: parsed.recoveringFrom } : {}),
      };
    }
  } catch {
    /* ignore corrupt attempt files */
  }
  return undefined;
}

export function beginAttempt(projectRoot: string, previousFault?: SliceError): AttemptRecord {
  const attemptId = crypto.randomUUID();
  const record: AttemptRecord = {
    attemptId,
    startedAt: new Date().toISOString(),
    ...(previousFault?.attemptId ? { recoveringFrom: previousFault.attemptId } : {}),
  };
  fs.mkdirSync(path.join(projectRoot, "_agent"), { recursive: true });
  fs.writeFileSync(attemptPath(projectRoot), `${JSON.stringify(record, null, 2)}\n`);
  if (previousFault) {
    recordAgentError(projectRoot, { ...previousFault, recovering: true });
  }
  return record;
}

export function parseModelSelection(raw: unknown): ModelSelectionInput | undefined {
  if (raw == null) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("modelSelection must be an object");
  }
  const rec = raw as Record<string, unknown>;
  const provider = typeof rec.provider === "string" ? rec.provider.trim() : "";
  const model = typeof rec.model === "string" ? rec.model.trim() : "";
  if (!provider || !model) throw new Error("modelSelection requires provider and model");
  const reasoningEffort = typeof rec.reasoningEffort === "string" ? rec.reasoningEffort.trim() : "";
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export function parseExpectedAttemptId(raw: unknown): string | undefined {
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "string" || !raw.trim()) throw new Error("expectedAttemptId must be a string");
  return raw.trim();
}

export function assertExpectedAttempt(projectRoot: string | undefined, expected?: string): void {
  if (!expected) return;
  const current = projectRoot ? (readAttempt(projectRoot)?.attemptId ?? null) : null;
  if (current !== expected) {
    throw new SessionTransitionConflict(
      "attempt_conflict",
      "expectedAttemptId does not match the current session attempt",
    );
  }
}

function drainTransitionQueue(sessionId: string, queue: TransitionQueue): void {
  const next = queue.user.shift() ?? queue.auto.shift();
  if (next) {
    next();
    return;
  }
  queue.running = false;
  if (queues.get(sessionId) === queue) queues.delete(sessionId);
}

/**
 * Serialize per-session state transitions. Explicit user actions (`priority: "user"`,
 * the default) are dequeued ahead of automatic background recovery (`priority: "auto"`),
 * so a user `/model` or `/turn` request overtakes a queued 429 retry without needing to
 * mutate recovery state before validating preconditions inside the lock.
 */
export async function withSessionTransition<T>(
  sessionId: string,
  work: () => Promise<T>,
  options: { readonly priority?: SessionTransitionPriority } = {},
): Promise<T> {
  let queue = queues.get(sessionId);
  if (!queue) {
    queue = { running: false, user: [], auto: [] };
    queues.set(sessionId, queue);
  }
  const priority = options.priority ?? "user";
  if (queue.running) {
    await new Promise<void>((resolve) => {
      (priority === "auto" ? queue!.auto : queue!.user).push(resolve);
    });
  } else {
    queue.running = true;
  }
  try {
    return await work();
  } finally {
    drainTransitionQueue(sessionId, queue);
  }
}

export function markFaultRecovering(projectRoot: string): SliceError | undefined {
  const fault = readAgentError(projectRoot);
  if (!fault) return undefined;
  recordAgentError(projectRoot, { ...fault, recovering: true });
  return { ...fault, recovering: true };
}
