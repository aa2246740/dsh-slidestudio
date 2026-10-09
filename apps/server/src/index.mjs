/**
 * DSH SlideStudio local API — real LLM generation + PPTX export.
 * Default: http://127.0.0.1:8787
 */

import http from "node:http";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  assertRequestAllowed,
  corsHeaders,
  readJsonBody as readBody,
  HttpInputError,
  safeFilename,
} from "./http-input.mjs";
import { createLogger } from "./logger.mjs";
import { assertGenerationInput, generate } from "./generate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");

async function loadAgent() {
  const core = path.join(root, "packages/agent-core/dist/index.js");
  const node = path.join(root, "packages/agent-core/dist/node.js");
  const browser = await import(pathToFileURL(core).href);
  const nodeApi = await import(pathToFileURL(node).href);
  return { ...browser, ...nodeApi };
}

async function loadExporter() {
  const base = path.join(root, "packages/exporter-pptx/dist/index.js");
  return import(pathToFileURL(base).href);
}

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";

// CORS: legacy local API — loopback origins only by default. Never "*":
// a wildcard would let any web page call generate/export through the local
// server. Extra trusted origins may be opted in via env.
const EXTRA_CORS_ORIGINS = (process.env.OPENSLIDESTUDIO_CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function sendJson(req, res, status, body, extraOrigins) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...corsHeaders(req, extraOrigins),
  });
  res.end(data);
}

/** Importing this module never binds a port. Tests cross the same HTTP interface. */
export function createApiServer({
  agentLoader = loadAgent,
  exporterLoader = loadExporter,
  diagnostics = createLogger(),
  extraOrigins = EXTRA_CORS_ORIGINS,
} = {}) {
  return http.createServer(async (req, res) => {
    const context = diagnostics.observe(req, res);
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const route = `${req.method} ${url.pathname}`;
      assertRequestAllowed(req, extraOrigins);
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(req, extraOrigins));
        return res.end();
      }
      if (route === "GET /api/diagnostics") {
        return sendJson(req, res, 200, diagnostics.snapshot(), extraOrigins);
      }
      if (route === "GET /api/openapi") {
        const schema = JSON.parse(readFileSync(path.join(root, "docs/api/legacy/openapi.json"), "utf8"));
        return sendJson(req, res, 200, schema, extraOrigins);
      }
      if (route === "GET /api/health") {
        const agent = await agentLoader();
        const has = agent.hasLlmCredentials();
        const creds = has ? agent.resolveLlmCredentials() : null;
        return sendJson(
          req,
          res,
          200,
          {
            ok: true,
            llm: has,
            source: creds?.source ?? null,
            model: creds?.model ?? null,
          },
          extraOrigins,
        );
      }

      if (route === "POST /api/generate") {
        const body = await readBody(req);
        assertGenerationInput(body);
        const result = await generate(body, await agentLoader());
        return sendJson(req, res, 200, result, extraOrigins);
      }

      if (route === "POST /api/export-pptx") {
        const body = await readBody(req);
        if (!body.deck) return sendJson(req, res, 400, { error: "deck required" }, extraOrigins);
        const exp = await exporterLoader();
        const out = await exp.exportDeckToArrayBuffer(body.deck, {
          filename: body.filename,
        });
        const buf = Buffer.from(out.data);
        res.writeHead(200, {
          "Content-Type": out.mimeType,
          "Content-Disposition": `attachment; filename="${safeFilename(out.filename)}"`,
          "X-Content-Type-Options": "nosniff",
          ...corsHeaders(req, extraOrigins),
          "X-Export-Report": Buffer.from(
            JSON.stringify({
              degradations: out.report.degradations?.length ?? 0,
              nativeCoverage: out.report.nativeCoverage,
              fullyNative: out.report.fullyNative,
            }),
          ).toString("base64url"),
        });
        res.end(buf);
        return;
      }

      sendJson(req, res, 404, { error: "not found" }, extraOrigins);
    } catch (err) {
      const status = err instanceof HttpInputError ? err.statusCode : 500;
      diagnostics.error(err, context);
      if (status === 413) res.setHeader("Connection", "close");
      sendJson(
        req,
        res,
        status,
        {
          error: status < 500 ? err.message : "internal server error",
          requestId: context.requestId,
        },
        extraOrigins,
      );
    }
  });
}

export const server = createApiServer();
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : PORT;
    console.log(`DSH SlideStudio API http://${HOST}:${port}`);
    console.log(`  GET  /api/health`);
    console.log(`  POST /api/generate   { prompt, modelId? }`);
    console.log(`  POST /api/export-pptx { deck }`);
  });
}
