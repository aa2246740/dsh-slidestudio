/**
 * Runs canonical material tools (`list_materials`, `view_material`, …) through a real in-process
 * slides-mcp session over a fresh project: the fixtures fill a real attachment store, the records
 * they return are materialized into the project, then each step is a real `tools/call`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSlidesMcpServer } from "@open-slidestudio/slides-mcp";
import { prepareSessionMaterials, writeSessionMaterials } from "@open-slidestudio/slides-tools/internal/material-store";

/**
 * @typedef {{type: string, text?: string, data?: string, mimeType?: string}} McpBlock
 * @typedef {{text: string, isError: boolean, imageBlocks: number}} StepResult
 */

/**
 * @param {{
 *   vision?: boolean,
 *   steps: {name: string, args: Record<string, unknown>}[],
 *   fixtures: (storeDir: string) => Promise<import("@open-slidestudio/slides-tools").EditorAttachment[]>,
 * }} script
 * @returns {Promise<{results: StepResult[], saved: {data: Buffer, mimeType?: string}[], cleanup: () => Promise<void>}>}
 */
export async function runToolScript({ vision = true, steps, fixtures }) {
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oss-material-tools-")));
  const server = createSlidesMcpServer({
    dataRoot,
    editorBaseUrl: "http://127.0.0.1:9",
    acceptsImages: vision,
    log: () => {},
  });
  const session = server.createSession();
  const cleanup = async () => {
    server.closeAll();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  };
  let next = 1;
  /** @param {string} method @param {unknown} [params] */
  const request = async (method, params) => {
    const outcome = await session.handle({ jsonrpc: "2.0", id: next++, method, params });
    await outcome.afterDelivery?.();
    const response = /** @type {{result?: {content?: McpBlock[], isError?: boolean}, error?: {message: string}}} */ (
      outcome.response ?? {}
    );
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result ?? {};
  };
  try {
    await request("initialize", { protocolVersion: "2025-03-26" });
    const opened = await request("tools/call", { name: "open_project", arguments: { title: "素材" } });
    const projectId = String(JSON.parse(opened.content?.[0]?.text ?? "{}").projectId ?? "");
    const projectRoot = path.join(dataRoot, "output", "dsh-slices", projectId);
    if (!projectId || !fs.existsSync(projectRoot)) throw new Error("open_project did not create a project");
    const storeDir = path.join(dataRoot, "output", "attachments");
    const attachments = await fixtures(storeDir);
    writeSessionMaterials(projectRoot, prepareSessionMaterials(storeDir, attachments));

    /** @type {StepResult[]} */ const results = [];
    /** @type {{data: Buffer, mimeType?: string}[]} */ const saved = [];
    for (const step of steps) {
      const called = await request("tools/call", { name: step.name, arguments: step.args });
      const blocks = called.content ?? [];
      const images = blocks.filter((block) => block.type === "image");
      for (const image of images) {
        saved.push({ data: Buffer.from(image.data ?? "", "base64"), mimeType: image.mimeType });
      }
      results.push({
        text: blocks.find((block) => block.type === "text")?.text ?? "",
        isError: called.isError === true,
        imageBlocks: images.length,
      });
    }
    return { results, saved, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
