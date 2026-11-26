/** Command-line and environment configuration for the `slides-mcp` binary. */
import path from "node:path";
import { DEFAULT_EDITOR_URL, type SlidesMcpConfig } from "./server.js";

export const USAGE = `Usage: slides-mcp --data-root <dir> [options]

Transport:
  --transport stdio|http     stdio (default) or loopback Streamable HTTP
  --host <host>              HTTP bind host: 127.0.0.1 (default), localhost or ::1
  --port <n>                 HTTP port (default 0 = any free port)
  --auth-token <token>       Require "Authorization: Bearer <token>" (HTTP); or SLIDESTUDIO_MCP_AUTH_TOKEN

Project:
  --data-root <dir>          SlideStudio data root owning output/dsh-slices (or SLIDESTUDIO_DATA_DIR)
  --editor-url <url>         Native editor origin (default ${DEFAULT_EDITOR_URL})
  --repo-root <dir>          Checkout/package root holding the reference catalog (auto-detected)
  --config-b64 <base64url>   Base64url JSON overrides ({dataRoot, editorBaseUrl, repoRoot})
  --allow-import-root <dir>  Directory import_material may read (repeatable); or
                             SLIDESTUDIO_MCP_IMPORT_ROOTS (path-delimiter separated).
                             Without one, import_material refuses every call.
  --client-label <label>     Provider label recorded on projects (default: initialize clientInfo)
  --no-images                Never send image content; declare a text-only route
  --help                     Show this help
`;

export type CliOptions = SlidesMcpConfig & {
  readonly transport: "stdio" | "http";
  readonly host: string;
  readonly port: number;
  readonly authToken?: string;
};

export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

const VALUE_FLAGS = new Set([
  "--transport",
  "--host",
  "--port",
  "--auth-token",
  "--data-root",
  "--editor-url",
  "--repo-root",
  "--config-b64",
  "--allow-import-root",
  "--client-label",
]);

type Raw = { values: Map<string, string[]>; flags: Set<string> };

function scan(argv: readonly string[]): Raw {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++index];
      if (value === undefined || value === "") throw new CliUsageError(`${name} needs a value`);
      values.set(name, [...(values.get(name) ?? []), value]);
    } else if (name === "--no-images" || name === "--help" || name === "-h") {
      flags.add(name === "-h" ? "--help" : name);
    } else {
      throw new CliUsageError(`unknown argument ${arg}`);
    }
  }
  return { values, flags };
}

function last(raw: Raw, name: string): string | undefined {
  return raw.values.get(name)?.at(-1);
}

function importRoots(raw: Raw, env: NodeJS.ProcessEnv): string[] {
  const fromEnv = (env.SLIDESTUDIO_MCP_IMPORT_ROOTS ?? "").split(path.delimiter).filter((item) => item.trim());
  const roots = [...(raw.values.get("--allow-import-root") ?? []), ...fromEnv].map((item) => item.trim());
  for (const root of roots) {
    if (!path.isAbsolute(root)) throw new CliUsageError(`import root must be absolute: ${root}`);
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliUsageError(`invalid --port ${value}`);
  return port;
}

function transportOf(value: string | undefined): "stdio" | "http" {
  if (value === undefined || value === "stdio") return "stdio";
  if (value === "http") return "http";
  throw new CliUsageError(`--transport must be stdio or http, not ${value}`);
}

type EncodedConfig = {
  readonly dataRoot?: string;
  readonly editorBaseUrl?: string;
  readonly repoRoot?: string;
};

function decodeConfigB64(raw: string | undefined): EncodedConfig {
  if (!raw) return {};
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new CliUsageError("--config-b64 must be valid base64url");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new CliUsageError("--config-b64 is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliUsageError("--config-b64 must decode to a JSON object");
  }
  const rec = parsed as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    if (rec[key] === undefined) return undefined;
    if (typeof rec[key] !== "string" || !rec[key].trim()) {
      throw new CliUsageError(`--config-b64.${key} must be a non-empty string`);
    }
    return rec[key];
  };
  return {
    ...(str("dataRoot") ? { dataRoot: str("dataRoot") } : {}),
    ...(str("editorBaseUrl") ? { editorBaseUrl: str("editorBaseUrl") } : {}),
    ...(str("repoRoot") ? { repoRoot: str("repoRoot") } : {}),
  };
}

/** Parse CLI arguments. Returns `"help"` for --help. */
export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions | "help" {
  const raw = scan(argv);
  if (raw.flags.has("--help")) return "help";
  const encoded = decodeConfigB64(last(raw, "--config-b64"));
  const dataRoot = last(raw, "--data-root") ?? encoded.dataRoot ?? env.SLIDESTUDIO_DATA_DIR;
  if (!dataRoot) throw new CliUsageError("--data-root (or SLIDESTUDIO_DATA_DIR) is required");
  if (!path.isAbsolute(dataRoot)) throw new CliUsageError("--data-root must be an absolute path");
  const authToken = last(raw, "--auth-token") ?? env.SLIDESTUDIO_MCP_AUTH_TOKEN;
  const repoRoot = last(raw, "--repo-root") ?? encoded.repoRoot;
  if (repoRoot && !path.isAbsolute(repoRoot)) throw new CliUsageError("--repo-root must be an absolute path");
  const clientLabel = last(raw, "--client-label");
  return {
    transport: transportOf(last(raw, "--transport")),
    host: last(raw, "--host") ?? "127.0.0.1",
    port: parsePort(last(raw, "--port")),
    dataRoot: path.resolve(dataRoot),
    editorBaseUrl: last(raw, "--editor-url") ?? encoded.editorBaseUrl ?? DEFAULT_EDITOR_URL,
    allowedImportRoots: importRoots(raw, env),
    acceptsImages: !raw.flags.has("--no-images"),
    ...(authToken?.trim() ? { authToken: authToken.trim() } : {}),
    ...(repoRoot ? { repoRoot: path.resolve(repoRoot) } : {}),
    ...(clientLabel ? { clientLabel } : {}),
  };
}
