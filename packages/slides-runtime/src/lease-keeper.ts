/**
 * Runtime side of the slides-tools leases:
 * - `mode: "writer"` (default) holds both the project single-writer lease
 *   (`_agent/writer-lease.v1.json`) and the runtime turn lease
 *   (`_agent/runtime-turn.lease.v1.json`), preventing concurrent deck or log
 *   writes across Hub runs, MCP clients and the human editor.
 * - `mode: "session"` (read-only discussion turns) holds only the runtime turn
 *   lease so concurrent runtimes never corrupt `_agent/runtime-session.v1.jsonl`
 *   or `_agent/agent-trace.jsonl`, while leaving `_agent/writer-lease.v1.json`
 *   untouched for the human editor or MCP.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireProjectLease,
  DEFAULT_WRITER_LEASE_TTL_MS,
  readProjectLease,
  releaseProjectLease,
  renewProjectLease,
  withProjectLeaseLock,
  type SlideCaller,
} from "@open-slidestudio/slides-tools";
import type { RuntimeFault } from "./faults.js";

export const DEFAULT_LEASE_HEARTBEAT_MS = 60_000;
export const RUNTIME_TURN_LEASE_FILE = path.join("_agent", "runtime-turn.lease.v1.json");

export type LeaseMode = "writer" | "session";

type TurnLeaseHolder = {
  readonly kind: SlideCaller["kind"];
  readonly ownerId: string;
  readonly label?: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
  readonly token: string;
};

type TurnLeaseFile = { readonly version: 1; readonly holder?: TurnLeaseHolder };

const activeWriterHolders = new Map<string, WriterLeaseKeeper>();
const activeTurnHolders = new Map<string, WriterLeaseKeeper>();

function canonicalRoot(projectRoot: string): string {
  try {
    return fs.realpathSync(projectRoot);
  } catch {
    return path.resolve(projectRoot);
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function turnLeasePath(projectRoot: string): string {
  return path.join(projectRoot, RUNTIME_TURN_LEASE_FILE);
}

function readTurnLeaseFile(projectRoot: string): TurnLeaseFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(turnLeasePath(projectRoot), "utf8")) as Partial<TurnLeaseFile>;
    if (parsed?.version !== 1) return { version: 1 };
    return { version: 1, holder: parsed.holder };
  } catch {
    return { version: 1 };
  }
}

function writeTurnLeaseFile(projectRoot: string, fileData: TurnLeaseFile): void {
  const file = turnLeasePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(fileData, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function turnHolderActive(holder: TurnLeaseHolder | undefined, now = Date.now()): boolean {
  if (!holder) return false;
  const expiresMs = Date.parse(holder.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= now) return false;
  if (holder.hostname === os.hostname() && !pidAlive(holder.pid)) return false;
  return true;
}

export type RuntimeTurnLeaseState = {
  readonly holder?: TurnLeaseHolder;
  readonly active: boolean;
};

/** Lock-free read of the active runtime turn lease (covers both writer and read-only session turns). */
export function readRuntimeTurnLease(projectRoot: string, now = Date.now()): RuntimeTurnLeaseState {
  const holder = readTurnLeaseFile(projectRoot).holder;
  return {
    ...(holder ? { holder } : {}),
    active: turnHolderActive(holder, now),
  };
}

export function isLeaseFaultCode(code: string | undefined): boolean {
  return code === "lease-conflict" || code === "lease-preempted-by-editor" || code === "writer-lease-lost";
}

export type LeaseKeeperOptions = {
  readonly caller: SlideCaller;
  readonly mode?: LeaseMode;
  readonly ttlMs?: number;
  readonly heartbeatMs?: number;
  /** Called once when a held lease is lost or preempted. */
  readonly onLost: (fault: RuntimeFault) => void;
};

export type LeaseStatus = "idle" | "held" | "lost";

function lostFault(projectRoot: string, ownerId: string, mode: LeaseMode): RuntimeFault {
  if (mode === "session") {
    const holder = readTurnLeaseFile(projectRoot).holder;
    return {
      code: "writer-lease-lost",
      detail: holder
        ? `the runtime session turn lease is now held by ${holder.kind}${holder.label ? ` (${holder.label})` : ""}; the run stopped without further writes`
        : "the runtime session turn lease is no longer held by this run; the run stopped without further writes",
    };
  }
  const state = readProjectLease(projectRoot);
  const preemption = state.preempted.find((row) => row.ownerId === ownerId);
  if (preemption) {
    return {
      code: "lease-preempted-by-editor",
      detail: `the human editor${preemption.byLabel ? ` (${preemption.byLabel})` : ""} took this project over; the run stopped without further writes`,
    };
  }
  const holder = state.holder;
  return {
    code: "writer-lease-lost",
    detail: holder
      ? `the project writer lease is now held by ${holder.kind}${holder.label ? ` (${holder.label})` : ""}; the run stopped without further writes`
      : "the project writer lease is no longer held by this run; the run stopped without further writes",
  };
}

function isLockContention(error: unknown): boolean {
  return error instanceof Error && /lock|EEXIST|busy|timed? ?out/i.test(error.message);
}

export class WriterLeaseKeeper {
  private readonly mode: LeaseMode;
  private readonly pid = process.pid;
  private readonly hostname = os.hostname();
  private root?: string;
  private rootKey?: string;
  private token?: string;
  private turnToken?: string;
  private timer?: NodeJS.Timeout;
  private state: LeaseStatus = "idle";

  constructor(private readonly options: LeaseKeeperOptions) {
    this.mode = options.mode ?? "writer";
  }

  get status(): LeaseStatus {
    return this.state;
  }

  get projectRoot(): string | undefined {
    return this.root;
  }

  private clearInProcessHolders(): void {
    if (!this.rootKey) return;
    if (activeTurnHolders.get(this.rootKey) === this) activeTurnHolders.delete(this.rootKey);
    if (activeWriterHolders.get(this.rootKey) === this) activeWriterHolders.delete(this.rootKey);
  }

  private acquireTurnLease(projectRoot: string): { ok: true; token: string } | { ok: false; fault: RuntimeFault } {
    const ttl = this.options.ttlMs ?? DEFAULT_WRITER_LEASE_TTL_MS;
    return withProjectLeaseLock(projectRoot, () => {
      const now = Date.now();
      const current = readTurnLeaseFile(projectRoot).holder;
      const sameOwnerAndProcess =
        current?.ownerId === this.options.caller.id &&
        current.pid === this.pid &&
        current.hostname === this.hostname &&
        (!this.turnToken || current.token === this.turnToken);
      if (current && turnHolderActive(current, now) && !sameOwnerAndProcess) {
        return {
          ok: false as const,
          fault: {
            code: "lease-conflict",
            detail: `project already has an active runtime turn (${current.kind}${current.label ? ` (${current.label})` : ""}) until ${current.expiresAt}`,
          },
        };
      }
      const next: TurnLeaseHolder = {
        kind: this.options.caller.kind,
        ownerId: this.options.caller.id,
        ...(this.options.caller.label ? { label: this.options.caller.label } : {}),
        pid: this.pid,
        hostname: this.hostname,
        acquiredAt: sameOwnerAndProcess && current ? current.acquiredAt : new Date(now).toISOString(),
        renewedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttl).toISOString(),
        token: crypto.randomUUID(),
      };
      writeTurnLeaseFile(projectRoot, { version: 1, holder: next });
      return { ok: true as const, token: next.token };
    });
  }

  private matchesTurnHolder(projectRoot: string, now = Date.now()): boolean {
    const current = readTurnLeaseFile(projectRoot).holder;
    return Boolean(
      current &&
      this.turnToken &&
      current.ownerId === this.options.caller.id &&
      current.pid === this.pid &&
      current.hostname === this.hostname &&
      current.token === this.turnToken &&
      turnHolderActive(current, now),
    );
  }

  private renewTurnLease(projectRoot: string): boolean {
    const ttl = this.options.ttlMs ?? DEFAULT_WRITER_LEASE_TTL_MS;
    return withProjectLeaseLock(
      projectRoot,
      () => {
        const now = Date.now();
        const current = readTurnLeaseFile(projectRoot).holder;
        const ownedBySelf =
          current &&
          this.turnToken &&
          current.ownerId === this.options.caller.id &&
          current.pid === this.pid &&
          current.hostname === this.hostname &&
          current.token === this.turnToken;
        if (!ownedBySelf) return false;
        const next: TurnLeaseHolder = {
          ...current,
          renewedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + ttl).toISOString(),
          token: crypto.randomUUID(),
        };
        writeTurnLeaseFile(projectRoot, { version: 1, holder: next });
        this.turnToken = next.token;
        return true;
      },
      { timeoutMs: 0 },
    );
  }

  private releaseTurnLease(projectRoot: string, expectedToken: string | undefined): boolean {
    if (!fs.existsSync(turnLeasePath(projectRoot)) || !expectedToken) return false;
    return withProjectLeaseLock(projectRoot, () => {
      const current = readTurnLeaseFile(projectRoot).holder;
      if (
        !current ||
        current.ownerId !== this.options.caller.id ||
        current.pid !== this.pid ||
        current.hostname !== this.hostname ||
        current.token !== expectedToken
      ) {
        return false;
      }
      writeTurnLeaseFile(projectRoot, { version: 1 });
      return true;
    });
  }

  /** Acquire (or renew) the lease for `projectRoot`; a refusal is returned as a fault. */
  acquire(projectRoot: string): RuntimeFault | undefined {
    const key = canonicalRoot(projectRoot);
    const existingTurn = activeTurnHolders.get(key);
    if (existingTurn && existingTurn !== this && existingTurn.state === "held") {
      return {
        code: "lease-conflict",
        detail: `project is already held by another active runtime instance (${existingTurn.options.caller.kind})`,
      };
    }
    let writerToken: string | undefined;
    if (this.mode === "writer") {
      const existingWriter = activeWriterHolders.get(key);
      if (existingWriter && existingWriter !== this && existingWriter.state === "held") {
        return {
          code: "lease-conflict",
          detail: `project is already held by another active runtime instance (${existingWriter.options.caller.kind})`,
        };
      }
      const result = acquireProjectLease(projectRoot, {
        kind: this.options.caller.kind,
        ownerId: this.options.caller.id,
        ...(this.options.caller.label ? { label: this.options.caller.label } : {}),
        ttlMs: this.options.ttlMs ?? DEFAULT_WRITER_LEASE_TTL_MS,
        reacquire: true,
      });
      if (!result.ok) return { code: result.outcome, detail: result.detail };
      writerToken = result.lease.token;
    }
    const rollbackWriterLease = () => {
      if (this.mode !== "writer") return;
      try {
        releaseProjectLease(projectRoot, this.options.caller.id, {
          expectedToken: writerToken ?? null,
          expectedPid: this.pid,
          expectedHostname: this.hostname,
        });
      } catch {
        /* best-effort rollback when turn lease acquisition conflicted or threw */
      }
    };
    let turnLease: { ok: true; token: string } | { ok: false; fault: RuntimeFault };
    try {
      turnLease = this.acquireTurnLease(projectRoot);
    } catch (error) {
      rollbackWriterLease();
      throw error;
    }
    if (!turnLease.ok) {
      rollbackWriterLease();
      return turnLease.fault;
    }
    this.clearInProcessHolders();
    this.root = projectRoot;
    this.rootKey = key;
    this.token = writerToken;
    this.turnToken = turnLease.token;
    this.state = "held";
    activeTurnHolders.set(key, this);
    if (this.mode === "writer") activeWriterHolders.set(key, this);
    this.startHeartbeat();
    return undefined;
  }

  private markLost(projectRoot: string): RuntimeFault {
    const fault = lostFault(projectRoot, this.options.caller.id, this.mode);
    const prevTurnToken = this.turnToken;
    this.state = "lost";
    this.token = undefined;
    this.turnToken = undefined;
    this.clearInProcessHolders();
    this.stopHeartbeat();
    try {
      this.releaseTurnLease(projectRoot, prevTurnToken);
    } catch {
      /* best-effort cleanup on loss */
    }
    this.options.onLost(fault);
    return fault;
  }

  /** Verify live ownership under the lease lock and execute `write` atomically; returns false on loss. */
  withAuthorizedWrite(projectRoot: string, write: () => void): boolean {
    if (this.state !== "held" || this.root !== projectRoot) return false;
    if (this.rootKey && activeTurnHolders.get(this.rootKey) !== this) return false;
    if (this.mode === "writer" && this.rootKey && activeWriterHolders.get(this.rootKey) !== this) return false;
    let authorized = false;
    let lost = false;
    withProjectLeaseLock(projectRoot, () => {
      const turnValid = this.matchesTurnHolder(projectRoot);
      const writerValid =
        this.mode === "session" ||
        (() => {
          const current = readProjectLease(projectRoot);
          return Boolean(
            current.holder?.ownerId === this.options.caller.id &&
            current.holder.pid === this.pid &&
            current.holder.hostname === this.hostname &&
            current.active,
          );
        })();
      if (turnValid && writerValid) {
        write();
        authorized = true;
        return;
      }
      lost = true;
    });
    if (lost) this.markLost(projectRoot);
    return authorized;
  }

  /** Live check under the lease lock; transitions to `lost` and notifies if preempted/expired. */
  isAuthorized(projectRoot: string): boolean {
    return this.withAuthorizedWrite(projectRoot, () => undefined);
  }

  private startHeartbeat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.heartbeat(), this.options.heartbeatMs ?? DEFAULT_LEASE_HEARTBEAT_MS);
    this.timer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Renew the held lease once. Returns the fault when the lease was lost. */
  heartbeat(): RuntimeFault | undefined {
    const root = this.root;
    if (!root || this.state !== "held") return undefined;
    try {
      const turnRenewed = this.renewTurnLease(root);
      if (!turnRenewed) return this.markLost(root);
      if (this.mode === "session") return undefined;
      const renewed = renewProjectLease(root, {
        kind: this.options.caller.kind,
        ownerId: this.options.caller.id,
        ttlMs: this.options.ttlMs ?? DEFAULT_WRITER_LEASE_TTL_MS,
        renewOnly: true,
        lockTimeoutMs: 0,
      });
      if (renewed.ok) {
        this.token = renewed.lease.token;
        return undefined;
      }
    } catch (error) {
      if (isLockContention(error)) return undefined;
    }
    return this.markLost(root);
  }

  /** Release the lease if this owner still holds it. Idempotent. */
  release(): boolean {
    this.stopHeartbeat();
    const root = this.root;
    const prevTurnToken = this.turnToken;
    const ownedTurn = this.state === "held" && (!this.rootKey || activeTurnHolders.get(this.rootKey) === this);
    const ownedWriter =
      this.mode === "writer" &&
      this.state === "held" &&
      (!this.rootKey || activeWriterHolders.get(this.rootKey) === this);
    this.state = "idle";
    this.token = undefined;
    this.turnToken = undefined;
    this.clearInProcessHolders();
    if (!root || !ownedTurn) return false;
    let releasedTurn = false;
    try {
      releasedTurn = this.releaseTurnLease(root, prevTurnToken);
    } catch {
      releasedTurn = false;
    }
    if (!ownedWriter) return releasedTurn;
    try {
      return releaseProjectLease(root, this.options.caller.id, {
        expectedPid: this.pid,
        expectedHostname: this.hostname,
      });
    } catch {
      return false;
    }
  }
}
