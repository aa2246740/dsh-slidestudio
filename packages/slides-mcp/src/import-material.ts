/**
 * `import_material`: copy one local file into the bound project's materials.
 *
 * Fail-closed by default: without configured import roots
 * (`--allow-import-root` / `SLIDESTUDIO_MCP_IMPORT_ROOTS`) every call is refused.
 * The path is canonicalized with `realpath`, so traversal and symlinks that
 * leave every root are refused, as are directories, oversized files and
 * unsupported formats. Path checks run before the writer lease is taken.
 */
import fs from "node:fs";
import path from "node:path";
import { withProjectWriteLock } from "@open-slidestudio/pptd-v2";
import { MATERIAL_MAX_ORIGINAL_BYTES, verifyMaterial } from "@open-slidestudio/presentation-run";
import {
  leaseRefusal,
  readMaterialsManifest,
  slideTool,
  withProjectLeaseLock,
  writeSessionMaterials,
  type SlideToolContext,
  type SlideToolDefinition,
  type SlideToolResult,
  type SlideToolRuntimeDeps,
} from "@open-slidestudio/slides-tools";
import { IMPORT_FORMATS, MaterialFormatError, materialName, prepareImportedMaterial } from "./material-derivative.js";

export type ImportPolicy = {
  /** Directories an MCP client may import from; empty refuses every import. */
  readonly allowedImportRoots: readonly string[];
};

type Resolved =
  | { readonly ok: true; readonly real: string; readonly extension: string }
  | { readonly ok: false; readonly error: string; readonly detail: string };

function refusal(error: string, detail: string): SlideToolResult {
  return { isError: true, data: { ok: false, error, detail, painted: false } };
}

function canonicalRoots(roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    try {
      const real = fs.realpathSync(root);
      if (fs.statSync(real).isDirectory()) out.push(real);
    } catch {
      // A missing root matches nothing.
    }
  }
  return out;
}

function within(root: string, real: string): boolean {
  return real.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

function supportedList(): string {
  return Object.keys(IMPORT_FORMATS).join(", ");
}

/** Resolve and check an import path without reading its bytes. */
export function resolveImportPath(policy: ImportPolicy, raw: unknown): Resolved {
  if (!policy.allowedImportRoots.length) {
    return {
      ok: false,
      error: "import_roots_not_configured",
      detail:
        "import_material is disabled: start slides-mcp with --allow-import-root <dir> (repeatable) or set SLIDESTUDIO_MCP_IMPORT_ROOTS",
    };
  }
  if (typeof raw !== "string" || !raw.trim() || !path.isAbsolute(raw.trim())) {
    return { ok: false, error: "import_path_not_absolute", detail: "path must be an absolute file path" };
  }
  let real: string;
  try {
    real = fs.realpathSync(raw.trim());
  } catch {
    return { ok: false, error: "import_path_not_found", detail: "no file exists at that path" };
  }
  if (!canonicalRoots(policy.allowedImportRoots).some((root) => within(root, real))) {
    return {
      ok: false,
      error: "import_path_outside_roots",
      detail: "the file resolves outside every configured import root (symlinks and '..' are resolved first)",
    };
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) return { ok: false, error: "import_path_not_file", detail: "path is not a regular file" };
  if (stat.size > MATERIAL_MAX_ORIGINAL_BYTES) {
    return {
      ok: false,
      error: "import_file_too_large",
      detail: `files are limited to ${MATERIAL_MAX_ORIGINAL_BYTES} bytes`,
    };
  }
  const extension = path.extname(real).toLowerCase();
  if (!IMPORT_FORMATS[extension]) {
    return {
      ok: false,
      error: "unsupported_material_format",
      detail: `unsupported file type ${extension || "(none)"}; supported: ${supportedList()}`,
    };
  }
  return { ok: true, real, extension };
}

/** Read the resolved file through one descriptor so its type and size are re-checked at read time. */
function readChecked(real: string): Buffer {
  const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new MaterialFormatError("import_path_not_file", "path is not a regular file");
    if (stat.size > MATERIAL_MAX_ORIGINAL_BYTES) {
      throw new MaterialFormatError(
        "import_file_too_large",
        `files are limited to ${MATERIAL_MAX_ORIGINAL_BYTES} bytes`,
      );
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function importInto(
  deps: SlideToolRuntimeDeps,
  ctx: SlideToolContext,
  resolved: Extract<Resolved, { ok: true }>,
  name: string,
): SlideToolResult {
  const bytes = readChecked(resolved.real);
  const prepared = prepareImportedMaterial({ bytes, extension: resolved.extension, name, ownerId: ctx.caller.id });
  const id = prepared.attachment.id;
  const projectRoot = ctx.projectRoot;
  const commit = withProjectWriteLock(projectRoot, () =>
    withProjectLeaseLock(projectRoot, () => {
      const denied = leaseRefusal(deps, ctx);
      if (denied) return { ok: false as const, refusal: denied };
      const replaced = readMaterialsManifest(projectRoot).materials.some((entry) => entry.id === id);
      writeSessionMaterials(projectRoot, [prepared]);
      return { ok: true as const, replaced };
    }),
  );
  if (!commit.ok) return commit.refusal;
  const material = verifyMaterial(projectRoot, id);
  return {
    data: {
      ok: true,
      outcome: commit.replaced ? "replaced" : "imported",
      materialId: id,
      name: material.name,
      kind: material.kind,
      parser: material.parser,
      summaryZh: material.summaryZh,
      needsVision: material.needsVision,
      parts: material.parts,
      ...(material.mediaSrc ? { mediaSrc: material.mediaSrc } : {}),
      next: "Call list_materials, then read_material for every part you rely on before using its facts.",
    },
  };
}

export function importMaterialTool(deps: SlideToolRuntimeDeps, policy: ImportPolicy): SlideToolDefinition {
  const gated = slideTool(deps, {
    name: "import_material",
    description: `Import one local file into the bound project's reference materials so list_materials, read_material and view_material can read it. path must be an absolute path inside a directory the server operator allowed with --allow-import-root; without one every import is refused (import_roots_not_configured). Supported: ${supportedList()} (UTF-8 text and tables, PNG/JPEG images). Re-importing identical bytes replaces the same material.`,
    parameters: {
      path: { type: "string", required: true, description: "Absolute path of the file to import" },
      name: { type: "string", description: "Optional display name; defaults to the file name" },
    },
    closed: true,
    readOnly: false,
    async execute(args, ctx) {
      const resolved = resolveImportPath(policy, args.path);
      if (!resolved.ok) return refusal(resolved.error, resolved.detail);
      try {
        return importInto(deps, ctx, resolved, materialName(args.name, resolved.real));
      } catch (error) {
        if (error instanceof MaterialFormatError) return refusal(error.code, error.message);
        throw error;
      }
    },
  });
  return {
    ...gated,
    async execute(args, ctx) {
      gated.validate?.(args);
      // Refuse before the writer lease: a disabled or invalid import never touches the project.
      const resolved = resolveImportPath(policy, args.path);
      if (!resolved.ok) return refusal(resolved.error, resolved.detail);
      return gated.execute(args, ctx);
    },
  };
}
