import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type EditorAttachment as MaterialAttachment,
  type MaterialKind,
  type MaterialPart,
} from "@open-slidestudio/slides-tools";
import { MATERIAL_KINDS, materialManifestEntry } from "@open-slidestudio/slides-tools/internal/material-input";

export const MAX_ATTACHMENT_CONTEXT_CHARS = 48_000;
export const inputSha256 = (value: string | Buffer): string => crypto.createHash("sha256").update(value).digest("hex");
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export type GenerationFormat = Readonly<{ kind: "Slides"; layout: "16:9" | "4:3"; size: readonly [number, number] }>;
export function generationFormat(kind: unknown, layout: unknown): GenerationFormat {
  if (kind !== undefined && kind !== "Slides")
    throw new Error("kind must be Slides; Docs and Report are not supported");
  if (layout !== undefined && layout !== "16:9" && layout !== "4:3")
    throw new Error("layout must be 16:9 or 4:3; Adaptive is not supported");
  return { kind: "Slides", layout: layout ?? "16:9", size: layout === "4:3" ? [720, 540] : [960, 540] };
}

type AttachmentReceipt = Pick<MaterialAttachment, "id" | "name" | "bytes" | "storeId" | "originalSha256">;
type MaterialDetails = Pick<
  MaterialAttachment,
  "summaryZh" | "needsVision" | "parts" | "mediaSrc" | "designSourceMdSha256" | "designSourceJsonSha256"
>;
type MaterialIdentity = Pick<MaterialAttachment, "kind" | "derivativeSha256"> & MaterialDetails;

type InlineAttachment = Readonly<{
  text: string;
  textSha256: string;
  chars: number;
  parser: "utf8-full-v1";
  parsed: true;
  complete: true;
  materialParser?: string;
}>;

type MaterialOnlyAttachment = MaterialIdentity &
  Readonly<{
    parser: string;
    status: "parsed";
    text?: never;
    textSha256?: never;
    chars?: number;
    materialParser?: never;
  }>;

export type EditorAttachment = AttachmentReceipt &
  ((InlineAttachment & Partial<MaterialIdentity>) | MaterialOnlyAttachment);

function invalidReceipt(id: string): never {
  throw new Error(`attachment ${id} lacks a complete, owned and hash-verified parsing receipt; re-upload it`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMaterialKind(value: unknown): value is MaterialKind {
  return typeof value === "string" && MATERIAL_KINDS.has(value);
}

function isMaterialParser(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value !== "utf8-full-v1";
}

function isMaterialPart(value: unknown): value is MaterialPart {
  if (!isRecord(value) || typeof value.part !== "string" || typeof value.label !== "string") return false;
  const { part, label, hidden, format, ...counts } = value;
  return (
    (hidden === undefined || typeof hidden === "boolean") &&
    (format === undefined || typeof format === "string") &&
    Object.values(counts).every((value) => value === undefined || Number.isSafeInteger(value))
  );
}

function materialDetails(body: Record<string, unknown>): Partial<MaterialDetails> {
  const summaryZh =
    typeof body.summaryZh === "string" ? body.summaryZh : isRecord(body.summary) ? body.summary.zh : undefined;
  return {
    ...(typeof summaryZh === "string" ? { summaryZh } : {}),
    ...(body.needsVision === undefined ? {} : { needsVision: Boolean(body.needsVision) }),
    ...(Array.isArray(body.parts) && body.parts.every(isMaterialPart) ? { parts: body.parts } : {}),
    ...(typeof body.mediaSrc === "string" ? { mediaSrc: body.mediaSrc } : {}),
    ...(isHash(body.designSourceMdSha256) ? { designSourceMdSha256: body.designSourceMdSha256 } : {}),
    ...(isHash(body.designSourceJsonSha256) ? { designSourceJsonSha256: body.designSourceJsonSha256 } : {}),
  };
}

function verifiedInline(receipt: AttachmentReceipt, body: Record<string, unknown>): EditorAttachment {
  if (
    body.parsed !== true ||
    body.complete !== true ||
    typeof body.text !== "string" ||
    !body.text.trim() ||
    !isHash(body.textSha256) ||
    body.textSha256 !== inputSha256(body.text) ||
    body.chars !== body.text.length
  ) {
    return invalidReceipt(receipt.id);
  }
  const inline: AttachmentReceipt & InlineAttachment = {
    ...receipt,
    text: body.text,
    chars: body.chars,
    textSha256: body.textSha256,
    parser: "utf8-full-v1",
    parsed: true,
    complete: true,
  };
  const { kind, materialParser, derivativeSha256 } = body;
  const validKind = isMaterialKind(kind);
  const validParser = isMaterialParser(materialParser);
  const validDerivative = isHash(derivativeSha256);
  if (derivativeSha256 !== undefined && !(validKind && validParser && validDerivative)) {
    return invalidReceipt(receipt.id);
  }
  return {
    ...inline,
    ...materialDetails(body),
    ...(validKind ? { kind } : {}),
    ...(validParser ? { materialParser } : {}),
    ...(validDerivative ? { derivativeSha256 } : {}),
  };
}

export function verifiedAttachment(id: string, body: Record<string, unknown>): EditorAttachment {
  const { name, storeId, originalSha256, bytes, kind, parser, derivativeSha256, chars } = body;
  if (
    body.id !== id ||
    body.clipped === true ||
    body.truncated === true ||
    body.ownerId !== undefined ||
    typeof name !== "string" ||
    !name.trim() ||
    !isHash(storeId) ||
    !isHash(originalSha256) ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0
  ) {
    return invalidReceipt(id);
  }
  const receipt = { id, name, storeId, originalSha256, bytes };
  if (parser === "utf8-full-v1") return verifiedInline(receipt, body);
  if (body.status !== "parsed" || !isMaterialKind(kind) || !isMaterialParser(parser) || !isHash(derivativeSha256)) {
    return invalidReceipt(id);
  }
  return {
    ...receipt,
    summaryZh: "",
    needsVision: false,
    ...materialDetails(body),
    kind,
    parser,
    derivativeSha256,
    status: "parsed",
    ...(typeof chars === "number" && Number.isSafeInteger(chars) && chars >= 0 ? { chars } : {}),
  };
}

export function toMaterialAttachment(attachment: EditorAttachment): MaterialAttachment | undefined {
  const {
    id,
    name,
    kind,
    bytes,
    storeId,
    originalSha256,
    derivativeSha256,
    text,
    textSha256,
    chars,
    summaryZh = "",
    needsVision = false,
    parts,
    mediaSrc,
    designSourceMdSha256,
    designSourceJsonSha256,
  } = attachment;
  const parser = attachment.materialParser ?? attachment.parser;
  if (!isMaterialKind(kind) || !isHash(derivativeSha256) || !isMaterialParser(parser)) return undefined;
  return {
    id,
    name,
    kind,
    parser,
    bytes,
    storeId,
    originalSha256,
    derivativeSha256,
    summaryZh,
    needsVision,
    parts,
    mediaSrc,
    designSourceMdSha256,
    designSourceJsonSha256,
    ...(text !== undefined ? { text, textSha256, chars } : chars !== undefined ? { chars } : {}),
  };
}

export function attachmentDeliveryBlock(attachment: EditorAttachment): string {
  if (attachment.text !== undefined) {
    return JSON.stringify({ id: attachment.id, name: attachment.name, text: attachment.text });
  }
  const material = toMaterialAttachment(attachment);
  if (!material) return invalidReceipt(attachment.id);
  return JSON.stringify(materialManifestEntry(material));
}

export function assertAttachmentBudget(attachments: readonly EditorAttachment[]): void {
  const inlineChars = attachments
    .filter((attachment) => attachment.text !== undefined)
    .reduce((sum, attachment) => sum + attachmentDeliveryBlock(attachment).length, 0);
  if (inlineChars > MAX_ATTACHMENT_CONTEXT_CHARS) {
    throw new Error(
      `selected attachment JSON context exceeds ${MAX_ATTACHMENT_CONTEXT_CHARS} characters; explicitly remove files or use separate turns, no text was clipped`,
    );
  }
}

export type GenerationInputSnapshot = Readonly<{
  version: 1;
  sessionId: string;
  acceptedAt: string;
  brief: string;
  format: GenerationFormat;
  design:
    | Readonly<{ kind: "self-directed" }>
    | Readonly<{
        kind: "explicit-style";
        designSystemId: string;
        designSourceId: string;
        designHash: string;
      }>;
  model: Readonly<{ provider: string; model: string; reasoningEffort?: string }>;
  attachments: readonly (EditorAttachment & Readonly<{ contentBlockSha256: string }>)[];
  initialMessage: string;
  initialMessageSha256: string;
}>;

export function persistGenerationInput(projectRoot: string, input: GenerationInputSnapshot): string {
  const expectedFormat = generationFormat(input.format.kind, input.format.layout);
  if (
    JSON.stringify(input.format.size) !== JSON.stringify(expectedFormat.size) ||
    input.initialMessageSha256 !== inputSha256(input.initialMessage) ||
    !input.initialMessage.includes(input.brief)
  )
    throw new Error("generation input does not match its actual initial message or canvas");
  assertAttachmentBudget(input.attachments);
  const ids = new Set<string>();
  for (const attachment of input.attachments) {
    const verified = verifiedAttachment(attachment.id, attachment);
    const block = attachmentDeliveryBlock(verified);
    const delivered = verified.text === undefined ? verified.id : block;
    if (
      ids.has(verified.id) ||
      attachment.contentBlockSha256 !== inputSha256(block) ||
      !input.initialMessage.includes(delivered)
    ) {
      throw new Error("generation input does not include each selected attachment exactly as delivered");
    }
    ids.add(attachment.id);
  }
  const serialized = JSON.stringify(input);
  const fingerprint = inputSha256(serialized);
  const destination = path.join(projectRoot, "_agent", "generation-input.v1.json");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify({ ...input, fingerprint }, null, 2)}\n`, { flag: "wx" });
  return fingerprint;
}
