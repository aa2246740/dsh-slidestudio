import fs from "node:fs";
import path from "node:path";
import { quarantineCorruptFile, writeJsonAtomic } from "./domain/atomic-file.js";
import { canonicalDesignSourceId } from "./domain/theme-pack.js";
import type { SourceReceipt, SourceReceiptState } from "./types.js";

const RECEIPTS_REL = path.join("_agent", "presentation-receipts.v1.json");

type ReceiptFile = {
  readonly version: 1;
  readonly receipts: SourceReceipt[];
};

function filePath(projectRoot: string): string {
  return path.join(projectRoot, RECEIPTS_REL);
}

function load(projectRoot: string): SourceReceipt[] {
  const file = filePath(projectRoot);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ReceiptFile>;
    return Array.isArray(parsed.receipts) ? [...parsed.receipts] : [];
  } catch {
    // A torn receipts cache denies rather than grants — sources must be
    // re-consulted — but the corrupt file should not keep poisoning reads.
    quarantineCorruptFile(file);
    return [];
  }
}

function save(projectRoot: string, receipts: SourceReceipt[]): void {
  const body: ReceiptFile = { version: 1, receipts };
  writeJsonAtomic(filePath(projectRoot), body);
}

const RANK: Record<SourceReceiptState, number> = {
  available: 0,
  consulted: 1,
  adopted: 2,
  executed: 3,
};

export function listSourceReceipts(projectRoot: string): SourceReceipt[] {
  return load(projectRoot);
}

export function recordSourceReceipt(projectRoot: string, receipt: SourceReceipt): SourceReceipt[] {
  const canonical = canonicalDesignSourceId(receipt.sourceId);
  const stored = canonical ? { ...receipt, sourceId: canonical } : receipt;
  const rows = load(projectRoot);
  const idx = rows.findIndex((row) => row.sourceId === stored.sourceId);
  if (idx < 0) {
    rows.push(stored);
  } else {
    const prev = rows[idx]!;
    if (RANK[stored.state] >= RANK[prev.state]) rows[idx] = { ...prev, ...stored };
  }
  save(projectRoot, rows);
  return rows;
}

export function consultedAdoptedExecuted(projectRoot: string): {
  consulted: number;
  adopted: number;
  executed: number;
} {
  const rows = load(projectRoot);
  return {
    consulted: rows.filter((row) => RANK[row.state] >= RANK.consulted).length,
    adopted: rows.filter((row) => RANK[row.state] >= RANK.adopted).length,
    executed: rows.filter((row) => RANK[row.state] >= RANK.executed).length,
  };
}

export function requireConsultAdoptBeforeWrite(projectRoot: string, tool = "write_page"): string | undefined {
  const counts = consultedAdoptedExecuted(projectRoot);
  if (counts.consulted < 1) {
    return `${tool} blocked: no consulted reference receipt (read_reference)`;
  }
  if (counts.adopted < 1) {
    return `${tool} blocked: no adopted design receipt (commit_design)`;
  }
  return undefined;
}
