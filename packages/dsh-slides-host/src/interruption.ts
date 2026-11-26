import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_WRITER_LEASE_TTL_MS,
  leaseHolderActive,
  readProjectLease,
  releaseProjectLease as releaseWriterLease,
  renewProjectLease,
  withProjectLeaseLock,
  type ProjectLeaseHolder,
} from "@open-slidestudio/slides-tools";
import { readRuntimeTurnLease, readTraceHighWater } from "@open-slidestudio/slides-runtime";
import { AGENT_TRACE_REL, appendAgentTrace, type AgentTraceRow } from "./agent-trace.js";
import { readAgentError, readRateLimitWait, recordAgentError } from "./agent-fault.js";
import { readAttempt } from "./session-transition.js";
import type { SliceSessionStore } from "./slice-session.js";

const DEFERRED_RELEASE_FAST_RETRY_MS = 25;
const DEFERRED_RELEASE_SLOW_RETRY_MS = 100;
const DEFERRED_RELEASE_FAST_ATTEMPTS = 40;
const DEFERRED_RELEASE_MAX_ATTEMPTS = 340;
const HEARTBEAT_BUSY_RETRY_MS = 5;

export type LeaseRenewStatus = "renewed" | "busy" | "not-held";

export type DeferredReleaseOptions = {
  readonly canRelease?: () => boolean;
  readonly registry?: DeferredReleaseRegistry;
  readonly retryMs?: number;
  readonly maxAttempts?: number;
};

/** Tracks pending non-blocking lease release retries so new turns or plugin unload cancel them. */
export class DeferredReleaseRegistry {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  set(sessionId: string, timer: ReturnType<typeof setTimeout>): void {
    this.cancel(sessionId);
    this.timers.set(sessionId, timer);
  }

  clear(sessionId: string, timer: ReturnType<typeof setTimeout>): void {
    if (this.timers.get(sessionId) === timer) this.timers.delete(sessionId);
  }

  cancel(sessionId: string): void {
    const existing = this.timers.get(sessionId);
    if (!existing) return;
    clearTimeout(existing);
    this.timers.delete(sessionId);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

function isWriteLockContention(error: unknown): boolean {
  return error instanceof Error && /project write lock/i.test(error.message);
}

/**
 * Release a Hub session's leftover writer lease atomically under the lease lock:
 * never revokes an active turn lease or an active lease owned by another live process.
 */
export function releaseHubWriterLease(projectRoot: string, sessionId: string): boolean {
  try {
    return releaseWriterLease(projectRoot, `hub-run:${sessionId}`, {
      canRelease: (holder) =>
        !readRuntimeTurnLease(projectRoot).active &&
        (!leaseHolderActive(holder) || (holder.pid === process.pid && holder.hostname === os.hostname())),
    });
  } catch {
    return false;
  }
}

function isCurrentProcessHolder(holder: ProjectLeaseHolder | undefined, ownerId: string): boolean {
  return Boolean(
    holder && holder.ownerId === ownerId && holder.pid === process.pid && holder.hostname === os.hostname(),
  );
}

function runDeferredReleaseAttempt(
  projectRoot: string,
  sessionId: string,
  ownerId: string,
  expectedToken: string | null,
  options: DeferredReleaseOptions,
  attempt: number,
): boolean {
  if (options.canRelease && !options.canRelease()) return false;
  if (attempt > 0) {
    const holder = readProjectLease(projectRoot).holder;
    if (!isCurrentProcessHolder(holder, ownerId) || (holder?.token ?? null) !== expectedToken) return false;
  }
  try {
    return releaseWriterLease(projectRoot, ownerId, {
      lockTimeoutMs: 0,
      expectedToken,
      expectedPid: process.pid,
      expectedHostname: os.hostname(),
    });
  } catch (error) {
    const maxAttempts = options.maxAttempts ?? DEFERRED_RELEASE_MAX_ATTEMPTS;
    if (isWriteLockContention(error) && attempt < maxAttempts) {
      const delay =
        options.retryMs ??
        (attempt < DEFERRED_RELEASE_FAST_ATTEMPTS ? DEFERRED_RELEASE_FAST_RETRY_MS : DEFERRED_RELEASE_SLOW_RETRY_MS);
      const timer = setTimeout(() => {
        options.registry?.clear(sessionId, timer);
        runDeferredReleaseAttempt(projectRoot, sessionId, ownerId, expectedToken, options, attempt + 1);
      }, delay);
      timer.unref?.();
      options.registry?.set(sessionId, timer);
    }
    return false;
  }
}

/**
 * Non-blocking release for live event-loop paths (`agent/status: idle`,
 * `agent/disposed`, HTTP stop): verifies lifetime/eligibility first, snapshots
 * the lease generation token, attempts one zero-wait lease-lock acquire, and
 * retries asynchronously on lock contention with compare-and-delete so neither
 * a stale retry nor an unloaded plugin can delete a lease owned by a later turn
 * or a successor process with the same ownerId.
 */
export function releaseHubWriterLeaseNonBlocking(
  projectRoot: string,
  sessionId: string,
  options: DeferredReleaseOptions = {},
): boolean {
  if (options.canRelease && !options.canRelease()) return false;
  const ownerId = `hub-run:${sessionId}`;
  const holder = readProjectLease(projectRoot).holder;
  if (!isCurrentProcessHolder(holder, ownerId)) {
    options.registry?.cancel(sessionId);
    return false;
  }
  return runDeferredReleaseAttempt(projectRoot, sessionId, ownerId, holder!.token ?? null, options, 0);
}

/** Resolve a bound Hub session and release its single-writer lease if held. */
export function releaseBoundHubWriterLease(
  store: Pick<SliceSessionStore, "bindingFor" | "resolveRoot">,
  sessionId: string,
  nonBlocking = false,
  options: DeferredReleaseOptions = {},
): boolean {
  const binding = store.bindingFor(sessionId);
  if (!binding) return false;
  const root = store.resolveRoot(binding);
  return nonBlocking
    ? releaseHubWriterLeaseNonBlocking(root, sessionId, options)
    : releaseHubWriterLease(root, sessionId);
}

/** Extend an already-owned Hub writer lease without acquiring a new one or blocking on `.pptd-write.lock`. */
export function renewBoundHubWriterLease(
  store: Pick<SliceSessionStore, "bindingFor" | "resolveRoot">,
  sessionId: string,
  ttlMs = DEFAULT_WRITER_LEASE_TTL_MS,
): LeaseRenewStatus {
  const binding = store.bindingFor(sessionId);
  if (!binding) return "not-held";
  const root = store.resolveRoot(binding);
  const ownerId = `hub-run:${sessionId}`;
  if (!isCurrentProcessHolder(readProjectLease(root).holder, ownerId)) return "not-held";
  try {
    return renewProjectLease(root, {
      kind: "hub-run",
      ownerId,
      ttlMs,
      lockTimeoutMs: 0,
      renewOnly: true,
    }).ok
      ? "renewed"
      : "not-held";
  } catch (error) {
    return isWriteLockContention(error) ? "busy" : "not-held";
  }
}

/**
 * True when any live process (or another in-process runtime instance) currently
 * holds an active runtime turn lease, or when another live process owns an
 * active Hub writer lease for this project.
 */
export function hasActiveLiveTurn(projectRoot: string, sessionId?: string): boolean {
  if (readRuntimeTurnLease(projectRoot).active) return true;
  const writer = readProjectLease(projectRoot);
  if (!writer.active || writer.holder?.kind !== "hub-run") return false;
  if (sessionId && writer.holder.ownerId !== `hub-run:${sessionId}`) return false;
  return writer.holder.pid !== process.pid || writer.holder.hostname !== os.hostname();
}

/** Activation recovery: drop any leftover Hub writer lease before marking interrupted turns. */
export function recoverSessionOnActivation(projectRoot: string, sessionId: string, now = new Date()): boolean {
  if (hasActiveLiveTurn(projectRoot, sessionId)) return false;
  releaseHubWriterLease(projectRoot, sessionId);
  return markInterruptedTurn(projectRoot, now);
}

type LiveAgentProbe = {
  readonly id?: string;
  readonly session?: { readonly id?: string };
  readonly status?: string;
};

/** Collect session ids for agents that are already non-idle at activation (hot reload). */
export function activeAgentIds(agents: Iterable<LiveAgentProbe>): Set<string> {
  const running = new Set<string>();
  for (const agent of agents) {
    if (agent.status === "idle") continue;
    const id = agent.id ?? agent.session?.id;
    if (id) running.add(id);
  }
  return running;
}

/**
 * Recover persisted sessions on plugin activation without disturbing live agents
 * that survived a hot reload. Running sessions keep their writer lease until they
 * reach idle or are disposed.
 */
export function recoverSessionsOnActivation(
  store: Pick<SliceSessionStore, "rebuild" | "resolveRoot">,
  liveAgents: Iterable<LiveAgentProbe>,
  busy: Set<string>,
  onInterrupted?: (sessionId: string) => void,
): void {
  const running = activeAgentIds(liveAgents);
  for (const id of running) busy.add(id);
  for (const [sessionId, binding] of store.rebuild()) {
    if (running.has(sessionId)) continue;
    try {
      if (recoverSessionOnActivation(store.resolveRoot(binding), sessionId)) {
        onInterrupted?.(sessionId);
      }
    } catch {
      /* best-effort: a corrupt trace must not block plugin activation */
    }
  }
}

export type BoundedStopOptions = {
  readonly onIdle: () => void;
  readonly onHeartbeat?: () => LeaseRenewStatus | boolean | void;
  readonly heartbeatIntervalMs?: number;
  readonly busyRetryMs?: number;
  readonly signal?: AbortSignal;
};

/**
 * Cancel an active agent and bound the HTTP wait while keeping lease cleanup
 * attached to actual idle settlement so hung tools cannot race a new writer.
 * Immediately renews the active lease before awaiting `whenIdle()` and keeps a
 * `.unref()` heartbeat running until `whenIdle()` settles or `signal` aborts.
 */
export async function stopAgentWithBoundedWait(
  agent: { cancel(reason: { kind: "user" }): void; whenIdle(): Promise<void> } | undefined,
  timeoutMs: number,
  options: BoundedStopOptions,
): Promise<boolean> {
  if (!agent) {
    options.onIdle();
    return true;
  }
  let settled = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let busyRetry: ReturnType<typeof setTimeout> | undefined;
  const stopTimers = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (busyRetry) {
      clearTimeout(busyRetry);
      busyRetry = undefined;
    }
    options.signal?.removeEventListener("abort", stopTimers);
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    stopTimers();
    if (options.signal?.aborted) return;
    options.onIdle();
  };
  const busyRetryMs = options.busyRetryMs ?? HEARTBEAT_BUSY_RETRY_MS;
  const pulse = () => {
    if (settled || options.signal?.aborted || !options.onHeartbeat) {
      stopTimers();
      return;
    }
    const status = options.onHeartbeat();
    if (status === "busy" && !busyRetry && !settled && !options.signal?.aborted) {
      busyRetry = setTimeout(() => {
        busyRetry = undefined;
        pulse();
      }, busyRetryMs);
      busyRetry.unref?.();
    }
  };
  options.signal?.addEventListener("abort", stopTimers, { once: true });
  agent.cancel({ kind: "user" });
  const idle = Promise.resolve()
    .then(() => agent.whenIdle())
    .then(finish, finish);
  if (options.onHeartbeat && !options.signal?.aborted) {
    pulse();
    const intervalMs = options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(DEFAULT_WRITER_LEASE_TTL_MS / 2));
    heartbeat = setInterval(pulse, intervalMs);
    heartbeat.unref?.();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([idle, timeout]);
  if (timer) clearTimeout(timer);
  return settled;
}

export type HubWriterLeaseController = {
  cancelPendingRelease(sessionId: string): void;
  releaseNonBlocking(sessionId: string, projectRoot?: string): boolean;
  stopAndRelease(
    agent: { cancel(reason: { kind: "user" }): void; whenIdle(): Promise<void> } | undefined,
    sessionId: string,
    timeoutMs: number,
    heartbeatIntervalMs?: number,
  ): Promise<boolean>;
  dispose(): void;
};

/** Plugin-scoped coordinator for non-blocking Hub lease release and stop heartbeats. */
export function createHubWriterLeaseController(
  store: Pick<SliceSessionStore, "bindingFor" | "resolveRoot">,
  busy: ReadonlySet<string>,
): HubWriterLeaseController {
  const registry = new DeferredReleaseRegistry();
  const lifetime = new AbortController();
  const releaseOptions = (sessionId: string): DeferredReleaseOptions => ({
    registry,
    canRelease: () => !lifetime.signal.aborted && !busy.has(sessionId),
  });
  return {
    cancelPendingRelease(sessionId) {
      registry.cancel(sessionId);
    },
    releaseNonBlocking(sessionId, projectRoot) {
      const opts = releaseOptions(sessionId);
      return projectRoot
        ? releaseHubWriterLeaseNonBlocking(projectRoot, sessionId, opts)
        : releaseBoundHubWriterLease(store, sessionId, true, opts);
    },
    stopAndRelease(agent, sessionId, timeoutMs, heartbeatIntervalMs) {
      return stopAgentWithBoundedWait(agent, timeoutMs, {
        onIdle: () => releaseBoundHubWriterLease(store, sessionId, true, releaseOptions(sessionId)),
        onHeartbeat: () => renewBoundHubWriterLease(store, sessionId),
        signal: lifetime.signal,
        ...(heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs } : {}),
      });
    },
    dispose() {
      lifetime.abort();
      registry.dispose();
    },
  };
}

/** Long generations append megabytes of deltas; the marker only needs the tail. */
const TAIL_BYTES = 128 * 1024;

export const HOST_INTERRUPTED_CODE = "host-interrupted";
const INTERRUPTED_DETAIL = "Turn interrupted during restart or recovery";

type OpenTurnScan = {
  /** Step rows (kind "turn", name "step") whose last write is still running. */
  readonly openSteps: AgentTraceRow[];
  /** Turn rows (kind "turn", name "turn") whose last write is still running. */
  readonly openTurns: AgentTraceRow[];
  /** Terminal status of the most recently written closed turn, if any. */
  readonly lastTurnTerminal?: AgentTraceRow["status"];
};

function asRow(value: unknown): AgentTraceRow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as AgentTraceRow;
  return typeof row.id === "string" && row.id ? row : undefined;
}

/** Fold the append-only trace tail: a later row replaces the status of its id. */
function scanOpenTurns(projectRoot: string): OpenTurnScan {
  const file = path.join(projectRoot, AGENT_TRACE_REL);
  if (!fs.existsSync(file)) return { openSteps: [], openTurns: [] };
  const size = fs.statSync(file).size;
  const offset = Math.max(0, size - TAIL_BYTES);
  const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    fs.closeSync(fd);
  }
  // Drop the first partial line when the window starts mid-record.
  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  if (offset > 0) lines.shift();
  const latest = new Map<string, AgentTraceRow>();
  let lastTurnTerminal: AgentTraceRow["status"] | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: AgentTraceRow | undefined;
    try {
      row = asRow(JSON.parse(line));
    } catch {
      continue;
    }
    if (!row || row.kind !== "turn" || typeof row.name !== "string") continue;
    if (row.status === "running") {
      latest.set(row.id, row);
    } else {
      latest.delete(row.id);
      if (row.name === "turn") lastTurnTerminal = row.status;
    }
  }
  const open = [...latest.values()];
  return {
    openSteps: open.filter((row) => row.name === "step"),
    openTurns: open.filter((row) => row.name === "turn"),
    lastTurnTerminal,
  };
}

/**
 * A turn the process never closed is dead work: the Host was killed (SIGKILL,
 * crash, OS AutomaticTermination) before turn/end could land. Persist the
 * interruption so the durable projections read paused-with-continue instead of
 * a permanently active "thinking" phase.
 *
 * Safe while idle only — callers must check agent activity first. Skips when a
 * fault or an armed rate-limit retry already owns the verdict, and when the
 * latest turn ended normally.
 */
export function markInterruptedTurn(projectRoot: string, now = new Date()): boolean {
  if (!fs.existsSync(path.join(projectRoot, AGENT_TRACE_REL))) return false;
  return withProjectLeaseLock(projectRoot, () => {
    if (hasActiveLiveTurn(projectRoot)) return false;
    if (readAgentError(projectRoot)) return false;
    const wait = readRateLimitWait(projectRoot);
    if (wait && wait.nextRetryAt > Date.now()) return false;
    const scan = scanOpenTurns(projectRoot);
    if (!scan.openTurns.length && !scan.openSteps.length && scan.lastTurnTerminal !== "cancelled") return false;
    const at = now.toISOString();
    let nextSeq = readTraceHighWater(projectRoot).maxSeq;
    const assignSeq = (row: AgentTraceRow): AgentTraceRow => {
      const { seq: _ignored, ...rest } = row;
      return { ...rest, seq: ++nextSeq };
    };
    const rows: AgentTraceRow[] = [];
    // Close steps before their turn so readers fold terminal states in order.
    for (const row of scan.openSteps) {
      rows.push(assignSeq({ ...row, at, status: "cancelled", detail: INTERRUPTED_DETAIL, detailMode: "replace" }));
    }
    // A step can outlive its turn's start row in the tail window; any turn with
    // an open step is by definition unclosed, so close it by number either way.
    const openTurnsByNumber = new Map<number, AgentTraceRow>();
    for (const row of scan.openTurns) {
      if (typeof row.turn === "number") openTurnsByNumber.set(row.turn, row);
    }
    for (const row of scan.openSteps) {
      if (typeof row.turn === "number" && !openTurnsByNumber.has(row.turn)) {
        openTurnsByNumber.set(row.turn, {
          id: `turn:${row.turn}`,
          at: row.at,
          turn: row.turn,
          kind: "turn",
          name: "turn",
          status: "running",
          detailMode: "replace",
        });
      }
    }
    for (const row of openTurnsByNumber.values()) {
      rows.push(assignSeq({ ...row, at, status: "cancelled", detail: INTERRUPTED_DETAIL, detailMode: "replace" }));
    }
    appendAgentTrace(projectRoot, rows);
    const attemptId = readAttempt(projectRoot)?.attemptId;
    recordAgentError(projectRoot, {
      code: HOST_INTERRUPTED_CODE,
      detail: "应用或主机已重启，生成中断；已完成的内容保留，可在编辑器中继续。",
      ...(attemptId ? { attemptId } : {}),
    });
    return true;
  });
}
