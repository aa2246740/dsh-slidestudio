import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { projectDeliveryIssue } from "./delivery-note.mjs";
import { buildSystemDeliveryNote, cleanupScratchRoots, projectCopy } from "./delivery-note-test-fixture.mjs";

afterEach(cleanupScratchRoots);

const fault = { code: "CONTEXT_BUDGET_EXCEEDED", detail: "Synthetic post-seal budget fault." };

describe("delivery issue projection", () => {
  it("turns a fault after completion into a sealed delivery issue", () => {
    assert.deepEqual(projectDeliveryIssue({ activityPhase: "complete", fault, inspection: { composed: true } }), {
      ...fault,
      sealed: true,
    });
    assert.deepEqual(projectDeliveryIssue({ activityPhase: "complete", fault, inspection: {} }), {
      ...fault,
      sealed: false,
    });
  });

  it("leaves running, paused, recovering, guarded and quota-wait faults alone", () => {
    assert.equal(projectDeliveryIssue({ activityPhase: "working", fault }), undefined);
    assert.equal(projectDeliveryIssue({ activityPhase: "complete", fault: { ...fault, recovering: true } }), undefined);
    for (const code of ["provider-quota", "provider-rate-limit", "tool-invalid-args-loop"]) {
      assert.equal(projectDeliveryIssue({ activityPhase: "complete", fault: { code, detail: "x" } }), undefined, code);
    }
    assert.equal(projectDeliveryIssue({ activityPhase: "complete", fault: { code: "x" } }), undefined);
    assert.equal(projectDeliveryIssue({ activityPhase: "complete", fault: null }), undefined);
  });

  it("feeds the sealed summary card of a composed project", () => {
    const projectRoot = projectCopy("24-page");
    const deliveryIssue = projectDeliveryIssue({
      activityPhase: "complete",
      fault,
      inspection: { composed: true },
    });
    const note = buildSystemDeliveryNote({ projectRoot, deliveryIssue });
    assert.equal(note.title, "系统整理的交付摘要（根据生成记录自动整理，不是智能助手写的说明）");
    assert.equal(note.lines[0], "页数：24 页，全部写入；24 页通过页面检查。");
    assert.equal(buildSystemDeliveryNote({ projectRoot }), undefined, "no provenance, no issue");
  });
});
