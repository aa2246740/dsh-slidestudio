/**
 * Project-level single-writer lease. Exactly one owner (a Hub run, an MCP
 * client, or a human editor tab) may mutate a project at a time. The lease is
 * persisted under `<projectRoot>/_agent/writer-lease.v1.json`, every
 * read-modify-write runs inside the PPTD project write lock, and a TTL plus a
 * same-host pid probe keep a crashed process from wedging the project.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withProjectWriteLock } from "@open-slidestudio/pptd-v2";
import type { SlideCallerKind } from "./contract.js";

export const WRITER_LEASE_FILE = path.join("_agent", "writer-lease.v1.json");
export const WRITER_LEASE_LOCK_DIR = path.join("_agent", ".pptd-write.lock");
export const DEFAULT_WRITER_LEASE_TTL_MS = 10 * 60_000;

/**
 * Dedicated cross-process mutex under `<projectRoot>/_agent/` for lease and
 * run-metadata updates, so lease heartbeats and releases never stall behind
 * multi-file PPTD YAML saves holding `<projectRoot>/.pptd-write.lock`.
 */
export function withProjectLeaseLock<T>(
  projectRoot: string,
  action: () => T,
  opts: { readonly timeoutMs?: number } = {},
): T {
  return withProjectWriteLock(path.join(projectRoot, "_agent"), action, opts);
}

export type ProjectLeaseHolder = {
  readonly kind: SlideCallerKind;
  readonly ownerId: string;
  readonly label?: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
  /** Unique generation minted on every acquire or renew for compare-and-delete release. */
  readonly token?: string;
};

export type LeasePreemption = {
  readonly ownerId: string;
  readonly kind: SlideCallerKind;
  readonly byOwnerId: string;
  readonly byLabel?: string;
  readonly at: string;
};

type LeaseFile = {
  readonly version: 1;
  readonly holder?: ProjectLeaseHolder;
  readonly preempted: readonly LeasePreemption[];
};

export type LeaseRequest = {
  readonly kind: SlideCallerKind;
  readonly ownerId: string;
  readonly label?: string;
  readonly ttlMs?: number;
  /**
   * An owner preempted by the editor must re-acquire explicitly once the
   * editor released; an implicit per-write acquire keeps failing closed.
   */
  readonly reacquire?: boolean;
  readonly now?: number;
  readonly pid?: number;
  /** Only renew when `ownerId` already holds the lease; never acquire or take over. */
  readonly renewOnly?: boolean;
  /** Optional PPTD file-lock wait budget in ms (`0` = non-blocking single attempt). */
  readonly lockTimeoutMs?: number;
};

export type LeaseHolderView = {
  readonly kind: SlideCallerKind;
  readonly ownerId: string;
  readonly label?: string;
  readonly expiresAt: string;
};

export type LeaseAcquireResult =
  | {
      readonly ok: true;
      readonly outcome: "acquired" | "renewed" | "taken-over-expired" | "preempted";
      readonly lease: ProjectLeaseHolder;
      readonly preempted?: LeaseHolderView;
    }
  | {
      readonly ok: false;
      readonly outcome: "lease-conflict";
      readonly holder: LeaseHolderView;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "lease-preempted-by-editor";
      readonly preemption: LeasePreemption;
      readonly holder?: LeaseHolderView;
      readonly detail: string;
    };

function leasePath(projectRoot: string): string {
  return path.join(projectRoot, WRITER_LEASE_FILE);
}

function emptyLease(): LeaseFile {
  return { version: 1, preempted: [] };
}

function readLeaseFile(projectRoot: string): LeaseFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(leasePath(projectRoot), "utf8")) as Partial<LeaseFile>;
    if (parsed?.version !== 1) return emptyLease();
    return { version: 1, holder: parsed.holder, preempted: Array.isArray(parsed.preempted) ? parsed.preempted : [] };
  } catch {
    return emptyLease();
  }
}

function writeLeaseFile(projectRoot: string, lease: LeaseFile): void {
  const file = leasePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(lease, null, 2)}\n`);
  fs.renameSync(temp, file);
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

/** A holder is active until its TTL elapses or its same-host process exits. */
export function leaseHolderActive(holder: ProjectLeaseHolder | undefined, now = Date.now()): boolean {
  if (!holder) return false;
  const expiresMs = Date.parse(holder.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= now) return false;
  if (holder.hostname === os.hostname() && !pidAlive(holder.pid)) return false;
  return true;
}

function view(holder: ProjectLeaseHolder): LeaseHolderView {
  return {
    kind: holder.kind,
    ownerId: holder.ownerId,
    ...(holder.label ? { label: holder.label } : {}),
    expiresAt: holder.expiresAt,
  };
}

function holderFor(request: LeaseRequest, now: number, prior?: ProjectLeaseHolder): ProjectLeaseHolder {
  const ttl = request.ttlMs ?? DEFAULT_WRITER_LEASE_TTL_MS;
  return {
    kind: request.kind,
    ownerId: request.ownerId,
    ...(request.label ? { label: request.label } : {}),
    pid: request.pid ?? process.pid,
    hostname: os.hostname(),
    acquiredAt: prior?.acquiredAt ?? new Date(now).toISOString(),
    renewedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    token: crypto.randomUUID(),
  };
}

function describe(holder: ProjectLeaseHolder): string {
  return `${holder.kind}${holder.label ? ` (${holder.label})` : ""} until ${holder.expiresAt}`;
}

function preemptionBlock(lease: LeaseFile, request: LeaseRequest, now: number): LeaseAcquireResult | undefined {
  const preemption = lease.preempted.find((row) => row.ownerId === request.ownerId);
  if (!preemption) return undefined;
  const editorActive = lease.holder?.kind === "editor-human" && leaseHolderActive(lease.holder, now);
  if (request.reacquire && !editorActive) return undefined;
  return {
    ok: false,
    outcome: "lease-preempted-by-editor",
    preemption,
    ...(editorActive && lease.holder ? { holder: view(lease.holder) } : {}),
    detail: editorActive
      ? `the human editor took this project over; wait until it releases, then re-acquire the writer lease`
      : `the human editor changed this project after preempting you; re-read the project and re-acquire the writer lease`,
  };
}

function decide(
  lease: LeaseFile,
  request: LeaseRequest,
  now: number,
): { result: LeaseAcquireResult; next?: LeaseFile } {
  const blocked = preemptionBlock(lease, request, now);
  if (blocked) return { result: blocked };
  const preempted = lease.preempted.filter((row) => row.ownerId !== request.ownerId);
  const current = lease.holder;
  const effectivePid = request.pid ?? process.pid;
  const currentActive = leaseHolderActive(current, now);
  const sameProcess = current?.hostname === os.hostname() && current?.pid === effectivePid;
  if (current?.ownerId === request.ownerId && sameProcess) {
    const next = holderFor(request, now, current);
    return { result: { ok: true, outcome: "renewed", lease: next }, next: { version: 1, holder: next, preempted } };
  }
  if (request.renewOnly) {
    return {
      result: {
        ok: false,
        outcome: "lease-conflict",
        holder: current ? view(current) : { kind: request.kind, ownerId: "", expiresAt: new Date(0).toISOString() },
        detail: "writer lease is no longer held by this owner",
      },
    };
  }
  if (!currentActive) {
    const next = holderFor(request, now);
    const outcome = current ? "taken-over-expired" : "acquired";
    return { result: { ok: true, outcome, lease: next }, next: { version: 1, holder: next, preempted } };
  }
  const holder = current!;
  if (request.kind === "editor-human" && holder.kind === "mcp") {
    const next = holderFor(request, now);
    const marker: LeasePreemption = {
      ownerId: holder.ownerId,
      kind: holder.kind,
      byOwnerId: request.ownerId,
      ...(request.label ? { byLabel: request.label } : {}),
      at: new Date(now).toISOString(),
    };
    return {
      result: { ok: true, outcome: "preempted", lease: next, preempted: view(holder) },
      next: { version: 1, holder: next, preempted: [...preempted, marker] },
    };
  }
  return {
    result: {
      ok: false,
      outcome: "lease-conflict",
      holder: view(holder),
      detail: `project is being written by ${describe(holder)}`,
    },
  };
}

/** Acquire or renew the writer lease. Fails closed while another active owner holds it. */
export function acquireProjectLease(projectRoot: string, request: LeaseRequest): LeaseAcquireResult {
  const now = request.now ?? Date.now();
  const lockOpts = request.lockTimeoutMs !== undefined ? { timeoutMs: request.lockTimeoutMs } : {};
  return withProjectLeaseLock(
    projectRoot,
    () => {
      const { result, next } = decide(readLeaseFile(projectRoot), request, now);
      if (next) writeLeaseFile(projectRoot, next);
      return result;
    },
    lockOpts,
  );
}

/**
 * Heartbeat: re-acquiring an owned lease extends its TTL (`outcome: "renewed"`);
 * every other case follows the same fail-closed rules as an acquire.
 */
export function renewProjectLease(projectRoot: string, request: LeaseRequest): LeaseAcquireResult {
  return acquireProjectLease(projectRoot, request);
}

/** Release the lease if `ownerId` (and optional token/process guards) holds it. Returns whether a lease was released. */
export function releaseProjectLease(
  projectRoot: string,
  ownerId: string,
  opts: {
    readonly lockTimeoutMs?: number;
    readonly expectedToken?: string | null;
    readonly expectedPid?: number;
    readonly expectedHostname?: string;
    /** Evaluated atomically under `withProjectLeaseLock`; return false to refuse release. */
    readonly canRelease?: (holder: ProjectLeaseHolder) => boolean;
  } = {},
): boolean {
  if (!fs.existsSync(leasePath(projectRoot))) return false;
  const lockOpts = opts.lockTimeoutMs !== undefined ? { timeoutMs: opts.lockTimeoutMs } : {};
  return withProjectLeaseLock(
    projectRoot,
    () => {
      const lease = readLeaseFile(projectRoot);
      if (lease.holder?.ownerId !== ownerId) return false;
      if (opts.expectedToken !== undefined && (lease.holder.token ?? null) !== opts.expectedToken) return false;
      if (
        opts.expectedPid !== undefined &&
        (lease.holder.pid !== opts.expectedPid || lease.holder.hostname !== (opts.expectedHostname ?? os.hostname()))
      ) {
        return false;
      }
      if (opts.canRelease && !opts.canRelease(lease.holder)) return false;
      writeLeaseFile(projectRoot, { version: 1, preempted: lease.preempted });
      return true;
    },
    lockOpts,
  );
}

export type ProjectLeaseState = {
  readonly holder?: ProjectLeaseHolder;
  readonly active: boolean;
  readonly preempted: readonly LeasePreemption[];
};

export function readProjectLease(projectRoot: string, now = Date.now()): ProjectLeaseState {
  const lease = readLeaseFile(projectRoot);
  return {
    ...(lease.holder ? { holder: lease.holder } : {}),
    active: leaseHolderActive(lease.holder, now),
    preempted: lease.preempted,
  };
}
