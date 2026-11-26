/**
 * The gates a template component reference passes before the Host expands it (architecture §3.21):
 * the reference must name a component of a deck-template's kit; the user must have adopted the
 * aspects that component needs; a Hub style pack refuses decoration components outright; and the
 * template's whole `kit` part must have been read in the current context. A refusal is Chinese and
 * names the reference. Nothing here writes; the Host expands and records after the write succeeds.
 */
import { attachmentStylePriorityRefusal, selectedStylePackId } from "./style-pack-priority.js";
import { currentAdoptedSourceSelection } from "./design-adoption.js";
import { DEFAULT_TEMPLATE_ASPECTS, readDesignAspects, sourceDesignAspects } from "./design-aspects.js";
import { materialChunkCount, readMaterialChunk } from "./material-content.js";
import { verifyMaterial, type VerifiedMaterial } from "./material-pack.js";
import { readRunLedger } from "./run-ledger.js";
import { canonicalDesignSourceId } from "./theme-pack.js";
import {
  componentAspects,
  loadTemplateKit,
  parseComponentRef,
  type KitComponent,
  type LoadedTemplateKit,
} from "./template-kit.js";

export type ComponentUse = "page" | "layout";

export type ComponentRefusal = Readonly<{ error: string; detail: string }>;

export type ResolvedComponent = Readonly<{
  ref: string;
  material: VerifiedMaterial;
  kit: LoadedTemplateKit;
  component: KitComponent;
}>;

const KIT_PART = "kit";

/** Page uses report component_*; layout uses report layout_component_* (aspect, read and style gates share one code). */
function refusal(use: ComponentUse, gate: "ref" | "aspect", detail: string): ComponentRefusal {
  if (use === "layout") {
    return { error: gate === "ref" ? "layout_component_ref" : "layout_component_aspect", detail };
  }
  return { error: gate === "ref" ? "component_ref" : "component_aspect", detail };
}

function kitUnread(root: string, material: VerifiedMaterial, contextEpochId: string): number | undefined {
  const count = materialChunkCount(material, KIT_PART);
  const facts = readRunLedger(root)?.facts ?? [];
  for (let chunkIndex = 0; chunkIndex < count; chunkIndex += 1) {
    const expected = readMaterialChunk({ material, part: KIT_PART, offset: chunkIndex });
    const read = facts.some(
      (fact) =>
        fact.type === "material.chunk-returned" &&
        fact.contextEpochId === contextEpochId &&
        fact.materialId === material.id &&
        fact.materialSha256 === material.sha256 &&
        fact.part === KIT_PART &&
        fact.chunkIndex === chunkIndex &&
        fact.chunkSha256 === expected.chunkSha256,
    );
    if (!read) return count;
  }
  return undefined;
}

function adoptedAspectsRefusal(
  root: string,
  ref: string,
  material: VerifiedMaterial,
  needed: readonly string[],
  use: ComponentUse,
): ComponentRefusal | undefined {
  const sourceId = `material:${material.id}`;
  const adopted = currentAdoptedSourceSelection(root).some((id) => (canonicalDesignSourceId(id) ?? id) === sourceId);
  const granted = sourceDesignAspects(readDesignAspects(root), sourceId, DEFAULT_TEMPLATE_ASPECTS);
  if (adopted && needed.every((aspect) => (granted as readonly string[]).includes(aspect))) {
    return undefined;
  }
  const missing = needed.filter((aspect) => !adopted || !(granted as readonly string[]).includes(aspect));
  return refusal(
    use,
    "aspect",
    `不能使用组件「${ref}」：模板「${material.name}」还没有被采用为「${missing.join("、")}」用途。` +
      `请在 commit_design 的 adoptedSourceIds 加入 ${sourceId}，并在 designAspects 里为它声明 ${needed.join("、")}，再引用组件。`,
  );
}

/** The component a reference names, or the Chinese refusal explaining why it may not be used. */
export function resolveTemplateComponent(
  root: string,
  contextEpochId: string,
  ref: string,
  use: ComponentUse,
): ResolvedComponent | ComponentRefusal {
  const parsed = parseComponentRef(ref);
  if (!parsed) {
    return refusal(
      use,
      "ref",
      `组件引用「${ref}」格式不对，应为 material:<资料编号>#<组件编号>；请从 read_material 的 kit part 复制引用。`,
    );
  }
  let material: VerifiedMaterial;
  try {
    material = verifyMaterial(root, parsed.materialId);
  } catch {
    return refusal(use, "ref", `组件引用「${ref}」指向的资料不存在或校验失败，请重新 list_materials。`);
  }
  if (material.kind !== "deck-template") {
    return refusal(
      use,
      "ref",
      `组件引用「${ref}」指向的资料「${material.name}」不是 PPT 模板，只有 PPT 模板的 kit 里才有可引用的组件。`,
    );
  }
  const kit = loadTemplateKit(material.derivative);
  if (!kit) {
    return refusal(use, "ref", `模板「${material.name}」没有可复用组件（没有 kit），不能使用「${ref}」。`);
  }
  const component = kit.components.find((entry) => entry.id === parsed.componentId);
  if (!component) {
    return refusal(
      use,
      "ref",
      `模板「${material.name}」里没有组件「${parsed.componentId}」，不能使用「${ref}」；` +
        `先 read_material {"materialId":"${material.id}","part":"kit"} 查看可用组件。`,
    );
  }
  const needed = componentAspects(kit, component);
  const packId = selectedStylePackId(root);
  if (needed.includes("decorations")) {
    const remedy = attachmentStylePriorityRefusal(packId, material.name, ["decorations"]);
    if (remedy) return refusal(use, "aspect", `不能使用装饰组件「${ref}」。${remedy}`);
  }
  const aspects = adoptedAspectsRefusal(root, ref, material, needed, use);
  if (aspects) return aspects;
  const unread = kitUnread(root, material, contextEpochId);
  if (unread !== undefined) {
    return refusal(
      use,
      "aspect",
      `使用组件「${ref}」前，必须在当前上下文读完模板「${material.name}」的全部 kit 内容（共 ${unread} 段）：` +
        `请调用 read_material {"materialId":"${material.id}","part":"kit"}，再重试。`,
    );
  }
  return { ref, material, kit, component };
}
