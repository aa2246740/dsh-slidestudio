/**
 * Skill produce: images live in project media/, then YAML src points at them.
 */
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";

const SAFE_ID = /[^a-zA-Z0-9_-]+/g;

export function mediaId(raw: string, fallback = "img"): string {
  const id = raw
    .trim()
    .replace(SAFE_ID, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return id || fallback;
}

export function saveMediaFile(
  projectRoot: string,
  id: string,
  bytes: Buffer,
  ext = "png",
  options: { preserveId?: boolean } = {},
): { src: string; abs: string } {
  // Host-owned material filenames retain their complete id (including CJK)
  // instead of the short, lossy ids used by agent-authored media.
  const base = options.preserveId ? id : mediaId(id);
  const suffix = ext.replace(/^\./, "");
  if (
    options.preserveId &&
    (!base ||
      /[\\/\0]/.test(base) ||
      base.includes("..") ||
      !/^[a-z0-9]+$/i.test(suffix) ||
      Buffer.byteLength(`${base}.${suffix}`) > 240)
  ) {
    throw new Error("资料媒体文件名无效或过长，请缩短文件名后重新上传");
  }
  const dir = path.join(projectRoot, "media");
  fs.mkdirSync(dir, { recursive: true });
  // Sanitized ids collide (e.g. "a b" and "a-b"): never clobber different
  // bytes under the same name — suffix until free. Identical bytes reuse.
  let name = `${base}.${suffix}`;
  let abs = path.join(dir, name);
  for (let n = 2; fs.existsSync(abs); n++) {
    if (n > 999) throw new Error(`media id namespace exhausted for ${base}`);
    try {
      if (fs.readFileSync(abs).equals(bytes)) break;
    } catch {
      break;
    }
    name = `${base}-${n}.${suffix}`;
    abs = path.join(dir, name);
  }
  writeFileAtomic(abs, bytes);
  return { src: `media/${name}`, abs };
}

export function mediaExists(projectRoot: string, src: string): boolean {
  const rel = src.replace(/^\/+/, "");
  if (!rel.startsWith("media/")) return false;
  const abs = path.resolve(projectRoot, rel);
  const root = path.resolve(projectRoot);
  if (!abs.startsWith(root + path.sep)) return false;
  return fs.existsSync(abs);
}

export function listMedia(projectRoot: string): string[] {
  const dir = path.join(projectRoot, "media");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .map((name) => `media/${name}`)
    .sort();
}
