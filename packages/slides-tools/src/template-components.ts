/**
 * Host side of template components (architecture §3.21). A write_page or write_layout call may carry
 * `{elementType:"component", ref, bounds}` entries; the Host resolves each against the template's
 * kit, runs the component gates, materializes the kit's image bytes into project media, and
 * replaces the entry with native PPTD elements before anything is validated or saved. A saved page
 * or layout therefore never holds a component. The Host never composes a page: a reference only
 * stands in for decoration the model placed itself, and it cannot create a page.
 */
import crypto from "node:crypto";
import path from "node:path";
import { SlideToolArgsError, type SlideToolDefinition } from "./contract.js";
import { unzipSync } from "fflate";
import { isComponentReference } from "@open-slidestudio/pptd-v2";
import {
  applySmartArtTexts,
  expandTemplateComponent,
  packageBytesOf,
  planSmartArtTexts,
  recordTemplateComponentUsed,
  resolveTemplateComponent,
  saveMediaFile,
  type ComponentTarget,
  type KitAsset,
  type ResolvedComponent,
  type SmartArtTextsPlan,
} from "@open-slidestudio/presentation-run";
import { templateMediaKey } from "./template-assets.js";

export type ComponentKind = "page" | "layout";

export type UsedComponent = Readonly<{ ref: string; kitSha256: string }>;

export type ComponentExpansion =
  | Readonly<{ ok: true; elements: unknown[]; uses: readonly UsedComponent[] }>
  | Readonly<{ ok: false; error: string; detail: string }>;

/** A kit image may be a full-bleed picture; anything larger is not a decoration. */
const MAX_KIT_IMAGE_BYTES = 20 * 1024 * 1024;
const MEDIA_PREFIX = "ppt/media/";

class ComponentAssetError extends Error {}

const sha256Of = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The kit names an original image by the part path below ppt/media with `/` written as `_`. */
function originalImage(resolved: ResolvedComponent, asset: KitAsset): Uint8Array | undefined {
  // A legacy template's media lives in its converted package (M8), never the upload.
  const files = unzipSync(packageBytesOf(resolved.material), {
    filter(entry) {
      if (!entry.name.startsWith(MEDIA_PREFIX)) return false;
      const name = `media/${entry.name.slice(MEDIA_PREFIX.length).replaceAll("/", "_")}`;
      if (name !== asset.file) return false;
      if (entry.originalSize > MAX_KIT_IMAGE_BYTES) {
        throw new ComponentAssetError("组件里的图片过大");
      }
      return true;
    },
  });
  return Object.values(files)[0];
}

/** A processed (grayscale) kit image is stored inside the verified template derivative. */
function derivedImage(resolved: ResolvedComponent, asset: KitAsset): Uint8Array | undefined {
  const detail = record(record(resolved.material.derivative["deck-template"]).templateDetail);
  const stored = (Array.isArray(detail.assets) ? detail.assets : [])
    .map(record)
    .find((entry) => entry.file === asset.detail);
  if (stored?.encoding !== "base64" || typeof stored.content !== "string") return undefined;
  return Buffer.from(stored.content, "base64");
}

/** Saves one kit image under a content-addressed media name and returns its project path. */
function materializeImage(projectRoot: string, resolved: ResolvedComponent, file: string): string {
  const asset = resolved.kit.assets.find((entry) => entry.file === file);
  const missing = new ComponentAssetError(
    `组件「${resolved.ref}」引用的图片「${file}」没有随模板保存，请重新上传该模板后再试`,
  );
  if (!asset) throw missing;
  let bytes: Uint8Array | undefined;
  try {
    bytes = asset.kind === "derived" ? derivedImage(resolved, asset) : originalImage(resolved, asset);
  } catch (error) {
    if (error instanceof ComponentAssetError) throw error;
  }
  if (!bytes?.length || bytes.length > MAX_KIT_IMAGE_BYTES) throw missing;
  if (sha256Of(bytes) !== asset.sha256) {
    throw new ComponentAssetError(
      `组件「${resolved.ref}」的图片「${file}」校验失败（与提取时记录的内容不一致），请重新上传该模板后再试`,
    );
  }
  const ext = path.extname(asset.file).slice(1).toLowerCase();
  const id = `tpl-${templateMediaKey(resolved.material.id)}-${asset.sha256.slice(0, 12)}`;
  return saveMediaFile(projectRoot, id, Buffer.from(bytes), ext || "png", { preserveId: true }).src;
}

function boundsOf(entry: Record<string, unknown>): ComponentTarget | undefined | "invalid" {
  if (entry.bounds === undefined) return undefined;
  const bounds = entry.bounds;
  if (
    !Array.isArray(bounds) ||
    bounds.length !== 4 ||
    !bounds.every((part) => typeof part === "number" && Number.isFinite(part)) ||
    bounds[2] <= 0 ||
    bounds[3] <= 0
  ) {
    return "invalid";
  }
  return bounds as unknown as ComponentTarget;
}

const refusal = (kind: ComponentKind, detail: string) =>
  ({
    ok: false,
    error: kind === "layout" ? "layout_component_ref" : "component_ref",
    detail,
  }) as const;

/**
 * Replaces every component reference in `elements`, keeping the template's paint order and the
 * position of the reference among the model's own elements. Elements without a reference are
 * returned untouched, so a call with no component is byte-identical to before.
 */
type ComponentRefusal = Extract<ComponentExpansion, { ok: false }>;

/** Validate one reference's texts against its resolved component. */
function smartArtTextsPlan(
  entry: Record<string, unknown>,
  ref: string,
  kind: ComponentKind,
  component: ResolvedComponent["component"],
): { plan?: SmartArtTextsPlan } | ComponentRefusal {
  if (entry.texts === undefined || (Array.isArray(entry.texts) && entry.texts.length === 0)) return {};
  if (component.role !== "smartart") {
    return refusal(kind, `组件「${ref}」不是 SmartArt 组件，不接受 texts；组件上的文字请在页面上另写文字元素。`);
  }
  const verdict = planSmartArtTexts(component, entry.texts);
  if (!verdict.ok) return refusal(kind, verdict.detail);
  return { plan: verdict.plan };
}

type ExpandedReference = { readonly elements: unknown[]; readonly use: UsedComponent };

function expandReference(
  projectRoot: string,
  contextEpochId: string,
  element: unknown,
  kind: ComponentKind,
  usedIds: Set<string>,
): ExpandedReference | ComponentRefusal {
  const entry = record(element);
  const ref = typeof entry.ref === "string" ? entry.ref.trim() : "";
  if (!ref) {
    return refusal(kind, "模板组件缺少 ref；请从 read_material 的 kit part 复制 material:<资料编号>#<组件编号>。");
  }
  const target = boundsOf(entry);
  if (target === "invalid") {
    return refusal(
      kind,
      `组件「${ref}」的 bounds 必须是 [x, y, w, h] 四个数字（960×540 像素，宽高大于 0），或者不写 bounds 保持模板位置。`,
    );
  }
  const resolved = resolveTemplateComponent(projectRoot, contextEpochId, ref, kind);
  if ("error" in resolved) return { ok: false, error: resolved.error, detail: resolved.detail };
  // SmartArt components are page-only; a layout refuses them like a chart or a table.
  if (kind === "layout" && resolved.component.role === "smartart") {
    return refusal(
      kind,
      `版式里不能放图表、表格或 SmartArt：组件「${ref}」是 SmartArt 组件，请把它写在页面的 elements 里。`,
    );
  }
  const texts = smartArtTextsPlan(entry, ref, kind, resolved.component);
  if ("ok" in texts) return texts;
  let expanded;
  try {
    expanded = expandTemplateComponent(resolved.component, {
      ...(target ? { bounds: target } : {}),
      usedIds,
      mediaFor: (file) => materializeImage(projectRoot, resolved, file),
    });
  } catch (error) {
    if (!(error instanceof ComponentAssetError)) throw error;
    return refusal(kind, error.message);
  }
  if (texts.plan) expanded = applySmartArtTexts(expanded, resolved.component, texts.plan, usedIds);
  for (const item of expanded) usedIds.add(item.elementId);
  return { elements: expanded, use: { ref, kitSha256: resolved.kit.kitSha256 } };
}

export function expandComponentElements(options: {
  projectRoot: string;
  contextEpochId: string;
  elements: readonly unknown[];
  kind: ComponentKind;
}): ComponentExpansion {
  const { projectRoot, contextEpochId, elements, kind } = options;
  if (!elements.some(isComponentReference)) {
    return { ok: true, elements: [...elements], uses: [] };
  }
  const usedIds = new Set<string>();
  for (const element of elements) {
    const id = record(element).elementId;
    if (typeof id === "string") usedIds.add(id);
  }
  const written: unknown[] = [];
  const uses: UsedComponent[] = [];
  for (const element of elements) {
    if (!isComponentReference(element)) {
      written.push(element);
      continue;
    }
    const expanded = expandReference(projectRoot, contextEpochId, element, kind, usedIds);
    if ("ok" in expanded) return expanded;
    written.push(...expanded.elements);
    if (!uses.some((use) => use.ref === expanded.use.ref)) uses.push(expanded.use);
  }
  return { ok: true, elements: written, uses };
}

export type ComponentScope = () => { projectRoot: string; contextEpochId: string };

export type ComponentArgsExpansion =
  | Readonly<{ ok: true; uses: readonly UsedComponent[] }>
  | Readonly<{
      ok: false;
      outcome: Readonly<{ outcome: "rejected"; error: string; detail: string; painted: false }>;
    }>;

/**
 * Expands the component references of a write_page/write_layout argument object in place. The
 * scope is read lazily, so a call without a reference never touches the project binding.
 */
export function expandComponentArgs(
  args: Record<string, unknown>,
  kind: ComponentKind,
  scope: ComponentScope,
): ComponentArgsExpansion {
  const elements = args.elements;
  if (!Array.isArray(elements) || !elements.some(isComponentReference)) return { ok: true, uses: [] };
  const expansion = expandComponentElements({ ...scope(), elements, kind });
  if (!expansion.ok) {
    return {
      ok: false,
      outcome: {
        outcome: "rejected",
        error: expansion.error,
        detail: expansion.detail,
        painted: false,
      },
    };
  }
  args.elements = expansion.elements;
  return { ok: true, uses: expansion.uses };
}

/** One `template.component-used` fact per distinct component; recorded only after the write succeeded. */
export function recordComponentUses(
  scope: ComponentScope,
  uses: readonly UsedComponent[],
  target: { pageId: string; revision: number } | { layoutId: string; revision?: number },
): void {
  if (!uses.length) return;
  const { projectRoot, contextEpochId } = scope();
  for (const use of uses) {
    recordTemplateComponentUsed(projectRoot, { contextEpochId, ...use, ...target });
  }
}

/** The page target of a write_page result that left a current page behind (written, unchanged or replayed). */
export function writtenPageTarget(result: unknown): { pageId: string; revision: number } | undefined {
  const outcome = record(result);
  if (!["written", "skipped-identical", "replayed"].includes(String(outcome.outcome))) return undefined;
  if (typeof outcome.pageId !== "string" || typeof outcome.revision !== "number") return undefined;
  return { pageId: outcome.pageId, revision: outcome.revision };
}

function findComponent(value: unknown, depth: number): string | undefined {
  if (depth > 12) return undefined;
  if (typeof value === "string") {
    if (!/^\s*[[{]/.test(value) || !value.includes("component")) return undefined;
    try {
      return findComponent(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findComponent(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  if (isComponentReference(value)) {
    const ref = (value as { ref?: unknown }).ref;
    return typeof ref === "string" && ref.trim() ? ref.trim() : "（未写 ref）";
  }
  for (const nested of Object.values(value)) {
    const found = findComponent(nested, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

const COMPONENT_WRITE_TOOLS: ReadonlySet<string> = new Set(["write_page", "write_layout"]);

/**
 * Every tool except write_page and write_layout refuses a component reference in its arguments,
 * in Chinese and naming the reference: components exist only as a request the Host expands.
 */
export function withComponentRefGuard(definition: SlideToolDefinition): SlideToolDefinition {
  if (COMPONENT_WRITE_TOOLS.has(definition.name)) return definition;
  const execute = definition.execute;
  const refuseComponentRef = (args: Record<string, unknown>): void => {
    const ref = findComponent(args, 0);
    if (ref !== undefined) {
      throw new SlideToolArgsError([
        `${definition.name} 不接受模板组件引用「${ref}」：组件只能写在 write_page 的 elements 里` +
          "（可以编辑版式的轮次里，版式的 elements 也可以），由 Host 展开成普通元素；其他工具只处理已经展开的元素。",
      ]);
    }
  };
  return {
    ...definition,
    validate(args) {
      refuseComponentRef(args);
      definition.validate?.(args);
    },
    async execute(args, ctx) {
      refuseComponentRef(args);
      return execute(args, ctx);
    },
  };
}
