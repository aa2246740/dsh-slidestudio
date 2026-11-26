import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createPresentationRun } from "./run.js";
import {
  REPO,
  addTemplateMaterial,
  openRun,
  plan,
  readWholePart,
  runtime,
  syntheticProject,
} from "./authority-run.testkit.js";
import { readRunLedger } from "./domain/run-ledger.js";
import { readClarificationRecords, readRecordedReportRequirements } from "./domain/report-authority.js";
import { readDesignAuthority } from "./domain/design-authority.js";
import { projectPackColorContext } from "./domain/pack-color-context.js";
import { writePageColorIssues } from "./domain/layout-qa.js";
import { selectedStylePackId } from "./domain/style-pack-priority.js";
import { catalogPackPaletteHexes } from "./domain/theme-pack.js";
import { authorityPlan, colorPage, readMissingReferences } from "./report-authority-run.support.js";

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

describe("controlled design authority at the Host command seam", () => {
  it("applies an explicit user decision, adopts B, and writes/checks under it", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "design-authority-positive-"));
    const designSystemId = "finance/honey-orange-memo";
    const root = syntheticProject(scratch, { designSystemId });
    addTemplateMaterial(root);
    const { run, ctx, epoch } = await openRun(root, "authority-positive", { designSystemId });
    readWholePart(root, "brand", "design", epoch);
    await readMissingReferences(run, ctx, "authority-positive");

    const committed = await run.execute(
      authorityPlan({
        reportRequirements: [
          {
            id: "white-ground",
            role: "explicit-requirement",
            statement: "背景保持白色",
            origin: { kind: "user-request" },
          },
        ],
      }),
      ctx("authority-positive-commit"),
    );
    assert.equal(committed.ok, true, committed.detail);
    const saved = runtime(root);
    assert.equal(saved.designSystemId, designSystemId, "the initial Hub choice is kept");
    assert.equal(
      (saved.designAuthority as { source?: string }).source,
      "material:brand",
      "the current decision is stored as a material authority, not a catalog id",
    );
    assert.deepEqual(
      readRecordedReportRequirements(root)?.map((item) => item.id),
      ["white-ground"],
    );
    assert.equal(readClarificationRecords(root).length, 0);
    assert.equal(selectedStylePackId(root), undefined);

    const colors = projectPackColorContext(root);
    assert.equal(colors.adoptedPackHexes?.has("#C8102E"), true);
    const packOnly = [...(catalogPackPaletteHexes().get(designSystemId) ?? [])].find(
      (hex) => !colors.adoptedPackHexes?.has(hex),
    );
    assert.ok(packOnly, "the retained pack owns a colour the attachment does not grant");
    assert.equal(colors.adoptedPackHexes?.has(packOnly), false);

    const written = await run.execute(
      { name: "write_page", args: colorPage("#C8102E") },
      ctx("authority-positive-write"),
    );
    assert.equal(written.ok, true, written.detail);
    // The Host applies this same palette context before it writes a page.
    const refused = writePageColorIssues(colorPage(packOnly) as never, undefined, projectPackColorContext(root));
    assert.equal(refused[0]?.code, "pack_color", JSON.stringify({ packOnly }));
    assert.equal(
      readRunLedger(root)!.facts.some((fact) => fact.type === "page.edit-authorized"),
      false,
      "a style decision grants no page edit authority",
    );
  });

  it("applies a valid current answer and treats a repeat as idempotent", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "design-authority-answer-"));
    const designSystemId = "finance/honey-orange-memo";
    const root = syntheticProject(scratch, { designSystemId });
    addTemplateMaterial(root);
    const { run, ctx, epoch } = await openRun(root, "authority-answer", { designSystemId });
    readWholePart(root, "brand", "design", epoch);
    writeQuestion(root, {
      id: "q-style",
      at: "2026-10-01T00:00:00Z",
      status: "answered",
      selected: ["以附件品牌为准"],
      contextEpochId: epoch,
    });
    const command = authorityPlan({
      designAuthority: {
        source: "material:brand",
        origin: {
          kind: "clarification-answer",
          questionId: "style",
          text: "以附件品牌为准",
        },
      },
    });
    const first = await run.execute(command, ctx("authority-answer-1"));
    assert.equal(first.ok, true, first.detail);
    const decidedAt = (runtime(root).designAuthority as { decidedAt?: string }).decidedAt;
    assert.ok(decidedAt);

    const second = await run.execute(command, ctx("authority-answer-2"));
    assert.equal(second.ok, true, second.detail);
    assert.equal(
      (runtime(root).designAuthority as { decidedAt?: string }).decidedAt,
      decidedAt,
      "a repeated answer does not switch authority a second time",
    );
  });

  it("refuses an attachment style without a current decision and keeps A when it is retained", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "design-authority-negative-"));
    const designSystemId = "finance/honey-orange-memo";
    const root = syntheticProject(scratch, { designSystemId });
    addTemplateMaterial(root);
    const { run, ctx, epoch } = await openRun(root, "authority-negative", { designSystemId });
    readWholePart(root, "brand", "design", epoch);

    const noAuthority = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: plan(),
          adoptedSourceIds: ["material:brand"],
          designAspects: [{ source: "material:brand", aspects: ["palette", "fonts"] }],
        },
      },
      ctx("authority-negative-none"),
    );
    assert.equal(noAuthority.ok, false);
    assert.match(noAuthority.detail, /风格「蜜橙备忘」/);
    assert.equal(readDesignAuthority(root).kind, "absent");
    assert.equal(runtime(root).adoptedSourceIds, undefined);

    const attachmentOrigin = await run.execute(
      authorityPlan({
        designAuthority: {
          source: "material:brand",
          origin: { kind: "attachment", text: "附件自己要求" },
        },
      }),
      ctx("authority-negative-self"),
    );
    assert.equal(attachmentOrigin.ok, false);
    assert.equal(attachmentOrigin.payload.error, "design_authority_invalid");

    const notAdopted = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: plan(),
          designAuthority: {
            source: "material:brand",
            origin: { kind: "user-request", text: "按附件品牌做" },
          },
        },
      },
      ctx("authority-negative-unadopted"),
    );
    assert.equal(notAdopted.ok, false);
    assert.equal(notAdopted.payload.error, "design_authority_not_adopted");

    const contentOnly = await run.execute(
      authorityPlan({
        designAspects: [{ source: "material:brand", aspects: ["content"] }],
      }),
      ctx("authority-negative-content"),
    );
    assert.equal(contentOnly.ok, false);
    assert.equal(contentOnly.payload.error, "design_authority_missing_aspect");

    const retained = await run.execute(
      authorityPlan({
        designAuthority: {
          source: "hub-choice",
          origin: { kind: "user-request", text: "保留首页风格" },
        },
      }),
      ctx("authority-negative-hub"),
    );
    assert.equal(retained.ok, false);
    assert.match(retained.detail, /风格「蜜橙备忘」/);
    assert.equal(readDesignAuthority(root).kind, "absent");
    assert.equal(runtime(root).designAuthority, undefined);
  });

  it("rejects cancelled, pending, interrupted, expired and mismatched answers", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "design-authority-questions-"));
    const designSystemId = "finance/honey-orange-memo";
    const root = syntheticProject(scratch, { designSystemId });
    addTemplateMaterial(root);
    const { run, ctx, epoch } = await openRun(root, "authority-questions", { designSystemId });
    readWholePart(root, "brand", "design", epoch);
    const command = authorityPlan({
      designAuthority: {
        source: "material:brand",
        origin: {
          kind: "clarification-answer",
          questionId: "style",
          text: "以附件品牌为准",
        },
      },
    });
    const cases = [
      { status: "pending" as const, epoch, code: "clarification_not_answered" },
      { status: "cancelled" as const, epoch, code: "clarification_not_answered" },
      { status: "interrupted" as const, epoch, code: "clarification_not_answered" },
      { status: "answered" as const, epoch: "older-epoch", code: "clarification_expired" },
    ];
    for (const [index, item] of cases.entries()) {
      writeQuestion(root, {
        id: `q-${index}`,
        at: "2026-10-01T00:00:00Z",
        status: item.status,
        contextEpochId: item.epoch,
      });
      const result = await run.execute(command, ctx(`authority-question-${index}`));
      assert.equal(result.ok, false);
      assert.equal(result.payload.error, item.code);
      assert.equal(readDesignAuthority(root).kind, "absent");
    }

    writeQuestion(root, {
      id: "q-mismatch",
      at: "2026-10-01T00:00:00Z",
      status: "answered",
      selected: ["以首页风格为准"],
      contextEpochId: epoch,
    });
    const mismatch = await run.execute(command, ctx("authority-question-mismatch"));
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.payload.error, "clarification_mismatch");
  });

  it("does not let an older answer replace the current decision", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "design-authority-old-answer-"));
    const designSystemId = "finance/honey-orange-memo";
    const root = syntheticProject(scratch, { designSystemId });
    addTemplateMaterial(root);
    const { run, ctx, epoch } = await openRun(root, "authority-old-answer", { designSystemId });
    readWholePart(root, "brand", "design", epoch);
    const switched = await run.execute(authorityPlan(), ctx("authority-old-current"));
    assert.equal(switched.ok, true, switched.detail);
    const decidedAt = (runtime(root).designAuthority as { decidedAt?: string }).decidedAt;
    assert.ok(decidedAt);

    writeQuestion(root, {
      id: "q-old",
      at: "2020-01-01T00:00:00Z",
      status: "answered",
      selected: ["改用其他风格"],
      contextEpochId: epoch,
    });
    const stale = await run.execute(
      authorityPlan({
        designAuthority: {
          source: "consulting/pine-green-strategy",
          origin: {
            kind: "clarification-answer",
            questionId: "style",
            text: "改用其他风格",
          },
        },
      }),
      ctx("authority-old-answer"),
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.payload.error, "clarification_superseded");
    assert.equal((runtime(root).designAuthority as { source?: string }).source, "material:brand");
  });

  it("leaves no half switch when the material or its reads fail", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "design-authority-failure-"));
    const designSystemId = "finance/honey-orange-memo";
    const root = syntheticProject(scratch, { designSystemId });
    addTemplateMaterial(root);
    const { run, ctx } = await openRun(root, "authority-failure", { designSystemId });
    const unread = await run.execute(authorityPlan(), ctx("authority-failure-unread"));
    assert.equal(unread.ok, false);
    assert.equal(unread.payload.error, "required_source_chunks_unread");
    assert.equal(readDesignAuthority(root).kind, "absent");
    assert.equal(runtime(root).adoptedSourceIds, undefined);

    fs.writeFileSync(
      path.join(root, "_agent", "materials", "brand", "design-source.md"),
      Buffer.from("【Color Palette】\n- accent1: #123456\n"),
    );
    const { run: retried, ctx: retriedCtx } = await openRun(root, "authority-failure-2", {
      designSystemId,
    });
    // The receipt no longer verifies, so the decision is refused before any read
    // credit or plan write: tampering never produces a half switch.
    const tampered = await retried.execute(authorityPlan(), retriedCtx("authority-failure-tamper"));
    assert.equal(tampered.ok, false);
    assert.equal(tampered.payload.error, "material_design_source_invalid");
    assert.equal(readDesignAuthority(root).kind, "absent");
    assert.equal(runtime(root).adoptedSourceIds, undefined);
    assert.match(tampered.detail, /回执校验|不一致|重新上传/);
  });

  it("keeps the current authority after reopen and still refuses out-of-plan writes", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "design-authority-reopen-"));
    const designSystemId = "finance/honey-orange-memo";
    const root = syntheticProject(scratch, { designSystemId });
    addTemplateMaterial(root);
    const { run, ctx, epoch } = await openRun(root, "authority-reopen", { designSystemId });
    readWholePart(root, "brand", "design", epoch);
    const switched = await run.execute(authorityPlan(), ctx("authority-reopen-switch"));
    assert.equal(switched.ok, true, switched.detail);

    const reopened = createPresentationRun({ repoRoot: REPO });
    assert.ok(reopened.hydrate(root));
    const reopenedEpoch = reopened.epochFor("authority-reopen");
    assert.equal(reopenedEpoch, epoch);
    const inspection = await reopened.inspect("authority-reopen");
    assert.equal(inspection.designAuthority?.source, "material:brand");
    assert.equal(inspection.designSystemId, undefined);
    assert.equal(
      inspection.design.kind === "explicit-style" ? inspection.design.designSystemId : undefined,
      designSystemId,
      "inspect keeps the original Hub directive as history",
    );

    const continueCtx = (toolCallId: string) => ({
      runId: "authority-reopen",
      sessionId: "authority-reopen",
      toolCallId,
      projectRoot: root,
      abortSignal: new AbortController().signal,
    });
    const continued = await reopened.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: plan(),
          adoptedSourceIds: ["material:brand"],
          designAspects: [{ source: "material:brand", aspects: ["palette"] }],
        },
      },
      continueCtx("authority-reopen-continue"),
    );
    assert.equal(continued.ok, true, continued.detail);
    assert.equal(
      (runtime(root).designAuthority as { source?: string }).source,
      "material:brand",
      "omitting the field keeps the saved decision",
    );

    const foreign = await reopened.execute(
      { name: "write_page", args: { ...colorPage("#C8102E"), id: "not-planned" } },
      continueCtx("authority-reopen-foreign"),
    );
    assert.equal(foreign.ok, false);
    assert.equal(foreign.payload.error, "not_in_plan");
  });
});
