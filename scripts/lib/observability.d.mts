import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestContext = { requestId: string; route: string };
export type LocalObservability = {
  log(level: string, event: string, fields?: Record<string, unknown>): void;
  observe(req: IncomingMessage, res: ServerResponse): RequestContext;
  error(cause: unknown, context?: Record<string, unknown>): string;
  snapshot(): Record<string, unknown>;
  wrap(
    handler: (req: IncomingMessage, res: ServerResponse) => unknown,
    authorize?: (req: IncomingMessage) => boolean,
  ): (req: IncomingMessage, res: ServerResponse) => unknown;
};
export function scrub(value: unknown, depth?: number): unknown;
export function requestId(value: unknown): string;
export function routeLabel(raw: unknown): string;
export function createObservability(options: {
  app: string;
  version?: string;
  sink?: (line: string) => void;
  clock?: () => number;
}): LocalObservability;
