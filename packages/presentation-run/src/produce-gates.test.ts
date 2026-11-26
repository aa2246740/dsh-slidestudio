import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inspectProduceGates,
  assertProduceGates,
  PRODUCE_GATES_ID,
  PRODUCE_GATE_REL_FILES,
  type ProduceGateApi,
} from "./produce-gates.js";
import { visualReviewIsClaimable } from "./capabilities.js";
import {
  EMPTY_CLOSER_PRODUCE_NEXT,
  HOST_SEED_PRODUCE_NEXT,
  isPlaceholderReviewIssue,
  isWritePageCloser,
  pageCoverage,
  pageHasVisibleContent,
  persistPageKey,
  persistPagePathFromId,
  pageIdMatchesFile,
  tableEmptyCellIssues,
  writePageSchemaError,
  writePageSchemaIssues,
  composedPageLeftoverIssues,
  renderedLayoutBlocksCompose,
} from "./domain/layout-qa.js";
import { readMaterialChunk } from "./domain/material-content.js";
import { verifyMaterial, materialCapabilityEntries } from "./domain/material-pack.js";

const live: ProduceGateApi = {
  pageHasVisibleContent,
  pageCoverage,
  persistPageKey,
  persistPagePathFromId,
  pageIdMatchesFile,
  tableEmptyCellIssues,
  writePageSchemaIssues,
  writePageSchemaError,
  isWritePageCloser,
  visualReviewIsClaimable,
  isPlaceholderReviewIssue,
  composedPageLeftoverIssues,
  renderedLayoutBlocksCompose,
  verifyMaterial,
  readMaterialChunk,
  materialCapabilityEntries,
  EMPTY_CLOSER_PRODUCE_NEXT,
  HOST_SEED_PRODUCE_NEXT,
};

describe("produce gates fingerprint", () => {
  it("fingerprints the run and domain-hand integration points", () => {
    assert.ok(PRODUCE_GATE_REL_FILES.includes("packages/presentation-run/dist/run.js"));
    assert.ok(PRODUCE_GATE_REL_FILES.includes("packages/presentation-run/dist/domain/domain-hands.js"));
    assert.ok(PRODUCE_GATE_REL_FILES.includes("packages/presentation-run/dist/domain/agent-page-review.js"));
  });

  it("fingerprints the layout, pack-color and revision modules the produce path loads", () => {
    const listed = [
      "packages/presentation-run/dist/domain/layout-gates.js",
      "packages/presentation-run/dist/domain/layout-ledger.js",
      "packages/presentation-run/dist/domain/pack-color-context.js",
      "packages/presentation-run/dist/domain/page-layout-refusal.js",
      "packages/presentation-run/dist/domain/page-revision-ledger.js",
      "packages/presentation-run/dist/domain/rendered-layout-assessment.js",
      "packages/presentation-run/dist/domain/todo-hand.js",
      "packages/presentation-run/dist/domain/page-chrome.js",
      "packages/presentation-run/dist/domain/layout-compose-gate.js",
      "packages/presentation-run/dist/domain/compose-gate-failure.js",
      "packages/presentation-run/dist/domain/delivery-layouts.js",
      "packages/pptd-v2/dist/layout-duplicates.js",
      "packages/pptd-v2/dist/inheritance.js",
    ];
    for (const rel of listed) {
      assert.ok(
        PRODUCE_GATE_REL_FILES.some((item) => item === rel),
        `${rel} must be in the produce fingerprint`,
      );
    }
  });

  it("fingerprints the shared page-count authority used by plan and compose", () => {
    const listed = [
      "packages/presentation-run/dist/domain/page-count-requirement.js",
      "packages/presentation-run/dist/domain/conversation-requirements.js",
      "packages/presentation-run/dist/domain/deck-page-count.js",
      "packages/presentation-run/dist/domain/plan-coverage.js",
    ];
    for (const rel of listed) {
      assert.ok(
        PRODUCE_GATE_REL_FILES.some((item) => item === rel),
        `${rel} must be in the produce fingerprint`,
      );
    }
  });

  it("fingerprints the layout-scope gate that offers and refuses write_layout", () => {
    const listed = [
      "packages/presentation-run/dist/domain/layout-edit-scope.js",
      "packages/dsh-slides-host/dist/produce-tool-policy.js",
    ];
    for (const rel of listed) {
      assert.ok(
        PRODUCE_GATE_REL_FILES.some((item) => item === rel),
        `${rel} must be in the produce fingerprint`,
      );
    }
  });

  it("fingerprints every module that reads, gates and expands a template component", () => {
    const listed = [
      "packages/presentation-run/dist/domain/template-kit.js",
      "packages/presentation-run/dist/domain/template-kit-text.js",
      "packages/presentation-run/dist/domain/template-component-gates.js",
      "packages/presentation-run/dist/domain/template-component-expand.js",
      "packages/presentation-run/dist/domain/template-component-ledger.js",
      "packages/presentation-run/dist/domain/template-component-paint.js",
      "packages/pptd-v2/dist/component-element-schema.js",
    ];
    for (const rel of listed) {
      assert.ok(
        PRODUCE_GATE_REL_FILES.some((item) => item === rel),
        `${rel} must be in the produce fingerprint`,
      );
    }
  });

  it("fingerprints the editor-turn record that keeps a lapsed editor turn editor-scoped", () => {
    const listed = [
      "packages/presentation-run/dist/domain/editor-turn-authority.js",
      "packages/presentation-run/dist/domain/agent-tools.js",
    ];
    for (const rel of listed) {
      assert.ok(
        PRODUCE_GATE_REL_FILES.some((item) => item === rel),
        `${rel} must be in the produce fingerprint`,
      );
    }
  });

  it("fingerprints the sample-wording gate that refuses template sample text in layouts", () => {
    const listed: string[] = ["packages/presentation-run/dist/domain/layout-sample-text.js"];
    for (const rel of listed) {
      assert.ok(
        PRODUCE_GATE_REL_FILES.some((item) => item === rel),
        `${rel} must be in the produce fingerprint`,
      );
    }
  });

  it("passes on the loaded dist that includes pageHasVisibleContent", () => {
    const report = inspectProduceGates();
    assert.equal(report.id, PRODUCE_GATES_ID);
    assert.equal(report.ok, true, `failed=${report.failed.join(",")} missing=${report.missing.join(",")}`);
    assertProduceGates();
  });

  it("fails closed when pageHasVisibleContent is missing", () => {
    const report = inspectProduceGates({
      ...live,
      pageHasVisibleContent: undefined as unknown as typeof pageHasVisibleContent,
    });
    assert.equal(report.ok, false);
    assert.ok(report.missing.includes("pageHasVisibleContent"));
  });

  it("fails closed when a full-bleed navy rect is treated as content", () => {
    const report = inspectProduceGates({
      ...live,
      pageHasVisibleContent: () => true,
    });
    assert.equal(report.ok, false);
    assert.ok(report.failed.includes("has-content"));
    assert.throws(
      () => assertProduceGates({ ...live, pageHasVisibleContent: () => true }),
      /produce gates missing or stale/,
    );
  });

  it("fails closed when composedPageLeftoverIssues is missing", () => {
    const report = inspectProduceGates({
      ...live,
      composedPageLeftoverIssues: undefined as unknown as typeof composedPageLeftoverIssues,
    });
    assert.equal(report.ok, false);
    assert.ok(report.missing.includes("composedPageLeftoverIssues"));
  });

  it("fails closed when leftover scan ignores a host seed in front of an agent cover", () => {
    const report = inspectProduceGates({
      ...live,
      composedPageLeftoverIssues: () => [],
    });
    assert.equal(report.ok, false);
    assert.ok(report.failed.includes("host-seed-leftover"));
  });

  it("fails closed when rendered layout pass is treated as optional", () => {
    const report = inspectProduceGates({
      ...live,
      renderedLayoutBlocksCompose: () => false,
    });
    assert.equal(report.ok, false);
    assert.ok(report.failed.includes("layout-fail-blocks"));
  });

  it("fails closed when missing rasters deadlock compose", () => {
    const report = inspectProduceGates({
      ...live,
      renderedLayoutBlocksCompose: (layout) => layout !== "pass",
    });
    assert.equal(report.ok, false);
    assert.ok(report.failed.includes("layout-missing-deadlock"));
  });

  it("fails closed when strict editor runs do not require a current raster pass", () => {
    const report = inspectProduceGates({
      ...live,
      renderedLayoutBlocksCompose: (layout) => layout === "fail",
    });
    assert.equal(report.ok, false);
    assert.ok(report.failed.includes("layout-required-missing-pass"));
    assert.ok(report.failed.includes("layout-required-unavailable-pass"));
  });

  it("live dist keeps leftover and layout compose symbols", () => {
    const report = inspectProduceGates();
    assert.equal(report.failed.includes("layout-qa-symbols"), false);
    assert.equal(report.failed.includes("compose-skip"), false);
    assert.equal(report.failed.includes("compose-layout-vision-none"), false);
    assert.equal(report.failed.includes("host-seed-leftover"), false);
    assert.equal(report.failed.includes("empty-create-pages"), false);
    assert.equal(report.failed.includes("empty-create-lists-seed"), false);
    assert.equal(report.failed.includes("footer-zone-reject"), false);
    assert.equal(report.failed.includes("export-missing-fill-white"), false);
    assert.equal(report.failed.includes("omitted-fill-shape-paint"), false);
    assert.equal(report.failed.includes("omitted-fill-icon-paint"), false);
    assert.equal(report.failed.includes("unprefixed-hex-fallback"), false);
    assert.equal(report.failed.includes("unprefixed-hex-parse"), false);
    assert.equal(report.failed.includes("unprefixed-hex-black"), false);
    assert.equal(report.failed.includes("unprefixed-write-reject"), false);
    assert.equal(report.failed.includes("unresolved-theme-black"), false);
    assert.equal(report.failed.includes("unresolved-theme-write-reject"), false);
    assert.equal(report.failed.includes("resolved-theme-write-accept"), false);
    assert.equal(report.failed.includes("resolved-theme-roundtrip"), false);
    assert.equal(report.failed.includes("html-unprefixed-write-reject"), false);
    assert.equal(report.failed.includes("html-official-write-accept"), false);
    assert.equal(report.failed.includes("html-plaintext-hex-false-positive"), false);
    assert.equal(report.failed.includes("brief-kind-classify"), false);
    assert.equal(report.failed.includes("board-h1-kind"), false);
    assert.equal(report.failed.includes("board-h1-academic"), false);
    assert.equal(report.failed.includes("product-intro-kind"), false);
    assert.equal(report.failed.includes("product-intro-monthly"), false);
    assert.equal(report.failed.includes("harness-monthly"), false);
    assert.equal(report.failed.includes("chengguang-monthly"), false);
    assert.equal(report.failed.includes("export-shared-fill-paint"), false);
    assert.equal(report.failed.includes("export-css-as-pptd-color"), false);
    assert.equal(report.failed.includes("export-text-colorhex"), false);
    assert.equal(report.failed.includes("hub-svg-default-blue"), false);
    assert.equal(report.failed.includes("persist-dot-id"), false);
    assert.equal(report.failed.includes("persist-id-strip-dot"), false);
    assert.equal(report.failed.includes("persist-roundtrip"), false);
    assert.equal(report.failed.includes("persist-match-stripped-dot"), false);
    assert.equal(report.failed.includes("academic-kind"), false);
    assert.equal(report.failed.includes("learn-share-kind-classify"), false);
    assert.equal(report.failed.includes("learn-share-kind"), false);
    assert.equal(report.failed.includes("learn-share-missing-pack"), false);
    assert.equal(report.failed.includes("learn-share-self-directed"), false);
    assert.equal(report.failed.includes("learn-share-consulting"), false);
    assert.equal(report.failed.includes("learn-share-promotion"), false);
    assert.equal(report.failed.includes("learn-share-minimax-item-adopt"), false);
    assert.equal(report.failed.includes("learn-share-minimax-sourceid-adopt"), false);
    assert.equal(report.failed.includes("learn-share-minimax-kind-name-adopt"), false);
    assert.equal(report.failed.includes("learn-share-empty-sourceid-object"), false);
    assert.equal(report.failed.includes("academic-minimax-sourceid-adopt"), false);
    assert.equal(report.failed.includes("academic-minimax-kind-name-adopt"), false);
    assert.equal(report.failed.includes("academic-kind-only-object"), false);
    assert.equal(report.failed.includes("learn-share-minimax-id-adopt"), false);
    assert.equal(report.failed.includes("learn-share-minimax-packid-adopt"), false);
    assert.equal(report.failed.includes("learn-share-empty-id-object"), false);
    assert.equal(report.failed.includes("learn-share-pageid-object"), false);
    assert.equal(report.failed.includes("academic-minimax-packid-adopt"), false);
    assert.equal(report.failed.includes("academic-minimax-id-adopt"), false);
    assert.equal(report.failed.includes("learn-share-not-cover-only"), false);
    assert.equal(report.failed.includes("learn-share-chapters-missing-pack"), false);
    assert.equal(report.failed.includes("chengguang-empty-adopt-closed"), false);
    assert.equal(report.failed.includes("cover-only-empty-adopt-closed"), false);
  });

  it("fails closed when persistPagePathFromId strips the dot in 1_cover.page", () => {
    const report = inspectProduceGates({
      ...live,
      persistPagePathFromId: (id) => `pages/${id.replace(/[^a-zA-Z0-9_-]+/g, "")}.page`,
    });
    assert.equal(report.ok, false);
    assert.ok(report.failed.includes("persist-dot-id"));
  });

  it("fails closed when pageIdMatchesFile treats 1_coverpage.page as 1_cover.page", () => {
    const report = inspectProduceGates({
      ...live,
      pageIdMatchesFile: () => true,
    });
    assert.equal(report.ok, false);
    assert.ok(report.failed.includes("persist-match-stripped-dot"));
  });

  it("fails closed when write_page drops unprefixed hex issues", () => {
    const report = inspectProduceGates({
      ...live,
      writePageSchemaIssues: (page, ctx, raw) =>
        live.writePageSchemaIssues(page, ctx, raw).filter((issue) => issue.code !== "invalid_color"),
      writePageSchemaError: (issues, page, ctx) =>
        live.writePageSchemaError(
          issues.filter((issue) => issue.code !== "invalid_color"),
          page,
          ctx,
        ),
    });
    assert.equal(report.ok, false);
    assert.ok(report.failed.includes("unprefixed-write-reject"));
  });

  it("fails closed when write_page accepts unresolved $nope", () => {
    const report = inspectProduceGates({
      ...live,
      writePageSchemaIssues: (page, ctx, raw) =>
        live.writePageSchemaIssues(page, ctx, raw).filter((issue) => !issue.message.includes("$nope")),
      writePageSchemaError: (issues, page, ctx) =>
        live.writePageSchemaError(
          issues.filter((issue) => !issue.message.includes("$nope")),
          page,
          ctx,
        ),
    });
    assert.equal(report.ok, false);
    assert.ok(report.failed.includes("unresolved-theme-write-reject"));
  });

  it("fails closed when write_page accepts HTML style unprefixed hex", () => {
    const report = inspectProduceGates({
      ...live,
      writePageSchemaIssues: (page, ctx, raw) =>
        live.writePageSchemaIssues(page, ctx, raw).filter((issue) => !issue.message.includes("@style.")),
      writePageSchemaError: (issues, page, ctx) =>
        live.writePageSchemaError(
          issues.filter((issue) => !issue.message.includes("@style.")),
          page,
          ctx,
        ),
    });
    assert.equal(report.ok, false);
    assert.ok(report.failed.includes("html-unprefixed-write-reject"));
  });

  it("fails closed when write_page accepts another pack's Color Palette hex after adopt", () => {
    const report = inspectProduceGates({
      ...live,
      writePageSchemaIssues: (page, ctx, raw) =>
        live.writePageSchemaIssues(page, ctx, raw).filter((issue) => issue.code !== "pack_color"),
      writePageSchemaError: (issues, page, ctx) =>
        live.writePageSchemaError(
          issues.filter((issue) => issue.code !== "pack_color"),
          page,
          ctx,
        ),
    });
    assert.equal(report.ok, false);
    assert.ok(report.failed.includes("pack-color-foreign-reject"));
    assert.ok(report.failed.includes("pack-color-navy-reject"));
    assert.ok(report.failed.includes("pack-color-host-blue-reject"));
    assert.ok(report.failed.includes("pack-color-empty-primary-reject"));
  });

  it("fingerprint regex catches missing-fill collapsed to opaque white", () => {
    const stale = 'function fillToPptx(fill) { if (!fill) return { color: "FFFFFF" }; }';
    assert.match(stale, /if\s*\(\s*!fill\s*\)\s*return\s*\{\s*color:\s*["']FFFFFF["']\s*\}/);
  });
});
