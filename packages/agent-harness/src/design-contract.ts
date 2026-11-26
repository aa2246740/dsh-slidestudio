import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DESIGN_CONTRACT_REL = path.join("_agent", "design-contract.v1.json");

export const LAYOUT_FAMILIES = [
  "cover",
  "toc",
  "section-divider",
  "editorial-asymmetric",
  "chart-led",
  "table-led",
  "matrix",
  "comparison",
  "process-diagram",
  "timeline",
  "map",
  "annotated-image",
  "statement",
  "modular-list",
  "decision",
  "conclusion",
  "appendix",
] as const;

export type LayoutFamily = (typeof LAYOUT_FAMILIES)[number];

export type DesignContractDraft = Readonly<{
  audience: string;
  scene: string;
  purpose: string;
  designRead: string;
  necessaryJudgment: Readonly<{
    removeOrDemote: readonly string[];
    mustRemain: readonly string[];
    inevitableRelationships: readonly string[];
  }>;
  tasteDials: Readonly<{
    visualVariance: number;
    informationDensity: number;
    brandDistinction: number;
    typeExpressiveness: number;
    experimentRisk: number;
  }>;
  typeSystem: Readonly<{
    personality: string;
    title: string;
    body: string;
    data: string;
    mixedScript: string;
  }>;
  palette: Readonly<{
    background: string;
    text: string;
    primary: string;
    accent: string;
    neutral: string;
    areaRules: readonly string[];
  }>;
  grid: string;
  densityRules: readonly string[];
  chartGrammar: readonly string[];
  visualMemory: Readonly<{
    feature: string;
    recurrence: string;
    avoid: string;
  }>;
  referenceUse: Readonly<{
    adopt: readonly string[];
    adapt: readonly string[];
    doNotCopy: readonly string[];
  }>;
  antiDefaultLocks: readonly string[];
  slidePlan: readonly Readonly<{
    pageId: string;
    title: string;
    narrativeJob: string;
    layoutFamily: LayoutFamily;
    focalPoint: string;
  }>[];
  userOverrides: readonly Readonly<{ quote: string; effect: string }>[];
}>;

export type DesignReferenceBinding = Readonly<{
  sourceId: string;
  sha256: string;
  role: "selected-design" | "selected-preview";
}>;

export type CommittedDesignContract = Readonly<{
  schemaVersion: 1;
  briefSha256: string;
  categoryId: string;
  designSystemId: string;
  references: readonly DesignReferenceBinding[];
  draft: DesignContractDraft;
  contractSha256: string;
}>;

export type CommitDesignContractInput = Readonly<{
  brief: string;
  categoryId: string;
  designSystemId: string;
  references: readonly DesignReferenceBinding[];
  draft: unknown;
}>;

export class DesignContractError extends Error {
  override readonly name = "DesignContractError";
}

const HEX = /^#[0-9A-F]{6}$/;
const FORBIDDEN_KEYS = new Set([
  "background",
  "bounds",
  "content",
  "elementId",
  "elements",
  "exporter",
  "geometry",
  "pptx",
  "src",
]);

export function commitDesignContract(root: string, input: CommitDesignContractInput): CommittedDesignContract {
  const brief = requireText(input.brief, "brief");
  const categoryId = requireId(input.categoryId, "categoryId");
  const designSystemId = requireDesignId(input.designSystemId);
  const references = parseReferences(input.references, designSystemId);
  assertNoRenderablePayload(input.draft);
  const draft = parseDesignContractDraft(input.draft, brief);
  const unsigned = {
    schemaVersion: 1 as const,
    briefSha256: sha256(Buffer.from(brief, "utf8")),
    categoryId,
    designSystemId,
    references,
    draft,
  };
  const contract: CommittedDesignContract = {
    ...unsigned,
    contractSha256: stableSha256(unsigned),
  };
  const file = path.join(path.resolve(root), DESIGN_CONTRACT_REL);
  const existing = fs.existsSync(file) ? readDesignContract(root) : undefined;
  if (existing) {
    if (existing.contractSha256 === contract.contractSha256) return existing;
    throw new DesignContractError(
      "design contract already committed with different content; start a new run or revise through the explicit contract amendment path",
    );
  }
  atomicWrite(file, `${JSON.stringify(stableValue(contract), null, 2)}\n`);
  return contract;
}

export function readDesignContract(root: string): CommittedDesignContract | undefined {
  const file = path.join(path.resolve(root), DESIGN_CONTRACT_REL);
  if (!fs.existsSync(file)) return undefined;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  return parseCommittedDesignContract(raw);
}

export function parseDesignContractDraft(raw: unknown, brief: string): DesignContractDraft {
  const rec = requireRecord(raw, "design contract draft");
  const necessary = requireRecord(rec.necessaryJudgment, "necessaryJudgment");
  const dials = requireRecord(rec.tasteDials, "tasteDials");
  const typeSystem = requireRecord(rec.typeSystem, "typeSystem");
  const palette = requireRecord(rec.palette, "palette");
  const memory = requireRecord(rec.visualMemory, "visualMemory");
  const referenceUse = requireRecord(rec.referenceUse, "referenceUse");
  const slidePlanRaw = requireArray(rec.slidePlan, "slidePlan");
  if (slidePlanRaw.length < 2) throw new DesignContractError("slidePlan needs at least 2 pages");
  const slidePlan = slidePlanRaw.map((item, index) => {
    const slide = requireRecord(item, `slidePlan[${index}]`);
    const layoutFamily = requireText(slide.layoutFamily, `slidePlan[${index}].layoutFamily`);
    if (!isLayoutFamily(layoutFamily)) {
      throw new DesignContractError(`unknown layout family: ${layoutFamily}`);
    }
    return {
      pageId: requirePageId(slide.pageId, index),
      title: requireText(slide.title, `slidePlan[${index}].title`),
      narrativeJob: requireText(slide.narrativeJob, `slidePlan[${index}].narrativeJob`),
      layoutFamily,
      focalPoint: requireText(slide.focalPoint, `slidePlan[${index}].focalPoint`),
    };
  });
  assertUnique(
    slidePlan.map((slide) => slide.pageId),
    "slide page ids",
  );
  assertLayoutVariety(slidePlan.map((slide) => slide.layoutFamily));

  const userOverrides = optionalArray(rec.userOverrides, "userOverrides").map((item, index) => {
    const override = requireRecord(item, `userOverrides[${index}]`);
    const quote = requireText(override.quote, `userOverrides[${index}].quote`);
    if (!brief.includes(quote)) {
      throw new DesignContractError(`user override is not a verbatim brief quote: ${quote}`);
    }
    return {
      quote,
      effect: requireText(override.effect, `userOverrides[${index}].effect`),
    };
  });

  return {
    audience: requireText(rec.audience, "audience"),
    scene: requireText(rec.scene, "scene"),
    purpose: requireText(rec.purpose, "purpose"),
    designRead: requireText(rec.designRead, "designRead"),
    necessaryJudgment: {
      removeOrDemote: requireTextArray(necessary.removeOrDemote, "removeOrDemote"),
      mustRemain: requireTextArray(necessary.mustRemain, "mustRemain"),
      inevitableRelationships: requireTextArray(necessary.inevitableRelationships, "inevitableRelationships"),
    },
    tasteDials: {
      visualVariance: requireDial(dials.visualVariance, "visualVariance"),
      informationDensity: requireDial(dials.informationDensity, "informationDensity"),
      brandDistinction: requireDial(dials.brandDistinction, "brandDistinction"),
      typeExpressiveness: requireDial(dials.typeExpressiveness, "typeExpressiveness"),
      experimentRisk: requireDial(dials.experimentRisk, "experimentRisk"),
    },
    typeSystem: {
      personality: requireText(typeSystem.personality, "typeSystem.personality"),
      title: requireText(typeSystem.title, "typeSystem.title"),
      body: requireText(typeSystem.body, "typeSystem.body"),
      data: requireText(typeSystem.data, "typeSystem.data"),
      mixedScript: requireText(typeSystem.mixedScript, "typeSystem.mixedScript"),
    },
    palette: {
      background: requireHex(palette.background, "palette.background"),
      text: requireHex(palette.text, "palette.text"),
      primary: requireHex(palette.primary, "palette.primary"),
      accent: requireHex(palette.accent, "palette.accent"),
      neutral: requireHex(palette.neutral, "palette.neutral"),
      areaRules: requireTextArray(palette.areaRules, "palette.areaRules"),
    },
    grid: requireText(rec.grid, "grid"),
    densityRules: requireTextArray(rec.densityRules, "densityRules"),
    chartGrammar: requireTextArray(rec.chartGrammar, "chartGrammar"),
    visualMemory: {
      feature: requireText(memory.feature, "visualMemory.feature"),
      recurrence: requireText(memory.recurrence, "visualMemory.recurrence"),
      avoid: requireText(memory.avoid, "visualMemory.avoid"),
    },
    referenceUse: {
      adopt: requireTextArray(referenceUse.adopt, "referenceUse.adopt"),
      adapt: requireTextArray(referenceUse.adapt, "referenceUse.adapt"),
      doNotCopy: requireTextArray(referenceUse.doNotCopy, "referenceUse.doNotCopy"),
    },
    antiDefaultLocks: requireTextArray(rec.antiDefaultLocks, "antiDefaultLocks"),
    slidePlan,
    userOverrides,
  };
}

export function assertTodoMatchesDesignContract(contract: CommittedDesignContract, items: readonly unknown[]): void {
  if (items.length !== contract.draft.slidePlan.length) {
    throw new DesignContractError(
      `todo has ${items.length} items but design contract plans ${contract.draft.slidePlan.length}`,
    );
  }
  items.forEach((item, index) => {
    const rec = requireRecord(item, `todo[${index}]`);
    const planned = contract.draft.slidePlan[index]!;
    if (rec.pageId !== planned.pageId) {
      throw new DesignContractError(`todo[${index}].pageId must be ${planned.pageId}`);
    }
    if (rec.layoutFamily !== planned.layoutFamily) {
      throw new DesignContractError(`todo[${index}].layoutFamily must be ${planned.layoutFamily}`);
    }
    if (requireText(rec.title, `todo[${index}].title`) !== planned.title) {
      throw new DesignContractError(`todo[${index}].title must match the committed slide plan`);
    }
  });
}

export function assertPageMatchesDesignContract(
  contract: CommittedDesignContract,
  pageId: string,
  pageType: string | undefined,
): void {
  const planned = requirePlannedSlide(contract, pageId);
  if (pageType !== planned.layoutFamily) {
    throw new DesignContractError(
      `${pageId}.pageType must be committed layout family ${planned.layoutFamily}, received ${pageType === undefined ? "(omitted)" : `"${pageType}"`}`,
    );
  }
}

export function requirePlannedSlide(
  contract: CommittedDesignContract,
  pageId: string,
): CommittedDesignContract["draft"]["slidePlan"][number] {
  const planned = contract.draft.slidePlan.find((slide) => slide.pageId === pageId);
  if (!planned) throw new DesignContractError(`page is absent from design contract: ${pageId}`);
  return planned;
}

/**
 * pageId is already strictly bound to the committed slide plan by write_todo,
 * so an omitted pageType inherits the planned layout family instead of
 * demanding a redundant echo models cannot reliably produce. A supplied value
 * that disagrees with the plan still fails: that is real drift.
 */
export function requirePlannedLayoutFamily(contract: CommittedDesignContract, pageId: string): string {
  return requirePlannedSlide(contract, pageId).layoutFamily;
}

export function stableSha256(raw: unknown): string {
  return sha256(Buffer.from(JSON.stringify(stableValue(raw)), "utf8"));
}

function parseCommittedDesignContract(raw: unknown): CommittedDesignContract {
  const rec = requireRecord(raw, "committed design contract");
  if (rec.schemaVersion !== 1) throw new DesignContractError("unsupported design contract schema");
  const categoryId = requireId(rec.categoryId, "categoryId");
  const designSystemId = requireDesignId(rec.designSystemId);
  const briefSha256 = requireSha(rec.briefSha256, "briefSha256");
  const references = parseReferences(requireArray(rec.references, "references"), designSystemId);
  assertNoRenderablePayload(rec.draft);
  const draft = parseDesignContractDraft(rec.draft, reconstructOverrideBrief(rec.draft));
  const unsigned = {
    schemaVersion: 1 as const,
    briefSha256,
    categoryId,
    designSystemId,
    references,
    draft,
  };
  const contractSha256 = requireSha(rec.contractSha256, "contractSha256");
  if (stableSha256(unsigned) !== contractSha256) {
    throw new DesignContractError("design contract hash mismatch");
  }
  return { ...unsigned, contractSha256 };
}

function reconstructOverrideBrief(raw: unknown): string {
  const rec = requireRecord(raw, "design contract draft");
  const items = optionalArray(rec.userOverrides, "userOverrides");
  return items
    .map((item) => {
      const override = requireRecord(item, "user override");
      return typeof override.quote === "string" ? override.quote : "";
    })
    .join("\n");
}

function parseReferences(raw: readonly unknown[], designSystemId: string): DesignReferenceBinding[] {
  const references = raw.map((item, index) => {
    const rec = requireRecord(item, `references[${index}]`);
    const role = rec.role;
    if (role !== "selected-design" && role !== "selected-preview") {
      throw new DesignContractError(`invalid reference role at references[${index}]`);
    }
    const binding: DesignReferenceBinding = {
      sourceId: requireText(rec.sourceId, `references[${index}].sourceId`),
      sha256: requireSha(rec.sha256, `references[${index}].sha256`),
      role,
    };
    return binding;
  });
  assertUnique(
    references.map((reference) => reference.role),
    "reference roles",
  );
  if (references.length !== 2) {
    throw new DesignContractError("design contract requires selected-design and selected-preview references");
  }
  const preview = references.find((reference) => reference.role === "selected-preview");
  if (preview?.sourceId !== `openkimi-preview:${designSystemId}`) {
    throw new DesignContractError("selected preview does not match designSystemId");
  }
  return references;
}

function assertLayoutVariety(layouts: readonly LayoutFamily[]): void {
  if (layouts.length >= 6 && new Set(layouts).size < 4) {
    throw new DesignContractError("decks with at least 6 slides need at least 4 layout families");
  }
  for (let index = 2; index < layouts.length; index++) {
    if (layouts[index] === layouts[index - 1] && layouts[index] === layouts[index - 2]) {
      throw new DesignContractError("one layout family cannot repeat on more than 2 adjacent slides");
    }
  }
}

function assertNoRenderablePayload(raw: unknown, trail = "draft"): void {
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => assertNoRenderablePayload(item, `${trail}[${index}]`));
    return;
  }
  if (!raw || typeof raw !== "object") return;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const paletteBackground = trail === "draft.palette" && key === "background";
    if (FORBIDDEN_KEYS.has(key) && !paletteBackground) {
      throw new DesignContractError(`renderable field is forbidden in design contract: ${trail}.${key}`);
    }
    assertNoRenderablePayload(value, `${trail}.${key}`);
  }
}

function requireRecord(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DesignContractError(`${label} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function requireArray(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw)) throw new DesignContractError(`${label} must be an array`);
  return raw;
}

function optionalArray(raw: unknown, label: string): unknown[] {
  if (raw === undefined) return [];
  return requireArray(raw, label);
}

function requireText(raw: unknown, label: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new DesignContractError(`${label} must be non-empty`);
  return value;
}

function requireTextArray(raw: unknown, label: string): string[] {
  const values = requireArray(raw, label).map((item, index) => requireText(item, `${label}[${index}]`));
  if (!values.length) throw new DesignContractError(`${label} must be non-empty`);
  return values;
}

function requireHex(raw: unknown, label: string): string {
  const value = requireText(raw, label).toUpperCase();
  if (!HEX.test(value)) throw new DesignContractError(`${label} must be #RRGGBB`);
  return value;
}

function requireDial(raw: unknown, label: string): number {
  if (!Number.isInteger(raw) || Number(raw) < 1 || Number(raw) > 5) {
    throw new DesignContractError(`${label} must be an integer from 1 to 5`);
  }
  return Number(raw);
}

function requirePageId(raw: unknown, index: number): string {
  const value = requireText(raw, `slidePlan[${index}].pageId`);
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new DesignContractError(`invalid pageId: ${value}`);
  }
  return value;
}

function requireId(raw: unknown, label: string): string {
  const value = requireText(raw, label);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new DesignContractError(`invalid ${label}`);
  return value;
}

function requireDesignId(raw: unknown): string {
  const value = requireText(raw, "designSystemId");
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(value)) {
    throw new DesignContractError("invalid designSystemId");
  }
  return value;
}

function requireSha(raw: unknown, label: string): string {
  const value = requireText(raw, label);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new DesignContractError(`invalid ${label}`);
  return value;
}

function isLayoutFamily(value: string): value is LayoutFamily {
  return (LAYOUT_FAMILIES as readonly string[]).includes(value);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new DesignContractError(`${label} must be unique`);
}

function stableValue(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(stableValue);
  if (!raw || typeof raw !== "object") return raw;
  const rec = raw as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(rec)
      .sort()
      .map((key) => [key, stableValue(rec[key])]),
  );
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, content, "utf8");
  fs.renameSync(temp, file);
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
