import crypto from "node:crypto";
import {
  appendFact,
  bytesSha256,
  factId,
  nowIso,
  readRunLedger,
  RENDERED_LAYOUT_GATE_VERSION,
  type ImageEmittedFact,
  type ImagePreparedFact,
  type PageLayoutIssue,
  type PageRevisionFact,
  type RasterFact,
  type RunToolContext,
} from "./run-ledger.js";

/**
 * Page raster and image-delivery facts. Split out of run-ledger.ts to keep that module under
 * its budget.
 */
export function recordRaster(
  root: string,
  page: PageRevisionFact,
  input: Readonly<{
    bytes: Buffer;
    src: string;
    width: number;
    height: number;
    layoutStatus: RasterFact["layoutStatus"];
    layoutIssues: readonly PageLayoutIssue[];
    /** The masters and layouts the page showed when rendered; absent for rasters before layouts. */
    chromeSha256?: string;
  }>,
): { fact: RasterFact; deliveryToken: string } {
  const rasterSha256 = bytesSha256(input.bytes);
  const payload = {
    pageId: page.pageId,
    revision: page.revision,
    pageSha256: page.pageSha256,
    rasterSha256,
    src: input.src,
    width: input.width,
    height: input.height,
    layoutGateVersion: RENDERED_LAYOUT_GATE_VERSION,
    layoutStatus: input.layoutStatus,
    layoutIssues: input.layoutIssues,
    ...(input.chromeSha256 === undefined ? {} : { chromeSha256: input.chromeSha256 }),
  };
  const fact: RasterFact = {
    type: "page.raster-committed",
    factId: factId("page.raster-committed", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return { fact, deliveryToken: crypto.randomUUID() };
}

export function recordImagePrepared(
  root: string,
  context: RunToolContext,
  raster: RasterFact,
  deliveryToken: string,
): ImagePreparedFact {
  const payload = {
    contextEpochId: context.contextEpochId,
    pageId: raster.pageId,
    revision: raster.revision,
    pageSha256: raster.pageSha256,
    rasterSha256: raster.rasterSha256,
    deliveryToken,
  };
  const fact: ImagePreparedFact = {
    type: "page.image-result-prepared",
    factId: factId("page.image-result-prepared", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

export function recordImageEmitted(root: string, context: RunToolContext, deliveryToken: string): ImageEmittedFact {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const prepared = [...ledger.facts]
    .reverse()
    .find(
      (fact): fact is ImagePreparedFact =>
        fact.type === "page.image-result-prepared" && fact.deliveryToken === deliveryToken,
    );
  if (!prepared) throw new Error("image delivery token is not prepared for this context epoch");
  const payload = {
    contextEpochId: context.contextEpochId,
    commandId: context.commandId,
    pageId: prepared.pageId,
    revision: prepared.revision,
    pageSha256: prepared.pageSha256,
    rasterSha256: prepared.rasterSha256,
    deliveryToken,
  };
  const fact: ImageEmittedFact = {
    type: "page.image-content-emitted",
    factId: factId("page.image-content-emitted", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}
