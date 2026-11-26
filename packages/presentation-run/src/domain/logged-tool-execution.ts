import fs from "node:fs";
import path from "node:path";
import type { ToolExecution } from "./agent-tools.js";
import { withReviewProgress } from "./review-progress.js";

export function loggedToolExecution(
  root: string,
  name: string,
  args: Record<string, unknown>,
  result: ToolExecution,
): ToolExecution {
  const enriched = withReviewProgress(root, name, result);
  const payload = name === "read_material" && enriched.ok ? enriched.payload : undefined;
  const progress =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.fromEntries(
          ["part", "chunkIndex", "chunkCount", "chars", "pageRange", "rows", "readChunks", "allRead", "rowsRead"]
            .filter((key) => key in payload)
            .map((key) => [key, (payload as Record<string, unknown>)[key]]),
        )
      : undefined;
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.appendFileSync(
    path.join(root, "_agent", "hands-log.jsonl"),
    `${JSON.stringify({
      at: new Date().toISOString(),
      name,
      ok: enriched.ok,
      summary: enriched.summary,
      detail: enriched.ok ? undefined : enriched.detail,
      keys: Object.keys(args),
      args: JSON.stringify(args).slice(0, 1500),
      ...(progress ? { payload: progress } : {}),
    })}\n`,
    "utf8",
  );
  return enriched;
}
