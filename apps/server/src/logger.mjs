import { createObservability } from "../../../scripts/lib/observability.mjs";

export function createLogger(options = {}) {
  return createObservability({ app: "legacy-api", version: "0.2.7", ...options });
}
