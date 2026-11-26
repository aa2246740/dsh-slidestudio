/**
 * Host-neutral synchronous write-authority bridge. Lets callers wrap disk
 * commits inside `withProjectWriteLock(projectRoot)` -> host lease lock so
 * another writer cannot preempt between the lease check and the write.
 */
import { withProjectWriteLock } from "@open-slidestudio/pptd-v2";
import type { CommandContext, CommandReceipt, WriteAuthorityRefusal, WriteAuthorityRunner } from "./types.js";

/** Convert a write-authority refusal into a CommandReceipt. */
export function authorityRefusalReceipt(name: string, refusal: WriteAuthorityRefusal): CommandReceipt {
  return {
    ok: false,
    name,
    summary: refusal.summary,
    detail: refusal.detail,
    payload: refusal.payload,
  };
}

/**
 * Run a synchronous disk-mutating operation under the project write lock and
 * optional host write-authority runner. Obeys the outer project lock -> inner
 * lease lock ordering invariant.
 */
export function runWithWriteAuthority<T>(
  projectRoot: string,
  runner: WriteAuthorityRunner | undefined,
  commit: () => T,
): { readonly ok: true; readonly value: T } | WriteAuthorityRefusal {
  if (!runner) return { ok: true, value: commit() };
  return withProjectWriteLock(projectRoot, () => runner(commit));
}

export function runContextAuthorized<T>(
  context: CommandContext,
  commit: () => T,
): { readonly ok: true; readonly value: T } | WriteAuthorityRefusal {
  return runWithWriteAuthority(context.projectRoot, context.runAuthorizedWrite, commit);
}
