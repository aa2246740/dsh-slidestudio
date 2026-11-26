import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { persistPageKey } from "./page-identity.js";
import { ensureRunLedger, readRunLedger, type TodoFact } from "./run-ledger.js";

const CONTEXT = { commandId: "page-count-fixture", contextEpochId: "page-count-epoch" };

type PageInput = Readonly<{
  id: string;
  pageType: string;
  elements: readonly unknown[];
}>;

function page(id: string): PageInput {
  return {
    id,
    pageType: "content",
    elements: [
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 40, 800, 60],
        content: { text: `合成页面 ${id}`, fontSize: 28, color: "#111111" },
      },
      {
        elementId: "body",
        elementType: "text",
        bounds: [80, 160, 800, 200],
        content: {
          text: "本页只验证页数、页序和计划身份，不使用任何真实资料。",
          fontSize: 20,
          color: "#111111",
        },
      },
    ],
  };
}

function planItem(pageId: string, purpose?: string) {
  return {
    pageId,
    title: `合成页面 ${pageId}`,
    layoutFamily: "content",
    exhibits: ["none"],
    ...(purpose ? { purpose } : {}),
  };
}

function pageIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `p${String(index + 1).padStart(2, "0")}`);
}

function fixture(t: TestContext, brief: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-count-delivery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "合成页数交付" });
  writeDomainRuntime(root, { brief });
  persistPresentationRunProvider(root, {
    providerId: "offline",
    modelId: "fixture",
    ready: true,
    modelInputModalities: ["text"],
  });
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
  });
  return root;
}

function call(root: string, name: string, args: Record<string, unknown> = {}) {
  return runDomainHand(name, { ...args, __openSlideStudio: CONTEXT }, root);
}

async function planPages(root: string, brief: string, ids: readonly string[], purposes: readonly string[] = []) {
  return call(root, "write_todo", {
    items: ids.map((id, index) => planItem(id, purposes[index])),
  });
}

async function writePages(root: string, ids: readonly string[], order = ids) {
  for (const id of order) {
    const written = await call(root, "write_page", page(id));
    assert.equal(written.ok, true, written.detail);
  }
}

function payload(result: { payload: unknown }): Record<string, unknown> {
  assert.ok(result.payload && typeof result.payload === "object");
  return result.payload as Record<string, unknown>;
}

function diskIds(root: string): string[] {
  return loadProject(root).pages.map((entry) => persistPageKey(entry.path));
}

function committedPlan(root: string): TodoFact {
  const fact = [...(readRunLedger(root)?.facts ?? [])]
    .reverse()
    .find((item): item is TodoFact => item.type === "todo.committed");
  assert.ok(fact, "a todo.committed fact is required");
  return fact;
}

it("exact 7 composes only seven pages and persists the planned order after out-of-order writes", async (t) => {
  const root = fixture(t, "固定 7 页协作流程介绍。");
  const ids = pageIds(7);
  const purposes = [
    "第 1 页给出结论",
    "第 2 页给出证据",
    "第 3 页解释方法",
    "第 4 页列出风险",
    "第 5 页给出计划",
    "第 6 页列出资源",
    "第 7 页提出行动",
  ];
  assert.equal((await planPages(root, "固定 7 页协作流程介绍。", ids, purposes)).ok, true);
  await writePages(root, ids, [ids[6]!, ids[1]!, ids[4]!, ids[0]!, ids[3]!, ids[2]!, ids[5]!]);
  assert.deepEqual(diskIds(root), [ids[6], ids[1], ids[4], ids[0], ids[3], ids[2], ids[5]]);
  const reviewed = await call(root, "review_pages");
  assert.equal(reviewed.ok, true, reviewed.detail);
  const composed = await call(root, "compose_deck", { title: "合成页数交付" });
  assert.equal(composed.ok, true, composed.detail);
  assert.deepEqual(diskIds(root), ids);
  assert.equal(payload(composed).pageCount, 7);
  assert.deepEqual(
    (payload(composed).pages as { id: string }[]).map((entry) => entry.id),
    ids,
  );
  assert.deepEqual(
    committedPlan(root).pagePlan?.map((entry) => entry.purpose),
    purposes,
  );
});

it("exact 7 refuses a six- or eight-page plan instead of accepting a minimum", async (t) => {
  for (const count of [6, 8]) {
    const root = fixture(t, "固定 7 页协作流程介绍。");
    const planned = await planPages(root, "固定 7 页协作流程介绍。", pageIds(count));
    assert.equal(planned.ok, false, planned.detail);
    assert.equal(payload(planned).error, "page_count_mismatch");
    assert.doesNotMatch(planned.detail, /pages planned/);
    assert.equal(
      (readRunLedger(root)?.facts ?? []).some((fact) => fact.type === "todo.committed"),
      false,
      "a rejected plan must not be committed",
    );
  }
});

it("an explicit 6-8 range refuses 5 and 9 and composes an eight-page deck", async (t) => {
  const brief = "6 到 8 页协作流程介绍。";
  for (const count of [5, 9]) {
    const root = fixture(t, brief);
    const planned = await planPages(root, brief, pageIds(count));
    assert.equal(planned.ok, false, planned.detail);
    assert.equal(payload(planned).error, "page_count_mismatch");
  }
  const root = fixture(t, brief);
  const ids = pageIds(8);
  assert.equal((await planPages(root, brief, ids)).ok, true);
  await writePages(root, ids);
  const reviewed = await call(root, "review_pages");
  assert.equal(reviewed.ok, true, reviewed.detail);
  const composed = await call(root, "compose_deck", { title: "合成页数交付" });
  assert.equal(composed.ok, true, composed.detail);
  assert.equal(payload(composed).pageCount, 8);
});

it("approximate 7 composes six and eight pages without treating either as a count violation", async (t) => {
  for (const count of [6, 8]) {
    const brief = "约 7 页协作流程介绍。";
    const root = fixture(t, brief);
    const ids = pageIds(count);
    const planned = await planPages(root, brief, ids);
    assert.equal(planned.ok, true, planned.detail);
    await writePages(root, ids);
    const reviewed = await call(root, "review_pages");
    assert.equal(reviewed.ok, true, reviewed.detail);
    const composed = await call(root, "compose_deck", { title: "合成页数交付" });
    assert.equal(composed.ok, true, composed.detail);
    assert.equal(payload(composed).pageCount, count);
  }
});

it("unspecified keeps reference counts out of the target and composes the planned two pages", async (t) => {
  const brief = "参考稿有 12 页，Markdown 有 9 个内容块，做一份协作流程介绍。";
  const root = fixture(t, brief);
  const ids = pageIds(2);
  const planned = await planPages(root, brief, ids, ["第 1 页结论", "第 2 页证据"]);
  assert.equal(planned.ok, true, planned.detail);
  assert.equal(committedPlan(root).pagePlan?.length, 2);
  await writePages(root, ids, [ids[1]!, ids[0]!]);
  const reviewed = await call(root, "review_pages");
  assert.equal(reviewed.ok, true, reviewed.detail);
  const composed = await call(root, "compose_deck", { title: "合成页数交付" });
  assert.equal(composed.ok, true, composed.detail);
  assert.deepEqual(diskIds(root), ids);
});

it("uses an accepted page-count answer for the plan, not only for compose", async (t) => {
  const brief = "先问我需要几页，再做协作流程介绍。";
  const root = fixture(t, brief);
  fs.writeFileSync(
    path.join(root, "_agent", "assistant-conversation.v1.json"),
    JSON.stringify({
      version: 1,
      messages: [
        { mode: "generate", text: brief },
        { mode: "generate", text: "7 页" },
      ],
    }),
  );
  const rejected = await planPages(root, brief, pageIds(6));
  assert.equal(rejected.ok, false, rejected.detail);
  assert.equal(payload(rejected).error, "page_count_mismatch");
  const ids = pageIds(7);
  assert.equal((await planPages(root, brief, ids)).ok, true);
  await writePages(root, ids);
  const reviewed = await call(root, "review_pages");
  assert.equal(reviewed.ok, true, reviewed.detail);
  const composed = await call(root, "compose_deck", { title: "合成页数交付" });
  assert.equal(composed.ok, true, composed.detail);
  assert.equal(payload(composed).pageCount, 7);
});

function recordPageCountAnswer(root: string, label: string, overrides: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(root, "_agent", "assistant-questions.v1.json"),
    JSON.stringify([
      {
        id: "pages-row",
        at: "2026-11-14T10:00:00.000Z",
        status: "answered",
        contextEpochId: CONTEXT.contextEpochId,
        questions: [{ id: "pages" }],
        answer: { answers: [{ id: "pages", selected: [label] }] },
        answeredAt: "2026-11-14T10:01:00.000Z",
        ...overrides,
      },
    ]),
  );
}

it("a native question answered with a fixed total constrains plan, compose and delivery", async (t) => {
  const brief = "做协作流程介绍，页数请先问我。";
  const root = fixture(t, brief);
  recordPageCountAnswer(root, "固定 7 页", {});
  for (const count of [6, 8]) {
    const rejected = await planPages(root, brief, pageIds(count));
    assert.equal(rejected.ok, false, rejected.detail);
    assert.equal(payload(rejected).error, "page_count_mismatch");
  }
  const ids = pageIds(7);
  assert.equal((await planPages(root, brief, ids)).ok, true);
  await writePages(root, ids);
  const reviewed = await call(root, "review_pages");
  assert.equal(reviewed.ok, true, reviewed.detail);
  const composed = await call(root, "compose_deck", { title: "合成页数交付" });
  assert.equal(composed.ok, true, composed.detail);
  assert.equal(payload(composed).pageCount, 7);
});

it("a later answer of 7 replaces the 8 pages the first message asked for", async (t) => {
  const brief = "固定 8 页协作流程介绍。";
  const root = fixture(t, brief);
  fs.writeFileSync(
    path.join(root, "_agent", "assistant-conversation.v1.json"),
    JSON.stringify({
      version: 1,
      messages: [{ at: "2026-11-14T09:00:00.000Z", mode: "generate", text: brief }],
    }),
  );
  recordPageCountAnswer(root, "固定 7 页", {});
  const eight = await planPages(root, brief, pageIds(8));
  assert.equal(eight.ok, false, eight.detail);
  assert.equal(payload(eight).error, "page_count_mismatch");
  assert.equal((await planPages(root, brief, pageIds(7))).ok, true);
});

it("a cancelled or expired answer leaves the plan unconstrained", async (t) => {
  const brief = "做协作流程介绍，页数请先问我。";
  for (const overrides of [{ status: "cancelled" }, { contextEpochId: "earlier-epoch" }]) {
    const root = fixture(t, brief);
    recordPageCountAnswer(root, "固定 7 页", overrides);
    const planned = await planPages(root, brief, pageIds(5));
    assert.equal(planned.ok, true, planned.detail);
  }
});

it("missing, duplicate and unplanned page identities cannot be reported as complete", async (t) => {
  const brief = "固定 7 页协作流程介绍。";
  const root = fixture(t, brief);
  const ids = pageIds(7);
  assert.equal((await planPages(root, brief, ids)).ok, true);
  await writePages(root, ids.slice(0, 6));
  const reviewed = await call(root, "review_pages");
  assert.equal(reviewed.ok, false, reviewed.detail);
  assert.deepEqual(payload(reviewed).missing, [ids[6]]);
  const composed = await call(root, "compose_deck", { title: "合成页数交付" });
  assert.equal(composed.ok, false, composed.detail);

  const duplicate = await call(root, "write_todo", {
    items: [planItem("p01"), planItem("p01")],
  });
  assert.equal(duplicate.ok, false, duplicate.detail);
  assert.match(duplicate.detail, /duplicate canonical page ids/);

  const unplanned = await call(root, "write_page", page("p99"));
  assert.equal(unplanned.ok, false, unplanned.detail);
  assert.equal(payload(unplanned).error, "not_in_plan");
});

it("a reference count never reaches the production plan: fixed 7 refuses 6 and 8, and a reference range is no range", async (t) => {
  const fixed = "固定 7 页协作流程介绍，参考稿为约 12 页。";
  for (const count of [6, 8, 12]) {
    const root = fixture(t, fixed);
    const planned = await planPages(root, fixed, pageIds(count));
    assert.equal(planned.ok, false, `${count}: ${planned.detail}`);
    assert.equal(payload(planned).error, "page_count_mismatch");
    assert.match(planned.detail, /固定 7 页/);
  }
  const accepted = fixture(t, fixed);
  assert.equal((await planPages(accepted, fixed, pageIds(7))).ok, true);

  const referenceOnly = "协作流程介绍，参考稿为 6–8 页，按当前业务内容重新组织。";
  for (const count of [5, 9]) {
    const root = fixture(t, referenceOnly);
    const ids = pageIds(count);
    const planned = await planPages(root, referenceOnly, ids);
    assert.equal(planned.ok, true, `${count}: ${planned.detail}`);
    await writePages(root, ids);
    const reviewed = await call(root, "review_pages");
    assert.equal(reviewed.ok, true, reviewed.detail);
    const composed = await call(root, "compose_deck", { title: "合成页数交付" });
    assert.equal(composed.ok, true, `${count}: ${composed.detail}`);
    assert.equal(payload(composed).pageCount, count);
  }
});
