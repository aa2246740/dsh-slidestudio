import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kindThemePackIssue, packColorWriteContext } from "./domain/theme-pack.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gateSource(here: string, rel: string): string {
  const file = path.join(here, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/**
 * The canonical write/director sources moved from the DSH host into the
 * host-neutral slide tool package; probe that copy, then the host copy.
 */
function slideToolSourcePath(here: string, file: string): string {
  const canonical = path.resolve(here, "../../slides-tools/dist", file);
  return fs.existsSync(canonical) ? canonical : path.resolve(here, "../../dsh-slides-host/dist", file);
}

export function probeTemplateDesignSourceFiles(here: string, failed: string[]): void {
  const themePack = [gateSource(here, "domain/theme-pack.js"), gateSource(here, "domain/theme-pack-color.js")].join(
    "\n",
  );
  const requiredThemePackSymbols = [
    "kindThemePackDisagreement",
    "kind_theme_pack",
    "missing_theme_pack",
    "warm-jade-annual-report",
    "pack_color",
    "extractColorPaletteHexes",
    "packColorWriteContextFrom",
    "packColorWriteContext",
    "USER_DESIGN_TINT_SHADE_PERCENTAGES",
    "userPaletteWithVariants",
  ];
  if (requiredThemePackSymbols.some((symbol) => !themePack.includes(symbol))) {
    failed.push("kind-theme-pack-symbols");
  }

  const ledger = [gateSource(here, "domain/run-ledger.js"), gateSource(here, "domain/run-ledger-policy.js")].join("\n");
  // The rendered-layout blocker is applied by layout-compose-gate.js, which run-ledger calls.
  const layoutGate = fs.readFileSync(path.join(here, "domain", "layout-compose-gate.js"), "utf8");
  if (
    !layoutGate.includes("renderedLayoutBlocksCompose") ||
    !ledger.includes("renderedLayoutBlockers") ||
    !ledger.includes("leftoverComposeBlockers") ||
    !ledger.includes("packColorWriteContext")
  ) {
    failed.push("compose-layout-vision-none");
  }

  const hostWritePath = slideToolSourcePath(here, "write-page.js");
  if (fs.existsSync(hostWritePath)) {
    // write-page takes its context from the shared helper; the helper holds the theme-pack call.
    const hostWrite = fs.readFileSync(hostWritePath, "utf8");
    const sharedContext = fs.readFileSync(path.join(here, "domain", "pack-color-context.js"), "utf8");
    if (
      !hostWrite.includes("projectPackColorContext") ||
      !sharedContext.includes("packColorWriteContext") ||
      !sharedContext.includes("projectRoot")
    ) {
      failed.push("host-pack-color-write");
    }
  }

  const preflightPath = path.join(here, "domain", "design-source-preflight.js");
  const preflight = fs.readFileSync(preflightPath, "utf8");
  // Receipt matching moved into a shared module so page dependencies and
  // design-source preflight cannot drift apart.
  const readReceipts = fs.readFileSync(path.join(here, "domain", "material-read-receipts.js"), "utf8");
  if (
    !readReceipts.includes("material.chunk-returned") ||
    !readReceipts.includes("materialSha256") ||
    !preflight.includes("required_source_chunks_unread") ||
    !preflight.includes("missingMaterialChunks")
  ) {
    failed.push("design-source-read-preflight");
  }
  const runBody = fs.readFileSync(path.join(here, "run.js"), "utf8");
  if (!runBody.includes("commitAdoptedDesignSources")) {
    failed.push("design-source-runtime-adoption");
  }
  // The Agent write path refuses a kind/theme pack through the shared guard module.
  const agentTools = fs.readFileSync(path.join(here, "domain", "agent-tools.js"), "utf8");
  const adoptedGuard = fs.readFileSync(path.join(here, "domain", "adopted-source-guard.js"), "utf8");
  if (!agentTools.includes("refuseIfKindThemePack") || !adoptedGuard.includes("kindThemePackIssue")) {
    failed.push("kind-theme-pack-write");
  }

  probeDirectorTemplateFit(here, failed);
}

function probeDirectorTemplateFit(here: string, failed: string[]): void {
  const directorPath = slideToolSourcePath(here, "director-brief.js");
  if (!fs.existsSync(directorPath)) return;
  const director = fs.readFileSync(directorPath, "utf8");
  if (
    !director.includes("Decide each attached PPTX separately") ||
    !director.includes("author every page") ||
    director.includes("templateFitFromBrief") ||
    director.includes("must include")
  ) {
    failed.push("director-template-fit-branch");
  }
}

function writePaletteFixture(projectRoot: string, materialId: string): void {
  const materialDir = path.join(projectRoot, "_agent", "materials", materialId);
  fs.mkdirSync(materialDir, { recursive: true });
  const original = Buffer.from("produce gate template");
  const markdown = Buffer.from("## 【Color Palette】\n- Primary: #123456\n- Paper: #FFFFFF\n");
  const sourceJson = Buffer.from(JSON.stringify({ themeColors: { primary: "#123456", paper: "#FFFFFF" } }));
  const derivative = Buffer.from(
    JSON.stringify({
      schema: "material-derivative/v1",
      materialId,
      kind: "deck-template",
      source: { sha256: sha256(original) },
      parser: { id: "pptx-ooxml-v1" },
      status: "ok",
    }),
  );
  fs.writeFileSync(path.join(materialDir, "original.pptx"), original);
  fs.writeFileSync(path.join(materialDir, "derivative.json"), derivative);
  fs.writeFileSync(path.join(materialDir, "design-source.md"), markdown);
  fs.writeFileSync(path.join(materialDir, "design-source.json"), sourceJson);
  fs.writeFileSync(
    path.join(materialDir, "receipt.json"),
    JSON.stringify({
      version: 1,
      id: materialId,
      name: materialId,
      kind: "deck-template",
      parser: "pptx-ooxml-v1",
      originalSha256: sha256(original),
      derivativeSha256: sha256(derivative),
      designSourceMdSha256: sha256(markdown),
      designSourceJsonSha256: sha256(sourceJson),
    }),
  );
  fs.writeFileSync(
    path.join(projectRoot, "_agent", "materials", "manifest.json"),
    JSON.stringify({
      version: 1,
      materials: [
        {
          id: materialId,
          name: materialId,
          kind: "deck-template",
          summaryZh: "produce gate template",
          parser: "pptx-ooxml-v1",
          sha256: sha256(original),
          parts: [],
        },
      ],
    }),
  );
}

export function probeTemplateDesignPaletteGate(boardBrief: string, failed: string[]): void {
  const sourceId = "material:produce-gate-design.pptx";
  const forbidden = kindThemePackIssue({
    brief: boardBrief,
    adoptedSourceIds: [sourceId, "work/warm-jade-annual-report"],
  });
  if (forbidden?.code !== "kind_theme_pack") {
    failed.push("user-design-does-not-exempt-forbidden-catalog-family");
  }

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "produce-user-design-"));
  const materialId = sourceId.slice("material:".length);
  const materialDir = path.join(projectRoot, "_agent", "materials", materialId);
  try {
    writePaletteFixture(projectRoot, materialId);
    const required = kindThemePackIssue({
      brief: boardBrief,
      adoptedSourceIds: [sourceId],
      projectRoot,
    });
    if (required) failed.push("user-design-satisfies-required-family");
    const context = packColorWriteContext([sourceId], projectRoot);
    if (
      context.materialError ||
      !context.adoptedPackHexes?.has("#123456") ||
      !context.adoptedPackHexes.has("#415D78") ||
      !context.adoptedPackHexes.has("#0E2A45")
    ) {
      failed.push("user-design-palette");
    }
    const mixed = packColorWriteContext([sourceId, "consulting/pine-green-strategy"], projectRoot);
    if (!mixed.adoptedPackHexes?.has("#03522C")) failed.push("user-design-mixed-catalog");

    fs.appendFileSync(path.join(materialDir, "design-source.md"), "\n- tampered: #3366FF\n");
    const tampered = packColorWriteContext([sourceId], projectRoot);
    if (!tampered.materialError || !tampered.materialError.includes("已采用的设计源")) {
      failed.push("user-design-tamper");
    }
  } catch {
    failed.push("user-design-palette-probe");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}
