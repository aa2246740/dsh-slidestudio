/**
 * Stored derivative of an image overview. The mosaic for a given ordered set
 * of verified tiles is composed once and kept under
 * `_agent/materials/_overview/`; every later call (and every call after a
 * restart) serves the stored bytes after re-hashing them, so the model sees the
 * same pixels and the same sha256 for the same set of images.
 */
import fs from "node:fs";
import path from "node:path";
import type { OverviewPlan } from "@open-slidestudio/presentation-run";
import {
  composeImageOverview,
  IMAGE_OVERVIEW_SCHEMA,
  imageOverviewSha256,
  type ImageOverview,
  type OverviewTilePlacement,
} from "./image-overview.js";
import { inputSha256 } from "./material-input.js";

const OVERVIEW_DIR = path.join("_agent", "materials", "_overview");
/** Normalized JPEGs are ≤ 1568 px; template photos may be larger originals. */
const MAX_TILE_BYTES = 25 * 1024 * 1024;

export class OverviewSourceError extends Error {
  override readonly name = "OverviewSourceError";
}

type Descriptor = Readonly<{
  schema: typeof IMAGE_OVERVIEW_SCHEMA;
  kind: OverviewPlan["kind"];
  materialId: string;
  inputSha256: string;
  sha256: string;
  width: number;
  height: number;
  columns: number;
  rows: number;
  tiles: readonly OverviewTilePlacement[];
}>;

export type StoredImageOverview = Readonly<{ overview: ImageOverview; reused: boolean }>;

function storeKey(plan: OverviewPlan): string {
  return plan.kind === "all-images" ? "all-images" : `pdf-${inputSha256(plan.materialId).slice(0, 16)}`;
}

/** The composition inputs: who sits in which numbered cell, and exactly which bytes. */
function inputKey(plan: OverviewPlan): string {
  return inputSha256(
    JSON.stringify({
      schema: IMAGE_OVERVIEW_SCHEMA,
      kind: plan.kind,
      materialId: plan.materialId,
      tiles: plan.tiles.map((tile) => [tile.number, tile.sha256]),
    }),
  );
}

function readTileBytes(projectRoot: string, tile: OverviewPlan["tiles"][number]): Buffer {
  const materialsRoot = path.resolve(projectRoot, "_agent", "materials");
  const file = path.resolve(projectRoot, tile.file);
  const changed = new OverviewSourceError(`资料「${tile.name}」的图片已变化或缺失，请重新上传后再发送`);
  if (!file.startsWith(materialsRoot + path.sep)) throw changed;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TILE_BYTES) throw changed;
    const bytes = fs.readFileSync(file);
    if (inputSha256(bytes) !== tile.sha256) throw changed;
    return bytes;
  } catch {
    throw changed;
  }
}

function readStored(dir: string, key: string, expected: string): ImageOverview | undefined {
  try {
    const descriptor = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), "utf8")) as Descriptor;
    const bytes = fs.readFileSync(path.join(dir, `${key}.jpg`));
    if (
      descriptor.schema !== IMAGE_OVERVIEW_SCHEMA ||
      descriptor.inputSha256 !== expected ||
      descriptor.sha256 !== imageOverviewSha256(bytes)
    ) {
      return undefined;
    }
    return {
      bytes,
      sha256: descriptor.sha256,
      width: descriptor.width,
      height: descriptor.height,
      columns: descriptor.columns,
      rows: descriptor.rows,
      tiles: descriptor.tiles,
    };
  } catch {
    return undefined;
  }
}

function writeAtomic(file: string, data: Buffer | string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, file);
}

/** Serve the stored mosaic for this plan, composing (and storing) it when absent or stale. */
export async function composeOrReuseOverview(projectRoot: string, plan: OverviewPlan): Promise<StoredImageOverview> {
  const sources = plan.tiles.map((tile) => ({
    number: tile.number,
    bytes: readTileBytes(projectRoot, tile),
  }));
  const dir = path.join(projectRoot, OVERVIEW_DIR);
  const key = storeKey(plan);
  const expected = inputKey(plan);
  const stored = readStored(dir, key, expected);
  if (stored) return { overview: stored, reused: true };
  const overview = await composeImageOverview(sources);
  fs.mkdirSync(dir, { recursive: true });
  const descriptor: Descriptor = {
    schema: IMAGE_OVERVIEW_SCHEMA,
    kind: plan.kind,
    materialId: plan.materialId,
    inputSha256: expected,
    sha256: overview.sha256,
    width: overview.width,
    height: overview.height,
    columns: overview.columns,
    rows: overview.rows,
    tiles: overview.tiles,
  };
  writeAtomic(path.join(dir, `${key}.jpg`), overview.bytes);
  writeAtomic(path.join(dir, `${key}.json`), `${JSON.stringify(descriptor, null, 2)}\n`);
  return { overview, reused: false };
}
