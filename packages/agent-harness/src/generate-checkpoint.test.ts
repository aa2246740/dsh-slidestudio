import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GENERATE_CHECKPOINT_FILE,
  formatPauseMessage,
  readGenerateCheckpoint,
  recoverGenerateCheckpoint,
  writeGenerateCheckpoint,
  type AgentCheckpoint,
} from "./generate-checkpoint.js";

function checkpoint(): AgentCheckpoint {
  return {
    v: 1,
    brief: "澄光生活 2026年7月经营月报",
    messages: [],
    traces: [],
    categoryId: "management-report",
    designSystemId: "consulting/marine-blue-research",
    turnsUsed: 0,
    maxTurns: 10,
    pausedAt: "2026-08-21T00:00:00.000Z",
    reason: "provider interrupted",
    kind: "transient",
  };
}

describe("generate recovery checkpoint", () => {
  it("commits the checkpoint atomically and reads it back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-checkpoint-"));
    const file = writeGenerateCheckpoint(dir, checkpoint());
    assert.equal(file, path.join(dir, GENERATE_CHECKPOINT_FILE));
    assert.deepEqual(readGenerateCheckpoint(dir), checkpoint());
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes(".tmp")),
      [],
    );
  });

  it("recovers a resume pointer from durable runtime and ledger files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-recover-"));
    fs.mkdirSync(path.join(dir, "_agent"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "_agent", "runtime.json"),
      JSON.stringify({
        brief: "澄光生活 2026年7月经营月报",
        categoryId: "management-report",
        designSystemId: "consulting/marine-blue-research",
        strictExecution: true,
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "_agent", "run-ledger.v1.json"), "{}", "utf8");
    const recovered = recoverGenerateCheckpoint(dir);
    assert.equal(recovered?.brief, "澄光生活 2026年7月经营月报");
    assert.equal(recovered?.kind, "transient");
    assert.deepEqual(recovered?.messages, []);
    assert.match(recovered?.reason ?? "", /durable Open SlideStudio run ledger/);
  });

  it("does not invent recovery for a non-strict or incomplete project", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-no-recover-"));
    fs.mkdirSync(path.join(dir, "_agent"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "_agent", "runtime.json"),
      JSON.stringify({ brief: "draft", categoryId: "x", designSystemId: "a/b" }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "_agent", "run-ledger.v1.json"), "{}", "utf8");
    assert.equal(recoverGenerateCheckpoint(dir), undefined);
  });

  it("keeps provider and model recovery actions explicit", () => {
    assert.match(formatPauseMessage("rate_limit"), /切换供应商或模型/);
    assert.match(formatPauseMessage("auth"), /重新登录或切换供应商/);
    assert.match(formatPauseMessage("model_unavailable"), /换一个支持图片的模型/);

    const authCheckpoint = { ...checkpoint(), kind: "auth" as const };
    assert.equal(readGenerateCheckpoint(writeFixture(authCheckpoint))?.kind, "auth");
  });
});

function writeFixture(value: AgentCheckpoint): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-checkpoint-kind-"));
  writeGenerateCheckpoint(dir, value);
  return dir;
}
