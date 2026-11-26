/**
 * Adopted design-source ids and the kind/theme pack refusal shared by the Agent write tools.
 * Split out of agent-tools.ts to keep that module under its budget; the functions are moved verbatim.
 */
import { listSourceReceipts } from "../receipts.js";
import { kindThemePackIssue, sourceIdList } from "./theme-pack.js";
import type { AgentToolState, executeGenerateTool } from "./agent-tools.js";

export function adoptedSourceIdsForState(state: AgentToolState, args: Record<string, unknown> = {}): string[] {
  const adopted = sourceIdList(args.adoptedSourceIds, args.adopt);
  if (state.projectRoot) {
    for (const row of listSourceReceipts(state.projectRoot)) {
      if (row.state === "adopted" || row.state === "executed") adopted.push(row.sourceId);
    }
  }
  return adopted;
}

export function refuseIfKindThemePack(
  name: string,
  state: AgentToolState,
  args: Record<string, unknown> = {},
): ReturnType<typeof executeGenerateTool> | undefined {
  const issue = kindThemePackIssue({
    brief: state.brief,
    designSystemId: state.playbook.designSystemId,
    adoptedSourceIds: adoptedSourceIdsForState(state, args),
    projectRoot: state.projectRoot,
    userExplicitPack: state.userExplicitPack === true,
  });
  if (!issue) return undefined;
  return {
    name,
    ok: false,
    summary: "kind/theme pack",
    detail: issue.detail,
    payload: {
      error: issue.code,
      packId: issue.packId,
      kind: issue.kind,
      painted: false,
    },
  };
}
