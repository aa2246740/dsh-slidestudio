/**
 * Map a host-neutral `SlideToolResult` onto an MCP `CallToolResult`.
 *
 * Neutral image blocks become native `ImageContent` (`{type:"image", data, mimeType}`).
 * `onContentDelivered` is returned as `afterDelivery`: the transport runs it only after the
 * response carrying every encoded image was written to the client. When images are
 * disabled they are dropped with a text note and the hook is never offered.
 */
import type { SlideImageBlock, SlideToolDefinition, SlideToolResult } from "@open-slidestudio/slides-tools";

export type McpTextContent = { readonly type: "text"; readonly text: string };
export type McpImageContent = { readonly type: "image"; readonly data: string; readonly mimeType: string };
export type McpContent = McpTextContent | McpImageContent;
export type McpCallToolResult = { readonly content: McpContent[]; readonly isError?: boolean };

export const IMAGES_DISABLED_NOTE =
  "Image content omitted: this MCP server runs with images disabled (--no-images), so the picture was not sent. Rely on the text fields above.";

function isPng(data: Uint8Array): boolean {
  return data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
}

function isJpeg(data: Uint8Array): boolean {
  return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}

/** The MIME type the bytes actually carry; the declared type when they are neither PNG nor JPEG. */
export function imageMimeType(block: SlideImageBlock): string {
  if (isPng(block.data)) return "image/png";
  if (isJpeg(block.data)) return "image/jpeg";
  return block.mediaType;
}

export function encodeImage(block: SlideImageBlock): McpImageContent {
  return {
    type: "image",
    data: Buffer.from(block.data.buffer, block.data.byteOffset, block.data.byteLength).toString("base64"),
    mimeType: imageMimeType(block),
  };
}

function renderText(definition: SlideToolDefinition, data: Record<string, unknown>): string {
  return typeof definition.render === "function" ? definition.render(data) : JSON.stringify(data);
}

function textBlocks(result: SlideToolResult): McpTextContent[] {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => ({ type: "text" as const, text: block.text }));
}

export type MappedToolResult = {
  readonly result: McpCallToolResult;
  /** Run by the transport after the response reached the client; absent when no image was sent. */
  readonly afterDelivery?: () => Promise<void>;
};

export function toCallToolResult(
  definition: SlideToolDefinition,
  result: SlideToolResult,
  acceptsImages: boolean,
): MappedToolResult {
  const content: McpContent[] = [{ type: "text", text: renderText(definition, result.data) }, ...textBlocks(result)];
  const images = (result.content ?? []).filter((block): block is SlideImageBlock => block.type === "image");
  const mapped = { content, ...(result.isError ? { isError: true } : {}) };
  if (images.length && acceptsImages) {
    content.push(...images.map(encodeImage));
    const hook = result.onContentDelivered;
    return { result: mapped, ...(hook ? { afterDelivery: () => hook() } : {}) };
  }
  if (images.length) content.push({ type: "text", text: IMAGES_DISABLED_NOTE });
  return { result: mapped };
}

/** A structured tool-level error the model can read and correct. */
export function toolError(error: string, detail: string, extra: Record<string, unknown> = {}): McpCallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error, detail, ...extra }) }], isError: true };
}
