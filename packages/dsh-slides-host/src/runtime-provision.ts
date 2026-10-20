import {
  provisionManagedRuntime,
  resolvePlaywrightRuntime,
  runtimeLayoutUsable,
} from "@open-slidestudio/presentation-run";

export type RenderRuntimeSnapshot = {
  phase: "installing" | "ready" | "failed" | "manual";
  error?: string;
};

type RuntimeRoots = Parameters<typeof resolvePlaywrightRuntime>[1];
type ProvisionOptions = Parameters<typeof provisionManagedRuntime>[1];

export type RuntimeProvisionController = {
  current(): Promise<void> | undefined;
  snapshot(): RenderRuntimeSnapshot;
  start(): Promise<void>;
};

export function createRuntimeProvisionController(options: {
  env: NodeJS.ProcessEnv;
  roots: RuntimeRoots;
  stateDir: string;
  explicitOverride: string;
  provisionOptions: ProvisionOptions;
  resolve?: typeof resolvePlaywrightRuntime;
  isReady?: typeof runtimeLayoutUsable;
  provision?: typeof provisionManagedRuntime;
}): RuntimeProvisionController {
  const resolve = options.resolve ?? resolvePlaywrightRuntime;
  const isReady = options.isReady ?? runtimeLayoutUsable;
  const provision = options.provision ?? provisionManagedRuntime;
  const explicitOverride = options.explicitOverride.trim();
  const initial = resolve(options.env, options.roots);
  const managedPath = initial.path;
  let phase: RenderRuntimeSnapshot["phase"] = "failed";
  let error: string | undefined;
  let inFlight: Promise<void> | undefined;

  const manualError = () =>
    `SLIDESTUDIO_PLAYWRIGHT_RUNTIME is set to "${explicitOverride}", but it is not a usable Playwright runtime. Repair the path or unset it, then retry.`;
  const unavailableError = (runtimePath: string) =>
    `Playwright runtime at "${runtimePath}" is incomplete; its pinned package or browser executable is missing. Retry setup or configure a valid SLIDESTUDIO_PLAYWRIGHT_RUNTIME path.`;

  const refreshReady = () => {
    const resolution = resolve(options.env, options.roots);
    if (!resolution.ready || !isReady(resolution.path, options.env)) {
      if (explicitOverride) {
        phase = "manual";
        error = manualError();
      } else if (phase !== "installing") {
        const wasReady = phase === "ready";
        phase = "failed";
        if (wasReady || !error) error = unavailableError(resolution.path);
      }
      return false;
    }
    if (!explicitOverride) options.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = resolution.path;
    phase = "ready";
    error = undefined;
    return true;
  };

  if (refreshReady()) {
    phase = "ready";
  } else if (explicitOverride) {
    phase = "manual";
    error = manualError();
  }

  return {
    current: () => inFlight,
    snapshot() {
      if (refreshReady()) return { phase: "ready" };
      return {
        phase,
        ...(error ? { error } : {}),
      };
    },
    start() {
      if (inFlight) return inFlight;
      if (refreshReady()) return Promise.resolve();
      if (explicitOverride) {
        phase = "manual";
        error = manualError();
        return Promise.resolve();
      }
      options.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = managedPath;
      phase = "installing";
      error = undefined;
      const pending = Promise.resolve()
        .then(() => provision(options.stateDir, options.provisionOptions))
        .then(() => {
          const resolution = resolve(options.env, options.roots);
          if (!resolution.ready || !isReady(resolution.path, options.env))
            throw new Error("Playwright provisioning completed without a usable runtime");
          options.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = resolution.path;
          phase = "ready";
          error = undefined;
        })
        .catch((cause: unknown) => {
          error = cause instanceof Error ? cause.message : String(cause);
          phase = "failed";
          console.warn("[slides] playwright runtime auto-setup failed:", error);
          if (options.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME === managedPath) {
            delete options.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
          }
        })
        .finally(() => {
          if (inFlight === pending) inFlight = undefined;
        });
      inFlight = pending;
      return pending;
    },
  };
}
