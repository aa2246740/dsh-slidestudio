import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { materialChunkCount, readMaterialChunk } from "./material-content.js";
import { verifyMaterial } from "./material-pack.js";
import { ensureRunLedger, recordMaterialChunk } from "./run-ledger.js";
import {
  checkPlanningReportRequirements,
  persistPlanningReportRequirements,
  readClarificationRecords,
  readRecordedReportRequirements,
  requirementAuthorityIssue,
  resolvePlanningReportRequirements,
} from "./report-authority.js";
import {
  checkReportMaterialDependencies,
  materialDependenciesForRequirements,
  normalizeReportRequirements,
  type ReportRequirement,
} from "./report-requirements.js";

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function projectWithTemplate(parent: string, id = "brand"): string {
  const projectRoot = path.join(parent, "project");
  const dir = path.join(projectRoot, "_agent", "materials", id);
  fs.mkdirSync(dir, { recursive: true });
  const original = Buffer.from(`synthetic-template-${id}`);
  fs.writeFileSync(path.join(dir, "original.pptx"), original);
  const derivative = Buffer.from(
    JSON.stringify({
      schema: "material-derivative/v1",
      materialId: id,
      status: "ok",
      source: { sha256: sha256(original) },
      parser: { id: "pptx-ooxml-v1" },
      "deck-template": {
        slides: [
          { index: 1, title: "结论", text: "本章结论" },
          { index: 2, title: "证据", text: "关键证据" },
        ],
        masters: [],
        templateDetail: {},
      },
    }),
  );
  fs.writeFileSync(path.join(dir, "derivative.json"), derivative);
  const markdown = Buffer.from("【Color Palette】\n- accent1: #C8102E\n");
  const sourceJson = Buffer.from(`${JSON.stringify({ version: 1, layouts: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "design-source.md"), markdown);
  fs.writeFileSync(path.join(dir, "design-source.json"), sourceJson);
  fs.writeFileSync(
    path.join(dir, "receipt.json"),
    `${JSON.stringify({
      version: 1,
      id,
      name: `${id}.pptx`,
      kind: "deck-template",
      parser: "pptx-ooxml-v1",
      originalSha256: sha256(original),
      derivativeSha256: sha256(derivative),
      designSourceMdSha256: sha256(markdown),
      designSourceJsonSha256: sha256(sourceJson),
    })}\n`,
  );
  fs.writeFileSync(
    path.join(projectRoot, "_agent", "materials", "manifest.json"),
    `${JSON.stringify({
      version: 1,
      materials: [
        {
          id,
          name: `${id}.pptx`,
          kind: "deck-template",
          summaryZh: "合成模板",
          parser: "pptx-ooxml-v1",
          sha256: sha256(original),
          parts: [],
        },
      ],
    })}\n`,
  );
  return projectRoot;
}

function initLedger(projectRoot: string): void {
  ensureRunLedger(projectRoot, {
    manifestSha256: "0".repeat(64),
    requirementsId: "report-authority-test",
    requirements: [],
  });
}

function readWholePart(projectRoot: string, materialId: string, part: string): void {
  const material = verifyMaterial(projectRoot, materialId);
  const count = materialChunkCount(material, part, {});
  for (let index = 0; index < count; index += 1) {
    const chunk = readMaterialChunk({ material, part, offset: index });
    recordMaterialChunk(
      projectRoot,
      { commandId: `read-${part}-${index}`, contextEpochId: "epoch-1" },
      {
        materialId,
        materialSha256: material.sha256,
        part: chunk.part,
        chunkIndex: index,
        chunkSha256: chunk.chunkSha256,
      },
    );
  }
}

type QuestionRow = Readonly<{
  id: string;
  at: string;
  questionId?: string;
  status: "pending" | "answered" | "cancelled" | "interrupted";
  selected?: readonly string[];
  custom?: string;
  answeredAt?: string;
  contextEpochId?: string;
}>;

function writeQuestions(projectRoot: string, rows: readonly QuestionRow[]): void {
  const dir = path.join(projectRoot, "_agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "assistant-questions.v1.json"),
    `${JSON.stringify(
      rows.map((row) => ({
        id: row.id,
        at: row.at,
        ...(row.contextEpochId ? { contextEpochId: row.contextEpochId } : {}),
        questions: [
          {
            id: row.questionId ?? "style",
            question: "配色以哪边为准？",
            options: [{ label: "以企业要求为准" }, { label: "以参考风格为准" }],
          },
        ],
        status: row.status,
        ...(row.status === "answered"
          ? {
              answer: {
                answers: [
                  {
                    id: row.questionId ?? "style",
                    selected: [...(row.selected ?? [])],
                    ...(row.custom ? { custom: row.custom } : {}),
                  },
                ],
              },
              answeredAt: row.answeredAt ?? row.at,
            }
          : {}),
      })),
      null,
      2,
    )}\n`,
  );
}

function answeredRequirement(questionId = "style"): ReportRequirement {
  return normalizeReportRequirements([
    {
      id: "background-rule",
      role: "explicit-requirement",
      statement: "背景保持白色",
      origin: {
        kind: "clarification-answer",
        questionId,
        text: "以企业要求为准",
      },
    },
  ])[0]!;
}

describe("planning report requirements", () => {
  it("keeps an omitted declaration and clears it with an explicit empty list", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-authority-runtime-"));
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "_agent", "runtime.json"),
      `${JSON.stringify({ brief: "合成汇报", designSystemId: "finance/honey-orange-memo" })}\n`,
    );
    const requirements = normalizeReportRequirements([
      {
        id: "pages",
        role: "explicit-requirement",
        statement: "固定 7 页",
        origin: { kind: "user-request" },
      },
    ]);
    persistPlanningReportRequirements(root, requirements);
    assert.deepEqual(readRecordedReportRequirements(root), requirements);
    assert.deepEqual(resolvePlanningReportRequirements(root, {}), requirements);

    persistPlanningReportRequirements(root, []);
    assert.equal(readRecordedReportRequirements(root), undefined);
    const runtime = JSON.parse(fs.readFileSync(path.join(root, "_agent", "runtime.json"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal("reportRequirements" in runtime, false);
    assert.equal(runtime.designSystemId, "finance/honey-orange-memo");
  });

  it("requires slides for an explicit per-page rule and never accepts a design receipt", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "report-authority-slides-"));
    const root = projectWithTemplate(scratch);
    initLedger(root);
    const requirements = normalizeReportRequirements([
      {
        id: "per-page",
        role: "explicit-requirement",
        statement: "第 1 页给结论，第 2 页给证据",
        origin: { kind: "user-request" },
        material: { materialId: "brand", sourcePages: [1, 2] },
      },
    ]);
    const [dependency] = materialDependenciesForRequirements(requirements, [
      { materialId: "brand", kind: "deck-template" },
    ]);
    assert.equal(dependency?.part, "slides");
    assert.equal(dependency?.reason, "per-page-responsibility");

    readWholePart(root, "brand", "design");
    const designOnly = checkReportMaterialDependencies(root, "epoch-1", [dependency!]);
    assert.equal(designOnly.ok, false);
    assert.equal(
      designOnly.missing.every((chunk) => chunk.part === "slides"),
      true,
    );

    const beforeSlides = checkPlanningReportRequirements(root, "epoch-1", requirements);
    assert.equal(beforeSlides.ok, false);
    assert.equal(beforeSlides.missing.length > 0, true);

    readWholePart(root, "brand", "slides");
    const afterSlides = checkPlanningReportRequirements(root, "epoch-1", requirements);
    assert.equal(afterSlides.ok, true);
    assert.deepEqual(afterSlides.missing, []);
  });

  it("leaves unrelated parts optional and reports an unreadable dependency explicitly", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "report-authority-parts-"));
    const root = projectWithTemplate(scratch);
    initLedger(root);
    readWholePart(root, "brand", "slides");
    const requirement = normalizeReportRequirements([
      {
        id: "table-rule",
        role: "explicit-requirement",
        statement: "保留指标口径",
        origin: { kind: "user-request" },
        material: { materialId: "brand", parts: ["slides"] },
      },
    ]);
    const ok = checkPlanningReportRequirements(root, "epoch-1", requirement);
    assert.equal(ok.ok, true, JSON.stringify(ok.missing));

    const missingMaterial = normalizeReportRequirements([
      {
        id: "gone",
        role: "explicit-requirement",
        statement: "沿用缺失资料",
        origin: { kind: "user-request" },
        material: { materialId: "absent" },
      },
    ]);
    const unreadable = checkPlanningReportRequirements(root, "epoch-1", missingMaterial);
    assert.equal(unreadable.ok, false);
    assert.equal(unreadable.unreadable.length, 1);
    assert.match(unreadable.unreadable[0]!.detail, /无法读取|不存在|缺少/);
  });
});

describe("clarification authority", () => {
  it("accepts only an answered current-epoch question whose answer text matches", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-authority-answer-"));
    writeQuestions(root, [
      {
        id: "q-1",
        at: "2026-10-01T00:00:00Z",
        status: "answered",
        selected: ["以企业要求为准"],
        answeredAt: "2026-10-01T00:01:00Z",
        contextEpochId: "epoch-1",
      },
    ]);
    const records = readClarificationRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.answerText, "以企业要求为准");
    assert.equal(requirementAuthorityIssue([answeredRequirement()], records, "epoch-1"), undefined);
  });

  it("rejects missing, pending, cancelled, interrupted, expired and mismatched answers", () => {
    const requirement = answeredRequirement();
    const base = {
      id: "q-1",
      at: "2026-10-01T00:00:00Z",
      answeredAt: "2026-10-01T00:01:00Z",
      contextEpochId: "epoch-1",
    } as const;
    const cases: ReadonlyArray<{
      label: string;
      records: readonly QuestionRow[];
      code: string;
    }> = [
      { label: "missing", records: [], code: "clarification_missing" },
      {
        label: "pending",
        records: [{ ...base, status: "pending" }],
        code: "clarification_not_answered",
      },
      {
        label: "cancelled",
        records: [{ ...base, status: "cancelled" }],
        code: "clarification_not_answered",
      },
      {
        label: "interrupted",
        records: [{ ...base, status: "interrupted" }],
        code: "clarification_not_answered",
      },
      {
        label: "expired",
        records: [
          {
            ...base,
            status: "answered",
            selected: ["以企业要求为准"],
            contextEpochId: "epoch-0",
          },
        ],
        code: "clarification_expired",
      },
      {
        label: "legacy without epoch",
        records: [
          {
            ...base,
            status: "answered",
            selected: ["以企业要求为准"],
            contextEpochId: undefined,
          },
        ],
        code: "clarification_expired",
      },
      {
        label: "mismatch",
        records: [{ ...base, status: "answered", selected: ["以参考风格为准"] }],
        code: "clarification_mismatch",
      },
    ];
    for (const item of cases) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-authority-case-"));
      writeQuestions(root, item.records);
      const issue = requirementAuthorityIssue([requirement], readClarificationRecords(root), "epoch-1");
      assert.equal(issue?.code, item.code, item.label);
      assert.match(issue?.detail ?? "", /不能|过期|不一致|不存在|无法/);
    }
  });

  it("lets a re-asked question supersede the earlier answer, including its cancellation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-authority-requeue-"));
    writeQuestions(root, [
      {
        id: "q-old",
        at: "2026-10-01T00:00:00Z",
        status: "answered",
        selected: ["以企业要求为准"],
        answeredAt: "2026-10-01T00:01:00Z",
        contextEpochId: "epoch-1",
      },
      {
        id: "q-new",
        at: "2026-10-02T00:00:00Z",
        status: "cancelled",
        contextEpochId: "epoch-1",
      },
    ]);
    const issue = requirementAuthorityIssue([answeredRequirement()], readClarificationRecords(root), "epoch-1");
    assert.equal(issue?.code, "clarification_not_answered");
  });

  it("grants nothing from a malformed question file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-authority-bad-"));
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    fs.writeFileSync(path.join(root, "_agent", "assistant-questions.v1.json"), "{not json");
    assert.deepEqual(readClarificationRecords(root), []);
    assert.equal(requirementAuthorityIssue([answeredRequirement()], [], "epoch-1")?.code, "clarification_missing");
  });
});
