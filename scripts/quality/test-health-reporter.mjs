import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./source-files.mjs";

export default class TestHealthReporter {
  tests = [];
  onTestCaseResult(test) {
    const diagnostic = test.diagnostic();
    this.tests.push({
      name: test.fullName,
      project: test.module.project.name,
      durationMs: diagnostic?.duration ?? 0,
      retries: diagnostic?.retryCount ?? 0,
      state: test.result().state,
    });
  }
  onTestRunEnd() {
    const file = path.join(ROOT, "output/quality/test-health-history.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const history = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    const retried = this.tests.filter((test) => test.retries > 0);
    const flaky = retried.filter((test) => test.state === "passed");
    history.push({ at: new Date().toISOString(), tests: this.tests, retried, flaky });
    writeFileSync(file, `${JSON.stringify(history.slice(-30), null, 2)}\n`);
    if (retried.length) {
      console.error(`Retried tests detected: ${retried.map((test) => test.name).join(", ")}`);
      process.exitCode = 1;
    }
  }
}
