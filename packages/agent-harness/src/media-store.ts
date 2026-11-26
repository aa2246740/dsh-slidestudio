/**
 * Skill produce: images live in project media/, then YAML src points at them.
 */
import fs from "node:fs";
import path from "node:path";

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
): { src: string; abs: string } {
  const name = `${mediaId(id)}.${ext.replace(/^\./, "")}`;
  const dir = path.join(projectRoot, "media");
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, bytes);
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
