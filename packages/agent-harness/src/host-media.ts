/**
 * Optional image hands + attachment evidence. No public-web default.
 */
import type { ImagePort } from "./image-port.js";
import type { ImageSearchPort } from "./image-search-port.js";
import { saveMediaFile } from "./media-store.js";
import type { ExhibitKind, HostPageCopy } from "./exhibit-paint.js";

export type HostMediaPorts = {
  projectRoot?: string;
  search?: ImageSearchPort;
  generate?: ImagePort;
};

export async function maybePlaceImage(query: string, ports: HostMediaPorts): Promise<string | undefined> {
  const root = ports.projectRoot;
  if (!root || (!ports.search && !ports.generate)) return undefined;
  const id = query.replace(/[^\w\u4e00-\u9fff]+/g, "-").slice(0, 24) || "img";
  try {
    if (ports.search) {
      const hit = await ports.search.search(query.slice(0, 80));
      if (hit && "bytes" in hit && hit.bytes?.length > 64) {
        const ext = hit.mime === "image/jpeg" ? "jpg" : hit.mime === "image/webp" ? "webp" : "png";
        return saveMediaFile(root, id, hit.bytes, ext).src;
      }
    }
    if (ports.generate) {
      const gen = await ports.generate.generate(`${query.slice(0, 120)}, no text overlay`);
      if (gen.bytes?.length > 64) return saveMediaFile(root, id, gen.bytes, "png").src;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function parseMarkdownTables(text: string): { columns: string[]; rows: string[][] }[] {
  const tables: { columns: string[]; rows: string[][] }[] = [];
  const lines = text.split(/\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (line.startsWith("|") && line.endsWith("|") && lines[i + 1] && /\|[\s:-]+\|/.test(lines[i + 1]!)) {
      const columns = splitPipe(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        const cells = splitPipe(lines[i]!.trim());
        if (cells.length) rows.push(cells);
        i += 1;
      }
      if (columns.length && rows.length) tables.push({ columns, rows });
      continue;
    }
    i += 1;
  }
  return tables;
}

function splitPipe(line: string): string[] {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((s) => s.trim())
    .filter((s) => !/^:?-+:?$/.test(s));
}

export function evidencePagesFromReference(text: string): HostPageCopy[] {
  if (!text.trim()) return [];
  const tables = parseMarkdownTables(text);
  return tables.slice(0, 4).map((table, i) => ({
    id: `evidence-${i + 1}`,
    pageType: "content",
    title: table.columns.slice(0, 3).join(" / ").slice(0, 24) || `材料表 ${i + 1}`,
    kicker: "附件",
    lines: table.rows.slice(0, 8).map((r) => r.join(" / ")),
    body: `四列表\n列：${table.columns.join(" / ")}\n${table.rows.map((r) => r.join(" / ")).join("\n")}`,
    exhibit: "table" as ExhibitKind,
  }));
}

export function wantsPhoto(copy: HostPageCopy, intent?: string): boolean {
  if (intent === "travel") return copy.pageType === "cover" || copy.pageType === "content";
  return /旅游|攻略|风景|产品图/.test(`${copy.title} ${copy.body || ""}`);
}
