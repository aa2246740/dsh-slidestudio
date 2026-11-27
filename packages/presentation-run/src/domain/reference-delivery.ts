/**
 * Delivery-confirmed reference accounting.
 *
 * By default read_reference records `reference.chunk-returned` as soon as the
 * chunk is produced (the original, backward-compatible behaviour). With
 * confirmation enabled the read is recorded as `reference.chunk-prepared` with
 * a delivery token, and it only counts once the host calls
 * {@link recordReferenceDelivered} after the chunk text actually reached the
 * model. A dropped or truncated tool result therefore cannot satisfy a gate.
 */
import { appendFact, factId, mutateLedger, nowIso, stableSha256, type RunToolContext } from "./run-ledger.js";
import type { ReferenceChunkPreparedFact } from "./reference-facts.js";

export const REFERENCE_DELIVERY_ENV = "SLIDESTUDIO_REFERENCE_DELIVERY_CONFIRMATION";
export const REFERENCE_DELIVERY_FLAG_ENV = "SLIDESTUDIO_FLAG_REFERENCE_DELIVERY_CONFIRMATION";

export type ReferenceChunkIdentity = Readonly<{
  sourceId: string;
  fileSha256: string;
  chunkIndex: number;
  chunkSha256: string;
}>;

export type ReferenceDeliveryOptions = Readonly<{
  /** Defer the read until the host confirms delivery. Defaults to the env flag, else off. */
  confirmDelivery?: boolean;
}>;

function truthy(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  return undefined;
}

/** The explicit env var wins over the per-checkout flag override, matching feature-flag precedence. */
export function referenceDeliveryConfirmationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env[REFERENCE_DELIVERY_ENV]) ?? truthy(env[REFERENCE_DELIVERY_FLAG_ENV]) ?? false;
}

export function referenceDeliveryToken(context: RunToolContext, chunk: ReferenceChunkIdentity): string {
  return `refdel-${stableSha256({ ...chunk, commandId: context.commandId, epoch: context.contextEpochId }).slice(0, 32)}`;
}

/** Record a prepared (not yet counted) chunk and return its delivery token. */
export function recordReferencePrepared(root: string, context: RunToolContext, chunk: ReferenceChunkIdentity): string {
  const deliveryToken = referenceDeliveryToken(context, chunk);
  const payload = {
    ...chunk,
    contextEpochId: context.contextEpochId,
    commandId: context.commandId,
    deliveryToken,
  };
  appendFact(root, {
    type: "reference.chunk-prepared",
    factId: factId("reference.chunk-prepared", payload),
    at: nowIso(),
    ...payload,
  });
  return deliveryToken;
}

export type ReferenceDeliveryResult = Readonly<
  | { recorded: true; sourceId: string; chunkIndex: number; alreadyDelivered: boolean }
  | { recorded: false; reason: "unknown-token" | "other-epoch" }
>;

/**
 * Confirm that a prepared chunk reached the model. Idempotent: confirming the
 * same token twice records one `reference.chunk-returned` fact. A token from
 * another context epoch is refused, so a new model cannot inherit it.
 */
export function recordReferenceDelivered(
  root: string,
  context: Pick<RunToolContext, "contextEpochId">,
  deliveryToken: string,
): ReferenceDeliveryResult {
  let result: ReferenceDeliveryResult = { recorded: false, reason: "unknown-token" };
  mutateLedger(root, (current) => {
    const prepared = current.facts.find(
      (fact): fact is ReferenceChunkPreparedFact =>
        fact.type === "reference.chunk-prepared" && fact.deliveryToken === deliveryToken,
    );
    if (!prepared) return current;
    if (prepared.contextEpochId !== context.contextEpochId) {
      result = { recorded: false, reason: "other-epoch" };
      return current;
    }
    const payload = {
      sourceId: prepared.sourceId,
      fileSha256: prepared.fileSha256,
      chunkIndex: prepared.chunkIndex,
      chunkSha256: prepared.chunkSha256,
      contextEpochId: prepared.contextEpochId,
    };
    const id = factId("reference.chunk-returned", payload);
    const alreadyDelivered = current.facts.some((fact) => fact.factId === id);
    result = { recorded: true, sourceId: prepared.sourceId, chunkIndex: prepared.chunkIndex, alreadyDelivered };
    if (alreadyDelivered) return current;
    const at = nowIso();
    return {
      ...current,
      updatedAt: at,
      facts: [...current.facts, { type: "reference.chunk-returned", factId: id, at, ...payload }],
    };
  });
  return result;
}

/**
 * Confirm every prepared reference chunk recorded under `commandId` (tool call
 * id) in the current epoch. Lets runtimes confirm delivery from tool-call ids
 * without carrying delivery tokens in memory across restarts.
 */
export function recordReferenceDeliveredByCommandId(
  root: string,
  context: Pick<RunToolContext, "contextEpochId">,
  commandId: string,
): ReferenceDeliveryResult[] {
  const results: ReferenceDeliveryResult[] = [];
  mutateLedger(root, (current) => {
    const prepared = current.facts.filter(
      (fact): fact is ReferenceChunkPreparedFact =>
        fact.type === "reference.chunk-prepared" &&
        fact.commandId === commandId &&
        fact.contextEpochId === context.contextEpochId,
    );
    if (!prepared.length) return current;
    let nextFacts = current.facts;
    let changed = false;
    for (const item of prepared) {
      const payload = {
        sourceId: item.sourceId,
        fileSha256: item.fileSha256,
        chunkIndex: item.chunkIndex,
        chunkSha256: item.chunkSha256,
        contextEpochId: item.contextEpochId,
      };
      const id = factId("reference.chunk-returned", payload);
      const alreadyDelivered = nextFacts.some((fact) => fact.factId === id);
      results.push({ recorded: true, sourceId: item.sourceId, chunkIndex: item.chunkIndex, alreadyDelivered });
      if (alreadyDelivered) continue;
      changed = true;
      nextFacts = [...nextFacts, { type: "reference.chunk-returned", factId: id, at: nowIso(), ...payload }];
    }
    return changed ? { ...current, updatedAt: nowIso(), facts: nextFacts } : current;
  });
  return results;
}
