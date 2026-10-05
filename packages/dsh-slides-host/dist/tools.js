import { normalizeNumericPageText } from "./write-page-text.js";
import { discussionOnly, DISCUSSION_TOOLS } from "./assistant-conversation.js";
import { defineTool, ToolArgsError, validateJsonSchemaValue, } from "@deepseek-ai/dsh-tools";
import fs from "node:fs";
import path from "node:path";
import { currentPageRevision, readRunLedger, TODO_EXHIBIT_KINDS, readCommittedPagePlan, inspectProjectCapabilities, inspectCapabilities, persistPresentationRunProvider, webSearchQueriesFromArgs, kindThemePackIssue, listSourceReceipts, pageIdMatchesFile, persistPageKey, readPageRaster, sourceIdList, stableSha256, readActiveReviewGuard, reviewWriteTargets, reviewWriteTargetForPage, } from "@open-slidestudio/presentation-run";
import { EDIT_ELEMENTS_PARAMETER_SPEC, WRITE_PAGE_PARAMETER_SPEC, canonicalEditElementsIssues, writePageJsonSchema, editElementsJsonSchema, canonicalWritePageIssues, normalizeWritePageLineArrows, normalizeWritePageDialect, normalizePageFonts, SLIDE_FONTS, loadProject, } from "@open-slidestudio/pptd-v2";
import { commandHash, lookupToolReceipt, recordToolReceipt } from "./receipts.js";
import { SLICE_TOOL_NAMES } from "./protocol.js";
import { writeSliceRuntime, briefForOpenProject, readSliceRuntimeFile } from "./runtime.js";
import { yamlExistsForPage } from "./slice-session.js";
import { decideWritePage, readWritePageDisk, normalizeWritePageArgs } from "./write-page.js";
import { reviewPageGate, writePageSerial, } from "./write-page-serial.js";
import { renderPageToolContent, shouldAttachPageRaster } from "./page-raster-content.js";
import { CAPABILITY_FILTERED_PRODUCE_TOOL_NAMES, PRODUCE_WEB_SEARCH_DESCRIPTION, } from "./produce-request-header.js";
import { activeElementEditScope, prepareElementEdit } from "./edit-elements.js";
function closeToolParameterRoot(definition) {
    const parameters = { ...definition.parameters, additionalProperties: false };
    const execute = definition.execute;
    return {
        ...definition,
        parameters,
        async execute(args, exec) {
            const issues = validateJsonSchemaValue(parameters, args, "");
            if (issues.length)
                throw new ToolArgsError(issues);
            return execute(args, exec);
        },
    };
}
function plainRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return undefined;
    return value;
}
/**
 * Normalize a provider wire `function.arguments` envelope on a product tool
 * that did not declare `arguments` as one of its own business fields.
 *
 * A chain of envelopes is unwrapped while each level is unambiguous: `arguments`
 * is the sole top-level key and its value is a plain object. Once the inner
 * record is reached, every key must be a declared field or the call is rejected,
 * so a genuinely malformed call cannot be normalized into a successful call or
 * acquire a success receipt. Depth is capped to bound pathological nesting.
 */
const MAX_ARGUMENT_ENVELOPE_DEPTH = 4;
export function withProductToolArgumentContract(definition) {
    const properties = plainRecord(definition.parameters.properties);
    if (properties && Object.hasOwn(properties, "arguments"))
        return definition;
    const declaredKeys = properties ? new Set(Object.keys(properties)) : new Set();
    const expected = declaredKeys.size ? [...declaredKeys].join(", ") : "(no declared fields)";
    const execute = definition.execute;
    return {
        ...definition,
        async execute(rawArgs, exec) {
            const top = plainRecord(rawArgs);
            if (top === undefined || !Object.hasOwn(top, "arguments")) {
                return execute(rawArgs, exec);
            }
            let record = top;
            let depth = 0;
            while (Object.hasOwn(record, "arguments") &&
                Object.keys(record).length === 1 &&
                depth < MAX_ARGUMENT_ENVELOPE_DEPTH) {
                const inner = plainRecord(record.arguments);
                if (inner === undefined)
                    break;
                record = inner;
                depth += 1;
            }
            if (Object.hasOwn(record, "arguments") ||
                !Object.keys(record).every((key) => declaredKeys.has(key))) {
                throw new ToolArgsError([
                    `$args.arguments is a provider wire envelope, not a declared field of ${definition.name}; pass the declared fields directly at the top level: ${expected}`,
                ]);
            }
            return execute({ ...record }, exec);
        },
    };
}
function jsonOutput(renderText) {
    return {
        schema: { type: "json" },
        render(_args, value) {
            return [{ type: "text", text: renderText(value) }];
        },
    };
}
function jsonValue(value) {
    return JSON.parse(JSON.stringify(value));
}
function sessionIdOf(exec) {
    const id = exec.agent?.id;
    if (!id)
        throw new Error("tool call has no agent session");
    return id;
}
function runExclusivePageStep(gate, sessionId, toolName, task) {
    const slot = gate.tryAcquire(sessionId, toolName);
    if (!slot.ok) {
        throw new ToolArgsError([
            `Host runs ${toolName} one page at a time. ${slot.busyWith} is still running; wait for that result before another ${toolName}.`,
        ]);
    }
    return task().finally(() => slot.release());
}
function callIdOf(exec) {
    return exec.callId ?? "missing-call";
}
async function replayOrRun(projectRoot, name, args, toolCallId, run) {
    const hash = commandHash(name, args);
    const prior = lookupToolReceipt(projectRoot, toolCallId);
    if (prior) {
        if (prior.commandHash !== hash) {
            return jsonValue({
                outcome: "conflict",
                toolCallId,
                detail: "toolCallId reused with different arguments",
            });
        }
        return jsonValue(prior.outcome);
    }
    const outcome = await run();
    recordToolReceipt(projectRoot, { toolCallId, commandHash: hash, outcome });
    return jsonValue(outcome);
}
export function sliceToolGuard(allowed) {
    // A bare "forbidden" leaves the model dead-ended: it retries the same tool or
    // gives up and reports a fake system block. Naming the allowed write
    // surfaces lets it self-correct in the same step.
    const WRITE_SURFACES = ["write_page", "edit_elements", "edit_page_background", "delete_pages", "reorder_pages", "write_todo", "update_deck"];
    return (exec) => {
        if (exec.name.startsWith("_"))
            return undefined;
        if (allowed.has(exec.name))
            return undefined;
        const alternatives = WRITE_SURFACES.filter((name) => allowed.has(name));
        return `slides preset forbids ${exec.name}${alternatives.length ? `; the write tools available this turn: ${alternatives.join(", ")}` : ""}`;
    };
}
const CAPABILITY_FILTERED_PRODUCE_TOOLS = new Set(CAPABILITY_FILTERED_PRODUCE_TOOL_NAMES);
export function produceToolAllowlist(caps) {
    const allowed = new Set(SLICE_TOOL_NAMES.filter((name) => !CAPABILITY_FILTERED_PRODUCE_TOOLS.has(name)));
    allowed.add("ask_user_question");
    if (caps.vision.mode !== "none")
        allowed.add("review_page");
    if (caps.imageSearch.configured)
        allowed.add("search_image");
    if (caps.imageGenerate.configured)
        allowed.add("generate_image");
    return allowed;
}
function persistHubProvider(deps, sessionId) {
    if (!sessionId)
        return;
    const binding = deps.store.bindingFor(sessionId);
    if (!binding)
        return;
    const root = typeof deps.store.resolveRoot === "function"
        ? deps.store.resolveRoot(binding)
        : binding.projectRoot;
    if (typeof root !== "string" || !root.trim())
        return;
    const sameRoute = binding.provider.providerId === deps.provider.providerId &&
        binding.provider.modelId === deps.provider.modelId;
    // Host-global tools reflect the boot route. They may inspect a session that
    // has since switched, but must not downgrade that session's accepted binding.
    if (!sameRoute)
        return root;
    persistPresentationRunProvider(root, {
        ...binding.provider,
        ready: deps.provider.ready === true,
        ...(deps.provider.modelInputModalities !== undefined
            ? { modelInputModalities: deps.provider.modelInputModalities }
            : {}),
    });
    return root;
}
export function sessionProduceCapabilities(deps, sessionId) {
    const projectRoot = persistHubProvider(deps, sessionId);
    if (projectRoot)
        return inspectProjectCapabilities(projectRoot, process.env);
    return inspectCapabilities({
        env: process.env,
        providerId: deps.provider.providerId,
        modelId: deps.provider.modelId,
        ready: deps.provider.ready === true,
        modelInputModalities: deps.provider.modelInputModalities,
    });
}
export function sessionProduceToolAllowlist(deps, sessionId) {
    const caps = sessionProduceCapabilities(deps, sessionId);
    const binding = sessionId ? deps.store.bindingFor(sessionId) : undefined;
    const projectRoot = binding
        ? typeof deps.store.resolveRoot === "function"
            ? deps.store.resolveRoot(binding)
            : binding.projectRoot
        : undefined;
    if (projectRoot && discussionOnly(projectRoot))
        return DISCUSSION_TOOLS;
    const allowed = new Set(produceToolAllowlist(caps));
    if (projectRoot && activeElementEditScope(projectRoot)) {
        // Element review is an exact-subset operation. Expose one write surface so
        // the model cannot choose whole-page replacement or pay for both large
        // canonical element schemas in the same request header.
        const targets = reviewWriteTargets(readActiveReviewGuard(projectRoot));
        if (targets.every(({ scope }) => scope.kind === "elements"))
            allowed.delete("write_page");
        allowed.add("edit_elements");
    }
    const structural = projectRoot ? structuralEditScope(projectRoot) : undefined;
    if (projectRoot && !structural &&
        reviewWriteTargets(readActiveReviewGuard(projectRoot)).some(({ scope }) => scope.kind !== "elements")) {
        allowed.add("edit_page_background");
    }
    // Page deletion is only ever exposed while a structural lock names the pages
    // or a full-rewrite lock authorizes dropping any baseline page.
    const rewrite = projectRoot ? rewriteEditScope(projectRoot) : undefined;
    if (structural?.deletablePageIds.size || rewrite)
        allowed.add("delete_pages");
    // Same for a manifest reorder — only while the lock carries the target order,
    // or a rewrite lock needs the final plan order applied.
    if (structural?.reorderPageIds.length || rewrite)
        allowed.add("reorder_pages");
    // Deck metadata writes (title/theme) only while the lock whitelists the
    // fields via editableMeta, or under a rewrite lock which covers both.
    if (projectRoot && (editableMetaScope(projectRoot).size > 0 || rewrite))
        allowed.add("update_deck");
    // A metaOnly lock grants deck fields and nothing else — pull every page
    // write surface so the only mutation left is update_deck itself.
    if (projectRoot && metaOnlyEditScope(projectRoot)) {
        for (const name of ["write_page", "edit_elements", "edit_page_background", "delete_pages", "reorder_pages", "write_todo"]) {
            allowed.delete(name);
        }
    }
    return allowed;
}
/** True while the active lock is a metaOnly page lock (deck fields only). */
function metaOnlyEditScope(projectRoot) {
    const scope = readActiveReviewGuard(projectRoot)?.scope;
    if (!scope || typeof scope !== "object" || Array.isArray(scope))
        return false;
    return scope.metaOnly === true;
}
/** Fields the active lock whitelists for deck-level metadata writes. */
function editableMetaScope(projectRoot) {
    const scope = readActiveReviewGuard(projectRoot)?.scope;
    if (!scope || typeof scope !== "object" || Array.isArray(scope))
        return new Set();
    const rec = scope;
    return new Set((Array.isArray(rec.editableMeta) ? rec.editableMeta : [])
        .map((field) => String(field ?? "").trim())
        .filter((field) => field === "title" || field === "theme"));
}
/**
 * A full-rewrite lock (kind "deck" + rewrite) authorizes replacing the deck:
 * write_todo commits a new plan, write_page covers every baseline page plus
 * new ids, and delete_pages/reorder_pages settle the manifest to match.
 */
function rewriteEditScope(projectRoot) {
    const scope = readActiveReviewGuard(projectRoot)?.scope;
    if (!scope || typeof scope !== "object" || Array.isArray(scope))
        return false;
    const rec = scope;
    return rec.kind === "deck" && rec.rewrite === true && rec.structureOnly !== true;
}
/**
 * A page-list edit lock (kind "deck" + structureOnly) authorizes page-list
 * changes: adds at insertIndex, removals from deletablePageIds, whitelisted
 * rewrites via editablePageIds. It is the only scope under which write_page
 * may create a page that is absent from the committed plan.
 */
function structuralEditScope(projectRoot) {
    const scope = readActiveReviewGuard(projectRoot)?.scope;
    if (!scope || typeof scope !== "object" || Array.isArray(scope))
        return undefined;
    const rec = scope;
    if (rec.kind !== "deck" || rec.structureOnly !== true)
        return undefined;
    const insertIndex = Number(rec.insertIndex);
    const deletablePageIds = new Set((Array.isArray(rec.deletablePageIds) ? rec.deletablePageIds : [])
        .map((id) => String(id ?? "").trim())
        .filter((id) => id.length > 0));
    return {
        insertIndex: Number.isSafeInteger(insertIndex) && insertIndex >= 0 ? insertIndex : undefined,
        deletablePageIds,
        reorderPageIds: (Array.isArray(rec.reorderPageIds) ? rec.reorderPageIds : [])
            .map((id) => String(id ?? "").trim())
            .filter((id) => id.length > 0),
    };
}
async function present(deps, exec, name, args) {
    const sessionId = sessionIdOf(exec);
    const { projectRoot } = requireBinding(deps, sessionId);
    return deps.presentation.execute({ name, args }, {
        runId: sessionId,
        sessionId,
        toolCallId: callIdOf(exec),
        projectRoot,
        abortSignal: exec.signal,
    });
}
export function registerSliceTools(tools, deps, options) {
    const defs = [
        openProjectTool(deps),
        inspectCapabilitiesTool(deps),
        listReferencesTool(deps),
        readReferenceTool(deps),
        commitDesignTool(deps),
        writeTodoTool(deps),
        readPageTool(deps),
        editElementsTool(deps),
        editPageBackgroundTool(deps),
        deletePagesTool(deps),
        reorderPagesTool(deps),
        updateDeckTool(deps),
        writePageTool(deps),
        renderPageTool(deps),
        reviewPageTool(deps),
        reviewPagesTool(deps),
        composeDeckTool(deps),
        webSearchTool(deps),
        searchImageTool(deps),
        generateImageTool(deps),
        exportDeckTool(deps),
    ].filter((def) => !options?.exclude?.has(def.name));
    const disposers = defs.map((def) => tools.register(withProductToolArgumentContract(def)));
    disposers.push(tools.guard((exec) => {
        const allowed = sessionProduceToolAllowlist(deps, exec.agent?.id);
        // Discussion is an explicit read-only capability, including hidden tools.
        if (allowed === DISCUSSION_TOOLS && !allowed.has(exec.name))
            return `Discussion is read-only: ${exec.name} is unavailable`;
        return sliceToolGuard(allowed)(exec);
    }));
    return () => {
        for (const dispose of disposers)
            dispose();
    };
}
function openProjectTool(deps) {
    return defineTool({
        name: "open_project",
        description: "Create or reopen the PPTD project bound to this DSH session. Do not pass a filesystem path.",
        parameters: {
            title: { type: "string", description: "Deck title" },
        },
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            const title = String(args.title ?? "DSH SlideStudio slice").trim() || "DSH SlideStudio slice";
            const opened = deps.store.openProject({
                dshSessionId: sessionId,
                title,
                design: { kind: "self-directed" },
                provider: deps.provider,
            });
            const projectRoot = deps.store.resolveRoot(opened.binding);
            writeSliceRuntime(projectRoot, {
                brief: briefForOpenProject(projectRoot, title),
                design: opened.binding.design,
                editorBaseUrl: deps.editorBaseUrl,
                strictExecution: true,
            });
            return jsonValue({
                outcome: opened.created ? "created" : "reopened",
                projectRoot: opened.binding.projectRoot,
                title,
            });
        },
    });
}
function requireBinding(deps, sessionId) {
    const binding = deps.store.bindingFor(sessionId);
    if (!binding)
        throw new Error("open_project first");
    return { binding, projectRoot: deps.store.resolveRoot(binding) };
}
function inspectCapabilitiesTool(deps) {
    return defineTool({
        name: "inspect_capabilities",
        description: "List vision, search, render, and export capabilities that are actually configured. Do not invent a capability. Hub chips and this tool are the same snapshot.",
        parameters: {},
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(_args, exec) {
            const sessionId = sessionIdOf(exec);
            const { projectRoot } = requireBinding(deps, sessionId);
            const caps = sessionProduceCapabilities(deps, sessionId);
            deps.presentation.hydrate(projectRoot);
            await present(deps, exec, "inspect_capabilities", {});
            return jsonValue({
                ok: true,
                summary: caps.note,
                detail: caps.note,
                payload: caps,
            });
        },
    });
}
function listReferencesTool(deps) {
    return defineTool({
        name: "list_references",
        description: "List required source chunks first, with referencesComplete, missingReferenceChunks, and the exact next read_reference calls; then list the full OpenKimi source and visual catalog. Read every required chunk before commit_design/write_todo. Optional filters affect only the catalog listing, never the required preflight.",
        parameters: {
            family: { type: "string", description: "Optional family such as academic, consulting, finance" },
            kind: { type: "string", description: "source or visual" },
            tag: { type: "string", description: "Optional substring filter" },
        },
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(args, exec) {
            return jsonValue(await present(deps, exec, "list_references", args));
        },
    });
}
function readReferenceTool(deps) {
    return defineTool({
        name: "read_reference",
        description: "Read one OpenKimi source chunk by sourceId and chunkIndex. Marks the source consulted.",
        parameters: {
            sourceId: { type: "string", required: true },
            chunkIndex: { type: "integer", required: true },
        },
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(args, exec) {
            return jsonValue(await present(deps, exec, "read_reference", args));
        },
    });
}
const SLIDE_PLAN_ITEMS_PARAMETER = {
    type: "array",
    items: {
        type: "object",
        additionalProperties: false,
        properties: {
            pageId: { type: "string", required: true },
            title: { type: "string", required: true },
            layoutFamily: { type: "string", required: true },
            exhibits: { type: "array", required: true, items: { type: "string", enum: [...TODO_EXHIBIT_KINDS] } },
            note: { type: "string" },
            purpose: { type: "string" },
        },
    },
    description: "Complete ordered plan: {pageId, title, layoutFamily, exhibits, note?, purpose?}. Use an explicit empty exhibits array when none are needed. One page is valid.",
};
function runtimeKindThemeInput(projectRoot) {
    try {
        const rec = readSliceRuntimeFile(projectRoot);
        const brief = typeof rec.brief === "string" ? rec.brief.trim() : "";
        const designSystemId = typeof rec.designSystemId === "string" ? rec.designSystemId.trim() : "";
        return {
            brief,
            designSystemId: designSystemId || undefined,
            userExplicitPack: rec.designDirection === "preset" || rec.designDirection === "user-design",
        };
    }
    catch {
        return { brief: "", userExplicitPack: false };
    }
}
function rejectKindThemePack(projectRoot, args) {
    const runtime = runtimeKindThemeInput(projectRoot);
    const requestedSources = sourceIdList(args.adoptedSourceIds, args.adopt);
    const issue = kindThemePackIssue({
        brief: runtime.brief,
        designSystemId: runtime.designSystemId,
        adoptedSourceIds: requestedSources.length ? requestedSources : sourceIdList(listSourceReceipts(projectRoot)
            .filter((row) => row.state === "adopted" || row.state === "executed")
            .map((row) => row.sourceId)),
        userExplicitPack: runtime.userExplicitPack,
    });
    if (!issue)
        return undefined;
    return {
        outcome: "rejected",
        error: issue.code,
        packId: issue.packId,
        kind: issue.kind,
        detail: issue.detail,
        painted: false,
    };
}
function commitDesignTool(deps) {
    return closeToolParameterRoot(defineTool({
        name: "commit_design",
        description: "Commit the slide plan only after list_references reports referencesComplete=true. Pass an explicit ordered {pageId, title, layoutFamily, exhibits}[] plan, including a valid single-page plan. Optional adoptedSourceIds names the exact scenario/design sources chosen for this plan; every chunk of a newly selected source must already have been read. Do not invent a host preset id. Plan every page the brief needs.",
        parameters: {
            slidePlan: {
                ...SLIDE_PLAN_ITEMS_PARAMETER,
                required: true,
            },
            adoptedSourceIds: {
                type: "array",
                items: { type: "string" },
                description: "Canonical array of source ids actually adopted.",
            },
        },
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            const { projectRoot } = requireBinding(deps, sessionId);
            const rejected = rejectKindThemePack(projectRoot, args);
            if (rejected)
                return jsonValue(rejected);
            const result = await present(deps, exec, "commit_design", args);
            if (!result.ok) {
                return jsonValue({
                    ...result.payload,
                    outcome: "rejected",
                    error: result.payload.error ?? "rejected",
                    detail: result.detail,
                    painted: false,
                });
            }
            return jsonValue({ ...result.payload, outcome: "committed" });
        },
    }));
}
function writeTodoTool(deps) {
    return closeToolParameterRoot(defineTool({
        name: "write_todo",
        description: "Commit the page plan only after list_references reports referencesComplete=true. Same explicit plan shape as commit_design: items [{pageId, title, layoutFamily, exhibits}]. A single-page task is valid. A rejected reference preflight leaves the current plan unchanged. Plan every page the brief needs.",
        parameters: {
            items: {
                ...SLIDE_PLAN_ITEMS_PARAMETER,
                required: true,
            },
        },
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            const { projectRoot } = requireBinding(deps, sessionId);
            const rejected = rejectKindThemePack(projectRoot, args);
            if (rejected)
                return jsonValue(rejected);
            const result = await present(deps, exec, "write_todo", args);
            if (!result.ok) {
                return jsonValue({
                    ...result.payload,
                    outcome: "rejected",
                    error: result.payload.error ?? "rejected",
                    detail: result.detail,
                    painted: false,
                });
            }
            return jsonValue({ ...result.payload, outcome: "committed" });
        },
    }));
}
function lastReviewVerdict(projectRoot, pageId) {
    const ledger = readRunLedger(projectRoot);
    if (!ledger)
        return undefined;
    const fact = [...ledger.facts].reverse().find((row) => row.type === "page.visual-review-recorded" && row.pageId === pageId);
    if (fact?.type !== "page.visual-review-recorded")
        return undefined;
    return fact.verdict;
}
export async function autoRenderWriteOutcome(outcome, pageId, render) {
    const result = await render(pageId);
    const rawStatus = result.payload.layoutStatus;
    const layoutStatus = result.ok &&
        (rawStatus === "pass" || rawStatus === "fail" || rawStatus === "unavailable")
        ? rawStatus
        : "unavailable";
    const layoutIssues = Array.isArray(result.payload.layoutIssues)
        ? result.payload.layoutIssues
        : [];
    const renderNote = String(result.payload.note ?? result.detail ?? "").trim();
    return {
        ...outcome,
        layoutStatus,
        layoutIssues,
        ...(renderNote ? { renderNote } : {}),
    };
}
function layoutIssueLabel(issue) {
    if (!issue || typeof issue !== "object" || Array.isArray(issue))
        return String(issue);
    const rec = issue;
    return String(rec.code ?? rec.kind ?? rec.detail ?? "unknown-layout-issue");
}
export function formatWritePageOutcome(value) {
    const rec = value;
    if (rec.outcome === "skipped-identical") {
        const status = rec.layoutStatus ?? "unavailable";
        const base = `page already current; do not create another file. pageId=${rec.pageId} ` +
            `revision=${rec.revision} deterministicLayoutStatus=${status}`;
        if (status === "pass") {
            return `${base}. Deterministic browser QA passed; this does not claim a visual-review pass.`;
        }
        const issues = (rec.layoutIssues ?? []).map(layoutIssueLabel).filter(Boolean).join(", ");
        const evidence = issues ? ` issues=${issues}` : rec.renderNote ? ` note=${rec.renderNote}` : "";
        const next = status === "fail"
            ? "Rewrite this page to resolve the listed layout issues, then call render_page again."
            : "Retry render_page when the pinned editor raster is available; do not compose yet.";
        return `${base}.${evidence} ${next}`;
    }
    if (rec.outcome === "revise-requires-change") {
        return `revise requires a different body for ${rec.pageId} revision ${rec.revision}`;
    }
    return JSON.stringify(value);
}
/**
 * Read the exact, currently persisted PPTD v2 page body for a bound project.
 *
 * This deliberately does not use `replayOrRun`: recording a receipt would turn
 * a read into a filesystem mutation. The returned body is intentionally shaped
 * as a `write_page` baseline (`id`, `pageType`, `elements`, plus every other
 * persisted page field), so an agent can preserve user edits when changing one
 * element instead of reconstructing the entire page from memory.
 */
export function readPageFromProject(projectRoot, pageId) {
    const requestedId = pageId.trim();
    if (!requestedId) {
        return { outcome: "rejected", detail: "pageId is required" };
    }
    try {
        const project = loadProject(projectRoot);
        const matches = project.pages.filter((loaded) => pageIdMatchesFile(requestedId, loaded.path));
        if (matches.length === 0) {
            return { outcome: "not-found", pageId: requestedId, detail: "no persisted PPTD v2 page matches pageId" };
        }
        if (matches.length > 1) {
            return {
                outcome: "ambiguous",
                pageId: requestedId,
                detail: "multiple persisted PPTD v2 pages match pageId; refusing to choose one",
            };
        }
        const loaded = matches[0];
        // A JSON round trip gives the caller a detached, JSON-safe snapshot. Do not
        // return a loader-owned object that a future tool/runtime could mutate.
        const body = JSON.parse(JSON.stringify(loaded.page));
        const id = persistPageKey(loaded.path);
        return { ...body, id, pageSha256: stableSha256({ ...body, id }) };
    }
    catch (error) {
        return {
            outcome: "rejected",
            pageId: requestedId,
            detail: error instanceof Error ? error.message : "failed to read persisted PPTD v2 page",
        };
    }
}
function aiReviewLockForPage(projectRoot, pagePath) {
    const guard = readActiveReviewGuard(projectRoot);
    if (!guard)
        return undefined;
    const legacySinglePage = !guard.scope && guard.items === undefined && guard.pagePath === pagePath;
    return legacySinglePage || reviewWriteTargetForPage(guard, persistPageKey(pagePath)) ? guard : undefined;
}
/**
 * The editor creates this short-lived lock before asking the agent to revise
 * one selected element. This early check gives the agent a precise conflict;
 * presentation-run repeats the compare-and-swap inside its project write lock.
 */
export function aiReviewPageVersionConflict(projectRoot, pageId, expectedPageSha256) {
    const requestedId = pageId.trim();
    if (!requestedId)
        return undefined;
    try {
        const project = loadProject(projectRoot);
        const matches = project.pages.filter((loaded) => pageIdMatchesFile(requestedId, loaded.path));
        if (matches.length !== 1)
            return undefined;
        const loaded = matches[0];
        if (!aiReviewLockForPage(projectRoot, loaded.path))
            return undefined;
        const body = JSON.parse(JSON.stringify(loaded.page));
        const actual = stableSha256({ ...body, id: persistPageKey(loaded.path) });
        const expected = typeof expectedPageSha256 === "string" ? expectedPageSha256.trim() : "";
        if (expected === actual)
            return undefined;
        return `stale-page: expectedPageSha256 does not match the current persisted page ${requestedId}; read_page again before editing`;
    }
    catch (error) {
        return `stale-page: failed to verify the current persisted page ${requestedId}: ${error instanceof Error ? error.message : String(error)}`;
    }
}
function readPageTool(deps) {
    return defineTool({
        name: "read_page",
        description: "Read one current persisted PPTD v2 page by pageId. Strictly read-only: returns the COMPLETE page body plus stable pageSha256 as the baseline before a whole-page write_page edit. Call this immediately before editing an existing page so human changes are preserved.",
        parameters: {
            pageId: { type: "string", required: true, description: "Existing PPTD page id to read" },
        },
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            const { projectRoot } = requireBinding(deps, sessionId);
            return jsonValue(readPageFromProject(projectRoot, String(args.pageId ?? "")));
        },
    });
}
async function executeWritePageOnce(deps, exec, projectRoot, clean, toolCallId) {
    const sessionId = sessionIdOf(exec);
    const adopted = listSourceReceipts(projectRoot)
        .filter((row) => row.state === "adopted" || row.state === "executed")
        .map((row) => row.sourceId);
    const packRejected = rejectKindThemePack(projectRoot, { adoptedSourceIds: adopted });
    if (packRejected)
        return packRejected;
    const pageId = String(clean.id ?? "").trim();
    try {
        const onDisk = pageId
            ? loadProject(projectRoot).pages.some((loaded) => pageIdMatchesFile(pageId, loaded.path))
            : false;
        // A structural edit lock authorizes creating pages outside the committed
        // plan; existing disk pages are writable regardless of plan membership so
        // pages added by earlier structural turns stay editable.
        const structuralNewPage = !onDisk && structuralEditScope(projectRoot) !== undefined;
        if (!onDisk && !structuralNewPage &&
            !readCommittedPagePlan(projectRoot).some((page) => page.pageId === persistPageKey(pageId))) {
            return {
                outcome: "rejected", error: "not_in_plan", painted: false,
                detail: `page ${pageId} is not in the current plan — commit the updated complete plan before write_page`,
            };
        }
    }
    catch (error) {
        return { outcome: "rejected", detail: error instanceof Error ? error.message : String(error), painted: false };
    }
    const versionConflict = aiReviewPageVersionConflict(projectRoot, pageId, clean.expectedPageSha256);
    if (versionConflict) {
        return { outcome: "rejected", detail: versionConflict, painted: false };
    }
    const currentRev = pageId ? currentPageRevision(projectRoot, pageId) : undefined;
    const decision = decideWritePage(clean, currentRev
        ? {
            pageId: currentRev.pageId,
            revision: currentRev.revision,
            pageSha256: currentRev.pageSha256,
            lastVerdict: lastReviewVerdict(projectRoot, pageId),
            yamlExists: yamlExistsForPage(projectRoot, pageId),
        }
        : undefined, readWritePageDisk(projectRoot));
    if (decision.action === "skip") {
        return autoRenderWriteOutcome(decision.outcome, decision.outcome.pageId, (targetPageId) => present(deps, exec, "render_page", { pageId: targetPageId }));
    }
    if (decision.action === "reject")
        return decision.outcome;
    const fontReplacements = normalizePageFonts(clean);
    const result = await present(deps, exec, "write_page", clean);
    if (!result.ok) {
        return {
            outcome: "rejected",
            error: String(result.payload.error ?? "rejected"),
            detail: result.detail,
            painted: false,
        };
    }
    const page = result.payload.page;
    const writtenId = String(page?.id ?? result.payload.pageId ?? decision.pageId);
    const after = currentPageRevision(projectRoot, writtenId);
    const fontNotes = fontReplacements.map((entry) => `字体 ${JSON.stringify(entry.from)} 改成 ${JSON.stringify(entry.to)}`);
    const outcome = {
        outcome: "written",
        pageId: writtenId,
        revision: after?.revision ?? 1,
        pageSha256: after?.pageSha256 ?? decision.pageSha256,
        ...(fontNotes.length ? { fontNotes } : {}),
    };
    return autoRenderWriteOutcome(outcome, writtenId, (targetPageId) => present(deps, exec, "render_page", { pageId: targetPageId }));
}
function editPageBackgroundTool(deps) {
    const definition = defineTool({
        name: "edit_page_background",
        description: "Change ONLY an existing page background. Use this for background-only edits instead of copying all elements into write_page. Pass pageId, expectedPageSha256 from read_page, and the complete canonical background. The Host preserves every element, text string, style, order, notes and animation verbatim. Available only inside an active editor page/deck scope; stale hashes and element-only scopes are rejected. The same write/render and review gates apply.",
        parameters: {
            pageId: { type: "string", required: true },
            expectedPageSha256: { type: "string", required: true },
            background: { type: "json", required: true },
        },
        output: jsonOutput(formatWritePageOutcome),
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            const { projectRoot } = requireBinding(deps, sessionId);
            const toolCallId = callIdOf(exec);
            return writePageSerial.enqueue(sessionId, () => replayOrRun(projectRoot, "edit_page_background", args, toolCallId, async () => {
                const target = reviewWriteTargetForPage(readActiveReviewGuard(projectRoot), String(args.pageId));
                const allowed = Boolean(target) && target.scope.kind !== "elements";
                if (!allowed)
                    return { outcome: "rejected", error: "PAGE_EDIT_SCOPE_REQUIRED", detail: "edit_page_background requires an active editor page/deck scope for this page", painted: false };
                const baseline = readPageFromProject(projectRoot, String(args.pageId));
                if (baseline.pageSha256 !== String(args.expectedPageSha256).trim().toLowerCase()) {
                    return { outcome: "rejected", error: "PAGE_EDIT_STALE_PAGE", detail: "stale-page: read_page again before editing", painted: false };
                }
                const { pageSha256, ...page } = baseline;
                const merged = { ...page, background: structuredClone(args.background), expectedPageSha256: pageSha256 };
                const issues = canonicalWritePageIssues(merged);
                if (issues.length)
                    throw new ToolArgsError(issues);
                return executeWritePageOnce(deps, exec, projectRoot, merged, toolCallId);
            }));
        },
    });
    const pageSchema = writePageJsonSchema();
    return closeToolParameterRoot({ ...definition, parameters: {
            type: "object", required: ["pageId", "expectedPageSha256", "background"],
            properties: { pageId: { type: "string" }, expectedPageSha256: { type: "string" }, background: pageSchema.properties.background },
        } });
}
function deletePagesTool(deps) {
    const definition = defineTool({
        name: "delete_pages",
        description: "Remove exactly the pages named by the active editor structural authorization (deletablePageIds). Each pageId may be deleted once; pages outside that list are rejected. For a merge, first write the merged content into the surviving editable page, then delete the absorbed pages. The page list and manifest update atomically; verify rolls everything back if the result does not match the authorized set.",
        parameters: {
            pageIds: { type: "array", items: { type: "string" }, required: true },
        },
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            const { projectRoot } = requireBinding(deps, sessionId);
            const toolCallId = callIdOf(exec);
            const clean = { pageIds: Array.isArray(args.pageIds) ? args.pageIds.map(String) : [] };
            return writePageSerial.enqueue(sessionId, () => replayOrRun(projectRoot, "delete_pages", clean, toolCallId, async () => present(deps, exec, "delete_pages", clean)));
        },
    });
    return closeToolParameterRoot({ ...definition, parameters: {
            type: "object", required: ["pageIds"],
            properties: { pageIds: { type: "array", items: { type: "string" } } },
        } });
}
function reorderPagesTool(deps) {
    const definition = defineTool({
        name: "reorder_pages",
        description: "Reorder the deck's pages to exactly the authorized final order (reorderPageIds). pageIds must list every existing page once, in the authorized sequence. It changes the manifest order only — no page content is rewritten. Verify rolls everything back if the result differs from the authorized order.",
        parameters: {
            pageIds: { type: "array", items: { type: "string" }, required: true },
        },
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            const { projectRoot } = requireBinding(deps, sessionId);
            const toolCallId = callIdOf(exec);
            const clean = { pageIds: Array.isArray(args.pageIds) ? args.pageIds.map(String) : [] };
            return writePageSerial.enqueue(sessionId, () => replayOrRun(projectRoot, "reorder_pages", clean, toolCallId, async () => present(deps, exec, "reorder_pages", clean)));
        },
    });
    return closeToolParameterRoot({ ...definition, parameters: {
            type: "object", required: ["pageIds"],
            properties: { pageIds: { type: "array", items: { type: "string" } } },
        } });
}
function updateDeckTool(deps) {
    const definition = defineTool({
        name: "update_deck",
        description: "Change deck-level metadata: the presentation title and/or theme. Only the fields named by the active editor authorization (editableMeta) may be sent — a field outside that whitelist is rejected. Page content and the manifest are untouched. A rewrite lock authorizes both fields. Theme textStyles fontFamily uses the same Office/WPS faces as write_page; an off-list face is rewritten and reported in fontNotes.",
        parameters: {
            title: { type: "string" },
            theme: { type: "json" },
        },
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            const { projectRoot } = requireBinding(deps, sessionId);
            const toolCallId = callIdOf(exec);
            const clean = {};
            if (typeof args.title === "string")
                clean.title = args.title;
            if (args.theme !== undefined && args.theme !== null && typeof args.theme === "object" && !Array.isArray(args.theme)) {
                clean.theme = structuredClone(args.theme);
            }
            // A theme carries textStyles[].fontFamily; rewrite any off-list face the
            // same way write_page does, before the args are recorded for replay.
            const fontReplacements = normalizePageFonts(clean);
            const fontNotes = fontReplacements.map((entry) => `字体 ${JSON.stringify(entry.from)} 改成 ${JSON.stringify(entry.to)}`);
            return writePageSerial.enqueue(sessionId, () => replayOrRun(projectRoot, "update_deck", clean, toolCallId, async () => {
                const result = await present(deps, exec, "update_deck", clean);
                if (result.ok && fontNotes.length && result.payload && typeof result.payload === "object") {
                    return { ...result, payload: { ...result.payload, fontNotes } };
                }
                return result;
            }));
        },
    });
    return closeToolParameterRoot({ ...definition, parameters: {
            type: "object",
            properties: { title: { type: "string" }, theme: { type: "object" } },
        } });
}
function editElementsTool(deps) {
    const definition = defineTool({
        name: "edit_elements",
        description: "Replace exactly the selected elements in an active editor element review. Pass only the authorized target elements, but each must be one COMPLETE canonical native PPTD element with its existing elementId. The Host reads the current authoritative page, preserves every other element, page metadata, and element order, then executes the same canonical write_page persistence path. Call read_page immediately before this tool and pass its current pageSha256 as expectedPageSha256. Do not wrap arguments or send aliases. This tool is unavailable outside a live server-verified elements scope.",
        parameters: JSON.parse(JSON.stringify(EDIT_ELEMENTS_PARAMETER_SPEC, (key, value) => key === "minItems" || key === "maxItems" ? undefined : value)),
        output: jsonOutput(formatWritePageOutcome),
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            const { projectRoot } = requireBinding(deps, sessionId);
            const toolCallId = callIdOf(exec);
            const clean = structuredClone(args);
            return replayOrRun(projectRoot, "edit_elements", clean, toolCallId, async () => {
                const prepared = prepareElementEdit(projectRoot, clean);
                if (!prepared.ok)
                    return prepared.outcome;
                const merged = structuredClone(prepared.page);
                const issues = canonicalWritePageIssues(merged);
                if (issues.length) {
                    return {
                        outcome: "rejected",
                        error: "ELEMENT_EDIT_CANONICAL_PAGE_INVALID",
                        detail: issues.join("; "),
                        painted: false,
                    };
                }
                return executeWritePageOnce(deps, exec, projectRoot, merged, toolCallId);
            });
        },
    });
    const closed = closeToolParameterRoot({
        ...definition,
        parameters: editElementsJsonSchema(),
    });
    return {
        ...closed,
        async execute(args, exec) {
            const issues = canonicalEditElementsIssues(args);
            if (issues.length)
                throw new ToolArgsError(issues);
            return closed.execute(args, exec);
        },
    };
}
function writePageTool(deps) {
    const definition = defineTool({
        name: "write_page",
        description: `Write one COMPLETE PPTD v2 page in one call. Host accepts only one write_page at a time: wait for this result before the next page. This is whole-page replacement, never element append: every call must include the full elements[] array. Never omit elements — a background-only page is rejected; a photo cover still carries its title and subtitle as elements above the background. Elements use elementId, elementType, bounds [x,y,w,h], and content.text. Text fontSize/fontFamily/color/alignment fields belong directly on content; content.style is only a string theme reference such as $title, never an object. fontFamily must be one of ${SLIDE_FONTS.map((font) => font.name).join(", ")}; any other face is rewritten to the closest one and the result lists fontNotes. Prefer {latin, ea} so Latin and Chinese are named separately. layoutRole belongs on the element. Put element fill/line fields inside the owning element; optional page-level metadata is background, notes, and animations. Editing uses the same page id. Treat the complete page from read_page as the baseline, preserve its background/notes/animations, and pass its pageSha256 as expectedPageSha256; an editor review lock rejects stale edits. layoutStatus=pass is overflow-only, not a rewrite seal. The same pageId may be rewritten until review_pages records a current structural pass for that revision. After structural pass, rewrite only if the current revision has explicit editor edit authorization, review_pages names the page failing, or review_page says revise. An authorized editor edit uses read_page and expectedPageSha256; do not manufacture a visual review to enable it.`,
        // Lower only for DSH's executor DSL, which rejects standard cardinality
        // keywords. Publish the full JSON Schema from the same source below.
        parameters: JSON.parse(JSON.stringify(WRITE_PAGE_PARAMETER_SPEC, (key, value) => key === "minItems" || key === "maxItems" ? undefined : value)),
        output: jsonOutput(formatWritePageOutcome),
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            const { projectRoot } = requireBinding(deps, sessionId);
            const toolCallId = callIdOf(exec);
            const clean = structuredClone(args);
            return replayOrRun(projectRoot, "write_page", clean, toolCallId, () => executeWritePageOnce(deps, exec, projectRoot, clean, toolCallId));
        },
    });
    // The author DSL intentionally leaves parameter roots open. The generation
    // contract is closed, so publish that fact to providers as well as enforcing
    // it in canonicalWritePageIssues before any project access.
    const closed = closeToolParameterRoot({
        ...definition,
        parameters: writePageJsonSchema(),
    });
    return {
        ...closed,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            let clean = structuredClone(args);
            normalizeWritePageDialect(clean);
            clean = normalizeWritePageArgs(clean);
            normalizeWritePageLineArrows(clean);
            // Validate everything else before touching a project; only display text
            // has this narrow provider compatibility path.
            const textSource = structuredClone(clean);
            normalizeNumericPageText(clean);
            const canonicalIssues = canonicalWritePageIssues(clean);
            if (canonicalIssues.length)
                throw new ToolArgsError(canonicalIssues);
            const sessionId = sessionIdOf(exec);
            return writePageSerial.enqueue(sessionId, () => {
                const { projectRoot } = requireBinding(deps, sessionId);
                // Revisit the original numbers under the write queue so matching text
                // keeps leading zeros. The normal write gate still rejects stale hashes.
                const baseline = readPageFromProject(projectRoot, String(clean.id));
                normalizeNumericPageText(textSource, baseline);
                return closed.execute(textSource, exec);
            });
        },
    };
}
export async function attachPageRasterImage(opts) {
    const pngBytes = opts.pngBytes ?? readPageRaster(opts.projectRoot, opts.pageId);
    if (!shouldAttachPageRaster({ visionMode: opts.visionMode, pngBytes }) || !pngBytes) {
        return undefined;
    }
    if (!opts.deps.attachments) {
        throw new Error("vision.mode is main-model but the DSH attachments service is not mounted; cannot send the raster to the selected model");
    }
    const ref = await opts.deps.attachments.saveImage({
        data: pngBytes,
        mediaType: "image/png",
        name: `${opts.pageId || "page"}.png`,
    });
    if (opts.deliveryToken) {
        await present(opts.deps, opts.exec, "_mark_image_emitted", {
            deliveryToken: opts.deliveryToken,
        });
    }
    return { ...ref };
}
function rasterBytesFromPayload(projectRoot, src) {
    if (typeof src !== "string" || !src.trim())
        return undefined;
    const root = path.resolve(projectRoot);
    const abs = path.resolve(root, src.trim());
    if (abs !== root && !abs.startsWith(`${root}${path.sep}`))
        return undefined;
    if (!fs.existsSync(abs))
        return undefined;
    const bytes = fs.readFileSync(abs);
    return bytes.length >= 64 ? bytes : undefined;
}
function visionToolOutput() {
    return {
        schema: { type: "json" },
        render(_args, value) {
            return renderPageToolContent(value);
        },
    };
}
function renderPageTool(deps) {
    return defineTool({
        name: "render_page",
        description: "Raster the current page through the native editor #slide screenshot. Host accepts only one render_page at a time: wait for this result before the next page. Wait for this tool result before review_page. When inspect_capabilities.vision.mode is main-model, the PNG is attached as an image part for the selected vision-capable model. Copy the complete DELIVERY_TOKEN from this successful result into review_page for the same pageId and revision.",
        parameters: {
            pageId: { type: "string", required: true },
        },
        output: visionToolOutput(),
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            return runExclusivePageStep(reviewPageGate, sessionId, "render_page", async () => {
                const { projectRoot } = requireBinding(deps, sessionId);
                const caps = inspectProjectCapabilities(projectRoot);
                const result = await present(deps, exec, "render_page", args);
                const pageId = String(args.pageId ?? "").trim();
                const pngBytes = rasterBytesFromPayload(projectRoot, result.payload.src) ?? readPageRaster(projectRoot, pageId);
                const image = await attachPageRasterImage({
                    deps,
                    projectRoot,
                    visionMode: caps.vision.mode,
                    pageId,
                    pngBytes,
                    deliveryToken: typeof result.payload.deliveryToken === "string" ? result.payload.deliveryToken : undefined,
                    exec,
                });
                return jsonValue({
                    ok: result.ok,
                    summary: result.summary,
                    detail: result.detail,
                    payload: result.payload,
                    ...(image ? { image } : {}),
                });
            });
        },
    });
}
function reviewPageTool(deps) {
    return closeToolParameterRoot(defineTool({
        name: "review_page",
        description: "Aesthetics-only visual review after a successful render_page for this exact pageId and revision. Host accepts only one review_page at a time: wait for this result before the next page. Copy its complete DELIVERY_TOKEN exactly; do not shorten or reuse it. verdict=pass requires issues=[] because praise is not an unresolved issue. verdict=revise requires one or more concrete visible defects in issues. When vision.mode is none this tool is unavailable; use review_pages for deterministic checks and authorized editor edits for human-requested revisions.",
        parameters: {
            pageId: { type: "string", required: true },
            revision: { type: "integer", required: true },
            deliveryToken: { type: "string", required: true },
            verdict: { type: "string", enum: ["pass", "revise"], required: true },
            issues: { type: "array", items: { type: "string" }, required: true },
        },
        output: visionToolOutput(),
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            return runExclusivePageStep(reviewPageGate, sessionId, "review_page", async () => {
                const { projectRoot } = requireBinding(deps, sessionId);
                const caps = inspectProjectCapabilities(projectRoot);
                const pageId = String(args.pageId ?? "").trim();
                const result = await present(deps, exec, "review_page", args);
                const image = await attachPageRasterImage({
                    deps,
                    projectRoot,
                    visionMode: caps.vision.mode,
                    pageId,
                    exec,
                });
                return jsonValue({
                    ok: result.ok,
                    summary: result.summary,
                    detail: result.detail,
                    payload: result.payload,
                    ...(image ? { image } : {}),
                });
            });
        },
    }));
}
function reviewPagesTool(deps) {
    return closeToolParameterRoot(defineTool({
        name: "review_pages",
        description: "Run deterministic structural review for current page revisions. If it fails, repair the named pages and their concrete issues before reviewing again.",
        parameters: {},
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(args, exec) {
            return jsonValue(await present(deps, exec, "review_pages", args));
        },
    }));
}
function composeDeckTool(deps) {
    return closeToolParameterRoot(defineTool({
        name: "compose_deck",
        description: "Seal current PPTD pages after every required gate passes. Pass only the title. On rejection, follow payload.next and the exact missingReferenceChunks/page-id arrays; do not repeat compose_deck without satisfying that step.",
        parameters: { title: { type: "string", required: true } },
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(args, exec) {
            return jsonValue(await present(deps, exec, "compose_deck", args));
        },
    }));
}
export function searchImageTool(deps) {
    return defineTool({
        name: "search_image",
        description: "Search a unique image into media/ when inspect_capabilities.imageSearch.configured. Call this in a batch for every photo-led page (cover, section, closer, body photo) BEFORE write_page. Do not reuse one cover file on later pages. Assistant prose is not a search.",
        parameters: {
            id: { type: "string", required: true, description: "Media id written under media/" },
            query: { type: "string", required: true, description: "Image search query" },
        },
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(args, exec) {
            deps.ensureGrokImageEnv?.();
            return jsonValue(await present(deps, exec, "search_image", args));
        },
    });
}
export function generateImageTool(deps) {
    return defineTool({
        name: "generate_image",
        description: "Generate a unique image into media/ via grok-imagine when inspect_capabilities.imageGenerate.configured. Pass the planned photo frame width and height in page pixels (the write_page image bounds). Host maps that slot to the nearest API aspect so the file matches the frame. Call once per photo-led page BEFORE write_page. Do not default to 16:9 and cover-crop into a portrait column. Fails closed if the image API cannot run — no placeholder PNG.",
        parameters: {
            id: { type: "string", required: true, description: "Media id written under media/" },
            prompt: { type: "string", required: true, description: "Image generation prompt" },
            width: { type: "number", required: true, description: "Planned image frame width in page pixels" },
            height: { type: "number", required: true, description: "Planned image frame height in page pixels" },
            aspect: { type: "string", description: "Fallback only if width/height cannot be known: 16:9, 1:1, or 3:4" },
        },
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(args, exec) {
            deps.ensureGrokImageEnv?.();
            return jsonValue(await present(deps, exec, "generate_image", args));
        },
    });
}
export function webSearchTool(deps) {
    return defineTool({
        name: "web_search",
        description: PRODUCE_WEB_SEARCH_DESCRIPTION,
        parameters: {
            queries: {
                type: "array",
                required: true,
                items: { type: "string" },
                description: "Required search queries; accepts 1–4 items and merges their results.",
            },
        },
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(args, exec) {
            deps.ensureGrokImageEnv?.();
            const rec = args;
            const queries = webSearchQueriesFromArgs(rec);
            return jsonValue(await present(deps, exec, "web_search", {
                ...rec,
                queries,
                query: queries[0] ?? "",
            }));
        },
    });
}
function exportDeckTool(deps) {
    return defineTool({
        name: "export_deck",
        description: "Export the current PPTD project to a hybrid editable PPTX. Full-page raster is a failure.",
        parameters: {},
        output: jsonOutput((value) => JSON.stringify(value)),
        async execute(args, exec) {
            return jsonValue(await present(deps, exec, "export_deck", args));
        },
    });
}
//# sourceMappingURL=tools.js.map