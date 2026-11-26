import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type PiImageKind = "page" | "design-reference" | "deck-overview";

export type PiImageContentPayload = Readonly<{
  imageKind: PiImageKind;
  src: string;
  sha256: string;
  deliveryToken: string;
  subjectId: string;
  mimeType: "image/png" | "image/jpeg";
  pageId?: string;
  pageRevision?: number;
}>;

export type PiVerifiedImageContent = Readonly<{
  content: readonly [
    Readonly<{ type: "text"; text: string }>,
    Readonly<{ type: "image"; data: string; mimeType: "image/png" | "image/jpeg" }>,
  ];
  bytes: Buffer;
  payload: PiImageContentPayload;
}>;

export type PiRenderedPageContent = PiVerifiedImageContent &
  Readonly<{
    payload: PiImageContentPayload & Readonly<{ imageKind: "page"; pageId: string; pageRevision: number }>;
  }>;

function parsePayload(raw: Record<string, unknown>): PiImageContentPayload {
  const legacyPage = raw.imageKind === undefined && raw.pageId !== undefined;
  const imageKind = legacyPage ? "page" : raw.imageKind;
  if (imageKind !== "page" && imageKind !== "design-reference" && imageKind !== "deck-overview") {
    throw new Error("image tool did not return a known imageKind");
  }
  const mimeType = raw.mimeType ?? (imageKind === "design-reference" ? "image/jpeg" : "image/png");
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
    throw new Error("image tool did not return a supported MIME type");
  }
  const pageId = String(raw.pageId ?? "").trim();
  const pageRevision = Number(raw.pageRevision);
  const payload: PiImageContentPayload = {
    imageKind,
    src: String(raw.src ?? "").trim(),
    sha256: String(raw.sha256 ?? raw.rasterSha256 ?? "").trim(),
    deliveryToken: String(raw.deliveryToken ?? "").trim(),
    subjectId: String(raw.subjectId ?? raw.pageId ?? "").trim(),
    mimeType,
    ...(pageId ? { pageId } : {}),
    ...(Number.isSafeInteger(pageRevision) ? { pageRevision } : {}),
  };
  if (!payload.src || !/^[a-f0-9]{64}$/.test(payload.sha256) || !payload.deliveryToken || !payload.subjectId) {
    throw new Error("image tool did not return verifiable image-delivery metadata");
  }
  if (
    imageKind === "page" &&
    (!payload.pageId || !Number.isSafeInteger(payload.pageRevision) || Number(payload.pageRevision) < 1)
  ) {
    throw new Error("render_page did not return verifiable image-delivery metadata");
  }
  return payload;
}

function safeImageFile(cwd: string, src: string): string {
  const root = path.resolve(cwd);
  const file = path.resolve(root, src);
  if (file === root || !file.startsWith(`${root}${path.sep}`)) {
    throw new Error(`image tool returned a path outside the project: ${src}`);
  }
  return file;
}

export function buildPiImageContent(
  cwd: string,
  toolText: string,
  rawPayload: Record<string, unknown>,
): PiVerifiedImageContent {
  const payload = parsePayload(rawPayload);
  const bytes = fs.readFileSync(safeImageFile(cwd, payload.src));
  const actualSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== payload.sha256) {
    throw new Error(`image hash mismatch for ${payload.subjectId}`);
  }
  const instruction =
    payload.imageKind === "page"
      ? `The attached PNG is ${payload.pageId} revision ${payload.pageRevision}.\nInspect it, then call review_page with this exact pageId, revision, and deliveryToken.`
      : payload.imageKind === "design-reference"
        ? "The attached JPEG is the exact selected OpenKimi theme preview. Inspect its hierarchy, composition, typography, color-area discipline, density, and recurring visual memory before commit_design. Do not copy its literal text or data."
        : "The attached PNG is the current full-deck overview in todo order. Inspect the deck as one sequence, then call review_deck with this exact deliveryToken.";
  const text = [toolText, "", instruction, `DELIVERY_TOKEN: ${payload.deliveryToken}`].join("\n");
  return {
    content: [
      { type: "text", text },
      { type: "image", data: bytes.toString("base64"), mimeType: payload.mimeType },
    ],
    bytes,
    payload,
  };
}

export function buildPiRenderedPageContent(
  cwd: string,
  toolText: string,
  rawPayload: Record<string, unknown>,
): PiRenderedPageContent {
  const result = buildPiImageContent(cwd, toolText, rawPayload);
  if (result.payload.imageKind !== "page" || !result.payload.pageId || !result.payload.pageRevision) {
    throw new Error("render_page did not return a page image");
  }
  return result as PiRenderedPageContent;
}
