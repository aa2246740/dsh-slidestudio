export declare const HOST_INTERRUPTED_CODE = "host-interrupted";
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
export declare function markInterruptedTurn(projectRoot: string, now?: Date): boolean;
//# sourceMappingURL=interruption.d.ts.map