/**
 * Runtime side of the slides-tools single-writer lease: acquire before a
 * turn writes, renew on a heartbeat, detect loss or editor preemption, and
 * release on turn end, abort and dispose. A lost lease fails closed: the
 * keeper reports a fault and the runtime aborts the run.
 */
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

const activeInProcessHolders = new Map<string, WriterLeaseKeeper>();

function canonicalRoot(projectRoot: string): string {
  try {
    return fs.realpathSync(projectRoot);
  } catch {
    return path.resolve(projectRoot);
  }
}

export function isLeaseFaultCode(code: string | undefined): boolean {
  return code === "lease-conflict" || code === "lease-preempted-by-editor" || code === "writer-lease-lost";
}

export type LeaseKeeperOptions = {
  readonly caller: SlideCaller;
  readonly ttlMs?: number;
  readonly heartbeatMs?: number;
  /** Called once when a held lease is lost or preempted. */
  readonly onLost: (fault: RuntimeFault) => void;
};

export type LeaseStatus = "idle" | "held" | "lost";

function lostFault(projectRoot: string, ownerId: string): RuntimeFault {
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
  private readonly pid = process.pid;
  private readonly hostname = os.hostname();
  private root?: string;
  private rootKey?: string;
  private token?: string;
  private timer?: NodeJS.Timeout;
  private state: LeaseStatus = "idle";

  constructor(private readonly options: LeaseKeeperOptions) {}

  get status(): LeaseStatus {
    return this.state;
  }

  get projectRoot(): string | undefined {
    return this.root;
  }

  private clearInProcessHolder(): void {
    if (this.rootKey && activeInProcessHolders.get(this.rootKey) === this) {
      activeInProcessHolders.delete(this.rootKey);
    }
  }

  /** Acquire (or renew) the lease for `projectRoot`; a refusal is returned as a fault. */
  acquire(projectRoot: string): RuntimeFault | undefined {
    const key = canonicalRoot(projectRoot);
    const existing = activeInProcessHolders.get(key);
    if (existing && existing !== this && existing.state === "held") {
      return {
        code: "lease-conflict",
        detail: `project is already held by another active runtime instance (${existing.options.caller.kind})`,
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
    this.clearInProcessHolder();
    this.root = projectRoot;
    this.rootKey = key;
    this.token = result.lease.token;
    this.state = "held";
    activeInProcessHolders.set(key, this);
    this.startHeartbeat();
    return undefined;
  }

  private markLost(projectRoot: string): RuntimeFault {
    const fault = lostFault(projectRoot, this.options.caller.id);
    this.state = "lost";
    this.token = undefined;
    this.clearInProcessHolder();
    this.stopHeartbeat();
    this.options.onLost(fault);
    return fault;
  }

  /** Verify live ownership under the lease lock and execute `write` atomically; returns false on loss. */
  withAuthorizedWrite(projectRoot: string, write: () => void): boolean {
    if (this.state !== "held" || this.root !== projectRoot) return false;
    if (this.rootKey && activeInProcessHolders.get(this.rootKey) !== this) return false;
    let authorized = false;
    let lost = false;
    withProjectLeaseLock(projectRoot, () => {
      const current = readProjectLease(projectRoot);
      if (
        current.holder?.ownerId === this.options.caller.id &&
        current.holder.pid === this.pid &&
        current.holder.hostname === this.hostname &&
        current.active
      ) {
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
    const owned = this.state === "held" && (!this.rootKey || activeInProcessHolders.get(this.rootKey) === this);
    this.state = "idle";
    this.token = undefined;
    this.clearInProcessHolder();
    if (!root || !owned) return false;
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
