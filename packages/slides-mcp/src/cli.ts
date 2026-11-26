#!/usr/bin/env node
/**
 * `slides-mcp` binary. stdout carries only JSON-RPC (stdio transport); every
 * diagnostic goes to stderr. SIGINT/SIGTERM, stdin EOF and HTTP shutdown all
 * release the writer leases the sessions still hold.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveRepoRoot } from "@open-slidestudio/presentation-run";
import { CliUsageError, parseCliArgs, USAGE, type CliOptions } from "./config.js";
import { createSlidesMcpServer } from "./server.js";
import { createHttpTransport } from "./transport-http.js";
import { serveStdio } from "./transport-stdio.js";

function bindResourceRoot(options: CliOptions): void {
  if (options.repoRoot) {
    process.env.OPEN_SLIDESTUDIO_ROOT = options.repoRoot;
    return;
  }
  if (process.env.OPEN_SLIDESTUDIO_ROOT?.trim()) return;
  try {
    process.env.OPEN_SLIDESTUDIO_ROOT = resolveRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    // Let createSlidesMcpServer report the exact missing-root error if needed.
  }
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

function onSignals(stop: () => Promise<void>): void {
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      void stop().finally(() => process.exit(0));
    });
  }
}

async function startHttp(options: CliOptions): Promise<void> {
  const server = createSlidesMcpServer(options);
  const transport = createHttpTransport(server, {
    host: options.host,
    port: options.port,
    ...(options.authToken ? { authToken: options.authToken } : {}),
  });
  await transport.listen();
  err(`[slides-mcp] listening on ${transport.url()}${options.authToken ? " (bearer token required)" : ""}`);
  onSignals(() => transport.close());
}

function startStdio(options: CliOptions): void {
  const server = createSlidesMcpServer(options);
  const transport = serveStdio(server, process.stdin, process.stdout);
  onSignals(() => transport.close());
  void transport.closed.then(() => process.exit(0));
}

/** Run the CLI; resolves once the selected transport started. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let options: CliOptions | "help";
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    err(`slides-mcp: ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options === "help") {
    err(USAGE);
    return;
  }
  bindResourceRoot(options);
  if (options.transport === "http") await startHttp(options);
  else startStdio(options);
}

/** True when this module is the process entry, also through an npm `.bin` symlink. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error: unknown) => {
    err(`slides-mcp: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
