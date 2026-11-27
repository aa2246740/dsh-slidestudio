/**
 * Reference-read facts added for the sectioned (v2) source layout. v1 ledgers
 * never contain them, so their reference accounting is unchanged.
 */

/** A chunk handed to the host for delivery; it counts as read only once delivered. */
export type ReferenceChunkPreparedFact = Readonly<{
  type: "reference.chunk-prepared";
  factId: string;
  at: string;
  contextEpochId: string;
  commandId: string;
  deliveryToken: string;
  sourceId: string;
  fileSha256: string;
  chunkIndex: number;
  chunkSha256: string;
}>;

/**
 * A verified read from an earlier context epoch carried into a new one after a
 * model switch on a project whose plan is already committed. Provenance stays
 * explicit: the original `reference.chunk-returned` fact is untouched.
 */
export type ReferenceEpochCarriedFact = Readonly<{
  type: "reference.epoch-carried";
  factId: string;
  at: string;
  /** The new epoch the read counts in. */
  contextEpochId: string;
  fromEpochId: string;
  reason: "model-switch";
  sourceId: string;
  fileSha256: string;
  chunkIndex: number;
  chunkSha256: string;
}>;

type ReferenceReadType = "reference.chunk-returned" | "reference.epoch-carried";

/** A fact that makes a reference chunk count as read in its `contextEpochId`. */
export function isReferenceReadFact<F extends { readonly type: string }>(
  fact: F,
): fact is Extract<F, { readonly type: ReferenceReadType }> {
  return fact.type === "reference.chunk-returned" || fact.type === "reference.epoch-carried";
}
