import { projectExecution, type ProjectExecutionInput } from "./execution.js";
import { readRunLedger, inspectRunLedger } from "./domain/run-ledger.js";
import { resolveProjectPageIdentities } from "./domain/page-identity.js";

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
export function inspectProjectExecution(input: ProjectExecutionObservationInput) {
  const ledger = input.ledger ?? readRunLedger(input.root);
  return projectExecution({
    ...input, ledger, identity: resolveProjectPageIdentities(input.root),
    inspection: inspectRunLedger(input.root, input.contextEpochId, process.env, ledger),
  });
}
