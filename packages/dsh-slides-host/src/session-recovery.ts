/**
 * Turn outcomes of a session `SlidesAgentRuntime` → durable Hub fault state,
 * same-session 429 wait-and-resume and provider failover (Grok fallback,
 * minimax-cn ⇄ openrouter). The runtime runs with `rateLimit.maxAttempts: 0`,
 * so this controller is the only retry owner.
 */
import type { RuntimeFault, RuntimeTurnResult } from "@open-slidestudio/slides-runtime";
import {
  AgentFaults,
  classifyAgentError,
  clearAgentError,
  clearRateLimitWait,
  isMinimaxCnFailoverFault,
  isOpenRouterFailoverFault,
  isWaitAndResumeFault,
  parseRetryAfterMs,
  readAgentError,
  readRateLimitWait,
  writeRateLimitWait,
} from "./agent-fault.js";
import {
  markGrokFailed,
  markMinimaxCnAuthFailed,
  markOpenRouterHardFailed,
  OPENROUTER_MINIMAX_FREE_MODEL,
  SLIDES_LLM_DEFAULT_MODEL,
  SLIDES_LLM_PROVIDER,
} from "./args.js";
import { shouldFailoverGrok } from "./oauth-login.js";
import type { SliceError } from "./protocol.js";
import { RateLimitResumeController } from "./rate-limit-resume.js";
import type { SliceSessionStore } from "./slice-session.js";

export const RATE_LIMIT_RESUME_TEXT =
  "Continue the same Hub session after a provider wait. Never Gemini. Host did not paint leftover pages. Do not rewrite finished pages. Do not start a new session.";

type Target = { providerId: string; modelId: string };

export type SessionRecoveryDeps = {
  readonly store: SliceSessionStore;
  readonly faults: AgentFaults;
  /** Re-open the session runtime on its (possibly updated) store binding. */
  readonly reopen: (sessionId: string) => Promise<void>;
  /** Continue the same session: resume the transcript, or prompt `text` when nothing is resumable. */
  readonly continueSession: (sessionId: string, text: string) => void;
  readonly markBusy: (sessionId: string) => void;
  readonly markIdle: (sessionId: string) => void;
  readonly beforeResume?: () => void;
  /** Serialize automatic recovery (429 resume and provider failover) against concurrent user transitions. */
  readonly runTransition?: <T>(
    sessionId: string,
    fn: () => Promise<T>,
    options?: { readonly priority?: "user" | "auto" },
  ) => Promise<T>;
  readonly isBusy?: (sessionId: string) => boolean;
  /** True only when a runtime turn is actively queued or executing (excludes failover's own busy bit). */
  readonly isRunning?: (sessionId: string) => boolean;
  readonly clearSteers?: (sessionId: string) => void;
  /** Called after automatic provider failover rebinds the session so the next turn seeds from disk summary. */
  readonly onProviderSwitched?: (sessionId: string) => void;
  /** Grok fallback target (the next ready non-Grok route), when one exists. */
  readonly grokFallbackTarget: () => Target | undefined;
  readonly openrouterKeyPresent: () => boolean;
  readonly minimaxCnKeyPresent: () => boolean;
  readonly now?: () => number;
  readonly schedule?: (ms: number, fn: () => void) => { cancel: () => void };
  readonly log?: (message: string, detail?: unknown) => void;
};

export class SessionRecovery {
  readonly rateLimits: RateLimitResumeController;
  private readonly inflight = new Set<string>();
  private readonly userEpochs = new Map<string, number>();

  constructor(private readonly deps: SessionRecoveryDeps) {
    this.rateLimits = new RateLimitResumeController({
      now: deps.now ?? (() => Date.now()),
      schedule:
        deps.schedule ??
        ((ms, fn) => {
          const timer = setTimeout(fn, ms);
          timer.unref?.();
          return { cancel: () => clearTimeout(timer) };
        }),
      resume: (sessionId) => this.resumeAfterWait(sessionId),
      resumeFailed: (sessionId, fault, error) => {
        if (!this.deps.isRunning?.(sessionId)) this.deps.markIdle(sessionId);
        if (!this.rateLimits.isStopped(sessionId)) {
          this.deps.faults.note(sessionId, fault, this.rootOf(sessionId));
        }
        this.deps.log?.(`[slides] rate-limit resume failed for session ${sessionId}:`, error);
      },
      notePaused: (sessionId, fault, wait) => {
        const root = this.rootOf(sessionId);
        this.deps.faults.note(sessionId, fault, root);
        if (root) writeRateLimitWait(root, { ...wait, code: fault.code });
      },
    });
  }

  /** True while a provider failover for this session is switching routes. */
  recovering(sessionId: string): boolean {
    return this.inflight.has(sessionId);
  }

  /** Record a user-driven turn/model action, superseding any armed or in-flight automatic resume. */
  onUserTurn(sessionId: string): void {
    this.userEpochs.set(sessionId, (this.userEpochs.get(sessionId) ?? 0) + 1);
    this.rateLimits.onUserTurn(sessionId);
  }

  private rootOf(sessionId: string): string | undefined {
    const binding = this.deps.store.bindingFor(sessionId);
    return binding ? this.deps.store.resolveRoot(binding) : undefined;
  }

  private async resumeAfterWait(sessionId: string): Promise<void> {
    const epoch = this.userEpochs.get(sessionId) ?? 0;
    const run = async () => {
      try {
        this.deps.beforeResume?.();
        if (this.superseded(sessionId, epoch) || this.deps.isBusy?.(sessionId)) return;
        await this.deps.reopen(sessionId);
        if (this.superseded(sessionId, epoch) || this.deps.isBusy?.(sessionId)) return;
        const root = this.rootOf(sessionId);
        if (root) {
          clearAgentError(root);
          clearRateLimitWait(root);
          this.deps.faults.clear(sessionId, root);
        }
        this.deps.markBusy(sessionId);
        this.deps.continueSession(sessionId, RATE_LIMIT_RESUME_TEXT);
      } catch (error) {
        if (this.superseded(sessionId, epoch)) return;
        throw error;
      }
    };
    if (this.deps.runTransition) await this.deps.runTransition(sessionId, run, { priority: "auto" });
    else await run();
  }

  private superseded(sessionId: string, epoch: number): boolean {
    return this.rateLimits.isStopped(sessionId) || (this.userEpochs.get(sessionId) ?? 0) !== epoch;
  }

  /** Settle a finished turn: route its fault, then reconcile the durable fault record. */
  onTurnEnd(sessionId: string, result: RuntimeTurnResult): void {
    const fault =
      result.fault ??
      (result.status === "max-tokens"
        ? { code: "turn-max-tokens", detail: "Turn reached the output limit" }
        : undefined);
    if (fault && fault.code !== "operator-stop") this.onFault(sessionId, fault);
    const root = this.rootOf(sessionId);
    if (!root) return;
    let phase: string = fault ? "paused" : "ready";
    try {
      phase = this.deps.store.inspect(sessionId).phase.kind;
    } catch (error) {
      this.deps.log?.(`[slides] inspect failed while settling session ${sessionId}:`, error);
    }
    this.deps.faults.settle(sessionId, root, phase);
    if (phase !== "paused" && !this.rateLimits.isWaiting(sessionId)) this.rateLimits.onTurnSuccess(sessionId);
  }

  /** A turn that threw outside the loop (e.g. runtime rebuild) is classified like a provider error. */
  onTurnError(sessionId: string, error: unknown): void {
    this.onFault(sessionId, classifyAgentError(error));
  }

  onFault(sessionId: string, fault: RuntimeFault | SliceError): void {
    const error: SliceError = { code: fault.code, detail: fault.detail };
    if (this.grokFallback(sessionId, error)) return;
    if (isWaitAndResumeFault(error)) {
      const retryAfterMs = (fault as RuntimeFault).retryAfterMs ?? parseRetryAfterMs(fault.detail);
      if (this.rateLimits.pauseAndResume(sessionId, error, retryAfterMs)) return;
    }
    if (this.openRouterFailover(sessionId, error)) return;
    if (this.cnFailover(sessionId, error)) return;
    this.deps.faults.note(sessionId, error, this.rootOf(sessionId));
  }

  private grokFallback(sessionId: string, fault: SliceError): boolean {
    const bound = this.deps.store.bindingFor(sessionId)?.provider.providerId;
    if (!shouldFailoverGrok(bound, fault)) return false;
    const applied = this.failover(
      sessionId,
      fault,
      bound,
      this.deps.grokFallbackTarget,
      (target) =>
        `Grok returned ${fault.code}. Continue the same Hub session on ${target.providerId} ${target.modelId}. Never Gemini. Host did not paint leftover pages. Do not start a new session.`,
    );
    if (applied) markGrokFailed();
    return applied;
  }

  private openRouterFailover(sessionId: string, fault: SliceError): boolean {
    if (!isOpenRouterFailoverFault(fault)) return false;
    const applied = this.failover(
      sessionId,
      fault,
      SLIDES_LLM_PROVIDER,
      () =>
        this.deps.openrouterKeyPresent()
          ? { providerId: "openrouter", modelId: OPENROUTER_MINIMAX_FREE_MODEL }
          : undefined,
      (target) =>
        `MiniMax China returned 401/403. Continue on OpenRouter MiniMax free (${target.modelId}). Never Gemini. Host did not paint leftover pages.`,
    );
    if (applied) markMinimaxCnAuthFailed();
    return applied;
  }

  private cnFailover(sessionId: string, fault: SliceError): boolean {
    if (!isMinimaxCnFailoverFault(fault)) return false;
    const applied = this.failover(
      sessionId,
      fault,
      "openrouter",
      () =>
        this.deps.minimaxCnKeyPresent()
          ? { providerId: SLIDES_LLM_PROVIDER, modelId: SLIDES_LLM_DEFAULT_MODEL }
          : undefined,
      (target) =>
        `OpenRouter MiniMax free hard-failed. Continue on MiniMax China ${target.modelId}. Never Gemini. Host did not paint leftover pages.`,
    );
    if (applied) markOpenRouterHardFailed();
    return applied;
  }

  /**
   * Shared failover: only while the session is bound to `source`; resolves the
   * target before touching the binding, rolls back on failure and always
   * clears the in-flight marker.
   */
  private failover(
    sessionId: string,
    fault: SliceError,
    source: string | undefined,
    resolveTarget: () => Target | undefined,
    reasonText: (target: Target) => string,
  ): boolean {
    const binding = this.deps.store.bindingFor(sessionId);
    if (!binding || binding.provider.providerId !== source) return false;
    if (this.inflight.has(sessionId)) return true;
    const target = resolveTarget();
    if (!target) return false;
    if (this.rateLimits.isStopped(sessionId)) return false;
    this.inflight.add(sessionId);
    this.deps.markBusy(sessionId);
    const epoch = this.userEpochs.get(sessionId) ?? 0;
    void (async () => {
      let currentRoot = this.deps.store.resolveRoot(binding);
      let rollback = { providerId: binding.provider.providerId, modelId: binding.provider.modelId };
      let providerUpdated = false;
      const run = async () => {
        if (this.superseded(sessionId, epoch)) {
          if (!this.deps.isRunning?.(sessionId)) this.deps.markIdle(sessionId);
          return;
        }
        const current = this.deps.store.bindingFor(sessionId);
        if (!current || current.provider.providerId !== source) {
          if (!this.deps.isRunning?.(sessionId)) this.deps.markIdle(sessionId);
          return;
        }
        currentRoot = this.deps.store.resolveRoot(current);
        rollback = { providerId: current.provider.providerId, modelId: current.provider.modelId };
        this.deps.store.updateProvider(sessionId, target);
        providerUpdated = true;
        await this.deps.reopen(sessionId);
        if (this.superseded(sessionId, epoch)) {
          if (this.rateLimits.isStopped(sessionId)) {
            try {
              this.deps.store.updateProvider(sessionId, rollback);
            } catch {
              /* best-effort rollback when operator stopped mid-failover */
            }
            this.deps.clearSteers?.(sessionId);
          }
          if (!this.deps.isRunning?.(sessionId)) this.deps.markIdle(sessionId);
          return;
        }
        clearAgentError(currentRoot);
        this.deps.onProviderSwitched?.(sessionId);
        this.deps.markBusy(sessionId);
        this.deps.continueSession(sessionId, reasonText(target));
      };
      try {
        if (this.deps.runTransition) await this.deps.runTransition(sessionId, run, { priority: "auto" });
        else await run();
      } catch (error) {
        if (providerUpdated && (this.userEpochs.get(sessionId) ?? 0) === epoch) {
          try {
            this.deps.store.updateProvider(sessionId, rollback);
          } catch {
            /* binding rollback is best-effort; the fault note below still records the pause */
          }
        }
        this.deps.clearSteers?.(sessionId);
        if (!this.deps.isRunning?.(sessionId)) this.deps.markIdle(sessionId);
        if (!this.superseded(sessionId, epoch)) this.deps.faults.note(sessionId, fault, currentRoot);
        this.deps.log?.(`[slides] provider failover failed for session ${sessionId}:`, error);
      } finally {
        this.inflight.delete(sessionId);
      }
    })();
    return true;
  }

  /** Re-arm persisted 429 waits after a Host restart (only when an active wait record exists on disk). */
  restoreWaits(): void {
    for (const [sessionId, binding] of this.deps.store.rebuild()) {
      try {
        if (this.deps.store.inspect(sessionId).phase.kind !== "paused") continue;
        const root = this.deps.store.resolveRoot(binding);
        const wait = readRateLimitWait(root);
        if (!wait) continue;
        const error = readAgentError(root);
        if (!error) continue;
        const fault = classifyAgentError({ code: error.code, message: error.detail });
        if (!isWaitAndResumeFault(fault)) continue;
        this.rateLimits.restore(sessionId, fault, wait);
      } catch (error) {
        this.deps.log?.(`[slides] skipping corrupt session ${sessionId} while restoring waits:`, error);
      }
    }
  }
}
