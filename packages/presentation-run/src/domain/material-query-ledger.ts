/**
 * Receipts of `query_material`: the `material.query-computed` ledger fact written once per call,
 * and the stored result file a later page check re-reads to trace a number back to its query.
 * The file is addressed by the query's hash, not the rows': two queries can return the same cols
 * and rows and still mean different things by them (a share shown as a percentage, a plain
 * number), and one result hash would let the later query overwrite the earlier one's columns.
 * A file is trusted only when it names its own query and its rows still hash to the fact's result.
 */
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-file.js";
import { stableSha256 } from "./hashing.js";
import type { QueryCell, QueryColumn } from "./material-query.js";
import { appendFact, factId, readRunLedger, type RunToolContext } from "./run-ledger.js";

export const QUERY_RESULTS_REL = path.join("_agent", "material-queries");

/** One per call: the same query on the same material repeats its hashes, not its fact. */
export type MaterialQueryFact = Readonly<{
  type: "material.query-computed";
  factId: string;
  at: string;
  contextEpochId: string;
  commandId: string;
  materialId: string;
  /** Sha256 of the material's original uploaded bytes (receipt-pinned). */
  materialSha256: string;
  convertedSha256?: string;
  part: string;
  querySha256: string;
  resultSha256: string;
  rowsScanned: number;
  rowsReturned: number;
}>;

export type ComputedFigureMatch = Readonly<{
  /** The number as the page states it. */
  value: string;
  resultSha256: string;
  column: string;
}>;

/** Numbers a page states that equal cells of a query result of this run. */
export type PageComputedFiguresFact = Readonly<{
  type: "page.computed-figures";
  factId: string;
  at: string;
  contextEpochId: string;
  pageId: string;
  revision: number;
  matches: readonly ComputedFigureMatch[];
}>;

export type StoredQueryResult = Readonly<{
  schema: "material-query-result/v1";
  materialId: string;
  materialSha256: string;
  part: string;
  querySha256: string;
  resultSha256: string;
  cols: readonly string[];
  columns: readonly QueryColumn[];
  rows: readonly (readonly QueryCell[])[];
}>;

const HASH = /^[a-f0-9]{64}$/;

function resultFile(root: string, name: string): string {
  return path.join(root, QUERY_RESULTS_REL, `${name}.json`);
}

export function saveQueryResult(root: string, stored: StoredQueryResult): void {
  if (!HASH.test(stored.resultSha256)) throw new Error("query result hash is invalid");
  if (!HASH.test(stored.querySha256)) throw new Error("query hash is invalid");
  writeJsonAtomic(resultFile(root, stored.querySha256), stored);
}

function readStored(root: string, name: string): StoredQueryResult | undefined {
  try {
    return JSON.parse(fs.readFileSync(resultFile(root, name), "utf8")) as StoredQueryResult | undefined;
  } catch {
    return undefined;
  }
}

function holdsResult(stored: StoredQueryResult | undefined, resultSha256: string): boolean {
  return (
    stored?.schema === "material-query-result/v1" &&
    stored.resultSha256 === resultSha256 &&
    Array.isArray(stored.cols) &&
    Array.isArray(stored.rows) &&
    Array.isArray(stored.columns) &&
    stableSha256({ cols: stored.cols, rows: stored.rows }) === resultSha256
  );
}

/**
 * The stored result of one query, or undefined when it is missing, unreadable or does not verify.
 * Runs that predate per-query files filed the result under its own hash; that file still verifies
 * by its rows, though it may carry the columns of whichever query wrote it last.
 */
export function readQueryResult(
  root: string,
  ref: Pick<MaterialQueryFact, "querySha256" | "resultSha256">,
): StoredQueryResult | undefined {
  if (!HASH.test(ref.querySha256) || !HASH.test(ref.resultSha256)) return undefined;
  const own = readStored(root, ref.querySha256);
  if (holdsResult(own, ref.resultSha256) && own!.querySha256 === ref.querySha256) return own;
  const filedByRows = readStored(root, ref.resultSha256);
  return holdsResult(filedByRows, ref.resultSha256) ? filedByRows : undefined;
}

export function recordMaterialQuery(
  root: string,
  context: RunToolContext,
  input: Omit<MaterialQueryFact, "type" | "factId" | "at" | "contextEpochId" | "commandId">,
  at: string,
): MaterialQueryFact {
  const payload = {
    ...input,
    contextEpochId: context.contextEpochId,
    commandId: context.commandId,
  };
  const fact: MaterialQueryFact = {
    type: "material.query-computed",
    // The command id keeps two calls apart; replaying the same command stays idempotent.
    factId: factId("material.query-computed", payload),
    at,
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

/** `material.query-computed` facts of the context epoch, oldest first. */
export function epochQueryFacts(root: string, contextEpochId: string): readonly MaterialQueryFact[] {
  return (readRunLedger(root)?.facts ?? []).filter(
    (fact): fact is MaterialQueryFact =>
      fact.type === "material.query-computed" && fact.contextEpochId === contextEpochId,
  );
}
