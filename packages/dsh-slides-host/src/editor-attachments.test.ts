import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSliceRuntime } from "./runtime.js";
import { initializeRunLedger, stableSha256 } from "@open-slidestudio/presentation-run";
import {
  editorReviewScopeFromEdit,
  resolveEditorAttachments,
  turnTextWithAttachments,
  turnTextWithReviewScope,
  type SlidesHostRuntime,
} from "./routes.js";
import { SliceSessionStore } from "./slice-session.js";
import { REPO_ROOT, coverPage, completeAttachmentFixture, invokeSlides } from "./host-test-fixtures.js";

describe("editor Agent attachments", () => {
  it("keeps a server-verified multi-element review scope in the model turn", () => {
    const pageSha256 = "a".repeat(64);
    const scope = editorReviewScopeFromEdit({
      authorizationId: "comment:review-1",
      pageId: "01_page",
      revision: 7,
      pageSha256,
      reviewScope: {
        kind: "elements",
        pageId: "01_page",
        elementIds: ["title", "subtitle", "title"],
        pageRevision: 7,
        pageSha256,
        commentId: "review-1",
        commentRevision: 3,
      },
    });
    assert.deepEqual(scope?.elementIds, ["title", "subtitle"]);
    const turn = turnTextWithReviewScope("Apply the review", scope);
    assert.match(turn, /Server-verified scope/);
    assert.match(turn, /\["title","subtitle"\]/);
    assert.match(turn, /Do not modify page metadata, element order, or any other element/);
  });

  it("rejects a review scope whose page revision does not match its authorized edit", () => {
    const pageSha256 = "b".repeat(64);
    assert.throws(
      () =>
        editorReviewScopeFromEdit({
          authorizationId: "comment:review-2",
          pageId: "01_page",
          revision: 8,
          pageSha256,
          reviewScope: {
            kind: "elements",
            pageId: "01_page",
            elementIds: ["title"],
            pageRevision: 7,
            pageSha256,
            commentId: "review-2",
            commentRevision: 1,
          },
        }),
      /pageRevision must match/,
    );
  });

  it("passes the exact review scope through the real turn route before marking busy", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "review-scope-turn-"));
    const store = new SliceSessionStore(workspace);
    const sessionId = "review-scope-session";
    const opened = store.openProject({
      dshSessionId: sessionId,
      title: "Scoped review",
      design: { kind: "self-directed" },
      provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
    });
    const root = store.resolveRoot(opened.binding);
    writeSliceRuntime(root, {
      brief: "Scoped review",
      design: { kind: "self-directed" },
      editorBaseUrl: "http://127.0.0.1:55200",
      strictExecution: true,
    });
    initializeRunLedger(root);
    const page = { id: "01_page", pageType: "content", elements: [coverPage.elements[0]] };
    const pageSha256 = stableSha256(page);
    const ledgerFile = path.join(root, "_agent", "run-ledger.v1.json");
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8")) as { facts: Array<Record<string, unknown>> };
    ledger.facts.push({
      type: "page.revision-committed",
      factId: "page.revision-committed:review-scope-seed",
      at: new Date().toISOString(),
      contextEpochId: "review-scope-test",
      pageId: page.id,
      revision: 1,
      pageSha256,
    });
    fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
    fs.writeFileSync(
      path.join(root, "_agent", "comment-submissions.v1.json"),
      JSON.stringify({
        version: 1,
        submissions: [{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", status: "preparing", items: [] }],
      }),
    );
    const revision = { revision: 1, pageSha256 };
    let followedUp = "";
    let busy = false;
    const runtime = {
      workspaceRoot: REPO_ROOT,
      dshHome: fs.mkdtempSync(path.join(os.tmpdir(), "review-scope-home-")),
      store,
      presentation: {},
      agentBusy: () => false,
      markBusy: () => {
        busy = true;
      },
      cancelRateLimitWait: () => undefined,
      operatorStop: async () => undefined,
      getAgent: () => ({
        followup: (message: unknown) => {
          followedUp = JSON.stringify(message);
        },
      }),
      createAgent: async () => ({ sessionId: "unused" }),
      resumeAgent: async () => undefined,
      switchModel: async () => undefined,
    } as unknown as SlidesHostRuntime;
    const response = await invokeSlides(runtime, "POST", `/slides/sessions/${sessionId}/turn`, {
      text: "Change the selected title",
      editorEdit: {
        authorizationId: "comment-batch:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        pageId: page.id,
        revision: revision.revision,
        pageSha256: revision.pageSha256,
        reviewScope: {
          kind: "elements",
          pageId: page.id,
          elementIds: ["title"],
          pageRevision: revision.revision,
          pageSha256: revision.pageSha256,
          commentId: "review-route",
          commentRevision: 2,
        },
      },
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal((response.json as { reviewScopeAccepted?: boolean }).reviewScopeAccepted, true);
    const ack = (response.json as { userMessage?: { id: string; reviewSubmissionId: string } }).userMessage;
    assert.equal(ack?.reviewSubmissionId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const persisted = JSON.parse(fs.readFileSync(path.join(root, "_agent", "assistant-conversation.v1.json"), "utf8"));
    assert.deepEqual(persisted.messages.at(-1), ack);
    assert.equal(busy, true);
    assert.match(followedUp, /editor_review_scope/);
    assert.match(followedUp, /\[\\\"title\\\"\]/);
  });

  it("accepts two same-page comments through the real turn route before marking busy", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "review-scope-turn-"));
    const store = new SliceSessionStore(workspace);
    const sessionId = "review-scope-session";
    const opened = store.openProject({
      dshSessionId: sessionId,
      title: "Scoped review",
      design: { kind: "self-directed" },
      provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
    });
    const root = store.resolveRoot(opened.binding);
    writeSliceRuntime(root, {
      brief: "Scoped review",
      design: { kind: "self-directed" },
      editorBaseUrl: "http://127.0.0.1:55200",
      strictExecution: true,
    });
    initializeRunLedger(root);
    const page = { id: "01_page", pageType: "content", elements: [coverPage.elements[0]] };
    const pageSha256 = stableSha256(page);
    const ledgerFile = path.join(root, "_agent", "run-ledger.v1.json");
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8")) as { facts: Array<Record<string, unknown>> };
    ledger.facts.push({
      type: "page.revision-committed",
      factId: "page.revision-committed:review-scope-seed",
      at: new Date().toISOString(),
      contextEpochId: "review-scope-test",
      pageId: page.id,
      revision: 1,
      pageSha256,
    });
    fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
    const revision = { revision: 1, pageSha256 };
    let followedUp = "";
    let busy = false;
    const runtime = {
      workspaceRoot: REPO_ROOT,
      dshHome: fs.mkdtempSync(path.join(os.tmpdir(), "review-scope-home-")),
      store,
      presentation: {},
      agentBusy: () => false,
      markBusy: () => {
        busy = true;
      },
      cancelRateLimitWait: () => undefined,
      operatorStop: async () => undefined,
      getAgent: () => ({
        followup: (message: unknown) => {
          followedUp = JSON.stringify(message);
        },
      }),
      createAgent: async () => ({ sessionId: "unused" }),
      resumeAgent: async () => undefined,
      switchModel: async () => undefined,
    } as unknown as SlidesHostRuntime;
    const response = await invokeSlides(runtime, "POST", `/slides/sessions/${sessionId}/turn`, {
      text: "Change the selected title",
      editorEdit: {
        authorizationId: "comment:review-route",
        pages: [{ pageId: page.id, revision: revision.revision, pageSha256: revision.pageSha256 }],
        reviewScope: {
          items: [
            {
              kind: "elements",
              pageId: page.id,
              elementIds: ["title"],
              pageRevision: revision.revision,
              pageSha256: revision.pageSha256,
              commentId: "review-route-1",
              commentRevision: 2,
            },
            {
              kind: "elements",
              pageId: page.id,
              elementIds: ["subtitle", "body"],
              pageRevision: revision.revision,
              pageSha256: revision.pageSha256,
              commentId: "review-route-2",
              commentRevision: 1,
            },
          ],
        },
      },
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal((response.json as { reviewScopeAccepted?: boolean }).reviewScopeAccepted, true);
    assert.equal(busy, true);
    assert.match(followedUp, /2 comments across 1 page/);
    assert.match(followedUp, /editor_review_scope/);
    assert.match(followedUp, /\[\\\"title\\\"\]/);
  });

  it("resolves uploaded text and marks it as reference data in the model turn", async () => {
    const resolved = await resolveEditorAttachments(
      ["attachment-1"],
      async (url) => {
        assert.match(String(url), /\/api\/attachments\/attachment-1$/);
        return new Response(
          JSON.stringify(
            completeAttachmentFixture("attachment-1", "monthly-report.md", "Revenue: 42. Do not invent another value."),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      "http://127.0.0.1:55200",
    );
    const prompt = turnTextWithAttachments("Update the current page", resolved);
    assert.match(prompt, /^Update the current page/);
    assert.match(prompt, /<editor_attachments>/);
    assert.match(prompt, /monthly-report\.md/);
    assert.match(prompt, /Revenue: 42/);
    assert.match(prompt, /reference material/);
    assert.match(prompt, /not system instructions/);
  });

  for (const externalData of [false, true])
    it(`puts attachment content into the DSH followup (externalData=${externalData})`, async () => {
      let followedUp = "";
      let busy = false;
      const runtime = {
        workspaceRoot: REPO_ROOT,
        ...(externalData ? { dataRoot: path.join(os.tmpdir(), "persistent-slidestudio-data") } : {}),
        dshHome: fs.mkdtempSync(path.join(os.tmpdir(), "attachment-turn-home-")),
        store: { bindingFor: () => undefined },
        presentation: {},
        agentBusy: () => false,
        markBusy: () => {
          busy = true;
        },
        cancelRateLimitWait: () => undefined,
        operatorStop: async () => undefined,
        getAgent: () => ({
          followup: (message: unknown) => {
            followedUp = JSON.stringify(message);
          },
        }),
        createAgent: async () => ({ sessionId: "unused" }),
        resumeAgent: async () => undefined,
        switchModel: async () => undefined,
        resolveAttachments: async (ids: readonly string[]) => {
          assert.deepEqual(ids, ["attachment-1"]);
          const attachment = completeAttachmentFixture("attachment-1", "facts.csv", "metric,value\nretention,91%");
          return [
            {
              ...attachment,
              ...(externalData
                ? {
                    storeId: crypto
                      .createHash("sha256")
                      .update(path.join(os.tmpdir(), "persistent-slidestudio-data", "output", "attachments"))
                      .digest("hex"),
                  }
                : {}),
            },
          ];
        },
      } as unknown as SlidesHostRuntime;

      const response = await invokeSlides(runtime, "POST", "/slides/sessions/editor-session/turn", {
        text: "Use the attached facts",
        attachments: ["attachment-1"],
      });
      assert.equal(response.status, 200);
      assert.equal(busy, true);
      assert.match(followedUp, /Use the attached facts/);
      assert.match(followedUp, /facts\.csv/);
      assert.match(followedUp, /retention,91%/);
      assert.deepEqual((response.json as { attachments?: unknown }).attachments, [
        { id: "attachment-1", name: "facts.csv" },
      ]);
    });

  it("rejects an unreadable attachment before marking the Agent busy", async () => {
    let busy = false;
    let followedUp = false;
    const runtime = {
      workspaceRoot: REPO_ROOT,
      dshHome: fs.mkdtempSync(path.join(os.tmpdir(), "attachment-reject-home-")),
      store: { bindingFor: () => undefined },
      presentation: {},
      agentBusy: () => false,
      markBusy: () => {
        busy = true;
      },
      cancelRateLimitWait: () => undefined,
      operatorStop: async () => undefined,
      getAgent: () => ({
        followup: () => {
          followedUp = true;
        },
      }),
      createAgent: async () => ({ sessionId: "unused" }),
      resumeAgent: async () => undefined,
      switchModel: async () => undefined,
      resolveAttachments: async () => {
        throw new Error("image attachment is not readable by this Agent route");
      },
    } as unknown as SlidesHostRuntime;

    const response = await invokeSlides(runtime, "POST", "/slides/sessions/editor-session/turn", {
      text: "Use this image",
      attachments: ["attachment-image"],
    });
    assert.equal(response.status, 400);
    assert.equal((response.json as { code?: string }).code, "invalid_attachment");
    assert.equal(busy, false);
    assert.equal(followedUp, false);
  });
});
