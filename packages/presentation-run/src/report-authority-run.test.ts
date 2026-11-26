import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  addTemplateMaterial,
  openRun,
  plan,
  readWholePart,
  runtime,
  syntheticProject,
} from "./authority-run.testkit.js";
import { readRunLedger } from "./domain/run-ledger.js";
import { normalizeReportRequirements } from "./domain/report-requirements.js";
import { readClarificationRecords } from "./domain/report-authority.js";
import type { PresentationCommand } from "./types.js";

type QuestionSpec = Readonly<{
  id: string;
  at: string;
  status: "pending" | "answered" | "cancelled" | "interrupted";
  selected?: readonly string[];
  contextEpochId?: string;
}>;

function writeQuestion(projectRoot: string, spec: QuestionSpec): void {
  fs.writeFileSync(
    path.join(projectRoot, "_agent", "assistant-questions.v1.json"),
    `${JSON.stringify(
      [
        {
          id: spec.id,
          at: spec.at,
          ...(spec.contextEpochId ? { contextEpochId: spec.contextEpochId } : {}),
          questions: [
            {
              id: "style",
              question: "配色以哪边为准？",
              options: [{ label: "以企业要求为准" }, { label: "以参考风格为准" }],
            },
          ],
          status: spec.status,
          ...(spec.status === "answered"
            ? {
                answer: {
                  answers: [{ id: "style", selected: [...(spec.selected ?? [])] }],
                },
                answeredAt: spec.at,
              }
            : {}),
        },
      ],
      null,
      2,
    )}\n`,
  );
}

describe("planning requirements at the Host command seam", () => {
  it("records an explicit requirement and keeps or clears it like the other plan declarations", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "report-authority-run-"));
    const root = syntheticProject(scratch);
    const { run, ctx } = await openRun(root, "requirements-keep");
    const requirement = {
      id: "white-background",
      role: "explicit-requirement" as const,
      statement: "背景保持白色",
      origin: { kind: "user-request" as const },
    };
    const first = await run.execute(
      { name: "commit_design", args: { slidePlan: plan(), reportRequirements: [requirement] } },
      ctx("commit-1"),
    );
    assert.equal(first.ok, true, first.detail);
    assert.deepEqual(first.payload.reportRequirements, [requirement]);
    assert.deepEqual(runtime(root).reportRequirements, [requirement]);

    const second = await run.execute({ name: "commit_design", args: { slidePlan: plan() } }, ctx("commit-2"));
    assert.equal(second.ok, true, second.detail);
    assert.deepEqual(runtime(root).reportRequirements, [requirement]);

    const cleared = await run.execute(
      { name: "commit_design", args: { slidePlan: plan(), reportRequirements: [] } },
      ctx("commit-3"),
    );
    assert.equal(cleared.ok, true, cleared.detail);
    assert.equal("reportRequirements" in runtime(root), false);
  });

  it("rejects cancelled, stale and mismatched answers without changing authority", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "report-authority-answer-run-"));
    const root = syntheticProject(scratch);
    const { run, ctx, epoch } = await openRun(root, "requirements-answer");
    const requirement = {
      id: "white-background",
      role: "explicit-requirement" as const,
      statement: "背景保持白色",
      origin: {
        kind: "clarification-answer" as const,
        questionId: "style",
        text: "以企业要求为准",
      },
    };
    const call = (id: string) =>
      run.execute({ name: "commit_design", args: { slidePlan: plan(), reportRequirements: [requirement] } }, ctx(id));
    const missing = await call("missing");
    assert.equal(missing.ok, false);
    assert.equal(missing.payload.error, "clarification_missing");

    writeQuestion(root, {
      id: "q-1",
      at: "2026-10-01T00:00:00Z",
      status: "cancelled",
      contextEpochId: epoch,
    });
    const cancelled = await call("cancelled");
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.payload.error, "clarification_not_answered");
    assert.equal("reportRequirements" in runtime(root), false);

    writeQuestion(root, {
      id: "q-2",
      at: "2026-10-01T00:00:00Z",
      status: "answered",
      selected: ["以企业要求为准"],
      contextEpochId: "older-epoch",
    });
    const expired = await call("expired");
    assert.equal(expired.ok, false);
    assert.equal(expired.payload.error, "clarification_expired");

    writeQuestion(root, {
      id: "q-legacy",
      at: "2026-10-01T00:00:00Z",
      status: "answered",
      selected: ["以企业要求为准"],
    });
    const legacy = await call("legacy");
    assert.equal(legacy.ok, false);
    assert.equal(legacy.payload.error, "clarification_expired");
    assert.equal("reportRequirements" in runtime(root), false);

    writeQuestion(root, {
      id: "q-3",
      at: "2026-10-01T00:00:00Z",
      status: "answered",
      selected: ["以参考风格为准"],
      contextEpochId: epoch,
    });
    const mismatch = await call("mismatch");
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.payload.error, "clarification_mismatch");
    assert.equal("reportRequirements" in runtime(root), false);

    writeQuestion(root, {
      id: "q-4",
      at: "2026-10-01T00:00:00Z",
      status: "answered",
      selected: ["以企业要求为准"],
      contextEpochId: epoch,
    });
    const accepted = await call("accepted");
    assert.equal(accepted.ok, true, accepted.detail);
    assert.deepEqual(runtime(root).reportRequirements, [requirement]);
    const ledger = readRunLedger(root)!;
    assert.equal(
      ledger.facts.some((fact) => fact.type === "page.edit-authorized"),
      false,
      "a style clarification must not grant page edit authority",
    );
    assert.equal(readClarificationRecords(root).length, 1);
  });

  it("invalidates an earlier design-only read check when a per-page rule is added", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "report-authority-pages-run-"));
    const root = syntheticProject(scratch);
    addTemplateMaterial(root);
    const { run, ctx, epoch } = await openRun(root, "requirements-pages");
    readWholePart(root, "brand", "design", epoch);
    const style: PresentationCommand = {
      name: "commit_design",
      args: {
        slidePlan: plan(),
        reportRequirements: [
          {
            id: "style-source",
            role: "design-reference",
            statement: "配色参考附件",
            origin: { kind: "user-request" },
            material: { materialId: "brand", parts: ["design"] },
          },
        ],
      },
    };
    const designOnly = await run.execute(style, ctx("design-only"));
    assert.equal(designOnly.ok, true, designOnly.detail);
    assert.equal(runtime(root).reportRequirements !== undefined, true);

    const perPage = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: plan(),
          reportRequirements: [
            {
              id: "per-page",
              role: "explicit-requirement",
              statement: "第 1 页给结论，第 2 页给证据",
              origin: { kind: "user-request" },
              material: { materialId: "brand", sourcePages: [1, 2] },
            },
          ],
        },
      },
      ctx("per-page"),
    );
    assert.equal(perPage.ok, false);
    assert.equal(perPage.payload.error, "required_source_chunks_unread");
    assert.equal(
      (runtime(root).reportRequirements as readonly { id: string }[])[0]?.id,
      "style-source",
      "the rejected plan leaves the earlier declaration intact",
    );

    readWholePart(root, "brand", "slides", epoch);
    const retried = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: plan(),
          reportRequirements: [
            {
              id: "per-page",
              role: "explicit-requirement",
              statement: "第 1 页给结论，第 2 页给证据",
              origin: { kind: "user-request" },
              material: { materialId: "brand", sourcePages: [1, 2] },
            },
          ],
        },
      },
      ctx("per-page-retry"),
    );
    assert.equal(retried.ok, true, retried.detail);
    assert.deepEqual(
      (runtime(root).reportRequirements as readonly { id: string }[]).map((item) => item.id),
      ["per-page"],
    );
  });

  it("turns a required but unreadable material part into one explicit limitation question", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "report-authority-unreadable-run-"));
    const root = syntheticProject(scratch);
    const { run, ctx } = await openRun(root, "requirements-unreadable");
    const result = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: plan(),
          reportRequirements: [
            {
              id: "source-pages",
              role: "explicit-requirement",
              statement: "逐页沿用源结构",
              origin: { kind: "user-request" },
              material: { materialId: "missing", sourcePages: [1] },
            },
          ],
        },
      },
      ctx("missing-material"),
    );
    assert.equal(result.ok, false);
    assert.equal(result.payload.error, "report_requirement_unreadable");
    assert.equal(result.payload.next, "ask_user_question");
    assert.match(result.detail, /无法读取/);
    assert.match(result.detail, /说明这个限制|ask_user_question/);
    assert.equal("reportRequirements" in runtime(root), false);
  });

  it("does not let a clarification answer widen the selected style pack's palette", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "report-authority-pack-run-"));
    const designSystemId = "finance/honey-orange-memo";
    const root = syntheticProject(scratch, { designSystemId });
    addTemplateMaterial(root);
    const { run, ctx, epoch } = await openRun(root, "requirements-pack", { designSystemId });
    readWholePart(root, "brand", "design", epoch);
    writeQuestion(root, {
      id: "q-pack",
      at: "2026-10-01T00:00:00Z",
      status: "answered",
      selected: ["以参考风格为准"],
      contextEpochId: epoch,
    });
    const rejected = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: plan(),
          adoptedSourceIds: ["material:brand"],
          designAspects: [{ source: "material:brand", aspects: ["palette"] }],
          reportRequirements: [
            {
              id: "reference-palette",
              role: "explicit-requirement",
              statement: "按附件配色",
              origin: {
                kind: "clarification-answer",
                questionId: "style",
                text: "以参考风格为准",
              },
            },
          ],
        },
      },
      ctx("pack-palette"),
    );
    assert.equal(rejected.ok, false);
    assert.match(rejected.detail, /风格「蜜橙备忘」/);
    assert.match(rejected.detail, /designAuthority: material:<id>/);
    assert.equal(runtime(root).designSystemId, designSystemId);
    assert.equal("reportRequirements" in runtime(root), false);
    assert.equal("userColors" in runtime(root), false);
    const normalized = normalizeReportRequirements([
      {
        id: "reference-palette",
        role: "explicit-requirement",
        statement: "按附件配色",
        origin: {
          kind: "clarification-answer",
          questionId: "style",
          text: "以参考风格为准",
        },
      },
    ]);
    assert.equal(normalized[0]?.role, "explicit-requirement");
  });
});
