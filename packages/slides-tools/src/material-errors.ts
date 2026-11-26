/**
 * Receipt/ownership verification failures map to a 4xx client error, not a
 * 500: the user fixes them by re-uploading, and they must never create a run.
 */
export class MaterialVerificationError extends Error {}
