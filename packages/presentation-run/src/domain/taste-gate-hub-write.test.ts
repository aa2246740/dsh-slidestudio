import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import { createPresentationRun } from "../run.js";
import { ensureRunLedger, inspectRunLedger, persistPresentationRunProvider } from "../index.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const SLIDE_PLAN = [
  { pageId: "cover", title: "残缺污损人民币兑换全行讲解", layoutFamily: "cover", exhibits: [] },
  { pageId: "agenda", title: "宣讲五段", layoutFamily: "toc", exhibits: [] },
  { pageId: "flow", title: "临柜分流", layoutFamily: "process-diagram", exhibits: [] },
  { pageId: "risk", title: "红线", layoutFamily: "decision", exhibits: [] },
  { pageId: "close", title: "收口", layoutFamily: "conclusion", exhibits: [] },
  { pageId: "notes", title: "备查", layoutFamily: "appendix", exhibits: [] },
];

describe("Hub template path: commit_design then write_page", () => {
  it("commits the plan from slidePlan and persists a pack-color cover", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "taste-hub-write-"));
    createEmptyProject(root, { title: "宣讲会" });
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "_agent", "runtime.json"),
      `${JSON.stringify({
        brief: "全行宣讲会",
        designSystemId: "finance/honey-orange-memo",
        strictExecution: true,
      })}\n`,
    );
    fs.writeFileSync(
      path.join(root, "_agent", "presentation-run.v1.json"),
      `${JSON.stringify({ provider: { providerId: "pi-xai", modelId: "test-model" } })}\n`,
    );
    persistPresentationRunProvider(root, {
      providerId: "pi-xai",
      modelId: "test-model",
      ready: true,
      modelInputModalities: ["text"],
    });
    ensureRunLedger(root, {
      manifestSha256: "d".repeat(64),
      requirementsId: "req-test",
      requirements: [],
    });

    const run = createPresentationRun({ repoRoot: REPO });
    const handle = await run.open({
      projectRoot: root,
      sessionId: "taste-hub-write",
      brief: "全行宣讲会",
      editorBaseUrl: "http://127.0.0.1:55200",
      design: { kind: "explicit-style", designSystemId: "finance/honey-orange-memo" },
      provider: { providerId: "pi-xai", modelId: "test-model" },
    });
    const ctx = (toolCallId: string) => ({
      runId: handle.runId,
      sessionId: handle.sessionId,
      toolCallId,
      projectRoot: root,
      abortSignal: new AbortController().signal,
    });

    const committed = await run.execute({ name: "commit_design", args: { slidePlan: SLIDE_PLAN } }, ctx("commit-1"));
    assert.equal(committed.ok, true, committed.detail);
    assert.equal(
      fs.existsSync(path.join(root, "_agent", "design-contract.v1.json")),
      false,
      "Hub commit_design must not mint a Pi design-contract visa",
    );

    const written = await run.execute(
      {
        name: "write_page",
        args: {
          id: "cover",
          pageType: "cover",
          background: { type: "solid", color: "#FAF8F6" },
          elements: [
            {
              elementId: "rail",
              elementType: "shape",
              shapeName: "rect",
              bounds: [0, 0, 10, 540],
              fill: { type: "solid", color: "#FF5703" },
              layoutRole: "decoration",
            },
            {
              elementId: "title",
              elementType: "text",
              bounds: [48, 48, 720, 72],
              content: {
                text: "残缺污损人民币兑换全行讲解",
                fontSize: 28,
                color: "#172856",
                fontFamily: { latin: "Liter", ea: "MiSans" },
                bold: true,
                align: ["left", "middle"],
                wrap: true,
              },
              layoutRole: "title",
            },
          ],
        },
      },
      ctx("write-1"),
    );
    assert.equal(written.ok, true, written.detail);
    const project = loadProject(root);
    assert.ok(
      project.pages.some((page) => path.basename(page.path, ".page") === "cover"),
      `cover page missing; pages=${project.pages.map((page) => path.basename(page.path)).join(",")}`,
    );
    const compose = inspectRunLedger(root, handle.sessionId);
    assert.equal(
      compose.composeBlockers.some((blocker) => blocker.includes("design contract")),
      false,
      compose.composeBlockers.join("; "),
    );
  });
});
