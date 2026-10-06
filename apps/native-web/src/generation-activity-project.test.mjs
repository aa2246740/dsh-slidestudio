import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import * as pptd from "../../../packages/pptd-v2/dist/index.js";
import { initializeRunLedger } from "../../../packages/presentation-run/dist/index.js";
import { writeSliceRuntime } from "../../../packages/dsh-slides-host/dist/runtime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "generation-activity-project-"));
const firstRoot = path.join(scratch, "first");
const secondRoot = path.join(scratch, "second");
fs.mkdirSync(firstRoot);
fs.mkdirSync(secondRoot);

for (const [root, sessionId] of [[firstRoot, "session-first"], [secondRoot, "session-second"]]) {
  fs.mkdirSync(path.join(root, "_agent"));
  fs.writeFileSync(
    path.join(root, "_agent", "presentation-run.v1.json"),
    `${JSON.stringify({ sessionId })}\n`,
  );
}

const { generationActivityForRequest } = await import("./server.mjs");

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function request(root, sessionId) {
  const url = new URL("http://127.0.0.1/api/generation-activity");
  url.searchParams.set("project", root);
  url.searchParams.set("sessionId", sessionId);
  return url;
}

const sessions = new Map([
  [firstRoot, "session-first"],
  [secondRoot, "session-second"],
]);
const readActivity = async (_native, root) => ({
  ok: true,
  project: { path: root },
  sessionId: sessions.get(root),
  events: [],
});

describe("project-bound generation activity", () => {
  it("returns the real execution blockers so the UI can explain an unfinished run", async () => {
    const root = path.join(scratch, "unfinished");
    pptd.createEmptyProject(root, { title: "Unfinished regression" });
    writeSliceRuntime(root, { brief: "A simple deck", design: { kind: "self-directed" }, editorBaseUrl: "http://127.0.0.1:1", strictExecution: true });
    initializeRunLedger(root);
    fs.writeFileSync(path.join(root, "_agent", "presentation-run.v1.json"), JSON.stringify({ sessionId: "unfinished" }));
    const activity = await generationActivityForRequest(
      { pptd, store: { listVersions: () => [] } }, request(root, "unfinished"), root,
    );
    assert.equal(activity.project.pageCount, 0);
    assert.ok(activity.execution?.blockers.some((blocker) => blocker.code === "missing_plan"), JSON.stringify(activity.execution));
  });

  it("projects a persisted host-interrupted fault as a paused, resumable phase", async () => {
    const root = path.join(scratch, "interrupted");
    pptd.createEmptyProject(root, { title: "Interrupted regression" });
    writeSliceRuntime(root, { brief: "A deck killed by restart", design: { kind: "self-directed" }, editorBaseUrl: "http://127.0.0.1:1", strictExecution: true });
    initializeRunLedger(root);
    fs.writeFileSync(path.join(root, "_agent", "presentation-run.v1.json"), JSON.stringify({ sessionId: "interrupted" }));
    fs.writeFileSync(path.join(root, "_agent", "dsh-agent-error.json"), JSON.stringify({
      code: "host-interrupted",
      detail: "应用或主机已重启，生成中断；已完成的内容保留，可在编辑器中继续。",
    }));
    const activity = await generationActivityForRequest(
      { pptd, store: { listVersions: () => [] } }, request(root, "interrupted"), root,
    );
    assert.equal(activity.phase, "paused");
    assert.equal(activity.error?.code, "host-interrupted");
    assert.ok(
      activity.stages.some((stage) => stage.status === "needs-attention" && /已暂停/.test(stage.detail ?? "")),
      JSON.stringify(activity.stages),
    );
  });

  it("keeps two interleaved project polls bound to their own sessions", async () => {
    const first = await generationActivityForRequest({}, request(firstRoot, "session-first"), secondRoot, readActivity);
    const second = await generationActivityForRequest({}, request(secondRoot, "session-second"), firstRoot, readActivity);
    const firstAgain = await generationActivityForRequest({}, request(firstRoot, "session-first"), secondRoot, readActivity);

    assert.equal(first.sessionId, "session-first");
    assert.equal(second.sessionId, "session-second");
    assert.equal(firstAgain.sessionId, "session-first");
    assert.equal(first.project.path, firstRoot);
    assert.equal(second.project.path, secondRoot);
  });

  it("rejects a session id owned by another requested project", async () => {
    await assert.rejects(
      generationActivityForRequest({}, request(firstRoot, "session-second"), secondRoot, readActivity),
      (error) => {
        assert.equal(error.httpStatus, 409);
        assert.equal(error.code, "GENERATION_SESSION_PROJECT_MISMATCH");
        return true;
      },
    );
  });

  it("makes every editor activity read use the project-bound URL helper", () => {
    const source = fs.readFileSync(path.join(ROOT, "apps", "native-web", "public", "app.js"), "utf8");
    assert.doesNotMatch(source, /api\("\/api\/generation-activity"\)/);
    // Count raw endpoint literals rather than a fixed number of consumers;
    // refactoring a caller must not weaken project/session binding.
    assert.equal(source.match(/["'`]\/api\/generation-activity/g)?.length, 1);
    assert.ok(source.match(/api\(generationActivityUrl\(\)\)/g)?.length > 0);
    assert.match(source, /query\.set\("project", project\)/);
    assert.match(source, /query\.set\("sessionId", sessionId\)/);
  });
});
