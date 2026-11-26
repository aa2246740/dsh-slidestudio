import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { composeBodyRules } from "./compose-ir.js";
import { effectivePageCountRequirement } from "./conversation-requirements.js";
import { assertSkillDeck } from "./deck-page-count.js";
import { planWriteFeedback } from "./plan-coverage.js";
import type { SkillDeckInput } from "./skill-pages.js";

const EPOCH = "epoch-now";
const BRIEF = "做一份协作流程介绍，先问我需要几页";

type Row = {
  id: string;
  at: string;
  status: "pending" | "answered" | "cancelled" | "interrupted";
  contextEpochId?: string;
  questions: { id: string }[];
  answer?: { answers: { id: string; selected: string[]; custom?: string }[] };
  answeredAt?: string;
};

function answered(questionId: string, label: string, at: string, overrides: Partial<Row> = {}): Row {
  return {
    id: `row-${questionId}-${at}`,
    at,
    status: "answered",
    contextEpochId: EPOCH,
    questions: [{ id: questionId }],
    answer: { answers: [{ id: questionId, selected: [label] }] },
    answeredAt: at,
    ...overrides,
  };
}

function project(
  t: TestContext,
  rows: readonly Row[],
  messages: readonly { at: string; mode: string; text: string }[] = [],
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-answers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "_agent"));
  fs.writeFileSync(path.join(root, "_agent", "assistant-questions.v1.json"), JSON.stringify(rows));
  fs.writeFileSync(
    path.join(root, "_agent", "assistant-conversation.v1.json"),
    JSON.stringify({ version: 1, mode: "generate", messages }),
  );
  return root;
}

function plan(count: number) {
  return Array.from({ length: count }, (_, index) => ({ pageId: `p${index + 1}` }));
}

function mismatch(root: string, count: number, brief = BRIEF): string | undefined {
  return planWriteFeedback(root, plan(count), brief, EPOCH).countMismatch;
}

function deck(count: number): SkillDeckInput {
  return {
    title: "合成",
    pages: Array.from({ length: count }, (_, index) => ({
      id: `p${index + 1}`,
      elements: [
        {
          elementId: "title",
          elementType: "text" as const,
          bounds: [80, 40, 800, 60] as const,
          content: { text: `页 ${index + 1}`, fontSize: 28 },
        },
      ],
    })),
  };
}

describe("a current answered question supplies the page total", () => {
  it("fixes the total when the brief names none, for plan, compose and delivery alike", (t) => {
    const root = project(t, [answered("pages", "固定 7 页", "2026-11-14T10:00:00.000Z")]);
    const requirement = effectivePageCountRequirement(root, BRIEF, EPOCH);
    assert.deepEqual(requirement, { kind: "exact", count: 7 });
    assert.ok(mismatch(root, 6));
    assert.ok(mismatch(root, 8));
    assert.equal(mismatch(root, 7), undefined);
    const rules = composeBodyRules(BRIEF, undefined, requirement);
    assert.deepEqual(rules.pageCount, { kind: "exact", count: 7 });
    for (const count of [6, 8]) {
      assert.throws(
        () => assertSkillDeck(deck(count), { minPages: rules.minPages, pageCount: rules.pageCount }),
        /固定 7 页/,
      );
    }
    assert.doesNotThrow(() => assertSkillDeck(deck(7), { minPages: rules.minPages, pageCount: rules.pageCount }));
  });

  it("lets a later answer replace the 8 pages written in the first message", (t) => {
    const root = project(
      t,
      [answered("pages", "固定 7 页", "2026-11-14T10:05:00.000Z")],
      [{ at: "2026-11-14T10:00:00.000Z", mode: "generate", text: "固定 8 页协作流程介绍" }],
    );
    const brief = "固定 8 页协作流程介绍";
    assert.deepEqual(effectivePageCountRequirement(root, brief, EPOCH), {
      kind: "exact",
      count: 7,
    });
    assert.equal(mismatch(root, 7, brief), undefined);
    assert.ok(mismatch(root, 8, brief));
  });

  it("keeps a newer generation message ahead of an older answer", (t) => {
    const root = project(
      t,
      [answered("pages", "固定 7 页", "2026-11-14T10:00:00.000Z")],
      [{ at: "2026-11-14T10:10:00.000Z", mode: "generate", text: "改成 9 页" }],
    );
    assert.deepEqual(effectivePageCountRequirement(root, BRIEF, EPOCH), {
      kind: "exact",
      count: 9,
    });
  });

  it("uses the newest answer when the same question was answered twice", (t) => {
    const root = project(t, [
      answered("pages", "固定 6 页", "2026-11-14T10:00:00.000Z", { id: "row-a" }),
      answered("pages", "固定 7 页", "2026-11-14T10:05:00.000Z", { id: "row-b" }),
    ]);
    assert.deepEqual(effectivePageCountRequirement(root, BRIEF, EPOCH), {
      kind: "exact",
      count: 7,
    });
  });

  it("reads a custom text answer", (t) => {
    const root = project(t, [
      {
        ...answered("pages", "", "2026-11-14T10:00:00.000Z"),
        answer: { answers: [{ id: "pages", selected: [], custom: "做 7 页" }] },
      },
    ]);
    assert.deepEqual(effectivePageCountRequirement(root, BRIEF, EPOCH), {
      kind: "exact",
      count: 7,
    });
  });

  it("does not read ordinals or reference counts inside an answer as a total", (t) => {
    const root = project(t, [
      answered("pages", "第 1 页结论，第 2 页证据，参考稿约 12 页", "2026-11-14T10:00:00.000Z"),
    ]);
    assert.deepEqual(effectivePageCountRequirement(root, BRIEF, EPOCH), { kind: "unspecified" });
    assert.equal(mismatch(root, 3), undefined);
  });
});

describe("an answer that is not current changes nothing", () => {
  const cases: [string, Row][] = [
    ["cancelled", answered("pages", "固定 7 页", "2026-11-14T10:00:00.000Z", { status: "cancelled" })],
    ["interrupted", answered("pages", "固定 7 页", "2026-11-14T10:00:00.000Z", { status: "interrupted" })],
    ["pending", answered("pages", "固定 7 页", "2026-11-14T10:00:00.000Z", { status: "pending" })],
    ["expired", answered("pages", "固定 7 页", "2026-11-14T10:00:00.000Z", { contextEpochId: "epoch-old" })],
    ["without an epoch", answered("pages", "固定 7 页", "2026-11-14T10:00:00.000Z", { contextEpochId: undefined })],
  ];
  for (const [name, row] of cases) {
    it(`ignores a ${name} answer`, (t) => {
      const root = project(t, [row]);
      assert.deepEqual(effectivePageCountRequirement(root, BRIEF, EPOCH), {
        kind: "unspecified",
      });
      assert.equal(mismatch(root, 6), undefined);
      assert.equal(mismatch(root, 8), undefined);
    });
  }

  it("ignores every answer when the caller cannot name the current epoch", (t) => {
    const root = project(t, [answered("pages", "固定 7 页", "2026-11-14T10:00:00.000Z")]);
    assert.deepEqual(effectivePageCountRequirement(root, BRIEF), { kind: "unspecified" });
  });

  it("falls back to the brief when the answered question was later re-asked and cancelled", (t) => {
    const root = project(
      t,
      [
        answered("pages", "固定 7 页", "2026-11-14T10:00:00.000Z", { id: "row-a" }),
        {
          id: "row-b",
          at: "2026-11-14T10:05:00.000Z",
          status: "cancelled",
          contextEpochId: EPOCH,
          questions: [{ id: "pages" }],
        },
      ],
      [{ at: "2026-11-14T09:00:00.000Z", mode: "generate", text: "固定 8 页协作流程介绍" }],
    );
    assert.deepEqual(effectivePageCountRequirement(root, "固定 8 页协作流程介绍", EPOCH), {
      kind: "exact",
      count: 8,
    });
  });

  it("ignores answers about something other than the total", (t) => {
    const root = project(t, [answered("tone", "正式风格", "2026-11-14T10:00:00.000Z")]);
    assert.deepEqual(effectivePageCountRequirement(root, "固定 5 页", EPOCH), {
      kind: "exact",
      count: 5,
    });
  });

  it("does not let an incremental answer such as 再加两页 reset the total", (t) => {
    const root = project(t, [
      answered("pages", "再加两页", "2026-11-14T10:05:00.000Z"),
      answered("older", "固定 5 页", "2026-11-14T10:00:00.000Z"),
    ]);
    assert.deepEqual(effectivePageCountRequirement(root, BRIEF, EPOCH), {
      kind: "exact",
      count: 5,
    });
  });
});
