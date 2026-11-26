import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportProjectToPptx, validateExportReport, type ExportResult } from "@open-slidestudio/exporter-native";
import { calculateMaterialFingerprint, loadProject, withProjectWriteLock } from "@open-slidestudio/pptd-v2";
import { inspectRunLedger, readRunLedger, recordExportSucceeded } from "./domain/run-ledger.js";
import { writeFileAtomic, writeJsonAtomic } from "./domain/atomic-file.js";
import type { CommandContext, ExecutionDelivery, WriteAuthorityRunner } from "./types.js";
import { runWithWriteAuthority } from "./write-authority.js";

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function readVerifiedDelivery(root: string): ExecutionDelivery | null {
  const fact = readRunLedger(root)
    ?.facts.filter((row) => row.type === "export.succeeded")
    .at(-1);
  if (!fact || fact.type !== "export.succeeded") return null;
  const artifact = path.join(root, fact.artifactPath);
  const report = path.join(root, fact.reportPath);
  try {
    if (!fs.existsSync(artifact) || !fs.existsSync(report)) return null;
    if (fs.lstatSync(artifact).isSymbolicLink() || fs.lstatSync(report).isSymbolicLink()) return null;
    const artifactBytes = fs.readFileSync(artifact);
    const reportBytes = fs.readFileSync(report);
    if (artifactBytes.length !== fact.artifactBytes || sha256(artifactBytes) !== fact.artifactSha256) return null;
    if (sha256(reportBytes) !== fact.reportSha256) return null;
    const parsed = JSON.parse(reportBytes.toString("utf8")) as Record<string, unknown>;
    const validation = validateExportReport(parsed);
    if (!validation.ok) return null;
    const fingerprint = calculateMaterialFingerprint(root);
    if (fingerprint !== fact.materialFingerprint) return null;
    if (typeof parsed.materialFingerprint === "string" && parsed.materialFingerprint !== fingerprint) return null;
    return {
      artifactPath: fact.artifactPath,
      artifactSha256: fact.artifactSha256,
      artifactBytes: fact.artifactBytes,
      reportPath: fact.reportPath,
      reportSha256: fact.reportSha256,
      slideCount: fact.slideCount,
      inputFingerprint: fact.materialFingerprint,
    };
  } catch {
    return null;
  }
}

function copyRegularFile(src: string, dest: string): void {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`export snapshot refuses a non-regular file: ${path.basename(src)}`);
  }
  fs.copyFileSync(src, dest);
}

/**
 * Copies the deck, pages and media into `snapDir`. A failed copy removes the
 * partial snapshot before the error propagates, so nothing stays in the temp root.
 */
function copyExportSnapshot(root: string, snapDir: string): void {
  try {
    fs.mkdirSync(snapDir, { recursive: true });
    copyRegularFile(path.join(root, "deck.pptd"), path.join(snapDir, "deck.pptd"));

    const pagesDir = path.join(root, "pages");
    const snapPagesDir = path.join(snapDir, "pages");
    fs.mkdirSync(snapPagesDir, { recursive: true });
    if (fs.existsSync(pagesDir)) {
      for (const file of fs.readdirSync(pagesDir)) {
        if (file.endsWith(".page")) {
          copyRegularFile(path.join(pagesDir, file), path.join(snapPagesDir, file));
        }
      }
    }

    const mediaDir = path.join(root, "media");
    const snapMediaDir = path.join(snapDir, "media");
    fs.mkdirSync(snapMediaDir, { recursive: true });
    if (fs.existsSync(mediaDir)) {
      for (const file of fs.readdirSync(mediaDir)) {
        const srcPath = path.join(mediaDir, file);
        if (fs.lstatSync(srcPath).isFile() && !fs.lstatSync(srcPath).isSymbolicLink()) {
          copyRegularFile(srcPath, path.join(snapMediaDir, file));
        }
      }
    }
  } catch (error) {
    fs.rmSync(snapDir, { recursive: true, force: true });
    throw error;
  }
}

export async function exportEditablePptx(
  projectRoot: string,
  context?:
    | CommandContext
    | { toolCallId?: string; contextEpochId?: string; sessionId?: string; runAuthorizedWrite?: WriteAuthorityRunner },
): Promise<{
  ok: boolean;
  summary: string;
  detail: string;
  payload: Record<string, unknown>;
}> {
  const root = path.resolve(projectRoot);

  type SnapshotPrep =
    | { ok: true; snapDir: string; initialFingerprint: string; opId: string; filename: string }
    | { ok: false; summary: string; detail: string; payload: Record<string, unknown> };

  // Phase 1: Under synchronous write lock, verify compose seal and copy immutable export snapshot.
  const prep: SnapshotPrep = withProjectWriteLock(root, () => {
    let project;
    try {
      project = loadProject(root);
    } catch (err) {
      return {
        ok: false,
        summary: "failed to load project",
        detail: err instanceof Error ? err.message : String(err),
        payload: { error: "load_project_failed" },
      };
    }
    if (!inspectRunLedger(root).composed) {
      return {
        ok: false,
        summary: "compose seal required",
        detail: "export requires a current compose_deck seal for the present page revisions",
        payload: { error: "compose_seal_required" },
      };
    }
    const initialFingerprint = calculateMaterialFingerprint(root);
    const opId = `exp-${crypto.randomUUID()}`;
    const snapDir = path.join(os.tmpdir(), `pptd-export-snap-${opId}`);
    copyExportSnapshot(root, snapDir);

    const title = project.presentation.title ?? "deck";
    const filename = `${title.replace(/[^\w\u4e00-\u9fff-]+/g, "_")}.pptx`;
    return {
      ok: true,
      snapDir,
      initialFingerprint,
      opId,
      filename,
    };
  });

  if (!prep.ok) {
    return {
      ok: false,
      summary: prep.summary,
      detail: prep.detail,
      payload: prep.payload,
    };
  }

  // Phase 2: Outside the lock, run asynchronous export on the snapshot.
  let exportResult: ExportResult;
  try {
    exportResult = await exportProjectToPptx(prep.snapDir);
  } catch (err) {
    return {
      ok: false,
      summary: "native export threw error",
      detail: err instanceof Error ? err.message : String(err),
      payload: { error: "export_threw_error" },
    };
  } finally {
    fs.rmSync(prep.snapDir, { recursive: true, force: true });
  }

  const validation = validateExportReport(exportResult.report);
  if (!validation.ok) {
    return {
      ok: false,
      summary: "export report validation failed",
      detail: validation.reason,
      payload: {
        report: exportResult.report,
        hardDegradation: validation.hardDegradation,
      },
    };
  }

  // Phase 3: Under synchronous write lock, CAS material fingerprint and publish verified artifacts.
  type PublishResult =
    | {
        ok: true;
        relativeArtifact: string;
        relativeReport: string;
        artifactSha256: string;
        reportSha256: string;
        artifactBytes: number;
        materialFingerprint: string;
      }
    | { ok: false; summary: string; detail: string; payload: Record<string, unknown> };

  const authorizedPublish = runWithWriteAuthority(root, context?.runAuthorizedWrite, (): PublishResult =>
    withProjectWriteLock(root, () => {
      const currentFingerprint = calculateMaterialFingerprint(root);
      if (currentFingerprint !== prep.initialFingerprint) {
        return {
          ok: false,
          summary: "document modified during export",
          detail: "material fingerprint mismatch: document was modified while exporter was running",
          payload: { error: "material_fingerprint_mismatch" },
        };
      }

      const dest = path.join(root, "_agent", "export", prep.opId);
      fs.mkdirSync(dest, { recursive: true });
      const file = path.join(dest, prep.filename);
      writeFileAtomic(file, exportResult.data);
      const relativeArtifact = path.relative(root, file);

      const artifactBytes = exportResult.data.byteLength;
      const artifactSha256 = sha256(exportResult.data);

      const marker = path.join(dest, "export-report.json");
      const relativeReport = path.relative(root, marker);
      const reportData = {
        ...exportResult.report,
        src: relativeArtifact,
        artifactSha256,
        materialFingerprint: currentFingerprint,
      };
      const reportContent = `${JSON.stringify(reportData, null, 2)}\n`;
      writeFileAtomic(marker, reportContent);
      const reportSha256 = sha256(Buffer.from(reportContent, "utf8"));
      const onDiskArtifact = fs.readFileSync(file);
      const onDiskReport = fs.readFileSync(marker);
      if (onDiskArtifact.length === 0 || sha256(onDiskArtifact) !== artifactSha256) {
        return {
          ok: false,
          summary: "published artifact missing",
          detail: `artifact ${relativeArtifact} does not match the just-written bytes`,
          payload: { error: "published_artifact_missing" },
        };
      }
      if (onDiskReport.length === 0 || sha256(onDiskReport) !== reportSha256) {
        return {
          ok: false,
          summary: "published report missing",
          detail: `report ${relativeReport} does not match the just-written bytes`,
          payload: { error: "published_report_missing" },
        };
      }
      if (!validateExportReport(JSON.parse(onDiskReport.toString("utf8"))).ok) {
        return {
          ok: false,
          summary: "published report invalid",
          detail: "re-read export report failed shared acceptance",
          payload: { error: "published_report_invalid" },
        };
      }
      const receipt = {
        opId: prep.opId,
        artifactPath: relativeArtifact,
        artifactSha256,
        artifactBytes,
        reportPath: relativeReport,
        reportSha256,
        slideCount: exportResult.report.slideCount,
        inputFingerprint: currentFingerprint,
      };
      writeJsonAtomic(path.join(dest, "receipt.json"), receipt);
      writeJsonAtomic(path.join(root, "_agent", "export", "current.json"), receipt);

      // Record export fact in ledger
      const ledger = readRunLedger(root);
      if (ledger) {
        const toolCallId =
          context && "toolCallId" in context && typeof context.toolCallId === "string" && context.toolCallId
            ? context.toolCallId
            : prep.opId;
        const contextEpochId =
          context && "contextEpochId" in context && typeof context.contextEpochId === "string" && context.contextEpochId
            ? context.contextEpochId
            : "";
        recordExportSucceeded(
          root,
          {
            commandId: toolCallId,
            contextEpochId,
          },
          {
            commandId: toolCallId,
            artifactPath: relativeArtifact,
            artifactSha256,
            artifactBytes,
            reportPath: relativeReport,
            reportSha256,
            slideCount: exportResult.report.slideCount,
            materialFingerprint: currentFingerprint,
            producer: "agent-tool",
          },
        );
      }

      return {
        ok: true,
        relativeArtifact,
        relativeReport,
        artifactSha256,
        reportSha256,
        artifactBytes,
        materialFingerprint: currentFingerprint,
      };
    }),
  );
  const publish: PublishResult = authorizedPublish.ok ? authorizedPublish.value : authorizedPublish;

  if (!publish.ok) {
    return {
      ok: false,
      summary: publish.summary,
      detail: publish.detail,
      payload: publish.payload,
    };
  }

  return {
    ok: true,
    summary: `${exportResult.report.slideCount} slides · coverage ${exportResult.report.nativeCoverage}`,
    detail: `wrote ${publish.relativeArtifact} bytes=${publish.artifactBytes}`,
    payload: {
      src: publish.relativeArtifact,
      report: exportResult.report,
      artifactPath: publish.relativeArtifact,
      artifactSha256: publish.artifactSha256,
      artifactBytes: publish.artifactBytes,
      reportPath: publish.relativeReport,
      reportSha256: publish.reportSha256,
      slideCount: exportResult.report.slideCount,
      materialFingerprint: publish.materialFingerprint,
    },
  };
}
