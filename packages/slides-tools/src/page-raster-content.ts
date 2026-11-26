/**
 * Model-facing render_page / review_page content.
 * grok-4.6 is multimodal: a page raster must ride an image part, not JSON-only.
 */
export type PageRasterTextBlock = { readonly type: "text"; readonly text: string };

export type PageRasterImageDataBlock = {
  readonly type: "image";
  readonly mediaType: "image/png";
  readonly data: string;
  readonly name?: string;
};

export type PageRasterAttachmentBlock = {
  readonly type: "image";
  readonly attachment: {
    readonly attachmentId: string;
    readonly mediaType: string;
    readonly bytes?: number;
    readonly width?: number;
    readonly height?: number;
    readonly name?: string;
  };
};

export type PageRasterModelBlock = PageRasterTextBlock | PageRasterImageDataBlock;

export function pageRasterModelContent(opts: {
  readonly json: unknown;
  readonly pngBytes?: Buffer;
  readonly visionMode: "none" | "main-model" | "reviewer";
}): PageRasterModelBlock[] {
  const text: PageRasterTextBlock = { type: "text", text: JSON.stringify(opts.json) };
  if (opts.visionMode === "main-model" && opts.pngBytes && opts.pngBytes.length >= 64) {
    return [
      text,
      {
        type: "image",
        mediaType: "image/png",
        data: opts.pngBytes.toString("base64"),
        name: "page-raster.png",
      },
    ];
  }
  return [text];
}

export function renderPageToolContent(value: unknown): Array<PageRasterTextBlock | PageRasterAttachmentBlock> {
  const rec = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rest = { ...rec };
  const image = rest.image as Record<string, unknown> | undefined;
  const extraImages = Array.isArray(rest.images) ? (rest.images as Record<string, unknown>[]) : [];
  delete rest.image;
  delete rest.images;
  const blocks: Array<PageRasterTextBlock | PageRasterAttachmentBlock> = [{ type: "text", text: JSON.stringify(rest) }];
  const pushAttachment = (img: Record<string, unknown>) => {
    if (typeof img.attachmentId === "string" && img.attachmentId.length > 0) {
      blocks.push({
        type: "image",
        attachment: {
          attachmentId: img.attachmentId,
          mediaType: typeof img.mediaType === "string" ? img.mediaType : "image/png",
          bytes: typeof img.bytes === "number" ? img.bytes : undefined,
          width: typeof img.width === "number" ? img.width : undefined,
          height: typeof img.height === "number" ? img.height : undefined,
          name: typeof img.name === "string" ? img.name : undefined,
        },
      });
    }
  };
  if (image && typeof image === "object") pushAttachment(image);
  for (const img of extraImages) {
    if (img && typeof img === "object") pushAttachment(img);
  }
  return blocks;
}

export function shouldAttachPageRaster(opts: { readonly visionMode: string; readonly pngBytes?: Buffer }): boolean {
  return opts.visionMode === "main-model" && Boolean(opts.pngBytes && opts.pngBytes.length >= 64);
}
