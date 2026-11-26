import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { executeGenerateTool, packColorSchemaContext, type AgentToolState } from "./agent-tools.js";
import { writeDomainRuntime } from "./domain-hands.js";
import { buildToolState } from "./hands-tool-state.js";
import { imageFixture, tempProject, writeMaterialFixture } from "./material-testkit.js";
import { projectPackColorContext } from "./pack-color-context.js";
import { KIND_THEME_PACK_ERROR, PACK_COLOR_ERROR, catalogPackPaletteHexes } from "./theme-pack.js";
import { recordSourceReceipt } from "../receipts.js";
import { ensureRunLedger } from "./run-ledger.js";
import type { SkillPageInput } from "./skill-pages.js";

/**
 * The Agent hands (write_page, compose_deck) must take their palette from the same
 * effective authority the Host and the run ledger use, not from the Hub pack that
 * runtime.json keeps as history.
 */
const HUB_PACK = "work/warm-jade-annual-report";
const HUB_ONLY = "#FDC356";
const CHOSEN_PACK = "consulting/pine-green-strategy";
const CHOSEN_ONLY = "#03522C";
const ATTACHMENT_ACCENT = "#C00000";
const BRIEF = "向团队说明合成项目进展和下一步";

const IMAGE_PROFILE = {
  schema: "style-profile/v1",
  source: "image-pixels",
  accentColors: [
    { hex: ATTACHMENT_ACCENT, share: 0.3 },
    { hex: "#7A1F1F", share: 0.08 },
  ],
  neutralColors: [{ hex: "#FFFFFF" }, { hex: "#F2F2F2" }],
  background: "#FFFFFF",
  contrastPairs: [{ fg: ATTACHMENT_ACCENT, bg: "#FFFFFF", ratio: 6.5 }],
};

function runtimeFile(root: string): string {
  return path.join(root, "_agent", "runtime.json");
}

function patchRuntime(root: string, patch: Record<string, unknown>): void {
  const current = JSON.parse(fs.readFileSync(runtimeFile(root), "utf8")) as Record<string, unknown>;
  fs.writeFileSync(runtimeFile(root), `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}

function decision(source: string) {
  return {
    source,
    origin: { kind: "user-request", text: "按这个风格做" },
    decidedAt: "2026-11-14T00:00:00.000Z",
  };
}

/** A project that opened on the Hub pack; `authority` is the later decision, if any. */
function hubProject(t: TestContext, authority?: string): string {
  const root = tempProject("style-authority-consumers-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "风格权威" });
  writeDomainRuntime(root, { brief: BRIEF, designSystemId: HUB_PACK });
  if (authority) patchRuntime(root, { designAuthority: decision(authority) });
  return root;
}

/** The state the Agent hand builds for a tool call on this project. */
function handState(root: string): AgentToolState {
  return buildToolState(root, { brief: BRIEF, designSystemId: HUB_PACK }, { todos: [], writtenPages: [] });
}

function page(fill: string): SkillPageInput {
  return {
    id: "cover",
    pageType: "cover",
    elements: [
      {
        elementId: "band",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: fill },
      },
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 160, 800, 80],
        content: { text: "合成项目进展", fontSize: 32, color: "#FFFFFF" },
      },
    ],
  };
}

function closer(fill: string): SkillPageInput {
  const text = (elementId: string, value: string, y: number) => ({
    elementId,
    elementType: "text" as const,
    bounds: [52, y, 856, 60] as [number, number, number, number],
    content: { text: value, fontSize: 18, color: "#FFFFFF" },
  });
  return {
    id: "final",
    pageType: "final",
    elements: [
      {
        elementId: "band",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: fill },
      },
      text("title", "结束页 · 结构验收", 80),
      text("recap", "两页均有可读正文，layout-qa 通过。", 176),
      text("ask", "下次只补视觉审查员，不伪造 pass。", 294),
    ],
  };
}

function writeAs(root: string, fill: string) {
  return executeGenerateTool("write_page", page(fill), handState(root));
}

function composeAs(root: string, fill: string) {
  const state = handState(root);
  state.writtenPages = [page(fill), closer(fill)];
  return executeGenerateTool("compose_deck", { title: "风格权威" }, state);
}

function assertPackRefused(result: { ok: boolean; detail: string; payload?: unknown }): void {
  assert.equal(result.ok, false, "an off-palette colour must be refused");
  assert.equal((result.payload as { error?: string }).error, PACK_COLOR_ERROR, result.detail);
}

/** A deck whose adopted palette comes from one brand image, while the Hub pack stays in history. */
function attachmentProject(t: TestContext, authorized: boolean): string {
  const root = tempProject("style-authority-attachment-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = imageFixture("img-brand", "brand-redwhite.png", 1200, 800);
  writeMaterialFixture(root, {
    ...base,
    derivative: {
      image: {
        ...(base.derivative!.image as Record<string, unknown>),
        format: "png",
        styleProfile: IMAGE_PROFILE,
      },
    },
  });
  createEmptyProject(root, { title: "附件风格" });
  writeDomainRuntime(root, {
    brief: BRIEF,
    designSystemId: HUB_PACK,
    designAspects: [{ source: "material:img-brand", aspects: ["palette"] }],
  });
  if (authorized) patchRuntime(root, { designAuthority: decision("material:img-brand") });
  recordSourceReceipt(root, {
    sourceId: "material:img-brand",
    state: "adopted",
    toolCallId: "fixture",
  });
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

const paletteOf = (ctx: { adoptedPackHexes?: ReadonlySet<string> }) => [...(ctx.adoptedPackHexes ?? [])].sort();

it("after a catalog switch A to C, write_page and compose_deck take C's colours and refuse A-only ones", (t) => {
  const fresh = () => hubProject(t, CHOSEN_PACK);
  assertPackRefused(writeAs(fresh(), HUB_ONLY));
  const written = writeAs(fresh(), CHOSEN_ONLY);
  assert.equal(written.ok, true, written.detail);
  assertPackRefused(composeAs(fresh(), HUB_ONLY));
  const composed = composeAs(fresh(), CHOSEN_ONLY);
  assert.equal(composed.ok, true, composed.detail);
});

it("without a switch the Hub pack still governs write_page and compose_deck", (t) => {
  const fresh = () => hubProject(t);
  assertPackRefused(writeAs(fresh(), CHOSEN_ONLY));
  assert.equal(writeAs(fresh(), HUB_ONLY).ok, true);
  assertPackRefused(composeAs(fresh(), CHOSEN_ONLY));
  assert.equal(composeAs(fresh(), HUB_ONLY).ok, true);
});

it("keeping the Hub choice by decision leaves the Hub pack in force", (t) => {
  const fresh = () => hubProject(t, "hub-choice");
  assert.equal(writeAs(fresh(), HUB_ONLY).ok, true);
  assertPackRefused(writeAs(fresh(), CHOSEN_ONLY));
});

it("after adopting an attachment B by decision, the Agent hand allows exactly the set Host and ledger allow", (t) => {
  const root = attachmentProject(t, true);
  const host = projectPackColorContext(root);
  assert.equal(host.adoptedPackHexes?.has(ATTACHMENT_ACCENT), true);
  assert.equal(host.adoptedPackHexes?.has(HUB_ONLY), false);
  assert.deepEqual(paletteOf(packColorSchemaContext(handState(root))), paletteOf(host));

  assertPackRefused(writeAs(attachmentProject(t, true), HUB_ONLY));
  assert.equal(writeAs(attachmentProject(t, true), ATTACHMENT_ACCENT).ok, true);
  assertPackRefused(composeAs(attachmentProject(t, true), HUB_ONLY));
  assert.equal(composeAs(attachmentProject(t, true), ATTACHMENT_ACCENT).ok, true);
});

it("an attachment adopted without a decision changes nothing: Hub pack only, as Host and ledger", (t) => {
  const root = attachmentProject(t, false);
  const host = projectPackColorContext(root);
  assert.deepEqual(paletteOf(packColorSchemaContext(handState(root))), paletteOf(host));
  assert.equal(host.adoptedPackHexes?.has(HUB_ONLY), true);
  assert.equal(host.adoptedPackHexes?.has(ATTACHMENT_ACCENT), false);
});

it("a state without a project root keeps the playbook pack", () => {
  const state = {
    brief: BRIEF,
    playbook: { designSystemId: HUB_PACK },
  } as unknown as AgentToolState;
  const ctx = packColorSchemaContext(state);
  assert.equal(ctx.adoptedPackHexes?.has(HUB_ONLY), true);
  assert.equal(ctx.adoptedPackHexes?.has(CHOSEN_ONLY), false);
});

const COURSEWARE_BRIEF = "做一份教学课件，介绍合成协作流程";
const CROSS_FAMILY_PACK = "finance/honey-orange-memo";

/** Courseware that opened self-directed (no Hub pack); `authority` is a later style decision. */
function coursewareProject(t: TestContext, authority?: string): string {
  const root = tempProject("style-authority-courseware-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "课件风格" });
  writeDomainRuntime(root, { brief: COURSEWARE_BRIEF, designDirection: "self-directed" });
  if (authority) patchRuntime(root, { designAuthority: decision(authority) });
  return root;
}

function coursewareState(root: string): AgentToolState {
  return buildToolState(
    root,
    { brief: COURSEWARE_BRIEF, designDirection: "self-directed" },
    { todos: [], writtenPages: [] },
  );
}

function crossFamilyFill(): string {
  const hex = [...(catalogPackPaletteHexes().get(CROSS_FAMILY_PACK) ?? [])].find(
    (candidate) => candidate !== "#FFFFFF",
  );
  assert.ok(hex, "the finance pack owns a palette colour");
  return hex;
}

function assertKindThemeAllowed(result: { ok: boolean; detail: string; payload?: unknown }): void {
  assert.notEqual((result.payload as { error?: string } | undefined)?.error, KIND_THEME_PACK_ERROR, result.detail);
}

it("a valid style decision to another family counts as explicit for write_page and compose_deck", (t) => {
  const fill = crossFamilyFill();
  const written = executeGenerateTool(
    "write_page",
    page(fill),
    coursewareState(coursewareProject(t, CROSS_FAMILY_PACK)),
  );
  assertKindThemeAllowed(written);
  assert.equal(written.ok, true, written.detail);
  const state = coursewareState(coursewareProject(t, CROSS_FAMILY_PACK));
  state.writtenPages = [page(fill), closer(fill)];
  const composed = executeGenerateTool("compose_deck", { title: "课件风格" }, state);
  assertKindThemeAllowed(composed);
  assert.equal(composed.ok, true, composed.detail);
});

it("without a decision the self-directed courseware keeps refusing a cross-family pack", (t) => {
  const root = coursewareProject(t);
  patchRuntime(root, { designSystemId: CROSS_FAMILY_PACK });
  const refused = executeGenerateTool("write_page", page(crossFamilyFill()), coursewareState(root));
  assert.equal(refused.ok, false);
  assert.equal((refused.payload as { error?: string }).error, KIND_THEME_PACK_ERROR);
});

it("keeping the Hub choice by decision on a self-directed project does not grant a pack", (t) => {
  const root = coursewareProject(t, "hub-choice");
  assert.equal(coursewareState(root).userExplicitPack, false);
});
