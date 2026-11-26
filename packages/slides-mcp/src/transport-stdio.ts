/**
 * Newline-delimited JSON-RPC over a duplex byte stream (stdin/stdout for the CLI).
 * Partial lines are buffered until their newline; several messages in one chunk are
 * handled in order. Only JSON-RPC lines are written to `output`; diagnostics go to the
 * server log (stderr). EOF or `close()` ends the session and releases its leases.
 */
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { parseWire, rpcError, INVALID_REQUEST, type JsonRpcResponse } from "./jsonrpc.js";
import type { SlidesMcpServer } from "./server.js";
import type { McpSession, SessionOutcome } from "./session.js";

/** One line may carry a 4 MiB request (same bound as the HTTP transport). */
export const MAX_STDIO_LINE_BYTES = 4 * 1024 * 1024;

export type StdioTransport = {
  readonly session: McpSession;
  /** Resolves after input ended (or `close()` ran) and the session released its leases. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
};

export function serveStdio(server: SlidesMcpServer, input: Readable, output: Writable): StdioTransport {
  const session = server.createSession();
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let discardingOversized = false;
  let queue: Promise<void> = Promise.resolve();
  let finished = false;
  let outputBroken = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const pendingWrites = new Set<() => void>();

  const markOutputBroken = () => {
    if (outputBroken) return;
    outputBroken = true;
    for (const fail of pendingWrites) fail();
    pendingWrites.clear();
    void finish();
  };

  const onOutputError = (error: NodeJS.ErrnoException) => {
    if (
      error?.code !== "EPIPE" &&
      error?.code !== "ERR_STREAM_DESTROYED" &&
      error?.code !== "ERR_STREAM_WRITE_AFTER_END"
    ) {
      process.stderr.write(`[slides-mcp] stdio output error: ${String(error)}\n`);
    }
    markOutputBroken();
  };
  const onOutputClose = () => markOutputBroken();
  output.on("error", onOutputError);
  output.on("close", onOutputClose);

  /** Resolve true only when `output` accepted and flushed the frame without error. */
  const write = (response: JsonRpcResponse): Promise<boolean> =>
    new Promise((resolve) => {
      if (outputBroken || output.destroyed || !output.writable || output.writableEnded) return resolve(false);
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        pendingWrites.delete(fail);
        resolve(ok);
      };
      const fail = () => done(false);
      pendingWrites.add(fail);
      try {
        output.write(`${JSON.stringify(response)}\n`, (err) => {
          if (err) {
            markOutputBroken();
            done(false);
            return;
          }
          done(!outputBroken && !output.destroyed);
        });
      } catch {
        markOutputBroken();
        done(false);
      }
    });

  const deliver = async (outcome: SessionOutcome): Promise<void> => {
    if (!outcome.response) return;
    if (await write(outcome.response)) await outcome.afterDelivery?.();
  };

  const handleLine = async (line: string): Promise<void> => {
    if (outputBroken) return;
    const parsed = parseWire(line);
    if (!parsed.ok) {
      await write(parsed.response);
      return;
    }
    if (Array.isArray(parsed.value)) {
      await write(rpcError(null, INVALID_REQUEST, "batches are not supported over stdio"));
      return;
    }
    await deliver(await session.handle(parsed.value));
  };

  const enqueueTask = (task: () => Promise<void>) => {
    queue = queue.then(task, task).catch((error: unknown) => {
      process.stderr.write(`[slides-mcp] stdio message failed: ${String(error)}\n`);
    });
  };
  const enqueue = (line: string) => enqueueTask(() => handleLine(line));
  const enqueueOversized = () =>
    enqueueTask(async () => {
      await write(rpcError(null, INVALID_REQUEST, "message exceeds the 4 MiB line limit"));
    });

  const onData = (chunk: Buffer | string) => {
    if (outputBroken) return;
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (discardingOversized) {
        discardingOversized = false;
      } else if (Buffer.byteLength(line, "utf8") > MAX_STDIO_LINE_BYTES) {
        enqueueOversized();
      } else if (line.trim()) {
        enqueue(line);
      }
      newline = buffer.indexOf("\n");
    }
    if (discardingOversized) {
      buffer = "";
    } else {
      // Allow a single trailing `\r` whose paired `\n` arrives in the next chunk.
      const pending = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (Buffer.byteLength(pending, "utf8") > MAX_STDIO_LINE_BYTES) {
        discardingOversized = true;
        buffer = "";
        enqueueOversized();
      }
    }
  };

  const finish = async (): Promise<void> => {
    if (finished) return closed;
    finished = true;
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("close", onEnd);
    const rest = discardingOversized || outputBroken ? "" : (buffer + decoder.end()).replace(/\r$/, "").trim();
    buffer = "";
    discardingOversized = false;
    if (rest) {
      if (Buffer.byteLength(rest, "utf8") > MAX_STDIO_LINE_BYTES) enqueueOversized();
      else enqueue(rest);
    }
    await queue;
    server.closeSession(session.id);
    // Keep `onOutputError` attached after a broken-pipe write so Node's next-tick
    // `EPIPE` error event is absorbed instead of crashing the process before exit.
    output.off("close", onOutputClose);
    if (!outputBroken) output.off("error", onOutputError);
    resolveClosed();
    return closed;
  };
  const onEnd = () => void finish();

  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", onEnd);
  return { session, closed, close: finish };
}
