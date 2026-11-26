/**
 * @open-slidestudio/slides-mcp — a host-agnostic MCP server over the canonical
 * `@open-slidestudio/slides-tools` contract (stdio and loopback HTTP).
 * Runtime dependencies are Node built-ins and core workspace packages only.
 */
export { main as runCli } from "./cli.js";
export { CliUsageError, parseCliArgs, USAGE, type CliOptions } from "./config.js";
export {
  encodeImage,
  IMAGES_DISABLED_NOTE,
  imageMimeType,
  toCallToolResult,
  type McpCallToolResult,
  type McpContent,
} from "./content.js";
export { importMaterialTool, resolveImportPath, type ImportPolicy } from "./import-material.js";
export { mcpInstructions, mcpPersonaLines, MCP_WORKFLOW } from "./instructions.js";
export * from "./jsonrpc.js";
export { IMPORT_FORMATS, MCP_IMAGE_MAX_BYTES, prepareImportedMaterial } from "./material-derivative.js";
export { MCP_ONLY_TOOL_NAMES } from "./mcp-tools.js";
export { mcpProvider, resolveExistingProject, SLICES_REL, type McpSessionState } from "./project-port.js";
export { slideSchemaValidator, validateJsonSchema } from "./schema-validator.js";
export { createSlidesMcpServer, DEFAULT_EDITOR_URL, type SlidesMcpConfig, type SlidesMcpServer } from "./server.js";
export {
  LATEST_PROTOCOL_VERSION,
  McpSession,
  SERVER_NAME,
  SERVER_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type SessionOutcome,
} from "./session.js";
export {
  createHttpTransport,
  isLoopbackHost,
  MAX_HTTP_BODY_BYTES,
  MCP_PATH,
  type HttpTransport,
} from "./transport-http.js";
export { MAX_STDIO_LINE_BYTES, serveStdio, type StdioTransport } from "./transport-stdio.js";
