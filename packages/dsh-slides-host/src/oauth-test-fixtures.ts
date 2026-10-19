import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSlidesRequest, type SlidesHostRuntime } from "./routes.js";
import { addPlaywrightRuntimeLayout } from "./runtime-test-fixture.js";

export function stubPlaywrightRuntime(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-pw-"));
  const file = path.join(dir, "runtime.mjs");
  fs.writeFileSync(
    file,
    `export function verifyPinnedRuntime() { return true; }
export async function launchPinnedChromium() { throw new Error("stub"); }
`,
  );
  addPlaywrightRuntimeLayout(file);
  return file;
}

export function invokeSlides(
  runtime: SlidesHostRuntime,
  method: string,
  url: string,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.alloc(0)]) as IncomingMessage;
    req.method = method;
    req.url = url;
    req.headers = { host: "127.0.0.1:13080" };
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

export function emptyRuntime(dshHome: string): SlidesHostRuntime {
  return {
    workspaceRoot: dshHome,
    dshHome,
    store: {
      inspect: () => {
        throw new Error("unused");
      },
      bindingFor: () => undefined,
    } as unknown as SlidesHostRuntime["store"],
    presentation: {
      hydrate: () => undefined,
      inspect: async () => undefined,
    } as unknown as SlidesHostRuntime["presentation"],
    agentBusy: () => false,
    markBusy: () => undefined,
    cancelRateLimitWait: () => undefined,
    operatorStop: async () => undefined,
    getAgent: () => undefined,
    createAgent: async () => {
      throw new Error("unused");
    },
    resumeAgent: async () => undefined,
    switchModel: async () => undefined,
  };
}
