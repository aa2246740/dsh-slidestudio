/**
 * The kind and theme-pack refusal shared by the host write tools (write_page and write_layout).
 * A brief that needs a pack, or a declared aspect that the selected pack forbids, is refused before
 * any other write check (ruling 89). Moved verbatim out of tools.ts to keep that module under its budget.
 */
import {
  decidedCatalogPackIsExplicit,
  effectiveCatalogPackId,
  kindThemePackIssue,
  listSourceReceipts,
  sourceIdList,
} from "@open-slidestudio/presentation-run";
import { readSliceRuntimeFile } from "./runtime.js";

function runtimeKindThemeInput(projectRoot: string): {
  brief: string;
  designSystemId?: string;
  userExplicitPack: boolean;
} {
  try {
    const rec = readSliceRuntimeFile(projectRoot);
    const brief = typeof rec.brief === "string" ? rec.brief.trim() : "";
    // The effective pack, not the stale Hub designSystemId: a current style
    // decision may select another pack or replace the pack with an attachment.
    const designSystemId = effectiveCatalogPackId(projectRoot);
    return {
      brief,
      designSystemId,
      userExplicitPack:
        decidedCatalogPackIsExplicit(projectRoot) ||
        rec.designDirection === "preset" ||
        rec.designDirection === "user-design",
    };
  } catch {
    return { brief: "", userExplicitPack: false };
  }
}

export function rejectKindThemePack(
  projectRoot: string,
  args: Record<string, unknown>,
):
  | {
      outcome: "rejected";
      error: string;
      packId: string | undefined;
      kind: string;
      detail: string;
      painted: false;
    }
  | undefined {
  const runtime = runtimeKindThemeInput(projectRoot);
  const adoptedSourceIds = [
    ...sourceIdList(args.adoptedSourceIds, args.adopt),
    ...listSourceReceipts(projectRoot)
      .filter((row) => row.state === "adopted" || row.state === "executed")
      .map((row) => row.sourceId),
  ];
  const issue = kindThemePackIssue({
    brief: runtime.brief,
    designSystemId: runtime.designSystemId,
    adoptedSourceIds: [...new Set(adoptedSourceIds)],
    projectRoot,
    designAspects: args.designAspects,
    userExplicitPack: runtime.userExplicitPack,
  });
  if (!issue) return undefined;
  return {
    outcome: "rejected",
    error: issue.code,
    packId: issue.packId,
    kind: issue.kind,
    detail: issue.detail,
    painted: false,
  };
}
