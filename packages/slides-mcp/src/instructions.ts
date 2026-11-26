/**
 * MCP `initialize.instructions`, generated from the single persona source
 * (`SLIDES_DIRECTOR_PERSONA_LINES`). Lines that name the DSH-only
 * `ask_user_question` tool are replaced: an external agent asks its user
 * directly in the host conversation.
 */
import { SLIDES_DIRECTOR_PERSONA_LINES } from "@open-slidestudio/slides-tools";

export const MCP_WORKFLOW: readonly string[] = [
  "open_project (or bind_project to continue an existing project)",
  "inspect_capabilities",
  "list_references / read_reference",
  "import_material / list_materials / read_material",
  "commit_design",
  "write_todo",
  "write_page",
  "render_page / review_page / review_pages",
  "compose_deck",
  "export_deck",
  "open_in_editor",
];

const ASK_USER_LINE =
  "When a missing preference materially affects the result, ask the user directly in your own host conversation with concise options or free text, wait for the answer and continue the same task. Never invent an answer or repeat a cancelled question. ask_user_question is a DSH-only tool and does not exist over MCP.";

const TOOLS_LINE =
  "Use only the slidestudio MCP tools for project changes. Never write YAML except through write_page.";

const MCP_PREFACE: readonly string[] = [
  "This server is DSH SlideStudio over MCP: it edits editable PPTD slide projects through canonical slide tools.",
  `Workflow: ${MCP_WORKFLOW.join(" -> ")}.`,
  "Every write takes this session's single-writer lease. If a tool returns lease-preempted-by-editor, a human is editing the deck in the native editor: wait until they finish, call reacquire_lease, then read_page before writing again. lease-conflict means another writer holds the project.",
  "import_material only reads files inside directories the server operator allowed; otherwise it refuses with import_roots_not_configured.",
];

/** Persona lines adapted for MCP hosts (the DSH `ask_user_question` lines are replaced). */
export function mcpPersonaLines(): string[] {
  const out: string[] = [];
  for (const line of SLIDES_DIRECTOR_PERSONA_LINES) {
    const text = line.replaceAll("{{cwd}}", "the SlideStudio data root of this server");
    if (!text.includes("ask_user_question")) out.push(text);
    else if (text.startsWith("When a missing preference")) out.push(ASK_USER_LINE);
    else out.push(TOOLS_LINE);
  }
  return out;
}

export function mcpInstructions(): string {
  return [...MCP_PREFACE, "", ...mcpPersonaLines()].join("\n");
}
