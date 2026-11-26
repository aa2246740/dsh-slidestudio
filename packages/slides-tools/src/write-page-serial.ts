export type GateAcquire =
  { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly busyWith: string };

/**
 * At most one in-flight page step per session.
 * Extra parallel calls are refused so the model must wait for the current
 * write/render/review result. Prompt text cannot enforce this.
 */
export class ExclusiveSessionGate {
  private readonly busy = new Map<string, string>();

  tryAcquire(sessionId: string, toolName: string): GateAcquire {
    const key = sessionId.trim() || "anonymous";
    const current = this.busy.get(key);
    if (current) return { ok: false, busyWith: current };
    this.busy.set(key, toolName);
    return {
      ok: true,
      release: () => {
        if (this.busy.get(key) === toolName) this.busy.delete(key);
      },
    };
  }
}

export const writePageGate = new ExclusiveSessionGate();
export const reviewPageGate = new ExclusiveSessionGate();

/**
 * One write_page persist at a time per Hub session.
 * Parallel model tool calls still return independently; they just cannot
 * interleave PPTD disk writes. Prompt text cannot enforce this.
 */
export class WritePageSerialQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const key = sessionId.trim() || "anonymous";
    const prev = this.tails.get(key) ?? Promise.resolve();
    const run = prev.then(task, task);
    this.tails.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

export const writePageSerial = new WritePageSerialQueue();
