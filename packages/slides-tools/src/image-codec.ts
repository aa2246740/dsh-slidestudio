/**
 * Lazy, optional image codec. `sharp` is a native module that is never
 * required at startup or bundled; tools that need it load it on first use and
 * degrade with a typed error when it is unavailable.
 */

type RawInfo = { width: number; height: number; channels: number };

/** The subset of the sharp pipeline the slide tools use. */
export type ImagePipeline = {
  rotate(): ImagePipeline;
  resize(...args: unknown[]): ImagePipeline;
  flatten(options: { background: string }): ImagePipeline;
  toColourspace(space: string): ImagePipeline;
  raw(): ImagePipeline;
  composite(layers: readonly unknown[]): ImagePipeline;
  jpeg(options: Record<string, unknown>): ImagePipeline;
  toBuffer(): Promise<Buffer>;
  toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: RawInfo }>;
};

export type ImageCodec = (input?: unknown, options?: Record<string, unknown>) => ImagePipeline;

export class ImageCodecUnavailableError extends Error {
  readonly code = "IMAGE_CODEC_UNAVAILABLE";
  constructor(cause?: unknown) {
    super(
      `图片处理组件（sharp）不可用，无法生成或转换图片：${cause instanceof Error ? cause.message : String(cause ?? "not installed")}`,
    );
    this.name = "ImageCodecUnavailableError";
  }
}

export function isImageCodecUnavailable(error: unknown): error is ImageCodecUnavailableError {
  return error instanceof ImageCodecUnavailableError;
}

const CODEC_MODULE = "sharp";
const defaultLoader = (): Promise<unknown> => import(CODEC_MODULE);
let loader: () => Promise<unknown> = defaultLoader;

/** Override the codec module loader; pass undefined to restore the default. */
export function setImageCodecLoader(next: (() => Promise<unknown>) | undefined): void {
  loader = next ?? defaultLoader;
}

export async function loadImageCodec(): Promise<ImageCodec> {
  let mod: unknown;
  try {
    mod = await loader();
  } catch (error) {
    throw new ImageCodecUnavailableError(error);
  }
  const candidate = (mod as { default?: unknown } | undefined)?.default ?? mod;
  if (typeof candidate !== "function") throw new ImageCodecUnavailableError("module has no codec export");
  return candidate as ImageCodec;
}
