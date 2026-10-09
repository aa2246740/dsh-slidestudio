import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import TestHealthReporter from "./scripts/quality/test-health-reporter.mjs";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    pool: "forks",
    isolate: true,
    maxWorkers: 4,
    allowOnly: false,
    retry: 1,
    testTimeout: 10000,
    reporters: ["default", "json", "junit", new TestHealthReporter()],
    outputFile: {
      json: "output/quality/tests.json",
      junit: "output/quality/tests.xml",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "output/quality/coverage",
      // Explicit critical interfaces, not a claim of whole-product coverage.
      include: [
        "scripts/lib/observability.mjs",
        "apps/native-web/public/logger.js",
        "apps/server/src/{index,http-input,generate}.mjs",
        "apps/web/src/lib/{api,logger}.ts",
        "dsh-slidestudio/src/{data-directory,sidecar-ready,logger}.ts",
      ],
      thresholds: { perFile: true, lines: 80, statements: 80, functions: 80, branches: 80 },
    },
    projects: [
      { extends: true, test: { name: "native-web", include: ["apps/native-web/tests/**/*.spec.mjs"] } },
      { extends: true, test: { name: "server", include: ["apps/server/src/**/*.spec.mjs"] } },
      { extends: true, test: { name: "web", include: ["apps/web/src/**/*.spec.ts"] } },
      { extends: true, test: { name: "plugin", include: ["dsh-slidestudio/src/**/*.spec.ts"] } },
      { extends: true, test: { name: "tooling", include: ["scripts/quality/**/*.spec.mjs"] } },
    ],
  },
});
