import type { CommandReceipt } from "../types.js";
import { defaultTablePart, materialChunkCount, type MaterialRenderOptions } from "./material-content.js";
import { MaterialPackError, verifyMaterial } from "./material-pack.js";
import { missingChunksForPart, type MissingMaterialChunk } from "./material-read-receipts.js";
import { hasOfficeCharts, OFFICE_CHARTS_PART } from "./material-office-charts.js";
import { isPdfMaterial } from "./material-style-hints.js";
import { resolveOpenKimiPresetDesignSourceId, verifyOpenKimiPack } from "./openkimi-source-pack.js";
import { PALETTE_PART, paletteUnavailableReason } from "./palette-source.js";
import { checkPlanningReportRequirements } from "./report-authority.js";
import type { ReportRequirement } from "./report-requirements.js";
import { inspectRunLedger, readRunLedger } from "./run-ledger.js";
import { isReferenceReadFact } from "./reference-facts.js";
import { canonicalDesignSourceId } from "./theme-pack.js";
import { defaultTemplateAspects, sourceDesignAspects, type DesignAspects } from "./design-aspects.js";

export {
  REFERENCE_SECTION_UNREAD_ERROR,
  missingSectionChunks,
  pageReferenceSectionGroups,
  writePageReferencePreflight,
  type MissingReferenceSection,
} from "./reference-section-gate.js";

type MissingReferenceChunk = Readonly<{ sourceId: string; chunkIndex: number }>;

function uniqueMissingChunks(chunks: readonly MissingReferenceChunk[]): MissingReferenceChunk[] {
  const seen = new Set<string>();
  return chunks.filter((chunk) => {
    const key = `${chunk.sourceId}#${chunk.chunkIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One entry per material part chunk; a receipt is either current or it is not. */
function uniqueMaterialChunks(chunks: readonly MissingMaterialChunk[]): MissingMaterialChunk[] {
  const seen = new Set<string>();
  return chunks.filter((chunk) => {
    const key = `${chunk.materialId}\u0000${chunk.part ?? ""}\u0000${chunk.chunkIndex}\u0000${chunk.rows?.start ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidateAdoptedMissingChunks(
  repoRoot: string,
  projectRoot: string,
  adoptedSourceIds: readonly string[],
  contextEpochId?: string,
): MissingReferenceChunk[] {
  if (!adoptedSourceIds.length) return [];
  const ledger = readRunLedger(projectRoot);
  if (!ledger) return [];
  const pack = verifyOpenKimiPack(repoRoot);
  const resolved = new Set<string>();
  for (const raw of adoptedSourceIds) {
    const sourceId = raw.trim();
    if (!sourceId || sourceId === "agent-self-directed-plan") continue;
    if (sourceId.includes("material:") || canonicalDesignSourceId(sourceId)) continue;
    if (pack.entriesById.has(sourceId)) {
      resolved.add(sourceId);
      continue;
    }
    try {
      resolved.add(resolveOpenKimiPresetDesignSourceId(pack, sourceId));
    } catch {
      // A non-pack consulted source is not promoted to a new immutable requirement.
    }
  }
  const missing: MissingReferenceChunk[] = [];
  for (const sourceId of resolved) {
    const entry = pack.entriesById.get(sourceId);
    if (!entry) continue;
    for (const chunk of entry.chunks) {
      const read = ledger.facts.some(
        (fact) =>
          isReferenceReadFact(fact) &&
          (!contextEpochId || fact.contextEpochId === contextEpochId) &&
          fact.sourceId === sourceId &&
          fact.fileSha256 === entry.sha256 &&
          fact.chunkIndex === chunk.index &&
          fact.chunkSha256 === chunk.sha256,
      );
      if (!read) missing.push({ sourceId, chunkIndex: chunk.index });
    }
  }
  return missing;
}

function appendDataReadGaps(
  material: ReturnType<typeof verifyMaterial>,
  ledger: ReturnType<typeof readRunLedger>,
  contextEpochId: string,
  options: MaterialRenderOptions,
  missing: MissingMaterialChunk[],
  requiredParts: string[],
): void {
  if (material.kind === "deck-template") {
    const dataOptions = ["charts", "tables"]
      .map((part) => ({ part, count: materialChunkCount(material, part, options) }))
      .filter((option) => option.count > 0);
    if (!dataOptions.length) {
      throw new MaterialPackError(`资料「${material.name}」没有可读取的图表或表格数据，无法采用 data`);
    }
    const reads = dataOptions.map((option) => ({
      ...option,
      missing: missingChunksForPart(material, option.part, option.count, ledger, contextEpochId, options),
    }));
    if (!reads.some((option) => option.missing.length === 0)) {
      for (const option of reads) missing.push(...option.missing);
    }
  } else if (material.kind === "table" || material.kind === "document") {
    // CAP-33 / M8-SCR-12: the Office charts part is a valid data path
    // beside the original document-body / sheet-window read — an option,
    // never a must-read gate; a complete, current-epoch read of either
    // one qualifies. Chart-less files keep the single original part.
    const basePart = material.kind === "table" ? defaultTablePart(material) : "document";
    const chartsData = hasOfficeCharts(material);
    if (!chartsData) {
      const count = materialChunkCount(material, basePart, options);
      if (count < 1) {
        throw new MaterialPackError(`资料「${material.name}」没有可读取的 ${basePart} 内容，无法采用对应用途`);
      }
      requiredParts.push(basePart);
    } else {
      const dataOptions = [basePart, OFFICE_CHARTS_PART]
        .map((part) => ({ part, count: materialChunkCount(material, part, options) }))
        .filter((option) => option.count > 0);
      const reads = dataOptions.map((option) => ({
        ...option,
        missing: missingChunksForPart(material, option.part, option.count, ledger, contextEpochId, options),
      }));
      if (!reads.some((option) => option.missing.length === 0)) {
        for (const option of reads) missing.push(...option.missing);
      }
    }
  } else if (material.kind === "text") {
    requiredParts.push("text");
  }
}

function appendDeclaredReadGaps(
  material: ReturnType<typeof verifyMaterial>,
  aspects: ReturnType<typeof sourceDesignAspects>,
  ledger: ReturnType<typeof readRunLedger>,
  contextEpochId: string,
  options: MaterialRenderOptions,
  missing: MissingMaterialChunk[],
): void {
  const visual = aspects.some(
    (aspect) =>
      aspect === "palette" ||
      aspect === "fonts" ||
      aspect === "logo" ||
      aspect === "layouts" ||
      aspect === "decorations" ||
      aspect === "photos",
  );
  const requiredParts: string[] = [];
  if (visual) {
    if (material.kind === "deck-template") requiredParts.push("design");
    else if (material.kind === "image" || isPdfMaterial(material)) {
      const unavailable = paletteUnavailableReason(material);
      if (unavailable) throw new MaterialPackError(unavailable);
      requiredParts.push(PALETTE_PART);
    }
  }
  if (aspects.includes("content")) {
    requiredParts.push(material.kind === "deck-template" ? "slides" : material.kind === "text" ? "text" : "document");
  }
  if (aspects.includes("data")) {
    appendDataReadGaps(material, ledger, contextEpochId, options, missing, requiredParts);
  }

  for (const part of new Set(requiredParts)) {
    const count = materialChunkCount(material, part, options);
    if (count < 1) {
      throw new MaterialPackError(`资料「${material.name}」没有可读取的 ${part} 内容，无法采用对应用途`);
    }
    missing.push(...missingChunksForPart(material, part, count, ledger, contextEpochId, options));
  }
}

function candidateMaterialMissingChunks(
  projectRoot: string,
  adoptedSourceIds: readonly string[],
  contextEpochId: string,
  designAspects: DesignAspects | undefined,
  options: MaterialRenderOptions,
): { missing: MissingMaterialChunk[]; error?: { sourceId: string; detail: string } } {
  const ledger = readRunLedger(projectRoot);
  const missing: MissingMaterialChunk[] = [];
  const declaredSources = Array.isArray(designAspects) ? designAspects.map((entry) => entry.source) : [];
  for (const raw of new Set([...adoptedSourceIds, ...declaredSources])) {
    const submitted = raw.trim();
    if (!submitted.includes("material:")) continue;
    const sourceId = canonicalDesignSourceId(submitted);
    if (!sourceId) {
      return {
        missing,
        error: {
          sourceId: submitted,
          detail: "编号不是合法的 material:<id>，不能包含 ..、/ 或重复前缀",
        },
      };
    }
    const materialId = sourceId.slice("material:".length);
    try {
      const material = verifyMaterial(projectRoot, materialId);
      const fallback = material.kind === "deck-template" ? defaultTemplateAspects(material) : [];
      const aspects = sourceDesignAspects(designAspects, sourceId, fallback);
      const selected = adoptedSourceIds.some((adopted) => canonicalDesignSourceId(adopted) === sourceId);
      if (selected && material.kind !== "deck-template" && !aspects.length) {
        const isPdf = isPdfMaterial(material);
        throw new MaterialPackError(
          isPdf
            ? `资料「${material.name}」是 PDF，不是 PPTX 模板，不会自动采用配色、字体或 Logo；PDF 风格线索只作提示。在无目录风格限制时，用 designAspects 明确声明 palette；若用户明确要求按它配色，先按用户原话声明 designAuthority: material:${material.id}。也可以声明 content/data 并先读取对应分段`
            : material.kind === "image"
              ? `图片「${material.name}」不会被自动当作配色来源。要按它的颜色设计，请在 designAspects 里声明 [{source:"material:${material.id}",aspects:["palette"]}] 并先读取 palette 分段；只想把它放进页面，不必采用，直接用 mediaSrc`
              : `资料「${material.name}」不是 PPTX 模板，不会自动套用配色、字体或 Logo 默认用途；请在 designAspects 中明确声明用途`,
        );
      }
      appendDeclaredReadGaps(material, aspects, ledger, contextEpochId, options, missing);
    } catch (error) {
      return {
        missing,
        error: {
          sourceId: submitted,
          detail: error instanceof Error ? error.message : `设计源「${submitted}」校验失败，请重新上传后再试`,
        },
      };
    }
  }
  return { missing };
}

export function planningReferencePreflight(
  repoRoot: string,
  projectRoot: string,
  name: "commit_design" | "write_todo",
  adoptedSourceIds: readonly string[],
  contextEpochId: string,
  designAspects: DesignAspects | undefined,
  options: MaterialRenderOptions,
  reportRequirements: readonly ReportRequirement[] = [],
): CommandReceipt | undefined {
  const status = inspectRunLedger(projectRoot);
  const materialPreflight = candidateMaterialMissingChunks(
    projectRoot,
    adoptedSourceIds,
    contextEpochId,
    designAspects,
    options,
  );
  if (materialPreflight.error) {
    return {
      ok: false,
      name,
      summary: "user design source invalid",
      detail: `设计源 ${materialPreflight.error.sourceId} 无法采用：${materialPreflight.error.detail}`,
      payload: {
        error: "material_design_source_invalid",
        sourceId: materialPreflight.error.sourceId,
        next: "list_materials",
      },
    };
  }
  const requirementCheck = checkPlanningReportRequirements(projectRoot, contextEpochId, reportRequirements, options);
  if (requirementCheck.unreadable.length) {
    const parts = requirementCheck.unreadable.slice(0, 4).map(({ dependency, detail }) => ({
      materialId: dependency.materialId,
      part: dependency.part,
      reason: dependency.reason,
      detail,
    }));
    return {
      ok: false,
      name,
      summary: "report requirement material unreadable",
      detail: `本次要求依赖的资料分部无法读取：${parts
        .map((entry) => `material:${entry.materialId} 的 ${entry.part}（${entry.detail}）`)
        .join(
          "；",
        )}。请先说明这个限制，或只依据可读材料继续；如果它会改变结果且仍不确定，使用 ask_user_question 向用户澄清。`,
      payload: {
        error: "report_requirement_unreadable",
        next: "ask_user_question",
        unreadable: parts,
      },
    };
  }
  if (!status.initialized && !materialPreflight.missing.length && !requirementCheck.missing.length) return undefined;
  const missingReferenceChunks = uniqueMissingChunks([
    ...status.missingReferenceChunks,
    ...candidateAdoptedMissingChunks(repoRoot, projectRoot, adoptedSourceIds, contextEpochId),
  ]);
  const missingMaterialChunks = uniqueMaterialChunks([
    ...materialPreflight.missing,
    ...requirementCheck.missing.map((chunk) => ({
      sourceId: `material:${chunk.materialId}`,
      materialId: chunk.materialId,
      chunkIndex: chunk.chunkIndex,
      ...(chunk.part ? { part: chunk.part } : {}),
      ...(chunk.rows ? { rows: chunk.rows } : {}),
    })),
  ]);
  if (!missingReferenceChunks.length && !missingMaterialChunks.length) return undefined;
  const exact = missingReferenceChunks.map((chunk) => `${chunk.sourceId}#${chunk.chunkIndex}`);
  const materialExact = missingMaterialChunks.map((chunk) =>
    chunk.part === PALETTE_PART
      ? `${chunk.sourceId}#palette`
      : `${chunk.sourceId}${chunk.part ? `（part: "${chunk.part}"）` : ""}#${chunk.chunkIndex}${
          chunk.rows
            ? `（缺少第 ${chunk.rows.start}–${chunk.rows.end} 行，read_material 用 offset=${chunk.rows.start - 1}，单次最多 200 行）`
            : ""
        }`,
  );
  const instructions = [
    ...(exact.length ? [`请调用 read_reference 读取：${exact.join("、")}`] : []),
    ...(materialExact.length
      ? [
          `请调用 read_material，未标注的 part 为 "design"，读取：${materialExact.join("、")}` +
            (materialExact.some((entry) => entry.endsWith("#palette"))
              ? '（#palette 表示 part:"palette" 的配色分段）'
              : ""),
        ]
      : []),
  ];
  const needsDataRead = missingMaterialChunks.some((chunk) => chunk.part === "charts" || chunk.part === "tables");
  const requirementParts = [
    ...new Set(
      requirementCheck.missing.map(
        (chunk) =>
          `material:${chunk.materialId} 的 ${chunk.part ?? "design"}${
            chunk.rows ? ` 第 ${chunk.rows.start}–${chunk.rows.end} 行` : ""
          }（${chunk.reason}${chunk.sourcePages?.length ? `，源页 ${chunk.sourcePages.join("、")}` : ""}）`,
      ),
    ),
  ];
  return {
    ok: false,
    name,
    summary: "required references unread",
    detail: `在规划前，请先读完本轮上下文中每一个必需的设计源分块。${
      needsDataRead ? "声明 data 前，请先读取 charts 或 tables 的完整分段。" : ""
    }${requirementParts.length ? `本次明确要求依赖的分部尚未读完：${requirementParts.join("；")}。逐页职责必须读 slides，不能只读 design。` : ""}${instructions.join(" ")}`,
    payload: {
      error: "required_source_chunks_unread",
      next: missingMaterialChunks.length ? "read_material" : "read_reference",
      referencesComplete: false,
      missingReferenceChunks,
      missingMaterialChunks,
      ...(requirementCheck.missing.length
        ? {
            reportRequirementChunks: requirementCheck.missing.map((chunk) => ({
              materialId: chunk.materialId,
              part: chunk.part,
              chunkIndex: chunk.chunkIndex,
              ...(chunk.rows ? { rows: chunk.rows } : {}),
              reason: chunk.reason,
              ...(chunk.sourcePages ? { sourcePages: chunk.sourcePages } : {}),
            })),
          }
        : {}),
    },
  };
}
