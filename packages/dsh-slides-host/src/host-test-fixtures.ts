import crypto from "node:crypto";
import type { EditorAttachment } from "./generation-input.js";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSlidesRequest, type SlidesHostRuntime } from "./routes.js";

export const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../..");

export const coverPage = {
  id: "cover",
  pageType: "cover",
  elements: [
    {
      elementId: "title",
      elementType: "text",
      bounds: [80, 200, 800, 80],
      content: { text: "光合作用", fontSize: 36 },
    },
  ],
};

export function completeAttachmentFixture(id: string, name: string, text: string): EditorAttachment {
  const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
  return {
    id,
    name,
    text,
    bytes: Buffer.byteLength(text),
    chars: text.length,
    parsed: true,
    complete: true,
    parser: "utf8-full-v1",
    originalSha256: hash(text),
    textSha256: hash(text),
    storeId: hash(path.join(REPO_ROOT, "output", "attachments")),
  };
}

export function invokeSlides(
  runtime: SlidesHostRuntime,
  method: string,
  url: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
    const req = Readable.from([payload]) as IncomingMessage;
    req.method = method;
    req.url = url;
    req.headers = {
      host: "127.0.0.1:55200",
      ...(body ? { "content-type": "application/json" } : {}),
    };
    const res = {
      statusCode: 0,
      headersSent: false,
      chunks: "",
      writeHead(status: number) {
        this.statusCode = status;
        this.headersSent = true;
      },
      end(chunk?: unknown) {
        this.chunks = chunk == null ? "" : String(chunk);
        try {
          resolve({
            status: this.statusCode,
            json: this.chunks ? JSON.parse(this.chunks) : null,
          });
        } catch (error) {
          reject(error);
        }
      },
    };
    handleSlidesRequest(runtime, req, res as unknown as ServerResponse);
  });
}
