/**
 * `query_material` as a domain hand: verify the material, run the deterministic query, store the
 * receipt and record `material.query-computed`. Any failure is a Chinese error with no ledger
 * fact, so a number on a page can only trace back to a query that really ran.
 */
import type { ToolExecution } from "./agent-tools.js";
import { verifyMaterial } from "./material-pack.js";
import { queryMaterialTable } from "./material-query.js";
import { recordMaterialQuery, saveQueryResult } from "./material-query-ledger.js";
import type { RunToolContext } from "./run-ledger.js";

/** Pages show computed values at two decimals; fractions (share, yoy, mom) as percentages. */
export const QUERY_DISPLAY_RULE = "写入页面时数值保留两位小数；占比、同比、环比是小数，乘以 100 再加 % 显示";

/** A converted legacy file carries its own hash (M8); older records have none. */
function convertedSha256Of(derivative: Record<string, unknown>): string | undefined {
  const conversion = derivative.conversion;
  const hash =
    conversion && typeof conversion === "object" ? (conversion as Record<string, unknown>).convertedSha256 : undefined;
  return typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash) ? hash : undefined;
}

export function queryMaterialResult(
  root: string,
  context: RunToolContext,
  args: Record<string, unknown>,
): ToolExecution {
  const material = verifyMaterial(root, String(args.materialId ?? "").trim());
  const run = queryMaterialTable(material, args);
  const computedAt = new Date().toISOString();
  const convertedSha256 = convertedSha256Of(material.derivative);
  saveQueryResult(root, {
    schema: "material-query-result/v1",
    materialId: material.id,
    materialSha256: material.sha256,
    part: run.part,
    querySha256: run.querySha256,
    resultSha256: run.resultSha256,
    cols: run.cols,
    columns: run.columns,
    rows: run.rows,
  });
  recordMaterialQuery(
    root,
    context,
    {
      materialId: material.id,
      materialSha256: material.sha256,
      ...(convertedSha256 ? { convertedSha256 } : {}),
      part: run.part,
      querySha256: run.querySha256,
      resultSha256: run.resultSha256,
      rowsScanned: run.rowsScanned,
      rowsReturned: run.rowsReturned,
    },
    computedAt,
  );
  const sheet = run.part.startsWith("sheet:") ? `工作表「${run.part.slice(6)}」` : "";
  return {
    name: "query_material",
    ok: true,
    summary: `${material.name} 查询 ${run.rowsReturned} 行`,
    detail: [
      `资料「${material.name}」${sheet}：扫描 ${run.rowsScanned} 行，筛选后 ${run.rowsMatched} 行，返回 ${run.rowsReturned} 行。`,
      `结果见 payload.rows；${QUERY_DISPLAY_RULE}。`,
      ...(run.notes.length ? ["说明：", ...run.notes] : []),
    ].join("\n"),
    payload: {
      materialId: material.id,
      name: material.name,
      part: run.part,
      cols: run.cols,
      columns: run.columns,
      rows: run.rows,
      notes: run.notes,
      querySha256: run.querySha256,
      resultSha256: run.resultSha256,
      receipt: {
        materialId: material.id,
        originalSha256: material.sha256,
        ...(convertedSha256 ? { convertedSha256 } : {}),
        querySha256: run.querySha256,
        resultSha256: run.resultSha256,
        query: run.query,
        rowsScanned: run.rowsScanned,
        rowsMatched: run.rowsMatched,
        rowsReturned: run.rowsReturned,
        computedAt,
      },
    },
  };
}
