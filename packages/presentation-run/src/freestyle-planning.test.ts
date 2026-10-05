import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { createPresentationRun } from "./run.js";
import { listSourceReceipts } from "./receipts.js";
import { writeDomainRuntime } from "./domain/domain-hands.js";
import { inspectRunLedger } from "./domain/run-ledger.js";
import { verifyOpenKimiPack } from "./domain/openkimi-source-pack.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceId = "openkimi:reference/design_system/academic/blue-line-courseware/design.md";
const brief = "Windows 批处理教学课件，15 分钟，讲解概念、例子和课堂练习。";
const plan = [
  { pageId: "cover", title: "认识批处理", layoutFamily: "cover", exhibits: [] },
  { pageId: "practice", title: "写出第一条命令", layoutFamily: "content", exhibits: [] },
];

describe("freestyle planning through the real strict domain boundary", () => {
  for (const explicit of [false, true]) {
    it(`${explicit ? "selected" : "freestyle"} style commits and survives a later outline update`, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "slides-freestyle-regression-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      createEmptyProject(root, { title: "批处理教学" });
      writeDomainRuntime(root, {
        brief, strictExecution: true,
        designDirection: explicit ? "preset" : "self-directed",
        ...(explicit ? { designSystemId: "academic/blue-line-courseware" } : {}),
      });
      const run = createPresentationRun({ repoRoot });
      const handle = await run.open({
        projectRoot: root, sessionId: `planning-${explicit}`, brief,
        editorBaseUrl: "http://127.0.0.1:1",
        design: explicit
          ? { kind: "explicit-style", designSystemId: "academic/blue-line-courseware" }
          : { kind: "self-directed" },
        provider: { providerId: "test", modelId: "test" },
      });
      let sequence = 0;
      const execute = (name: string, args: Record<string, unknown>) => run.execute({ name, args }, {
        ...handle, toolCallId: `call-${++sequence}`, abortSignal: new AbortController().signal,
      });
      const args = { slidePlan: plan, ...(explicit ? {} : { adoptedSourceIds: [sourceId] }) };
      const unread = await execute("commit_design", args);
      assert.equal(unread.ok, false);
      assert.equal(unread.payload.error, "required_source_chunks_unread");
      assert.equal(listSourceReceipts(root).some((row) => row.state === "adopted"), false);
      const required = inspectRunLedger(root).missingReferenceChunks;
      const selected = verifyOpenKimiPack(repoRoot).entriesById.get(sourceId)!;
      for (const chunk of [...required, ...selected.chunks.map((chunk) => ({ sourceId, chunkIndex: chunk.index }))]) {
        const read = await execute("read_reference", chunk);
        assert.equal(read.ok, true, read.detail);
      }
      const committed = await execute("commit_design", args);
      assert.equal(committed.ok, true, committed.detail);
      assert.equal(inspectRunLedger(root).todoCount, plan.length);
      const expanded = [...plan, { pageId: "close", title: "课后练习", layoutFamily: "conclusion", exhibits: [] }];
      const updated = await execute("write_todo", { items: expanded });
      assert.equal(updated.ok, true, updated.detail);
      assert.deepEqual(updated.payload.plannedPageIds, expanded.map((page) => page.pageId));
    });
  }
});
