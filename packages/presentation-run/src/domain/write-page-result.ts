/**
 * The post-write steps of a successful strict write_page: bind the revision fact to the persisted
 * file, record the provenance facts and merge the non-blocking hints. None of these steps refuses
 * the write. Moved out of domain-hands.ts, which is at its line budget.
 */
import { loadProject } from "@open-slidestudio/pptd-v2";
import type { ToolExecution } from "./agent-tools.js";
import { carryEditorDeclaration } from "./editor-provenance-carry.js";
import { pageIdMatchesFile } from "./layout-qa.js";
import { applyWritePageProvenance } from "./material-figures.js";
import { layoutPlanHint } from "./page-layout-plan.js";
import { persistPageKey } from "./page-identity.js";
import { recordPageRevision, type RunToolContext } from "./run-ledger.js";
import type { SkillPageInput } from "./skill-pages.js";

export function withWritePageRevision(
  root: string,
  context: RunToolContext,
  result: ToolExecution,
  args: Record<string, unknown>,
): ToolExecution {
  const page = (result.payload as { page?: SkillPageInput } | undefined)?.page;
  if (!page?.id) throw new Error("write_page succeeded without a page payload");
  // Bind the revision fact to the persisted file, not the tool payload:
  // reload the page that was just written and hash the on-disk revision.
  const persisted = loadProject(root).pages.find((entry) => pageIdMatchesFile(page.id, entry.path));
  if (!persisted) {
    throw new Error(`write_page persisted no page file for ${page.id}`);
  }
  const canonicalId = persistPageKey(persisted.path);
  const revisionFact = recordPageRevision(root, context, canonicalId, {
    ...persisted.page,
    id: canonicalId,
  });
  // Non-blocking provenance/figure facts and hints; never a gate, never stored in the page.
  carryEditorDeclaration(root, context, revisionFact, persisted.page, args);
  const hint = [
    applyWritePageProvenance(root, context, revisionFact, persisted.page, args),
    layoutPlanHint(root, canonicalId, persisted.page.layoutId),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
  if (!hint) return result;
  return {
    ...result,
    payload: { ...(result.payload as Record<string, unknown>), hint },
  };
}
