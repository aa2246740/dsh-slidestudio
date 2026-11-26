/**
 * Durable product-progress guard: a pure, replayable reducer over guard
 * events plus durable snapshots. It trips on repeated identical business
 * rejections (3), repeated identical invalid arguments (8), or a phase budget
 * of tool results without new persistent evidence (planning 64, production 32).
 * Every checkpoint is JSON-serializable.
 */
import { stableSha256 } from "@open-slidestudio/presentation-run";
import { INVALID_ARGS_CODE, type GuardEvent } from "./guard-events.js";
import {
  completionEvidenceFingerprint,
  normalizeCompletionEvidence,
  readPersistentProductSnapshot,
  type PersistentProductSnapshot,
  type ProductProgressPhase,
} from "./progress-snapshot.js";

export const REPEATED_BUSINESS_REJECTION_CODE = "repeated-business-rejection";
export const REPEATED_INVALID_ARGS_CODE = "repeated-invalid-args";
export const PLANNING_NO_PROGRESS_BUDGET_CODE = "planning-no-progress-budget";
export const PRODUCTION_NO_PROGRESS_BUDGET_CODE = "production-no-progress-budget";

export const DEFAULT_REPEATED_BUSINESS_REJECTION_LIMIT = 3;
export const DEFAULT_REPEATED_INVALID_ARGS_LIMIT = 8;
export const DEFAULT_PLANNING_NO_PROGRESS_LIMIT = 64;
export const DEFAULT_PRODUCTION_NO_PROGRESS_LIMIT = 32;

const DEFAULT_READ_ONLY_TOOLS = ["inspect_capabilities", "list_references", "read_page", "read_reference"];

export type ProductProgressConfig = Readonly<{
  repeatedBusinessRejectionLimit?: number;
  repeatedInvalidArgsLimit?: number;
  planningNoProgressLimit?: number;
  productionNoProgressLimit?: number;
  readOnlyTools?: readonly string[];
}>;

type Streak = Readonly<{ toolName: string; fingerprint: string; count: number; lastStep?: number }>;

export type ProgressTripCode =
  | typeof REPEATED_BUSINESS_REJECTION_CODE
  | typeof REPEATED_INVALID_ARGS_CODE
  | typeof PLANNING_NO_PROGRESS_BUDGET_CODE
  | typeof PRODUCTION_NO_PROGRESS_BUDGET_CODE;

export type ProgressCheckpoint = Readonly<{
  version: 1;
  phase: ProductProgressPhase;
  phaseEpoch: string;
  pageRevisionFingerprint: string;
  completionEvidenceFingerprint: string;
  seenCompletionEvidence: readonly string[];
  noProgressCount: number;
  pendingCalls: Readonly<Record<string, string>>;
  pendingCallSteps?: Readonly<Record<string, number>>;
  rejectionStreak?: Streak;
  invalidArgsStreak?: Streak;
  trippedCode?: ProgressTripCode;
}>;

export type ProgressTrip = Readonly<{
  code: ProgressTripCode;
  detail: string;
  phase: ProductProgressPhase;
  phaseEpoch: string;
  pageRevisionFingerprint: string;
  count: number;
  limit: number;
  toolName?: string;
  rejectionFingerprint?: string;
}>;

/** Durable state sampled after the event completed. */
export type ProgressObservation = Readonly<{
  event: GuardEvent;
  phase: ProductProgressPhase;
  phaseEpoch: string;
  pageRevisionFingerprint: string;
  completionEvidenceFingerprint: string;
  completionEvidence: readonly string[];
}>;

type Limits = Readonly<{
  rejection: number;
  invalidArgs: number;
  planning: number;
  production: number;
  readOnly: ReadonlySet<string>;
}>;

function positive(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${field} must be a positive integer`);
  return resolved;
}

function limitsOf(config: ProductProgressConfig): Limits {
  return {
    rejection: positive(
      config.repeatedBusinessRejectionLimit,
      DEFAULT_REPEATED_BUSINESS_REJECTION_LIMIT,
      "repeatedBusinessRejectionLimit",
    ),
    invalidArgs: positive(
      config.repeatedInvalidArgsLimit,
      DEFAULT_REPEATED_INVALID_ARGS_LIMIT,
      "repeatedInvalidArgsLimit",
    ),
    planning: positive(config.planningNoProgressLimit, DEFAULT_PLANNING_NO_PROGRESS_LIMIT, "planningNoProgressLimit"),
    production: positive(
      config.productionNoProgressLimit,
      DEFAULT_PRODUCTION_NO_PROGRESS_LIMIT,
      "productionNoProgressLimit",
    ),
    readOnly: new Set(config.readOnlyTools ?? DEFAULT_READ_ONLY_TOOLS),
  };
}

const SHA256 = /^[a-f0-9]{64}$/i;

function assertObservation(observation: ProgressObservation): void {
  if (!observation.phaseEpoch.trim()) throw new Error("phaseEpoch must be non-empty");
  if (!SHA256.test(observation.pageRevisionFingerprint)) {
    throw new Error("pageRevisionFingerprint must be a 64-character sha256");
  }
  if (!SHA256.test(observation.completionEvidenceFingerprint)) {
    throw new Error("completionEvidenceFingerprint must be a 64-character sha256");
  }
  if (
    observation.completionEvidenceFingerprint.toLowerCase() !==
    completionEvidenceFingerprint(observation.completionEvidence)
  ) {
    throw new Error("completion evidence does not match its fingerprint");
  }
}

export function createProgressCheckpoint(snapshot: Omit<ProgressObservation, "event">): ProgressCheckpoint {
  assertObservation({ ...snapshot, event: { type: "other" } });
  return {
    version: 1,
    phase: snapshot.phase,
    phaseEpoch: snapshot.phaseEpoch,
    pageRevisionFingerprint: snapshot.pageRevisionFingerprint.toLowerCase(),
    completionEvidenceFingerprint: snapshot.completionEvidenceFingerprint.toLowerCase(),
    seenCompletionEvidence: normalizeCompletionEvidence(snapshot.completionEvidence),
    noProgressCount: 0,
    pendingCalls: {},
  };
}

function boundary(
  current: ProgressCheckpoint,
  observation: ProgressObservation,
  keepPending: boolean,
): ProgressCheckpoint {
  return {
    version: 1,
    phase: observation.phase,
    phaseEpoch: observation.phaseEpoch,
    pageRevisionFingerprint: observation.pageRevisionFingerprint.toLowerCase(),
    completionEvidenceFingerprint: observation.completionEvidenceFingerprint.toLowerCase(),
    seenCompletionEvidence: normalizeCompletionEvidence([
      ...current.seenCompletionEvidence,
      ...observation.completionEvidence,
    ]),
    noProgressCount: 0,
    pendingCalls: keepPending ? current.pendingCalls : {},
    ...(keepPending && current.pendingCallSteps ? { pendingCallSteps: current.pendingCallSteps } : {}),
  };
}

function budgetTrip(checkpoint: ProgressCheckpoint, limits: Limits): ProgressTrip | undefined {
  const planning = checkpoint.phase === "planning";
  const limit = planning ? limits.planning : limits.production;
  if (checkpoint.noProgressCount < limit) return undefined;
  const stage = planning ? "规划阶段" : "生产阶段";
  return {
    code: planning ? PLANNING_NO_PROGRESS_BUDGET_CODE : PRODUCTION_NO_PROGRESS_BUDGET_CODE,
    phase: checkpoint.phase,
    phaseEpoch: checkpoint.phaseEpoch,
    pageRevisionFingerprint: checkpoint.pageRevisionFingerprint,
    count: checkpoint.noProgressCount,
    limit,
    detail: `${stage}连续 ${checkpoint.noProgressCount} 个工具结果未产生新的持久完成证据，已达到有界预算。`,
  };
}

function rejectionFingerprint(toolName: string, texts: readonly string[]): string | undefined {
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && (parsed as { outcome?: unknown }).outcome === "rejected") {
        return stableSha256({ toolName, result: parsed });
      }
    } catch {
      // Free-form text is not stable rejection evidence.
    }
  }
  return undefined;
}

function finish(next: ProgressCheckpoint, trip: ProgressTrip | undefined): ProgressReduction {
  if (next.trippedCode || !trip) return { checkpoint: next };
  return { checkpoint: { ...next, trippedCode: trip.code }, trip };
}

export type ProgressReduction = Readonly<{ checkpoint: ProgressCheckpoint; trip?: ProgressTrip }>;

type ResultEvent = Extract<GuardEvent, { type: "tool/result" }>;
type Settled = { base: ProgressCheckpoint; toolName: string; issuedStep?: number };

function invalidArgsReduction(settled: Settled, event: ResultEvent, limits: Limits): ProgressReduction {
  const { base, toolName, issuedStep } = settled;
  const message = event.error?.message?.trim() ? event.error.message : event.texts.join("; ") || "invalid arguments";
  const signature = stableSha256(`${toolName}:${message}`);
  const streak = base.invalidArgsStreak;
  const same = streak?.toolName === toolName && streak.fingerprint === signature;
  // Parallel siblings from one reply are one decision; only a later step is a retry.
  const sameDecision =
    same && issuedStep !== undefined && streak.lastStep !== undefined && issuedStep <= streak.lastStep;
  const count = same ? streak.count + (sameDecision ? 0 : 1) : 1;
  const next: ProgressCheckpoint = {
    ...base,
    noProgressCount: base.noProgressCount + (sameDecision ? 0 : 1),
    rejectionStreak: undefined,
    invalidArgsStreak: {
      toolName,
      fingerprint: signature,
      count,
      ...(issuedStep !== undefined ? { lastStep: issuedStep } : {}),
    },
  };
  if (count < limits.invalidArgs) return finish(next, budgetTrip(next, limits));
  const snippet = message.length > 80 ? `${message.slice(0, 80)}…` : message;
  return finish(next, {
    code: REPEATED_INVALID_ARGS_CODE,
    phase: next.phase,
    phaseEpoch: next.phaseEpoch,
    pageRevisionFingerprint: next.pageRevisionFingerprint,
    count,
    limit: limits.invalidArgs,
    toolName,
    detail: `连续 ${count} 次 ${toolName} 参数无效（${snippet}），已达到熔断阈值。`,
  });
}

function businessReduction(settled: Settled, event: ResultEvent, limits: Limits): ProgressReduction {
  const { base, toolName } = settled;
  const fingerprint = rejectionFingerprint(toolName, event.texts);
  let streak = base.rejectionStreak;
  if (fingerprint) {
    streak =
      streak?.toolName === toolName && streak.fingerprint === fingerprint
        ? { ...streak, count: streak.count + 1 }
        : { toolName, fingerprint, count: 1 };
  } else if (!limits.readOnly.has(toolName)) {
    streak = undefined;
  }
  const next: ProgressCheckpoint = {
    ...base,
    noProgressCount: base.noProgressCount + 1,
    rejectionStreak: streak,
    invalidArgsStreak: undefined,
  };
  if (!streak || streak.count < limits.rejection) return finish(next, budgetTrip(next, limits));
  return finish(next, {
    code: REPEATED_BUSINESS_REJECTION_CODE,
    phase: next.phase,
    phaseEpoch: next.phaseEpoch,
    pageRevisionFingerprint: next.pageRevisionFingerprint,
    count: streak.count,
    limit: limits.rejection,
    toolName,
    rejectionFingerprint: fingerprint,
    detail: `连续 ${streak.count} 次 ${toolName} 业务拒绝具有相同指纹，且持久页面修订未变化。`,
  });
}

function withoutKey<T>(record: Readonly<Record<string, T>> | undefined, key: string): Record<string, T> | undefined {
  if (!record || !(key in record)) return record;
  const copy = { ...record };
  delete copy[key];
  return copy;
}

type Frame = {
  readonly observation: ProgressObservation;
  readonly limits: Limits;
  readonly progressed: boolean;
  readonly synced: (value: ProgressCheckpoint) => ProgressCheckpoint;
};

function alignedToObservation(current: ProgressCheckpoint, observation: ProgressObservation): ProgressCheckpoint {
  if (current.phase !== observation.phase) return boundary(current, observation, false);
  if (current.phaseEpoch === observation.phaseEpoch) return current;
  return { ...current, phaseEpoch: observation.phaseEpoch, pendingCalls: {}, pendingCallSteps: undefined };
}

function callReduction(
  current: ProgressCheckpoint,
  event: Extract<GuardEvent, { type: "tool/call" }>,
  frame: Frame,
): ProgressReduction {
  const checkpoint = frame.progressed ? boundary(current, frame.observation, true) : current;
  if (!event.callId || !event.toolName) return { checkpoint: frame.synced(checkpoint) };
  const step = event.step !== undefined && Number.isFinite(event.step) ? event.step : undefined;
  return {
    checkpoint: {
      ...frame.synced(checkpoint),
      pendingCalls: { ...checkpoint.pendingCalls, [event.callId]: event.toolName },
      ...(step !== undefined ? { pendingCallSteps: { ...checkpoint.pendingCallSteps, [event.callId]: step } } : {}),
    },
  };
}

function resultReduction(checkpoint: ProgressCheckpoint, event: ResultEvent, frame: Frame): ProgressReduction {
  const toolName = event.callId ? checkpoint.pendingCalls[event.callId] : undefined;
  if (!event.callId || !toolName) return { checkpoint: frame.synced(checkpoint) };
  const pendingCalls = withoutKey(checkpoint.pendingCalls, event.callId) ?? {};
  const pendingCallSteps = withoutKey(checkpoint.pendingCallSteps, event.callId);
  const issuedStep = checkpoint.pendingCallSteps?.[event.callId] ?? event.step;
  if (frame.progressed) {
    return { checkpoint: { ...boundary(checkpoint, frame.observation, true), pendingCalls, pendingCallSteps } };
  }
  const base: ProgressCheckpoint = { ...frame.synced(checkpoint), pendingCalls, pendingCallSteps };
  const settled: Settled = { base, toolName, ...(issuedStep !== undefined ? { issuedStep } : {}) };
  return event.error?.code === INVALID_ARGS_CODE
    ? invalidArgsReduction(settled, event, frame.limits)
    : businessReduction(settled, event, frame.limits);
}

/** Reduce one observation. Pure: the same inputs always yield the same checkpoint and trip. */
export function reduceProgress(
  current: ProgressCheckpoint,
  observation: ProgressObservation,
  config: ProductProgressConfig = {},
): ProgressReduction {
  assertObservation(observation);
  const observedPage = observation.pageRevisionFingerprint.toLowerCase();
  const observedEvidence = observation.completionEvidenceFingerprint.toLowerCase();
  const checkpoint = alignedToObservation(current, observation);
  const seen = checkpoint.seenCompletionEvidence;
  const unseen = observation.completionEvidence.some((milestone) => !seen.includes(milestone));
  const frame: Frame = {
    observation,
    limits: limitsOf(config),
    progressed: checkpoint.pageRevisionFingerprint !== observedPage || unseen,
    synced: (value) =>
      value.completionEvidenceFingerprint === observedEvidence
        ? value
        : { ...value, completionEvidenceFingerprint: observedEvidence },
  };
  const event = observation.event;
  if (event.type === "tool/call") return callReduction(checkpoint, event, frame);
  if (event.type === "tool/result") return resultReduction(checkpoint, event, frame);
  return { checkpoint: frame.progressed ? boundary(checkpoint, observation, true) : frame.synced(checkpoint) };
}

export type ProgressGuardOptions = Readonly<{
  config?: ProductProgressConfig;
  sample?: (projectRoot: string) => PersistentProductSnapshot;
}>;

/** Stateful adapter: samples durable state for every tool event and keeps one checkpoint per session. */
export class ProgressGuard {
  private readonly checkpoints = new Map<string, ProgressCheckpoint>();
  private readonly config: ProductProgressConfig;
  private readonly sample: (projectRoot: string) => PersistentProductSnapshot;

  constructor(options: ProgressGuardOptions = {}) {
    this.config = options.config ?? {};
    this.sample = options.sample ?? readPersistentProductSnapshot;
  }

  reset(sessionId: string): void {
    this.checkpoints.delete(sessionId);
  }

  checkpoint(sessionId: string): ProgressCheckpoint | undefined {
    return this.checkpoints.get(sessionId);
  }

  observe(sessionId: string, projectRoot: string, event: GuardEvent, turn?: number): ProgressTrip | undefined {
    if (event.type === "turn/start") {
      const snapshot = this.sample(projectRoot);
      this.checkpoints.set(sessionId, createProgressCheckpoint({ ...snapshot, phaseEpoch: `turn:${event.turn}` }));
      return undefined;
    }
    if (event.type === "turn/end") {
      this.reset(sessionId);
      return undefined;
    }
    if (event.type !== "tool/call" && event.type !== "tool/result") return undefined;
    const snapshot = this.sample(projectRoot);
    const current =
      this.checkpoints.get(sessionId) ??
      createProgressCheckpoint({ ...snapshot, phaseEpoch: `turn:${turn ?? "unknown"}` });
    const reduced = reduceProgress(
      current,
      { ...snapshot, event, phaseEpoch: turn == null ? current.phaseEpoch : `turn:${turn}` },
      this.config,
    );
    this.checkpoints.set(sessionId, reduced.checkpoint);
    return reduced.trip;
  }
}
