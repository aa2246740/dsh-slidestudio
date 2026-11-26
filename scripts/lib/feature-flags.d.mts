export type FeatureFlags = {
  defined(name: string): boolean;
  get(name: string): unknown;
};
export function flagEnvName(name: string): string;
export function loadFeatureFlags(root: string, env?: NodeJS.ProcessEnv): FeatureFlags;
