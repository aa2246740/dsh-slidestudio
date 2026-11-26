import fs from "node:fs";
import path from "node:path";
import { MATERIAL_MAX_LOGO_BYTES } from "./material-limits.js";
import { MaterialPackError, sha256Hex, type VerifiedMaterial } from "./material-pack.js";

/** Receipt paths are Host-written, but still confined before every image delivery. */
export function verifiedTemplatePhoto(material: VerifiedMaterial, mediaId: unknown) {
  const entry = material.receipt.media?.find((item) => item.role === "template-photo" && item.mediaId === mediaId);
  if (!entry) {
    throw new MaterialPackError("模板照片不存在；请从 list_materials 返回的 mediaId 中选择");
  }
  if (
    typeof entry.file !== "string" ||
    !/^(ppt\/media|photos)\/[^/\\\0]+$/.test(entry.file) ||
    entry.file.includes("..") ||
    typeof entry.mediaSrc !== "string" ||
    !/^media\/[^/\\\0]+$/.test(entry.mediaSrc) ||
    entry.mediaSrc.includes("..") ||
    typeof entry.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  )
    throw new MaterialPackError("模板照片回执无效，请重新上传后再发送");
  const root = path.resolve(material.directory, "../../..");
  const copies = [
    { root: material.directory, file: path.join(material.directory, entry.file) },
    { root, file: path.join(root, entry.mediaSrc) },
  ];
  let bytes: Buffer | undefined;
  for (const copy of copies) {
    try {
      const stat = fs.lstatSync(copy.file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > MATERIAL_MAX_LOGO_BYTES ||
        !fs.realpathSync(copy.file).startsWith(fs.realpathSync(copy.root) + path.sep)
      ) {
        throw new Error("invalid image copy");
      }
      const data = fs.readFileSync(copy.file);
      if (sha256Hex(data) !== entry.sha256) throw new Error("image hash mismatch");
      bytes = data;
    } catch {
      throw new MaterialPackError("模板照片已变化或校验失败，请重新上传后再发送");
    }
  }
  if (!bytes) throw new MaterialPackError("模板照片缺失，请重新上传后再发送");
  return { bytes, sha256: entry.sha256, mediaId: entry.mediaId, mediaSrc: entry.mediaSrc };
}
