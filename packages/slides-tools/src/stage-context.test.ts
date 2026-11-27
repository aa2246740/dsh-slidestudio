import assert from "node:assert/strict";
import test from "node:test";
import { DESIGN_CONTRACT_KIND, designContractCard } from "./design-contract.js";
import { directorBrief } from "./director-brief.js";
import { createSlideTools } from "./suite.js";
import { contextFor, makeProject, recordingPresentation, runtimeDeps } from "./testkit.js";

test("commit_design returns a compact design contract card read back from the committed state", async () => {
  const root = makeProject([]);
  const { presentation } = recordingPresentation((command) =>
    command.name === "commit_design"
      ? { payload: { adoptedSourceIds: ["material:brand"], userColors: ["#C8102E"], plannedPageIds: ["1_cover"] } }
      : {},
  );
  const tool = createSlideTools(runtimeDeps(presentation, { writerLease: false })).find(
    (def) => def.name === "commit_design",
  )!;
  const out = await tool.execute(
    { slidePlan: [{ pageId: "1_cover", title: "封面", layoutFamily: "cover", exhibits: [] }] },
    contextFor(root, { kind: "hub-run", id: "hub-run:s" }),
  );
  assert.equal(out.data.outcome, "committed");
  const card = out.data.designContract as Record<string, unknown>;
  assert.equal(card.kind, DESIGN_CONTRACT_KIND);
  assert.deepEqual(card.adoptedSourceIds, ["material:brand"]);
  assert.deepEqual(card.userColors, ["#C8102E"]);
  assert.deepEqual(card.palette, { primary: "#2563EB", text: "#111111", background: "#FFFFFF" });
  assert.deepEqual(card.typeScale, { title: 36, body: 18 });
  assert.ok((card.layoutRules as string[]).some((rule) => /4\.5:1/.test(rule)));
  assert.ok((card.layoutRules as string[]).some((rule) => /14px/.test(rule)));
  assert.ok(JSON.stringify(card).length < 1024, "the card stays compact");
});

test("write_todo results carry no design contract card", async () => {
  const root = makeProject([]);
  const tool = createSlideTools(runtimeDeps(recordingPresentation().presentation, { writerLease: false })).find(
    (def) => def.name === "write_todo",
  )!;
  const out = await tool.execute(
    { items: [{ pageId: "1_cover", title: "封面", layoutFamily: "cover", exhibits: [] }] },
    contextFor(root, { kind: "hub-run", id: "hub-run:s" }),
  );
  assert.equal(out.data.outcome, "committed");
  assert.equal("designContract" in out.data, false);
});

test("the design contract card tolerates an unreadable project", () => {
  const card = designContractCard("/nonexistent/slides-project", { adoptedSourceIds: "bad" });
  assert.deepEqual(card.palette, {});
  assert.deepEqual(card.adoptedSourceIds, []);
  assert.equal(card.layoutRules.length, 5);
});

test("the director brief adds step-scope discipline and trims attachment rules only when told", () => {
  const full = directorBrief("季度经营复盘，10 页");
  assert.match(full, /Step scope: each step decides only what the next tool call needs/);
  assert.match(full, /leave per-slide element choices .* to that page's write_page/);
  assert.match(full, /Decide each attached PPTX separately/);
  assert.doesNotMatch(full, /patch_page_elements/, "no patch advice unless the host offers the tool");
  const slim = directorBrief("季度经营复盘，10 页", undefined, { hasAttachments: false, patchPageElements: true });
  assert.doesNotMatch(slim, /Decide each attached PPTX|designAspects as/);
  assert.match(slim, /author every page for this brief/);
  assert.match(slim, /call patch_page_elements with its pageSha256 instead of rewriting the whole page/);
  const trimmed = full.length - directorBrief("季度经营复盘，10 页", undefined, { hasAttachments: false }).length;
  assert.ok(trimmed > 900, `trimmed ${trimmed} chars`);
  assert.equal(directorBrief("x", undefined, { hasAttachments: true }), directorBrief("x"));
});
