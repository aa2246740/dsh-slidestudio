import { type ProjectExecutionInput } from "./execution.js";
export type ProjectExecutionObservationInput = Omit<ProjectExecutionInput, "identity" | "inspection"> & {
    readonly root: string;
    readonly contextEpochId?: string;
};
/**
 * IO boundary. Delivery is never inferred from an arbitrary existing export report.
 *
 * Observation is a pure read: the project loader is documented lock-free
 * (atomic page commits keep snapshots coherent) and the ledger readers only
 * read files. Taking .pptd-write.lock here made every /slides/state poll
 * create+remove the lock directory and owner.json — constant churn that also
 * collided with the agent's own writes mid-generation.
 */
export declare function inspectProjectExecution(input: ProjectExecutionObservationInput): Readonly<{
    status: import("./types.js").ExecutionStatus;
    blockers: readonly import("./types.js").ExecutionBlocker[];
    next: string | null;
    plan: import("./types.js").ExecutionPlan;
    recovery: import("./types.js").ExecutionRecovery;
    attemptId: string | null;
    model: import("./types.js").ExecutionModel;
    delivery?: import("./types.js").ExecutionDelivery;
}>;
//# sourceMappingURL=execution-observation.d.ts.map