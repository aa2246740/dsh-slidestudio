import { createObservability } from "../../../scripts/lib/observability.mjs";

export const diagnostics = createObservability({ app: "native-web", version: "0.2.7" });
