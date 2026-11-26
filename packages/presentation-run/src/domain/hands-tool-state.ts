import fs from "node:fs";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { persistPageKey } from "./page-identity.js";
import { parseCanonicalPagePlan } from "./page-plan.js";
import { effectivePageCountRequirement } from "./conversation-requirements.js";
import { minimumPageCount } from "./page-count-requirement.js";
import { readRunLedger } from "./run-ledger.js";
import type { DomainRuntime } from "./domain-hands.js";
import type { AgentTodo, AgentToolState } from "./agent-tools.js";
import type { SkillDeckInput, SkillPageInput } from "./skill-pages.js";
import { inspectProjectCapabilities } from "../capabilities.js";
import { createPageRasterPort } from "./page-raster.js";
import { loadPlaybook } from "./playbook.js";
import { decidedCatalogPackIsExplicit, effectiveCatalogPackId } from "./design-authority.js";
import { createImagePort, grokImageConfigFromEnv, imageConfigFromEnv } from "./image-port.js";
import { createImageSearchPort } from "./image-search-port.js";
import { createGrokImageSearchPort, grokWebSearch } from "./grok-hosted.js";
import { readActiveReviewGuard } from "./review-write-scope.js";
import { structuralEditGuard } from "./page-structure-tools.js";
import { sessionMaterialReadings } from "./material-figures.js";

export type HandsStateFile = {
  todos: AgentTodo[];
  writtenPages: SkillPageInput[];
  skillDeck?: SkillDeckInput;
};

export function buildToolState(
  root: string,
  runtime: DomainRuntime,
  saved: HandsStateFile,
  contextEpochId?: string,
): AgentToolState {
  const ledger = readRunLedger(root);
  let todos = saved.todos;
  const __split1639 = () => {
    if (ledger) {
      const todo = ledger.facts.filter((fact) => fact.type === "todo.committed").at(-1);
      try {
        todos = parseCanonicalPagePlan(todo?.pagePlan).map((page) => ({
          ...page,
          exhibits: [...page.exhibits],
        }));
      } catch {
        todos = [];
      }
      // Structural edit turns grow the manifest beyond the committed plan. Teach
      // the plan about pages that now exist on disk so gates and prompts see the
      // real page set. Union, not replace: mid-generation the disk is still a
      // subset of the plan and committed entries must not drop out. Only a real
      // committed plan earns this sync — a bare hands-state never gated on plans.
      if (todos.length && structuralEditGuard(readActiveReviewGuard(root))) {
        try {
          const project = loadProject(root);
          const known = new Set(
            todos.map((todo) => persistPageKey(String(todo.pageId ?? ""))).filter((key) => key.length > 0),
          );
          const extras = project.pages
            .map((loaded) => persistPageKey(loaded.path))
            .filter((id) => id.length > 0 && !known.has(id))
            .map((id) => ({ pageId: id, title: id }));
          if (extras.length) todos = [...todos, ...extras];
        } catch {
          // The project may not exist yet during early generation.
        }
      }
    }
  };
  __split1639();

  const attach = path.join(root, "_agent", "attachments.md");
  const referenceText = [
    fs.existsSync(attach) ? fs.readFileSync(attach, "utf8") : "",
    ...(contextEpochId
      ? sessionMaterialReadings(root, contextEpochId, ["text", "table", "document", "deck-template"], {
          templateTables: true,
          tableCellsOnly: true,
        }).flatMap((material) => material.pages.map((page) => page.text))
      : []),
  ]
    .filter(Boolean)
    .join("\n\n");
  const caps = inspectProjectCapabilities(root);
  const pageCountRequirement = effectivePageCountRequirement(root, runtime.brief, contextEpochId);
  return {
    brief: runtime.brief,
    requestedPageCount: minimumPageCount(pageCountRequirement),
    pageCountRequirement,
    contextEpochId,
    playbook: loadPlaybook({
      categoryId: runtime.categoryId,
      // runtime.designSystemId is the Hub pack kept as history; a saved style decision may have replaced it.
      designSystemId: effectiveCatalogPackId(root, runtime.designSystemId),
      hostDefaults: false,
    }),
    referenceText: referenceText || undefined,
    todos,
    researchNotes: [],
    writtenPages: saved.writtenPages,
    skillDeck: saved.skillDeck,
    strictLedger: Boolean(ledger),
    projectRoot: root,
    userExplicitPack:
      decidedCatalogPackIsExplicit(root, runtime.designSystemId) ||
      runtime.designDirection === "preset" ||
      runtime.designDirection === "user-design",
    // The persisted editorBaseUrl can be stale across sidecar restarts (the
    // port moves); the kernel's own env carries the live value. Prefer it.
    raster: createPageRasterPort({
      editorBaseUrl: process.env.SLIDESTUDIO_EDITOR_URL?.trim() || runtime.editorBaseUrl,
      requestHeaders: runtime.principal
        ? {
            cookie: `oss_uid=${runtime.principal}`,
            ...(runtime.principal.startsWith("ext_") && process.env.SLIDESTUDIO_ADMIN_TOKEN
              ? {
                  "x-slides-principal": runtime.principal,
                  "x-slides-admin-token": process.env.SLIDESTUDIO_ADMIN_TOKEN,
                }
              : {}),
          }
        : undefined,
    }),
    image: caps.imageGenerate.configured
      ? createImagePort(caps.imageGenerate.via === "pi-xai-hosted" ? grokImageConfigFromEnv() : imageConfigFromEnv())
      : undefined,
    imageSearch: caps.imageSearch.configured
      ? caps.imageSearch.via === "pi-xai-hosted"
        ? createGrokImageSearchPort()
        : createImageSearchPort()
      : undefined,
    webSearch:
      caps.research.configured && caps.research.via === "pi-xai-hosted"
        ? { search: (query: string) => grokWebSearch(query) }
        : undefined,
  };
}
