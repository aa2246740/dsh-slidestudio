import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { createPresentationRun } from "../run.js";
import { readMaterialResult } from "./material-hands.js";
import { writeDomainRuntime } from "./domain-hands.js";
import { imageFixture, tempProject, writeMaterialFixture } from "./material-testkit.js";
import { ensureRunLedger } from "./run-ledger.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PROVIDER = { providerId: "pi-xai", modelId: "test-model" };
const CONTEXT = { commandId: "read-image-hint", contextEpochId: "epoch-image-hint" };
const VISION_LINE = "画面内容：调用 view_material 查看（需要模型支持看图）；write_page 可用 mediaSrc 直接放到页面";
const TEXT_ONLY_LINE =
  "画面内容：当前模型不能看图，无法查看画面；只知道颜色、尺寸和朝向等元信息。write_page 仍可用 mediaSrc 放到页面";

/** Record the selected model's declared input modalities on the binding file, as the Hub does. */
function persistModalities(root: string, modelInputModalities: ("text" | "image")[]): void {
  assert.equal(persistPresentationRunProvider(root, { ...PROVIDER, ready: true, modelInputModalities }), true);
}

/** A binding file that holds only the provider, for reads that open no run. */
function bindModalities(root: string, modelInputModalities: ("text" | "image")[]): void {
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "presentation-run.v1.json"),
    `${JSON.stringify({ provider: PROVIDER })}\n`,
  );
  persistModalities(root, modelInputModalities);
}

/** A picture with extracted accents, so its palette part is usable as a design source. */
function paletteImageFixture() {
  return imageFixture("img1", "brand-shot.png", 1200, 800, {
    derivative: {
      image: {
        width: 1200,
        height: 800,
        orientation: "landscape",
        format: "png",
        styleProfile: {
          schema: "style-profile/v1",
          source: "image-pixels",
          accentColors: [
            { hex: "#C00000", share: 0.3 },
            { hex: "#7A1F1F", share: 0.08 },
          ],
          neutralColors: [{ hex: "#FFFFFF" }, { hex: "#F2F2F2" }],
          background: "#FFFFFF",
          contrastPairs: [{ fg: "#C00000", bg: "#FFFFFF", ratio: 6.5 }],
        },
      },
    },
  });
}

function imageRoot(t: TestContext): string {
  const root = tempProject("oss-image-hint-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeMaterialFixture(root, imageFixture("img1", "brand-shot.png", 1200, 800));
  ensureRunLedger(root, {
    manifestSha256: "f".repeat(64),
    requirementsId: "image-hint",
    requirements: [],
  });
  return root;
}

describe("read_material on an image names view_material only for a vision model", () => {
  it("a text-only model gets no view_material and a Chinese line that the picture cannot be viewed", (t) => {
    const root = imageRoot(t);
    bindModalities(root, ["text"]);
    const read = readMaterialResult(root, CONTEXT, { materialId: "img1" });
    const text = String((read.payload as { text: unknown }).text);
    assert.doesNotMatch(text, /view_material/);
    assert.doesNotMatch(read.detail, /view_material/);
    assert.ok(text.includes(`- ${TEXT_ONLY_LINE}`), text);
    assert.ok(!text.includes(VISION_LINE), text);
  });

  it("a vision model keeps the view_material hint unchanged", (t) => {
    const root = imageRoot(t);
    bindModalities(root, ["text", "image"]);
    const read = readMaterialResult(root, CONTEXT, { materialId: "img1" });
    const text = String((read.payload as { text: unknown }).text);
    assert.ok(text.includes(`- ${VISION_LINE}`), text);
    assert.doesNotMatch(text, /当前模型不能看图/);
  });
});

describe("the palette read that commit_design verifies uses the same capability", () => {
  for (const [label, modalities] of [
    ["text-only", ["text"]],
    ["vision", ["text", "image"]],
  ] as const) {
    it(`a ${label} palette read satisfies the commit_design preflight`, async (t) => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "image-hint-run-"));
      t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
      const projectRoot = path.join(temp, "project");
      createEmptyProject(projectRoot, { title: "产品说明" });
      writeMaterialFixture(projectRoot, paletteImageFixture());
      // strictExecution initializes the run ledger itself; a second ensureRunLedger would conflict.
      writeDomainRuntime(projectRoot, {
        brief: "给团队做一份产品说明。",
        designDirection: "self-directed",
        strictExecution: true,
      });
      const run = createPresentationRun({ repoRoot: REPO_ROOT });
      const handle = await run.open({
        projectRoot,
        sessionId: `image-hint-${label}`,
        brief: "给团队做一份产品说明。",
        editorBaseUrl: "http://127.0.0.1:55200",
        design: { kind: "self-directed" },
        provider: PROVIDER,
      });
      // open() writes the binding file, so the selected model's modalities are recorded after it.
      persistModalities(projectRoot, [...modalities]);
      const ctx = (toolCallId: string) => ({
        runId: handle.runId,
        sessionId: handle.sessionId,
        projectRoot,
        abortSignal: new AbortController().signal,
        toolCallId,
      });
      const commit = {
        name: "commit_design",
        args: {
          slidePlan: [{ pageId: "cover", title: "产品说明", layoutFamily: "cover", exhibits: [] }],
          adoptedSourceIds: ["material:img1"],
          designAspects: [{ source: "material:img1", aspects: ["palette"] }],
        },
      };
      // An image has one part (palette), so every unread img1 chunk is the palette chunk.
      const unreadPalette = (receipt: { payload: Record<string, unknown> }) =>
        ((receipt.payload.missingMaterialChunks ?? []) as { materialId: string }[]).filter(
          (chunk) => chunk.materialId === "img1",
        );
      const before = await run.execute(commit, ctx(`image-hint-${label}-before`));
      assert.equal(before.payload.error, "required_source_chunks_unread", before.detail);
      assert.equal(unreadPalette(before).length, 1, before.detail);
      const read = await run.execute(
        { name: "read_material", args: { materialId: "img1" } },
        ctx(`image-hint-${label}-read`),
      );
      assert.equal(read.ok, true, read.detail);
      // The palette chunk the reader recorded must be the one the preflight recomputes.
      const references = await run.execute(
        { name: "list_references", args: {} },
        ctx(`image-hint-${label}-references`),
      );
      const missing = references.payload.missingReferenceChunks as {
        sourceId: string;
        chunkIndex: number;
      }[];
      for (const chunk of missing) {
        const reference = await run.execute(
          {
            name: "read_reference",
            args: { sourceId: chunk.sourceId, chunkIndex: chunk.chunkIndex },
          },
          ctx(`image-hint-${label}-ref-${chunk.sourceId}-${chunk.chunkIndex}`),
        );
        assert.equal(reference.ok, true, reference.detail);
      }
      const after = await run.execute(commit, ctx(`image-hint-${label}-after`));
      assert.deepEqual(unreadPalette(after), [], after.detail);
      assert.equal(after.ok, true, after.detail);
    });
  }
});
