/**
 * Test-only runtime writer for the design-authority seams. The production
 * writer lives in the Host; these tests need a minimal, valid `_agent/runtime.json`.
 */
import fs from "node:fs";
import path from "node:path";

export function createProjectRuntime(projectRoot: string, runtime: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(projectRoot, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "_agent", "runtime.json"),
    `${JSON.stringify({ brief: "向团队说明合成项目进展和下一步", strictExecution: true, ...runtime })}\n`,
  );
}
