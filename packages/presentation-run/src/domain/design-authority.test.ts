/**
 * The current effective design authority: an explicit user decision or a valid
 * current-epoch answer may replace the Hub style, an attachment cannot authorize
 * itself, and every consumer reads the same effective source. The Hub choice
 * stays in runtime.designSystemId as history.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { SOURCE_ID, T1_COLORS, writeTemplate } from "./deck-template.testkit.js";
import { buildDeliveryProvenance } from "./delivery-provenance.js";
import {
  HUB_CHOICE_SOURCE,
  authorityCatalogPackId,
  designAuthorityDecision,
  designAuthoritySourceIssue,
  effectiveCatalogPackId,
  normalizeDesignAuthority,
  readDesignAuthority,
  resolvePlanningDesignAuthority,
  type DesignAuthority,
} from "./design-authority.js";
import { createProjectRuntime } from "./design-authority.testkit.js";
import { projectPackColorContext, runtimeDesignSystemId } from "./pack-color-context.js";
import type { DeckComposedFact } from "./run-ledger.js";
import { ensureRunLedger } from "./run-ledger.js";
import { selectedStylePackId } from "./style-pack-priority.js";
import { catalogPackPaletteHexes, packColorWriteContext } from "./theme-pack.js";

const PACK = "finance/honey-orange-memo";

function project(t: TestContext, runtime: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "风格权威" });
  createProjectRuntime(root, { designSystemId: PACK, ...runtime });
  return root;
}

function materialAuthority(decidedAt = "2026-10-01T00:00:00.000Z"): DesignAuthority {
  return {
    source: SOURCE_ID,
    origin: { kind: "user-request", text: "按附件品牌模板的配色和字体" },
    decidedAt,
  };
}

function catalogAuthority(source: string): DesignAuthority {
  return {
    source,
    origin: { kind: "user-request", text: `改用 ${source}` },
    decidedAt: "2026-10-01T00:00:00.000Z",
  };
}

describe("effective design authority", () => {
  it("uses the Hub style until a valid decision replaces it, and keeps the Hub choice", (t) => {
    const root = project(t);
    assert.equal(selectedStylePackId(root), PACK);
    assert.equal(effectiveCatalogPackId(root), PACK);
    assert.equal(runtimeDesignSystemId(root), PACK);

    fs.writeFileSync(
      path.join(root, "_agent", "runtime.json"),
      `${JSON.stringify({ designSystemId: PACK, designAuthority: materialAuthority() })}\n`,
    );
    assert.equal(selectedStylePackId(root), undefined);
    assert.equal(effectiveCatalogPackId(root), undefined);
    assert.equal(runtimeDesignSystemId(root), undefined);
    const runtime = JSON.parse(fs.readFileSync(path.join(root, "_agent", "runtime.json"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(runtime.designSystemId, PACK, "the initial Hub choice stays as history");

    fs.writeFileSync(
      path.join(root, "_agent", "runtime.json"),
      `${JSON.stringify({
        designSystemId: PACK,
        designAuthority: catalogAuthority("consulting/pine-green-strategy"),
      })}\n`,
    );
    assert.equal(selectedStylePackId(root), "consulting/pine-green-strategy");
    assert.equal(effectiveCatalogPackId(root), "consulting/pine-green-strategy");

    fs.writeFileSync(
      path.join(root, "_agent", "runtime.json"),
      `${JSON.stringify({
        designSystemId: PACK,
        designAuthority: {
          source: HUB_CHOICE_SOURCE,
          origin: { kind: "user-request", text: "保留首页风格" },
          decidedAt: "2026-10-02T00:00:00.000Z",
        },
      })}\n`,
    );
    assert.equal(selectedStylePackId(root), PACK);
    assert.equal(effectiveCatalogPackId(root), PACK);
  });

  it("a malformed saved decision fails closed onto the Hub style and refuses planning", (t) => {
    const root = project(t, {
      designAuthority: { source: SOURCE_ID, origin: { kind: "user-request", text: "x" } },
    });
    const reading = readDesignAuthority(root);
    assert.equal(reading.kind, "invalid");
    assert.equal(selectedStylePackId(root), PACK);
    assert.equal(effectiveCatalogPackId(root), PACK);
    const planning = resolvePlanningDesignAuthority(root, {});
    assert.equal(planning.issue?.code, "design_authority_invalid");
    assert.match(planning.issue?.detail ?? "", /重新声明|hub-choice/);
  });

  it("a material decision grants exactly the adopted palette and drops the old pack palette", (t) => {
    const root = project(t, {
      adoptedSourceIds: [SOURCE_ID],
      designAspects: [{ source: SOURCE_ID, aspects: ["palette", "fonts"] }],
    });
    writeTemplate(root);
    const before = projectPackColorContext(root);
    assert.equal(before.adoptedPackId, PACK);
    assert.equal(before.adoptedPackHexes?.has(T1_COLORS.accent1), false);

    fs.writeFileSync(
      path.join(root, "_agent", "runtime.json"),
      `${JSON.stringify({
        designSystemId: PACK,
        adoptedSourceIds: [SOURCE_ID],
        designAspects: [{ source: SOURCE_ID, aspects: ["palette", "fonts"] }],
        designAuthority: materialAuthority(),
      })}\n`,
    );
    const after = projectPackColorContext(root);
    assert.equal(after.adoptedPackId, "已采用的设计源");
    assert.equal(after.adoptedPackHexes?.has(T1_COLORS.accent1), true);

    const packHexes = [...(catalogPackPaletteHexes().get(PACK) ?? [])];
    const materialHexes = packColorWriteContext([SOURCE_ID], root).adoptedPackHexes ?? new Set();
    const packOnly = packHexes.find((hex) => !materialHexes.has(hex));
    assert.ok(packOnly, "the catalog pack needs a colour the attachment does not grant");
    assert.equal(after.adoptedPackHexes?.has(packOnly), false);
  });

  it("delivery provenance reads the effective decision and keeps the Hub pack as history", (t) => {
    const root = project(t, {
      adoptedSourceIds: [SOURCE_ID],
      designAspects: [{ source: SOURCE_ID, aspects: ["palette"] }],
    });
    fs.writeFileSync(
      path.join(root, "_agent", "runtime.json"),
      `${JSON.stringify({
        designSystemId: PACK,
        adoptedSourceIds: [SOURCE_ID],
        designAspects: [{ source: SOURCE_ID, aspects: ["palette"] }],
        designAuthority: materialAuthority(),
      })}\n`,
    );
    const fact: DeckComposedFact = {
      type: "deck.composed",
      factId: "authority-seal",
      at: "2026-10-01T00:00:00.000Z",
      contextEpochId: "authority-epoch",
      title: "风格权威",
      deckSha256: "a".repeat(64),
      pageRevisions: {},
    };
    ensureRunLedger(root, {
      manifestSha256: "fixture",
      requirementsId: "fixture",
      requirements: [],
      executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
    });
    const { file } = buildDeliveryProvenance(root, fact);
    assert.equal(file.design.stylePriority, "attachments");
    assert.equal(file.design.designSystemId, null);
    assert.equal(file.design.hubDesignSystemId, PACK);
    assert.equal(file.design.designAuthority?.source, SOURCE_ID);
    assert.equal(file.design.designAuthority?.origin.kind, "user-request");
  });

  it("rejects a decision that names no user request, no adopted source, or no visual use", (t) => {
    assert.throws(
      () =>
        normalizeDesignAuthority({
          source: SOURCE_ID,
          origin: { kind: "attachment", text: "附件自己要求" },
        }),
      /attachment cannot authorize|user-request or a valid clarification-answer/,
    );
    assert.throws(
      () =>
        normalizeDesignAuthority({
          source: SOURCE_ID,
          origin: { kind: "user-request", text: "" },
        }),
      /designAuthority\.origin\.text/,
    );
    assert.throws(
      () =>
        normalizeDesignAuthority({
          source: "../material:brand",
          origin: { kind: "user-request", text: "x" },
        }),
      /designAuthority\.source/,
    );
    assert.equal(
      normalizeDesignAuthority({
        source: HUB_CHOICE_SOURCE,
        origin: { kind: "user-request", text: "保留首页风格" },
      }).source,
      HUB_CHOICE_SOURCE,
    );

    const root = project(t);
    writeTemplate(root);
    const notAdopted = designAuthoritySourceIssue({
      projectRoot: root,
      authority: materialAuthority(),
      hubPackId: PACK,
      adoptedSourceIds: [],
      designAspects: [],
      knownCatalogPack: () => true,
    });
    assert.equal(notAdopted?.code, "design_authority_not_adopted");

    const noVisualUse = designAuthoritySourceIssue({
      projectRoot: root,
      authority: materialAuthority(),
      hubPackId: PACK,
      adoptedSourceIds: [SOURCE_ID],
      designAspects: [{ source: SOURCE_ID, aspects: ["content"] }],
      knownCatalogPack: () => true,
    });
    assert.equal(noVisualUse?.code, "design_authority_missing_aspect");

    const unknownPack = designAuthoritySourceIssue({
      projectRoot: root,
      authority: catalogAuthority("missing/nope"),
      hubPackId: PACK,
      adoptedSourceIds: [],
      designAspects: [],
      knownCatalogPack: () => false,
    });
    assert.equal(unknownPack?.code, "design_authority_unknown_pack");

    const valid = designAuthoritySourceIssue({
      projectRoot: root,
      authority: materialAuthority(),
      hubPackId: PACK,
      adoptedSourceIds: [SOURCE_ID],
      designAspects: [{ source: SOURCE_ID, aspects: ["fonts"] }],
      knownCatalogPack: () => true,
    });
    assert.equal(valid, undefined);
  });

  it("keeps the first decision timestamp for a duplicate and advances it for a new one", () => {
    const existing = materialAuthority("2026-10-01T00:00:00.000Z");
    const duplicate = {
      ...existing,
      decidedAt: "",
    };
    assert.equal(designAuthorityDecision(duplicate, existing), existing);
    const changed = designAuthorityDecision(
      { ...catalogAuthority("consulting/pine-green-strategy"), decidedAt: "" },
      existing,
    );
    assert.notEqual(changed.decidedAt, existing.decidedAt);
    assert.equal(changed.source, "consulting/pine-green-strategy");
  });

  it("resolves the declared decision before the plan resolves aspects", (t) => {
    const root = project(t);
    const declared = resolvePlanningDesignAuthority(root, {
      designAuthority: {
        source: SOURCE_ID,
        origin: { kind: "user-request", text: "按附件品牌模板的配色" },
      },
    });
    assert.equal(declared.declared, true);
    assert.equal(declared.authority?.source, SOURCE_ID);
    assert.equal(authorityCatalogPackId(declared.authority, PACK), undefined);

    const omitted = resolvePlanningDesignAuthority(root, {});
    assert.equal(omitted.declared, false);
    assert.equal(omitted.authority, undefined);
    assert.equal(omitted.issue, undefined);
  });
});
