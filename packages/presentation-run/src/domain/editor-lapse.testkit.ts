/**
 * Test-only helpers for an editor lease that lapses while a write waits for the project lock.
 * The test runner loads only *.test.js files, so this module is compiled and imported by tests.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRESENTATION_RUN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The lease file an editor turn holds while its authorization is live. */
export const leaseFile = (root: string) => path.join(root, "_agent", "ai-review-lock.v1.json");

/** Takes the project write lock in a child process. Its own module graph is the real pptd-v2 lock. */
const LOCK_HOLDER = `
import fs from "node:fs";
const { withProjectWriteLock } = await import("@open-slidestudio/pptd-v2");
withProjectWriteLock(process.env.HOLD_ROOT, () => {
  fs.writeFileSync(process.env.HOLD_FLAG, "locked");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  fs.rmSync(process.env.HOLD_LEASE, { force: true });
});
`;

/**
 * Holds the project write lock in a child process and drops the editor lease while it is held.
 * The returned promise resolves once the child holds the lock, while the lease is still live. A
 * write started next passes its pre-lock check, waits behind the holder, and gets in only after
 * the lease has gone. `released` settles when the holder exits; the test must await it.
 */
export async function holdProjectLockUntilLeaseLapses(root: string): Promise<{ released: Promise<void> }> {
  const flag = path.join(root, "holder.locked");
  const child = spawn(process.execPath, ["--input-type=module", "-e", LOCK_HOLDER], {
    cwd: PRESENTATION_RUN_ROOT,
    env: { ...process.env, HOLD_ROOT: root, HOLD_FLAG: flag, HOLD_LEASE: leaseFile(root) },
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`lock holder exited with ${code}`))));
  });
  exited.catch(() => undefined);
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(flag)) {
    if (Date.now() > deadline) throw new Error("the lock holder never took the project lock");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { released: exited };
}
