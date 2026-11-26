import fs from "node:fs";
import path from "node:path";
import { stableSha256 } from "@open-slidestudio/presentation-run";

const RECEIPTS_REL = path.join("_agent", "dsh-tool-receipts.v1.json");

export type ToolCallReceipt = {
  readonly toolCallId: string;
  readonly commandHash: string;
  readonly outcome: unknown;
};

type ReceiptFile = { readonly receipts: readonly ToolCallReceipt[] };

export function commandHash(name: string, args: unknown): string {
  return stableSha256({ name, args });
}

function receiptsPath(projectRoot: string): string {
  return path.join(projectRoot, RECEIPTS_REL);
}

function loadReceipts(projectRoot: string): ToolCallReceipt[] {
  const file = receiptsPath(projectRoot);
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ReceiptFile>;
  return Array.isArray(parsed.receipts) ? [...parsed.receipts] : [];
}

export function lookupToolReceipt(projectRoot: string, toolCallId: string): ToolCallReceipt | undefined {
  return loadReceipts(projectRoot).find((row) => row.toolCallId === toolCallId);
}

export function recordToolReceipt(projectRoot: string, receipt: ToolCallReceipt): void {
  const rows = loadReceipts(projectRoot).filter((row) => row.toolCallId !== receipt.toolCallId);
  rows.push(receipt);
  fs.mkdirSync(path.join(projectRoot, "_agent"), { recursive: true });
  fs.writeFileSync(receiptsPath(projectRoot), `${JSON.stringify({ receipts: rows }, null, 2)}\n`);
}
