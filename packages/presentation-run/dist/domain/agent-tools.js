/**
 * Allowlisted generate tools. The model may only call these —
 * no shell, no iframe, no public web fetch.
 */
import fs from "node:fs";
import path from "node:path";
import { createEmptyProject, loadProject, saveProject, withProjectWriteLock, } from "@open-slidestudio/pptd-v2";
import { composeBodyRules, extractReferenceLines, finalizeComposeDeck, inferDeckIntent, isNamedClassroomFact, } from "./compose-ir.js";
import { parseCanonicalPagePlan } from "./page-plan.js";
import { aspectFromSlot } from "./image-port.js";
import { EMPTY_HOSTED_WEB_SEARCH, webSearchQueriesFromArgs, } from "./hosted-web-search.js";
import { stableSha256 } from "./run-ledger.js";
import { readActiveReviewGuard, reviewWriteTargetForPage, reviewWriteScopeViolation } from "./review-write-scope.js";
import { backgroundColorWriteAuthority } from "./background-color-authority.js";
import { resolveTodoExhibits, reviewSkillPages, isCloserPage, pageHasReadableCopy, pageHasVisibleContent, persistPageKey, persistPagePathFromId, pageIdMatchesFile, writePageSchemaIssues, writePageSchemaError, composedPageLeftoverIssues, EMPTY_CLOSER_PRODUCE_NEXT, TODO_EXHIBIT_KINDS, } from "./layout-qa.js";
import { listMedia, saveMediaFile } from "./media-store.js";
import { createPageRasterPort, rasterToDataUrl, savePageRaster, } from "./page-raster.js";
import { assertSkillDeck, parseSkillDeck, parseSkillPage, countRawChartElements, DROPPED_CHART_DETAIL, skillToCompose, } from "./skill-pages.js";
import { missingOperatingFactsReason, reportFactIssues } from "./report-facts.js";
import { inspectProjectCapabilities } from "../capabilities.js";
import { listSourceReceipts } from "../receipts.js";
import { kindThemePackIssue, packColorWriteContextFrom, PACK_COLOR_ERROR, sourceIdList, } from "./theme-pack.js";
export const GENERATE_TOOLS = [
    {
        type: "function",
        function: {
            name: "think",
            description: "Record the audience, constraints, and what you will not invent. Call this first.",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    summary: { type: "string" },
                    detail: { type: "string" },
                },
                required: ["summary", "detail"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_playbook",
            description: "Read one playbook section. Do not guess the category rules — read them.",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    section: {
                        type: "string",
                        enum: ["catalog", "skill", "images", "category", "guide", "design", "pptd"],
                    },
                },
                required: ["section"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read uploaded reference attachments. Quote only; never invent beyond this text.",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    query: { type: "string", description: "Optional substring filter" },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "research",
            description: "Look up facts in attachments or record an honest gap. No public web. Never invent citations.",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    query: { type: "string" },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "write_todo",
            description: "Write or replace the complete page outline. Do not default to 6 pages. A classroom lesson is usually 6 (cover→path→concept→remember→exhibit→takeaway). A 月报/复盘 follows the attachment: one job per exhibit, no padding. If the brief specifies a page count or page-by-page script, keep every specified page. Each item needs a note and the exact editable exhibits the later page must implement. Mark photo-led pages with the photo exhibit; their media must exist before write_page. Use none only when the page truly requests no exhibit; prose never substitutes for a requested chart, table, or diagram. Revise the todo whenever the page structure changes — split sections are allowed, but the new pageIds must appear here BEFORE their first write_page.",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    items: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                title: { type: "string" },
                                note: { type: "string" },
                                exhibits: {
                                    type: "array",
                                    minItems: 1,
                                    items: { type: "string", enum: [...TODO_EXHIBIT_KINDS] },
                                },
                            },
                            required: ["title", "note", "exhibits"],
                        },
                    },
                },
                required: ["items"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "web_search",
            description: "Search the web for current information. Provide 1–4 queries in the required queries array. Use a one-item array for a single search. Only when inspect_capabilities.research.configured and via=pi-xai-hosted. Returns facts and citations. Do not pretend you searched if this tool was not called.",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    queries: {
                        type: "array",
                        items: { type: "string" },
                        minItems: 1,
                        maxItems: 4,
                        description: "Required search queries; 1–4 non-empty strings. Use a one-item array for a single search.",
                    },
                },
                required: ["queries"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_image",
            description: "Optional. Query the configured image search port and write media/{id}.png. Only call this if the capability card says imageSearch=YES. No public-web scrape by the host. If the port is off or empty, you get kind=none — do not write src.",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    id: { type: "string", description: "File stem, e.g. cover or day1-sensoji" },
                    query: { type: "string" },
                },
                required: ["id", "query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "generate_image",
            description: "Create a file in project media/ only when the capability card says imageGenerate=YES. Pass the planned photo frame width and height in page pixels so the file matches that slot. Do not default to 16:9 and later cover-crop into a portrait frame. Fails closed if the image API cannot run — it does not write a placeholder PNG.",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    id: { type: "string", description: "File stem, e.g. cover or day1-sensoji" },
                    prompt: { type: "string" },
                    width: { type: "number", description: "Planned image frame width in page pixels" },
                    height: { type: "number", description: "Planned image frame height in page pixels" },
                    aspect: { type: "string", description: "Only if width/height are unknown: 16:9, 4:3, 1:1, or 3:4" },
                },
                required: ["id", "prompt"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "write_page",
            description: "Write ONE COMPLETE page as PPTD in a single call. This replaces the whole page; it never appends elements. Every revision must resend the full elements[] array, with bounds/style/fill/line/alignment inside each owning element. layoutStatus=pass is overflow-only, not a rewrite seal. The same pageId may be rewritten until review_pages records a current structural pass for that revision. After structural pass, rewrite only if the current revision has explicit editor edit authorization, review_pages names the page failing, or review_page says revise. An authorized editor edit uses read_page and expectedPageSha256; do not manufacture a visual review to enable it. Official recipe vocab: header|list|box|circle|band|text, or cover-botanical|title-band|coral-rule|chapter|page-title|route-path|method-panels|two-column-45-55|demo-band|two-column-body|result-bar|next-action|footer-chrome. pageType cover|route|concept|method|demo|transfer. Invalid parse returns error. The host will not rewrite your elements.",
            parameters: {
                type: "object",
                additionalProperties: true,
                properties: {
                    id: { type: "string" },
                    pageType: { type: "string" },
                    notes: { type: "string" },
                    background: { type: "object" },
                    elements: { type: "array", minItems: 1 },
                    expectedPageSha256: {
                        type: "string",
                        description: "When revising an existing page, pass the pageSha256 from the immediately preceding read_page. The write is rejected if that page changed before persistence.",
                    },
                },
                required: ["id", "elements"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "render_page",
            description: "Screenshot native #slide for ONE written page. Classroom decks must call this for every page the user will see (pageIndex 0..n-1). page-1.png alone is rejected. If Playwright/editor is down, kind=unavailable.",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    pageId: { type: "string" },
                    pageIndex: { type: "number" },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "review_pages",
            description: "Native structural QA (not Kimi export_images.py). One written page is enough. Fails empty pages and unlabeled invented numbers. Does not require media. If you chose an image src, that file must exist. Call render_page first if you want to see the real #slide. If raster/vision is off, say you did not see the slide.",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    title: { type: "string" },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "compose_deck",
            description: "Finalize the deck. Prefer pages already written with write_page, or send pages[] with elements. Images are optional. If you included src, the file must exist. Empty pages and unlabeled invented numbers are rejected. role+bullets without elements is an IR fallback.",
            parameters: {
                type: "object",
                additionalProperties: true,
                properties: {
                    title: { type: "string" },
                    pages: {
                        type: "array",
                        minItems: 5,
                        items: {
                            type: "object",
                            additionalProperties: true,
                            properties: {
                                id: { type: "string" },
                                pageType: { type: "string" },
                                role: {
                                    type: "string",
                                    enum: ["cover", "toc", "content", "evidence", "timeline", "matrix", "close"],
                                },
                                title: { type: "string" },
                                notes: { type: "string" },
                                elements: {
                                    type: "array",
                                    minItems: 1,
                                    items: {
                                        type: "object",
                                        additionalProperties: true,
                                        properties: {
                                            elementId: { type: "string" },
                                            elementType: {
                                                type: "string",
                                                enum: ["text", "shape", "image", "table", "chart", "line", "icon"],
                                            },
                                            bounds: {
                                                type: "array",
                                                items: { type: "number" },
                                                minItems: 4,
                                                maxItems: 4,
                                            },
                                            content: { type: "object" },
                                            shapeName: { type: "string" },
                                            fill: {},
                                            src: { type: "string" },
                                            data: { type: "object" },
                                            series: { type: "array" },
                                            columnWidths: { type: "array" },
                                            rows: { type: "array" },
                                        },
                                        required: ["elementType", "bounds"],
                                    },
                                },
                                subtitle: { type: "string" },
                                kicker: { type: "string" },
                                chapter: { type: "string" },
                                bullets: { type: "array", items: { type: "string" } },
                                items: { type: "array", items: { type: "string" } },
                                soWhat: { type: "string" },
                                note: { type: "string" },
                                chart: { type: "object" },
                            },
                            required: ["title"],
                        },
                    },
                },
                required: ["title"],
            },
        },
    },
];
export function researchExecution(result) {
    const detail = [
        `来源：${result.source}`,
        result.citations.length ? `引用：${result.citations.join("、")}` : "",
        result.note,
        result.gap ?? "",
        ...result.facts,
    ]
        .filter(Boolean)
        .join("\n");
    return {
        name: "research",
        ok: true,
        summary: result.gap ? "缺口" : result.source,
        detail,
        payload: result,
    };
}
function writtenPages(state) {
    if (!state.writtenPages)
        state.writtenPages = [];
    return state.writtenPages;
}
/**
 * Disk SSOT → review input. review_pages/compose_deck must grade what is
 * actually persisted, not the in-memory buffer — an editor edit or a partial
 * write can diverge them. Throws when the project cannot be loaded; callers
 * decide whether a missing/corrupt disk state may fall back to the buffer.
 */
function diskSkillPages(state) {
    if (!state.projectRoot)
        return [];
    return loadProject(state.projectRoot).pages.map((entry) => ({
        id: persistPageKey(entry.path),
        pageType: entry.page.pageType,
        notes: entry.page.notes,
        background: entry.page.background,
        animations: entry.page.animations,
        elements: entry.page.elements,
    }));
}
/** Authoritative page set for review/compose: disk first, buffer only as legacy fallback. */
function reviewablePages(state) {
    if (state.projectRoot) {
        try {
            const disk = diskSkillPages(state);
            if (disk.length)
                return { pages: disk };
        }
        catch (e) {
            return {
                pages: state.strictLedger ? [] : writtenPages(state),
                loadError: e instanceof Error ? e.message : String(e),
            };
        }
    }
    const buffered = writtenPages(state);
    return { pages: buffered.length ? buffered : state.skillDeck?.pages ?? [] };
}
function syncSkillDeckPage(state, page) {
    if (!state.skillDeck?.pages.length)
        return;
    const list = state.skillDeck.pages;
    const idx = list.findIndex((item) => persistPageKey(item.id) === persistPageKey(page.id));
    if (idx >= 0)
        list[idx] = page;
}
function wouldWipeWrittenCopy(existing, incoming) {
    return (pageHasReadableCopy({ elements: existing.page.elements }) &&
        !pageHasReadableCopy(incoming));
}
function matchExistingPageIndex(project, page) {
    return project.pages.findIndex((loaded) => pageIdMatchesFile(page.id, loaded.path));
}
function persistNewPagePath(page, index, used) {
    const byId = persistPagePathFromId(page.id);
    if (byId)
        return byId;
    let next = index;
    let candidate = persistPageFileName(next, page.pageType);
    while (used.has(candidate)) {
        next += 1;
        candidate = persistPageFileName(next, page.pageType);
    }
    return candidate;
}
function asPersistedPage(page) {
    return {
        pageType: page.pageType,
        notes: page.notes,
        background: page.background,
        animations: page.animations,
        elements: page.elements,
    };
}
/** Patch matching YAML in place. Never unlink leftover pages. Never invent copy. */
function patchPagesInPlace(project, pages) {
    for (const page of pages) {
        const idx = matchExistingPageIndex(project, page);
        if (idx < 0)
            continue;
        const existing = project.pages[idx];
        if (wouldWipeWrittenCopy(existing, page))
            continue;
        project.pages[idx] = {
            path: existing.path,
            page: asPersistedPage(page),
        };
    }
}
function persistPageFileName(index, pageType) {
    const role = (pageType || "page").replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 24) || "page";
    return `pages/${String(index + 1).padStart(2, "0")}_${role}.page`;
}
/**
 * Persist by page id onto the matching file. Never remap by index, first
 * `*_final`, or leftover last. Never let a staler skillDeck wipe writtenPages.
 * Unmatched pages with copy append as `pages/{persistPageKey(id)}.page`.
 * Empty pages are not appended. A newly created project has zero composed
 * pages; the first write_page lists the agent id. Host does not paint leftover YAML.
 */
/**
 * Persist only the pages mutated by the current tool call when a scope is
 * supplied. Replaying hands-state's historical writtenPages would otherwise
 * overwrite an editor change to p1 while DSH is writing an unrelated p2.
 */
export function persistWrittenPages(state, pageScope, opts = {}) {
    if (!state.projectRoot)
        return { ok: true };
    const pages = pageScope ?? writtenPages(state);
    let conflict;
    withProjectWriteLock(state.projectRoot, () => {
        const title = state.skillDeck?.title || state.brief.slice(0, 40) || "生成中";
        const hasPptd = fs.existsSync(state.projectRoot) && fs.readdirSync(state.projectRoot).some((name) => name.endsWith(".pptd"));
        // A successful compose can have no newly appended page while still owning
        // deck metadata (especially its finalized title). Do not manufacture an
        // empty project for an ordinary no-op scope, though.
        if (!hasPptd && !pages.length)
            return;
        const project = hasPptd
            ? loadProject(state.projectRoot)
            : createEmptyProject(state.projectRoot, { title });
        const expectedPageSha256 = String(opts.expectedPageSha256 ?? "").trim();
        const guard = readActiveReviewGuard(state.projectRoot);
        const structural = structuralEditGuard(guard);
        const rewrite = rewriteEditGuard(guard);
        const targetPageId = pages.length === 1 ? persistPageKey(pages[0].id) : "";
        const current = targetPageId
            ? project.pages.find((loaded) => pageIdMatchesFile(targetPageId, loaded.path))
            : undefined;
        const actualPageSha256 = current
            ? stableSha256({ ...current.page, id: persistPageKey(current.path) })
            : undefined;
        // A structural or rewrite lock authorizes creating exactly one new page per
        // write; there is no baseline revision to compare against.
        const structuralNewPage = structural !== undefined && pages.length === 1 && !current;
        const rewriteNewPage = rewrite !== undefined && pages.length === 1 && !current;
        if (guard && (!expectedPageSha256 || pages.length !== 1 || !current) && !structuralNewPage && !rewriteNewPage) {
            conflict = {
                ok: false,
                error: "page_revision_required",
                pageId: persistPageKey(pages[0]?.id ?? "unknown"),
                actualPageSha256,
            };
            return;
        }
        if (expectedPageSha256) {
            if (!targetPageId || actualPageSha256 !== expectedPageSha256) {
                conflict = {
                    ok: false,
                    error: "page_revision_conflict",
                    pageId: targetPageId || persistPageKey(pages[0]?.id ?? "unknown"),
                    expectedPageSha256,
                    actualPageSha256,
                };
                return;
            }
        }
        if (structural) {
            for (const proposed of pages) {
                const pageId = persistPageKey(proposed.id);
                const existing = project.pages.find(loaded => pageIdMatchesFile(proposed.id, loaded.path));
                // Baseline pages are writable only when the lock whitelists them in
                // editablePageIds — and the CAS check above has already run for them.
                if (existing && !structural.editablePageIds.has(pageId)) {
                    conflict = {
                        ok: false,
                        error: "review_scope_violation",
                        pageId,
                        detail: `Page ${pageId} is an existing page outside the structural edit's editable set`,
                    };
                    return;
                }
            }
        }
        else if (rewrite) {
            for (const proposed of pages) {
                const pageId = persistPageKey(proposed.id);
                const existing = project.pages.find(loaded => pageIdMatchesFile(proposed.id, loaded.path));
                // A rewrite lock authorizes every baseline page (CAS already ran for
                // them above) plus brand-new ids, which append at the end.
                if (existing && !rewrite.baselinePageIds.has(pageId)) {
                    conflict = {
                        ok: false,
                        error: "review_scope_violation",
                        pageId,
                        detail: `Page ${pageId} is not part of the rewrite baseline`,
                    };
                    return;
                }
            }
        }
        else if (guard && (guard.scope || guard.items !== undefined)) {
            for (const proposed of pages) {
                const pageId = persistPageKey(proposed.id);
                const target = reviewWriteTargetForPage(guard, pageId);
                if (!target) {
                    conflict = { ok: false, error: "review_scope_violation", pageId, detail: `Page ${pageId} is outside the authorized existing pages` };
                    return;
                }
                const elementGuard = target.scope.kind === "elements";
                if (elementGuard && !target.pageBody) {
                    conflict = { ok: false, error: "review_scope_violation", pageId, detail: "The original element review baseline is missing; create a new review" };
                    return;
                }
                const existing = project.pages.find(loaded => pageIdMatchesFile(proposed.id, loaded.path));
                const violation = reviewWriteScopeViolation(target.scope, pageId, elementGuard ? target.pageBody : existing?.page, asPersistedPage(proposed));
                if (violation) {
                    conflict = { ok: false, error: "review_scope_violation", pageId, detail: violation };
                    return;
                }
            }
        }
        // Editing a page must not rename the deck from an old generation brief.
        if (!guard)
            project.presentation.title = title;
        if (project.pages.length > 0) {
            patchPagesInPlace(project, pages);
        }
        const used = new Set(project.pages.map((loaded) => loaded.path));
        const added = [];
        for (const [index, page] of pages.entries()) {
            if (matchExistingPageIndex(project, page) >= 0)
                continue;
            if ([...used].some((listed) => pageIdMatchesFile(page.id, listed)))
                continue;
            if (!pageHasVisibleContent(page) && !pageHasReadableCopy(page))
                continue;
            const nextPath = persistNewPagePath(page, project.pages.length + index, used);
            if (!nextPath || used.has(nextPath))
                continue;
            used.add(nextPath);
            const entry = { path: nextPath, page: asPersistedPage(page) };
            if (structural)
                added.push(entry);
            else
                project.pages.push(entry);
        }
        if (structural && added.length) {
            // Insert before the baseline page at insertIndex; pages added by earlier
            // writes of this same turn already sit there, so each new page lands
            // right after them and write order is preserved.
            const baselineIds = new Set((Array.isArray(guard?.projectPages) ? guard.projectPages : [])
                .map((entry) => persistPageKey(String(entry?.pageId ?? "")))
                .filter((id) => id.length > 0));
            const alreadyAdded = baselineIds.size
                ? project.pages.filter((loaded) => !baselineIds.has(persistPageKey(loaded.path))).length
                : 0;
            const pos = Math.max(0, Math.min((structural.insertIndex ?? project.pages.length) + alreadyAdded, project.pages.length));
            project.pages.splice(pos, 0, ...added);
        }
        project.presentation.pages = project.pages.map((page) => page.path);
        saveProject(project);
    });
    return conflict ?? { ok: true };
}
/**
 * The persisted workspace-edit guard for page-list changes: kind "deck" plus
 * structureOnly. It authorizes new pages at insertIndex, whitelisted edits via
 * editablePageIds and removals via deletablePageIds; every other existing page
 * must remain byte-identical.
 */
function structuralEditGuard(guard) {
    const scope = guard?.scope;
    if (!scope || typeof scope !== "object" || Array.isArray(scope))
        return undefined;
    const rec = scope;
    if (rec.kind !== "deck" || rec.structureOnly !== true)
        return undefined;
    const insertIndex = Number(rec.insertIndex);
    const idSet = (value) => new Set((Array.isArray(value) ? value : [])
        .map((id) => persistPageKey(String(id ?? "")))
        .filter((id) => id.length > 0));
    return {
        insertIndex: Number.isSafeInteger(insertIndex) && insertIndex >= 0 ? insertIndex : undefined,
        editablePageIds: idSet(rec.editablePageIds),
        deletablePageIds: idSet(rec.deletablePageIds),
        // Order is the payload for a reorder — keep the sequence, not a set.
        reorderPageIds: (Array.isArray(rec.reorderPageIds) ? rec.reorderPageIds : [])
            .map((id) => persistPageKey(String(id ?? "")))
            .filter((id) => id.length > 0),
    };
}
/**
 * A full-rewrite lock (kind "deck" + rewrite, never structureOnly) authorizes
 * replacing the whole deck: every baseline page may be rewritten or deleted,
 * new pages may be appended, and the final manifest order is whatever the
 * committed plan demands — the verify step pins that order exactly.
 */
function rewriteEditGuard(guard) {
    const scope = guard?.scope;
    if (!scope || typeof scope !== "object" || Array.isArray(scope))
        return undefined;
    const rec = scope;
    if (rec.kind !== "deck" || rec.rewrite !== true || rec.structureOnly === true)
        return undefined;
    const baselinePageIds = new Set((Array.isArray(guard?.projectPages) ? guard.projectPages : [])
        .map((entry) => persistPageKey(String(entry?.pageId ?? "")))
        .filter((id) => id.length > 0));
    return { baselinePageIds };
}
/** Whether the active editor lock is a full-deck rewrite. */
export function rewriteLockActive(projectRoot) {
    return rewriteEditGuard(readActiveReviewGuard(projectRoot)) !== undefined;
}
/**
 * Deck-level metadata authorization ("editableMeta"): the scope may whitelist
 * "title" and/or "theme". A rewrite lock authorizes both implicitly.
 */
function editableMetaGuard(guard) {
    const scope = guard?.scope;
    if (!scope || typeof scope !== "object" || Array.isArray(scope))
        return new Set();
    const rec = scope;
    const meta = new Set((Array.isArray(rec.editableMeta) ? rec.editableMeta : [])
        .map((field) => String(field ?? "").trim())
        .filter((field) => field === "title" || field === "theme"));
    return meta;
}
function lastDiskBasename(state) {
    if (!state.projectRoot)
        return undefined;
    const manifest = path.join(state.projectRoot, "deck.pptd");
    if (!fs.existsSync(manifest))
        return undefined;
    try {
        const last = loadProject(state.projectRoot).pages.at(-1);
        return last ? path.basename(last.path, ".page") : undefined;
    }
    catch {
        return undefined;
    }
}
function siblingImageSrcsForWrite(state, pageId) {
    const rows = [];
    const seen = new Set();
    const add = (id, src) => {
        if (persistPageKey(id) === persistPageKey(pageId) || !src)
            return;
        const key = `${persistPageKey(id)}\0${src}`;
        if (seen.has(key))
            return;
        seen.add(key);
        rows.push({ pageId: id, src });
    };
    let diskPages = [];
    if (state.projectRoot && fs.existsSync(path.join(state.projectRoot, "deck.pptd"))) {
        try {
            diskPages = loadProject(state.projectRoot).pages;
        }
        catch {
            diskPages = [];
        }
    }
    for (const loaded of diskPages) {
        const rec = loaded.page;
        const id = path.basename(loaded.path, ".page") ||
            (typeof rec.id === "string" ? rec.id.trim() : "");
        if (!id)
            continue;
        for (const el of loaded.page.elements) {
            if (el.elementType === "image" && typeof el.src === "string")
                add(id, el.src);
        }
    }
    for (const page of writtenPages(state)) {
        for (const el of page.elements) {
            if (el.elementType === "image" && typeof el.src === "string")
                add(page.id, el.src);
        }
    }
    return rows;
}
function leftoverComposeIssue(state) {
    if (!state.projectRoot)
        return undefined;
    const manifest = path.join(state.projectRoot, "deck.pptd");
    if (!fs.existsSync(manifest))
        return undefined;
    try {
        return composedPageLeftoverIssues(loadProject(state.projectRoot).pages)[0];
    }
    catch {
        return undefined;
    }
}
function researchHadGap(state) {
    return state.researchNotes.some((n) => Boolean(n.gap) || n.source === "none");
}
function isClassroomBrief(brief) {
    return inferDeckIntent(brief) === "teach";
}
function mergedTodoExhibits(todo, index, brief) {
    return resolveTodoExhibits(todo, index, brief);
}
function reviewCurrent(state, pages, mode = "strict") {
    const classroom = isClassroomBrief(state.brief);
    const review = reviewSkillPages(pages, {
        projectRoot: state.projectRoot,
        researchHadGap: researchHadGap(state),
        todos: state.todos.map((todo, index) => ({
            ...todo,
            exhibits: mergedTodoExhibits(todo, index, state.brief),
        })),
        mode: classroom && mode === "compose" ? "compose" : classroom ? "strict" : mode,
        courseware: state.playbook.designSystemId === "academic/paper-white-courseware" &&
            isClassroomBrief(state.brief),
    });
    const extras = reportFactIssues(state.brief, pages, state.referenceText);
    if (extras.length) {
        review.issues.push(...extras);
        review.ok = false;
    }
    state.lastReview = review;
    return review;
}
function refuseIfNoReportFacts(name, state) {
    const reason = missingOperatingFactsReason(state.brief, state.referenceText);
    if (!reason)
        return undefined;
    return {
        name,
        ok: false,
        summary: "要数据",
        detail: reason,
        payload: { error: "need_data" },
    };
}
function refuseIfMissingHostedWebSearch(_name, _state, _phase) {
    // Grok search is dsh-oauth native hosted tools on the produce request.
    return undefined;
}
function adoptedSourceIdsForState(state, args = {}) {
    const adopted = sourceIdList(args.adoptedSourceIds, args.adopt);
    if (state.projectRoot) {
        for (const row of listSourceReceipts(state.projectRoot)) {
            if (row.state === "adopted" || row.state === "executed")
                adopted.push(row.sourceId);
        }
    }
    return adopted;
}
function packColorSchemaContext(state, args = {}) {
    return packColorWriteContextFrom({
        designSystemId: state.playbook.designSystemId || undefined,
        adoptedSourceIds: adoptedSourceIdsForState(state, args),
    });
}
function refuseIfKindThemePack(name, state, args = {}) {
    const adopted = adoptedSourceIdsForState(state, args);
    const issue = kindThemePackIssue({
        brief: state.brief,
        designSystemId: state.playbook.designSystemId,
        adoptedSourceIds: adopted,
        userExplicitPack: state.userExplicitPack === true,
    });
    if (!issue)
        return undefined;
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
function asRecord(raw) {
    return raw && typeof raw === "object" ? raw : {};
}
export function parseToolArgs(raw) {
    const trimmed = raw.trim() || "{}";
    try {
        const parsed = JSON.parse(trimmed);
        return asRecord(parsed);
    }
    catch {
        const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) {
            try {
                return asRecord(JSON.parse(fence[1].trim()));
            }
            catch {
                return {};
            }
        }
        return {};
    }
}
function playbookSection(bundle, section) {
    switch (section) {
        case "skill":
            return bundle.skillExcerpt;
        case "images": {
            const start = bundle.skillExcerpt.indexOf("##### Images and Visual Materials");
            const host = bundle.skillExcerpt.slice(0, bundle.skillExcerpt.indexOf("\n\n"));
            const images = start >= 0
                ? bundle.skillExcerpt.slice(start, bundle.skillExcerpt.indexOf("##### Content", start))
                : "";
            return [host, images.trim()].filter(Boolean).join("\n\n");
        }
        case "pptd":
            return bundle.pptdExcerpt;
        case "category":
            return bundle.categoryMarkdown;
        case "guide":
            return bundle.categoryGuideExcerpt;
        case "design":
            return `design_system: ${bundle.designSystemId}\n\n${bundle.designMarkdown.slice(0, 2000)}`;
        case "recipes":
            return bundle.recipesMarkdown;
        case "catalog":
            return JSON.stringify({
                categoryId: bundle.categoryId,
                designSystemId: bundle.designSystemId,
                sections: ["skill", "images", "pptd", "category", "guide", "design", "recipes"],
                note: "Read recipes before write_page. Media is optional. search_image / generate_image only if those ports are YES. Otherwise official no-image layouts.",
            }, null, 2);
        default:
            return "Unknown section. Use catalog, skill, images, pptd, category, guide, design, or recipes.";
    }
}
function filterLines(lines, query) {
    const q = query?.trim();
    if (!q)
        return lines;
    const tokens = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    return lines.filter((line) => {
        const low = line.toLowerCase();
        return low.includes(q.toLowerCase()) || tokens.some((t) => low.includes(t));
    });
}
export function runResearch(query, brief, referenceText) {
    const refs = extractReferenceLines(referenceText);
    const hits = filterLines(refs.lines, query);
    if (hits.length) {
        return {
            source: "attachment",
            citations: refs.names,
            facts: hits.slice(0, 8),
            note: "只引用附件原文，不是网络检索。",
        };
    }
    if (refs.lines.length) {
        return {
            source: "attachment",
            citations: refs.names,
            facts: refs.lines.slice(0, 5),
            note: "查询无精确命中，退回附件摘录。",
        };
    }
    if (isNamedClassroomFact(`${brief} ${query}`)) {
        return {
            source: "classroom_common",
            citations: [],
            facts: [
                "直角对着的边叫斜边，另外两边叫直角边。",
                "勾股关系：两直角边的平方和等于斜边的平方。3、4、5 是课堂练习数，不是统计。",
            ],
            note: "课堂常识，不是出处，不是调查数据。",
        };
    }
    return {
        source: "none",
        citations: [],
        facts: [],
        note: "没有可引用的来源。",
        gap: "没有可引用的来源。页上必须标占位，禁止编造机构名、网址或精确统计。",
    };
}
export function executeGenerateTool(name, args, state) {
    if (name === "think") {
        const summary = String(args.summary ?? "").trim() || "思考";
        const detail = String(args.detail ?? "").trim();
        if (!detail) {
            return {
                name,
                ok: false,
                summary: "think.detail required",
                detail: "think.detail required",
                payload: { error: "detail required" },
            };
        }
        return { name, ok: true, summary, detail, payload: { summary, detail } };
    }
    if (name === "read_playbook") {
        const section = String(args.section ?? "catalog").trim() || "catalog";
        const text = playbookSection(state.playbook, section);
        return {
            name,
            ok: true,
            summary: section,
            detail: text,
            payload: { section, text },
        };
    }
    if (name === "read_file") {
        const refs = extractReferenceLines(state.referenceText);
        if (!refs.names.length && !refs.lines.length) {
            const payload = { names: [], lines: [], note: "没有上传参考资料。" };
            return {
                name,
                ok: true,
                summary: "无附件",
                detail: payload.note,
                payload,
            };
        }
        const query = typeof args.query === "string" ? args.query : undefined;
        const lines = filterLines(refs.lines, query).slice(0, 20);
        const detail = [`来源：${refs.names.join("、") || "未命名"}`, ...lines].join("\n");
        return {
            name,
            ok: true,
            summary: `${refs.names.length} 份`,
            detail,
            payload: { names: refs.names, lines, query: query ?? null },
        };
    }
    if (name === "research") {
        const query = String(args.query ?? "").trim();
        if (!query) {
            return {
                name,
                ok: false,
                summary: "query required",
                detail: "research.query required",
                payload: { error: "query required" },
            };
        }
        const result = runResearch(query, state.brief, state.referenceText);
        state.researchNotes.push(result);
        return researchExecution(result);
    }
    if (name === "write_todo") {
        const blocked = refuseIfNoReportFacts(name, state) ?? refuseIfKindThemePack(name, state, args);
        if (blocked)
            return blocked;
        let items;
        try {
            items = parseCanonicalPagePlan(args.items).map((page) => ({ ...page, exhibits: [...page.exhibits] }));
        }
        catch (error) {
            return {
                name, ok: false, summary: "incomplete plan",
                detail: error instanceof Error ? error.message : String(error),
                payload: { error: "incomplete_plan" },
            };
        }
        state.todos = items;
        const detail = items
            .map((it, i) => `${it.pageId ?? String(i + 1).padStart(2, "0")}  ${it.title}${it.layoutFamily ? `  <${it.layoutFamily}>` : ""}  [${it.exhibits?.join(", ") ?? "none"}]${it.note ? `  · ${it.note}` : ""}`)
            .join("\n");
        return {
            name,
            ok: true,
            summary: `${items.length} 页`,
            detail,
            payload: { items },
        };
    }
    if (name === "delete_pages") {
        const guard = state.projectRoot ? readActiveReviewGuard(state.projectRoot) : undefined;
        const structural = structuralEditGuard(guard);
        const rewrite = rewriteEditGuard(guard);
        // Under a full-rewrite lock every baseline page is droppable.
        const deletable = structural?.deletablePageIds ?? rewrite?.baselinePageIds ?? new Set();
        const requested = [...new Set((Array.isArray(args.pageIds) ? args.pageIds : [])
                .map((id) => persistPageKey(String(id ?? "")))
                .filter((id) => id.length > 0))];
        const unauthorized = requested.filter((id) => !deletable.has(id));
        if ((!structural && !rewrite) || !deletable.size || !requested.length || unauthorized.length) {
            return {
                name,
                ok: false,
                summary: "delete outside structural scope",
                detail: !structural && !rewrite
                    ? "delete_pages needs an active editor structural authorization with deletablePageIds; this turn has none"
                    : `delete_pages only removes the pages this turn authorized (${[...deletable].join(", ")}); refusing ${unauthorized.join(", ") || "an empty pageIds"}`,
                payload: { error: "review_scope_violation", painted: false },
            };
        }
        const deleted = [];
        let missing = [];
        withProjectWriteLock(state.projectRoot, () => {
            const project = loadProject(state.projectRoot);
            const wanted = new Set(requested);
            const kept = [];
            for (const loaded of project.pages) {
                if (wanted.has(persistPageKey(loaded.path))) {
                    deleted.push(persistPageKey(loaded.path));
                    fs.rmSync(path.join(state.projectRoot, loaded.path), { force: true });
                }
                else
                    kept.push(loaded);
            }
            missing = requested.filter((id) => !deleted.includes(id));
            project.pages = kept;
            project.presentation.pages = kept.map((page) => page.path);
            saveProject(project);
        });
        if (missing.length) {
            return {
                name,
                ok: false,
                summary: "page not found",
                detail: `pageIds not on disk: ${missing.join(", ")} — read the page list again`,
                payload: { error: "page_not_found", missing, deleted, painted: false },
            };
        }
        return {
            name,
            ok: true,
            summary: `deleted ${deleted.length} 页`,
            detail: `已删除 ${deleted.join("、")}；其余页面与顺序不变。`,
            payload: { deleted, painted: false },
        };
    }
    if (name === "reorder_pages") {
        const guard = state.projectRoot ? readActiveReviewGuard(state.projectRoot) : undefined;
        const structural = structuralEditGuard(guard);
        const rewrite = rewriteEditGuard(guard);
        const authorized = structural?.reorderPageIds ?? [];
        const requested = (Array.isArray(args.pageIds) ? args.pageIds : [])
            .map((id) => persistPageKey(String(id ?? "")));
        // The requested order must equal the authorized permutation exactly —
        // same ids, same positions, every baseline page exactly once. Under a
        // full-rewrite lock any permutation of the current manifest is allowed;
        // the verify step pins the final order to the committed plan.
        const exact = structural
            ? authorized.length > 0 && requested.length === authorized.length &&
                requested.every((id, index) => id === authorized[index])
            : false;
        const rewritePermutation = rewrite !== undefined && (() => {
            if (!state.projectRoot || !requested.length || new Set(requested).size !== requested.length)
                return false;
            const current = loadProject(state.projectRoot).pages.map((entry) => persistPageKey(entry.path));
            return requested.length === current.length &&
                requested.every((id) => current.includes(id)) &&
                requested.some((id, index) => id !== current[index]);
        })();
        if (!exact && !rewritePermutation) {
            return {
                name,
                ok: false,
                summary: "reorder outside structural scope",
                detail: !structural && !rewrite
                    ? "reorder_pages needs an active editor structural authorization with reorderPageIds; this turn has none"
                    : structural
                        ? `reorder_pages must pass exactly this turn's authorized order (${authorized.join(" → ")}); refusing a different pageIds list`
                        : "reorder_pages under a rewrite must pass every current page id exactly once, in the new order",
                payload: { error: "review_scope_violation", painted: false },
            };
        }
        let missing = [];
        withProjectWriteLock(state.projectRoot, () => {
            const project = loadProject(state.projectRoot);
            const byId = new Map(project.pages.map((entry) => [persistPageKey(entry.path), entry]));
            missing = requested.filter((id) => !byId.has(id));
            if (missing.length)
                return;
            // Reorder touches the manifest only — page files are never rewritten.
            project.pages = requested.map((id) => byId.get(id));
            project.presentation.pages = project.pages.map((page) => page.path);
            saveProject(project);
        });
        if (missing.length) {
            return {
                name,
                ok: false,
                summary: "page not found",
                detail: `pageIds not on disk: ${missing.join(", ")} — read the page list again`,
                payload: { error: "page_not_found", missing, painted: false },
            };
        }
        return {
            name,
            ok: true,
            summary: `重排 ${requested.length} 页`,
            detail: `页面顺序已调整为 ${requested.join(" → ")}；页面内容均未改动。`,
            payload: { reordered: requested, painted: false },
        };
    }
    if (name === "update_deck") {
        const guard = state.projectRoot ? readActiveReviewGuard(state.projectRoot) : undefined;
        const rewrite = rewriteEditGuard(guard);
        const meta = editableMetaGuard(guard);
        const titleProvided = typeof args.title === "string";
        const themeProvided = args.theme !== undefined && args.theme !== null &&
            typeof args.theme === "object" && !Array.isArray(args.theme);
        if (!guard || !state.projectRoot) {
            return {
                name,
                ok: false,
                summary: "deck metadata needs authorization",
                detail: "update_deck needs an active editor authorization with editableMeta covering the requested fields",
                payload: { error: "review_scope_violation", painted: false },
            };
        }
        if (!titleProvided && !themeProvided) {
            return {
                name,
                ok: false,
                summary: "nothing to update",
                detail: "update_deck requires a title and/or theme to apply",
                payload: { error: "invalid_args", painted: false },
            };
        }
        const denied = [
            titleProvided && !(meta.has("title") || rewrite) ? "title" : undefined,
            themeProvided && !(meta.has("theme") || rewrite) ? "theme" : undefined,
        ].filter(Boolean);
        if (denied.length) {
            return {
                name,
                ok: false,
                summary: "deck metadata outside authorized scope",
                detail: `update_deck may only change the fields this turn authorized (editableMeta: ${[...meta].join(", ") || "none"}); refusing ${denied.join(", ")}`,
                payload: { error: "review_scope_violation", painted: false },
            };
        }
        let applied = [];
        withProjectWriteLock(state.projectRoot, () => {
            const project = loadProject(state.projectRoot);
            if (titleProvided)
                project.presentation.title = String(args.title).trim();
            if (themeProvided)
                project.presentation.theme = structuredClone(args.theme);
            saveProject(project);
            applied = [titleProvided ? "标题" : "", themeProvided ? "主题" : ""].filter(Boolean);
        });
        return {
            name,
            ok: true,
            summary: `更新文稿${applied.join("、")}`,
            detail: `文稿${applied.join("、")}已更新；页面内容均未改动。`,
            payload: { updatedMeta: [titleProvided ? "title" : "", themeProvided ? "theme" : ""].filter(Boolean), painted: false },
        };
    }
    if (name === "write_page") {
        const blocked = refuseIfNoReportFacts(name, state) ??
            refuseIfKindThemePack(name, state, args) ??
            refuseIfMissingHostedWebSearch(name, state, "write");
        if (blocked)
            return blocked;
        const parsed = parseSkillPage(args, writtenPages(state).length);
        if (!parsed) {
            return {
                name,
                ok: false,
                summary: "invalid page",
                detail: `write_page needs official vocab: cover-botanical|title-band|coral-rule|chapter|page-title|route-path|method-panels|two-column-45-55|demo-band|two-column-body|result-bar|next-action|footer-chrome, or header|list|box|circle|band|text with position/bounds. keys=${Object.keys(args).join(",")}`,
                payload: { error: "invalid page" },
            };
        }
        const page = parsed;
        const rawCharts = countRawChartElements(args.elements);
        const keptCharts = page.elements.filter((el) => el.elementType === "chart").length;
        if (rawCharts > keptCharts) {
            return {
                name,
                ok: false,
                summary: "chart dropped",
                detail: DROPPED_CHART_DETAIL,
                payload: { error: "dropped_chart", painted: false },
            };
        }
        const list = writtenPages(state);
        const planKeys = (state.todos ?? [])
            .map((todo) => (todo.pageId ? persistPageKey(todo.pageId) : ""))
            .filter((key) => key.length > 0);
        const rewriteLock = state.projectRoot
            ? rewriteEditGuard(readActiveReviewGuard(state.projectRoot))
            : undefined;
        // A rewrite's committed plan is the verify contract — writing before
        // write_todo would be rolled back wholesale, so refuse it up front.
        if (rewriteLock && !planKeys.length) {
            return {
                name,
                ok: false,
                summary: "not in plan",
                detail: "a rewrite must commit its new outline via write_todo before any write_page",
                payload: { error: "not_in_plan", painted: false },
            };
        }
        if ((state.todos ?? []).length > 0 && planKeys.length > 0) {
            const key = persistPageKey(page.id);
            const persisted = list.some((p) => persistPageKey(p.id) === key);
            // A structural page-list lock deliberately creates pages the committed
            // plan does not know; a rewrite's new ids ARE in the freshly committed
            // plan, so only a structural lock bypasses this check.
            const structuralLock = state.projectRoot
                ? structuralEditGuard(readActiveReviewGuard(state.projectRoot))
                : undefined;
            if (!persisted && !planKeys.includes(key) && structuralLock === undefined) {
                return {
                    name,
                    ok: false,
                    summary: "not in plan",
                    detail: `page ${page.id} is not in the current plan — call write_todo first to add it (title/exhibits), then write_page`,
                    payload: { error: "not_in_plan", painted: false },
                };
            }
        }
        const existingIdx = list.findIndex((p) => persistPageKey(p.id) === persistPageKey(page.id));
        const index = existingIdx >= 0 ? existingIdx : list.length;
        const last = existingIdx >= 0 ? list.length - 1 : list.length;
        const diskLast = lastDiskBasename(state);
        let diskPageCount;
        let theme;
        let persistedBackgroundColor;
        if (state.projectRoot) {
            try {
                const project = loadProject(state.projectRoot);
                diskPageCount = project.pages.length;
                theme = project.presentation.theme;
                const persistedPage = project.pages.find((loaded) => pageIdMatchesFile(page.id, loaded.path));
                if (persistedPage?.page.background?.type === "solid") {
                    persistedBackgroundColor = persistedPage.page.background.color;
                }
            }
            catch {
                diskPageCount = undefined;
            }
        }
        const siblingImageSrcs = siblingImageSrcsForWrite(state, page.id);
        const todoExhibits = (state.todos ?? []).find((todo) => todo.pageId && persistPageKey(todo.pageId) === persistPageKey(page.id))?.exhibits;
        let photoExhibit;
        if (todoExhibits?.includes("photo") && state.projectRoot) {
            const caps = inspectProjectCapabilities(state.projectRoot, process.env);
            if (caps.imageSearch.configured || caps.imageGenerate.configured)
                photoExhibit = true;
        }
        const schemaCtx = {
            writtenIndex: index,
            writtenLast: last,
            lastDiskBasename: diskLast,
            diskPageCount: diskLast ? diskPageCount : undefined,
            theme,
            ...packColorSchemaContext(state, args),
            ...backgroundColorWriteAuthority({
                projectRoot: state.projectRoot,
                pageId: page.id,
                persistedBackgroundColor,
            }),
            ...(siblingImageSrcs.length ? { siblingImageSrcs } : {}),
            ...(photoExhibit ? { photoExhibit, projectRoot: state.projectRoot } : {}),
        };
        const schemaIssues = writePageSchemaIssues(page, schemaCtx, args);
        const schemaError = writePageSchemaError(schemaIssues, page, schemaCtx);
        if (schemaError) {
            return {
                name,
                ok: false,
                summary: schemaError.error === "empty_closer" ? "empty closer" : schemaError.error,
                detail: schemaError.detail,
                payload: {
                    error: schemaError.error,
                    pageId: schemaError.pageId,
                    painted: false,
                    next: schemaError.error === "empty_closer" ? "write_page" : undefined,
                },
            };
        }
        const kinds = [...new Set(page.elements.map((el) => el.elementType))].join("+");
        const persisted = persistWrittenPages(state, [page], {
            expectedPageSha256: String(args.expectedPageSha256 ?? "").trim() || undefined,
        });
        if (!persisted.ok) {
            return {
                name,
                ok: false,
                summary: persisted.error === "review_scope_violation" ? "edit outside selected target" : "page changed",
                detail: persisted.error === "review_scope_violation"
                    ? `write_page rejected before saving: ${persisted.detail}. Read the page again and change only the authorized target; preserve all other elements and page settings exactly.`
                    : `write_page rejected because ${persisted.pageId} changed after read_page; read the page again and reapply the requested edit`,
                payload: { ...persisted, painted: false },
            };
        }
        const idx = list.findIndex((p) => p.id === page.id);
        if (idx >= 0)
            list[idx] = page;
        else
            list.push(page);
        syncSkillDeckPage(state, page);
        return {
            name,
            ok: true,
            summary: `${page.id} · ${page.elements.length} el`,
            detail: `${page.id}  ${page.pageType ?? "page"}  ${kinds}\n${list.length} pages on disk\nwrite_page kept agent elements; host did not restamp`,
            payload: { page, pageCount: list.length, applied: false, painted: false, restamped: false },
        };
    }
    if (name === "review_pages") {
        const { pages, loadError } = reviewablePages(state);
        if (loadError && state.strictLedger) {
            return {
                name,
                ok: false,
                summary: "project unreadable",
                detail: `loadProject failed: ${loadError}. Disk is the SSOT; review cannot grade a stale buffer.`,
                payload: { error: "project_unreadable" },
            };
        }
        if (!pages.length) {
            return {
                name,
                ok: false,
                summary: "need pages",
                detail: "write_page first. A one-page plan is valid.",
                payload: { error: "need pages" },
            };
        }
        const review = reviewCurrent(state, pages, "compose");
        const ok = review.ok;
        const rasterNote = state.lastRaster
            ? `last render_page: ${state.lastRaster.kind} ${state.lastRaster.src ?? ""} — ${state.lastRaster.note}`
            : "no render_page yet — you have not seen the native #slide";
        return {
            name,
            ok,
            summary: ok ? `${pages.length} 页通过` : `${review.issues.length} 个问题`,
            detail: ok
                ? `${rasterNote}\nstructural QA only unless render_page returned native-slide.\n${review.pages.map((p) => `${p.id} cover=${p.coverage.toFixed(2)} exhibit=${p.exhibit ?? "none"}`).join("\n")}`
                : review.issues.map((i) => `${i.pageId}: ${i.message}`).join("\n"),
            payload: { ...review, lastRaster: state.lastRaster ?? null },
        };
    }
    if (name === "compose_deck") {
        const blocked = refuseIfNoReportFacts(name, state) ??
            refuseIfKindThemePack(name, state, args) ??
            refuseIfMissingHostedWebSearch(name, state, "compose");
        if (blocked)
            return blocked;
        const leftover = leftoverComposeIssue(state);
        if (leftover) {
            return {
                name,
                ok: false,
                summary: leftover.kind === "host_seed" ? "host seed leftover" : "empty closer",
                detail: leftover.message,
                payload: {
                    error: leftover.kind === "host_seed" ? "host_seed" : "empty_closer",
                    pageId: leftover.pageId,
                    next: "write_page",
                },
            };
        }
        const rules = composeBodyRules(state.brief, state.playbook.categoryId, state.requestedPageCount);
        try {
            const buffered = writtenPages(state);
            const incoming = parseSkillDeck(args);
            let diskPages = [];
            let diskLoadError = "";
            if (state.projectRoot) {
                try {
                    diskPages = diskSkillPages(state);
                }
                catch (e) {
                    diskLoadError = e instanceof Error ? e.message : String(e);
                }
            }
            if (state.strictLedger && diskLoadError) {
                return {
                    name,
                    ok: false,
                    summary: "project unreadable",
                    detail: `loadProject failed: ${diskLoadError}. Disk is the SSOT; compose cannot grade a stale buffer.`,
                    payload: { error: "project_unreadable" },
                };
            }
            const skill = diskPages.length
                ? {
                    title: String(args.title ?? state.skillDeck?.title ?? "未命名演示"),
                    pages: diskPages,
                }
                : incoming ??
                    (buffered.length
                        ? {
                            title: String(args.title ?? state.skillDeck?.title ?? "未命名演示"),
                            pages: buffered,
                        }
                        : null);
            if (skill) {
                let composeTheme;
                let composeProject;
                if (state.projectRoot) {
                    try {
                        composeProject = loadProject(state.projectRoot);
                        composeTheme = composeProject.presentation.theme;
                    }
                    catch {
                        composeTheme = undefined;
                    }
                }
                const packCtx = { theme: composeTheme, ...packColorSchemaContext(state, args) };
                for (const page of skill.pages) {
                    const persistedPage = composeProject?.pages.find((loaded) => pageIdMatchesFile(page.id, loaded.path));
                    const persistedBackgroundColor = persistedPage?.page.background?.type === "solid"
                        ? persistedPage.page.background.color
                        : undefined;
                    const pagePackCtx = {
                        ...packCtx,
                        ...backgroundColorWriteAuthority({
                            pageId: page.id,
                            persistedBackgroundColor,
                            includeActiveOverride: false,
                        }),
                    };
                    const packErr = writePageSchemaError(writePageSchemaIssues(page, pagePackCtx), page, pagePackCtx);
                    if (packErr?.error === PACK_COLOR_ERROR) {
                        return {
                            name,
                            ok: false,
                            summary: "pack color",
                            detail: packErr.detail,
                            payload: {
                                error: PACK_COLOR_ERROR,
                                pageId: packErr.pageId,
                                painted: false,
                            },
                        };
                    }
                }
                const todoN = state.todos?.length ?? 0;
                const writtenN = skill.pages.length;
                // Match plan→page by persisted key, not array position/count: a renamed
                // pageId must still satisfy its own todo line, and duplicate keys must
                // not let one written page cover two planned pages.
                const writtenKeys = new Set(skill.pages.map((p) => persistPageKey(p.id)));
                const missingTodos = state.todos.filter((todo) => {
                    const key = persistPageKey(todo.pageId ?? todo.title);
                    return key && !writtenKeys.has(key);
                });
                if (todoN >= 3 && (writtenN < todoN || missingTodos.length)) {
                    return {
                        name,
                        ok: false,
                        summary: `还差 ${Math.max(todoN - writtenN, missingTodos.length)} 页`,
                        detail: `write_todo has ${todoN} pages; write_page landed ${writtenN}.${missingTodos.length ? ` Missing: ${missingTodos.map((t) => t.pageId ?? t.title).join(", ")}.` : ""} Keep calling write_page. The host will not paint the rest.`,
                        payload: {
                            error: "compose_before_todo_done",
                            todo: todoN,
                            written: writtenN,
                            missing: missingTodos.map((t) => t.pageId ?? t.title),
                        },
                    };
                }
                const last = skill.pages[skill.pages.length - 1];
                const closer = skill.pages.find((page, index) => isCloserPage(page, index, skill.pages.length - 1)) ?? last;
                if (closer && skill.pages.length > 1 && !pageHasReadableCopy(closer)) {
                    return {
                        name,
                        ok: false,
                        summary: "empty closer",
                        detail: EMPTY_CLOSER_PRODUCE_NEXT,
                        payload: { error: "empty_closer", pageId: closer.id, next: "write_page" },
                    };
                }
                const review = reviewCurrent(state, skill.pages, "compose");
                const reportBlocks = review.issues.filter((i) => i.code === "unnamed_gap" ||
                    i.code === "missing_column" ||
                    i.code === "missing_locked_fact" ||
                    i.code === "missing_requested_exhibit" ||
                    i.code === "empty_cell" ||
                    i.code === "overflow" ||
                    i.code === "overlap" ||
                    i.code === "zero_area" ||
                    i.code === "bounds_omitted");
                if (reportBlocks.length) {
                    return {
                        name,
                        ok: false,
                        summary: "report facts QA failed",
                        detail: reportBlocks.map((i) => `${i.pageId}: ${i.message}`).join("\n"),
                        payload: { error: "report facts QA failed", review },
                    };
                }
                if (!review.ok) {
                    const closerEmpty = review.issues.find((issue) => issue.code === "empty" &&
                        /closer|readable copy|结束页/.test(issue.message));
                    if (closerEmpty) {
                        return {
                            name,
                            ok: false,
                            summary: "empty closer",
                            detail: EMPTY_CLOSER_PRODUCE_NEXT,
                            payload: {
                                error: "empty_closer",
                                pageId: closerEmpty.pageId,
                                next: "write_page",
                            },
                        };
                    }
                    return {
                        name,
                        ok: false,
                        summary: "layout QA failed",
                        detail: review.issues.map((i) => `${i.pageId}: ${i.message}`).join("\n"),
                        payload: { error: "layout QA failed", review },
                    };
                }
                assertSkillDeck(skill, { minPages: rules.minPages });
                state.skillDeck = skill;
                state.deck = skillToCompose(skill);
                const detail = skill.pages
                    .map((p, i) => {
                    const kinds = [...new Set(p.elements.map((el) => el.elementType))].join("+");
                    return `${String(i + 1).padStart(2, "0")}  ${p.pageType ?? "page"}  ${p.id}  · ${p.elements.length} el (${kinds})`;
                })
                    .join("\n");
                return {
                    name,
                    ok: true,
                    summary: `${skill.pages.length} 页 PPTD`,
                    detail,
                    payload: skill,
                };
            }
            if (state.strictLedger) {
                return {
                    name,
                    ok: false,
                    summary: "no written pages",
                    detail: "The run ledger is active: compose only accepts pages persisted through write_page. The role+bullets IR fallback is disabled because it bypasses every gate.",
                    payload: { error: "ir_fallback_disabled", next: "write_page" },
                };
            }
            const deck = finalizeComposeDeck(args, state.todos, rules);
            state.skillDeck = undefined;
            state.deck = deck;
            const detail = deck.pages
                .map((p, i) => {
                const n = (p.bullets?.length ?? 0) + (p.items?.length ?? 0);
                const extra = p.chart ? "  · chart" : n ? `  · ${n} 条` : "";
                return `${String(i + 1).padStart(2, "0")}  ${p.role}  ${p.title}${extra}`;
            })
                .join("\n");
            return {
                name,
                ok: true,
                summary: `${deck.pages.length} 页 · IR fallback`,
                detail: `role+bullets only — skill did not write PPTD elements.\n${detail}`,
                payload: deck,
            };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
                name,
                ok: false,
                summary: "invalid compose",
                detail: msg,
                payload: { error: msg },
            };
        }
    }
    return {
        name,
        ok: false,
        summary: "unknown tool",
        detail: `Tool not allowed: ${name}`,
        payload: { error: `unknown tool: ${name}` },
    };
}
export function toolStepMeta(name) {
    switch (name) {
        case "think":
            return { tool: "think", label: "Think" };
        case "read_playbook":
        case "read_file":
            return { tool: "read_file", label: "Read" };
        case "research":
            return { tool: "research", label: "Research" };
        case "web_search":
            return { tool: "web_search", label: "Web Search" };
        case "write_todo":
            return { tool: "write_todo", label: "Write Todo" };
        case "compose_deck":
            return { tool: "compose_deck", label: "Compose Deck" };
        case "generate_image":
            return { tool: "generate_image", label: "Image" };
        case "search_image":
            return { tool: "search_image", label: "Search Image" };
        case "write_page":
            return { tool: "write_page", label: "Write Page" };
        case "render_page":
            return { tool: "render_page", label: "Render" };
        case "review_pages":
            return { tool: "review_pages", label: "Review" };
        default:
            return { tool: name, label: name };
    }
}
export async function executeGenerateToolAsync(name, args, state) {
    if (name === "web_search") {
        const queries = webSearchQueriesFromArgs(args);
        if (!queries.length) {
            return {
                name,
                ok: false,
                summary: "queries required",
                detail: "web_search needs queries[]",
                payload: { error: "queries required" },
            };
        }
        if (!state.webSearch) {
            return {
                name,
                ok: false,
                summary: "not configured",
                detail: "web_search is a Grok hosted tool; inspect_capabilities.research is off",
                payload: { error: "web_search is not configured" },
            };
        }
        const facts = [];
        const citations = [];
        const texts = [];
        for (const query of queries) {
            const result = await state.webSearch.search(query);
            facts.push(...result.facts);
            citations.push(...result.citations);
            if (result.text.trim())
                texts.push(result.text.trim());
        }
        const uniqueFacts = [...new Set(facts)];
        const uniqueCitations = [...new Set(citations)];
        if (uniqueFacts.length === 0 && uniqueCitations.length === 0) {
            return {
                name,
                ok: false,
                summary: "empty search",
                detail: EMPTY_HOSTED_WEB_SEARCH,
                payload: { error: EMPTY_HOSTED_WEB_SEARCH, queries },
            };
        }
        state.researchNotes.push({
            source: "pi-xai-hosted",
            citations: uniqueCitations,
            facts: uniqueFacts,
            note: "xAI web_search — live hosted search, not assistant prose.",
        });
        return {
            name,
            ok: true,
            summary: uniqueFacts.length ? `${uniqueFacts.length} facts` : "searched",
            detail: [...texts, ...uniqueCitations.map((url) => `source: ${url}`)].filter(Boolean).join("\n"),
            payload: {
                queries,
                query: queries[0],
                text: texts.join("\n\n"),
                facts: uniqueFacts,
                citations: uniqueCitations,
                source: "pi-xai-hosted",
            },
        };
    }
    if (name === "generate_image") {
        const id = String(args.id ?? "").trim();
        const prompt = String(args.prompt ?? "").trim();
        if (!id || !prompt) {
            return {
                name,
                ok: false,
                summary: "id+prompt required",
                detail: "generate_image needs id and prompt",
                payload: { error: "id and prompt required" },
            };
        }
        if (!state.projectRoot) {
            return {
                name,
                ok: false,
                summary: "no project",
                detail: "generate_image needs a project root to write media/",
                payload: { error: "no projectRoot" },
            };
        }
        if (!state.image) {
            return {
                name,
                ok: false,
                summary: "not configured",
                detail: "generate_image is not configured; refusing to write a placeholder PNG",
                payload: { error: "generate_image is not configured" },
            };
        }
        const slotW = Number(args.width);
        const slotH = Number(args.height);
        const namedAspect = typeof args.aspect === "string" ? args.aspect.trim() : "";
        let aspect;
        if (slotW > 0 && slotH > 0) {
            try {
                aspect = aspectFromSlot(slotW, slotH);
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                return {
                    name,
                    ok: false,
                    summary: "bad slot",
                    detail,
                    payload: { error: detail },
                };
            }
        }
        else if (namedAspect) {
            aspect = namedAspect;
        }
        else {
            return {
                name,
                ok: false,
                summary: "frame size required",
                detail: "generate_image needs the planned photo frame width and height in page pixels so the file matches the slot. Do not omit them and default to 16:9.",
                payload: { error: "width and height required" },
            };
        }
        try {
            const image = await state.image.generate(prompt, aspect);
            const ext = image.mime === "image/jpeg" ? "jpg" : "png";
            const saved = saveMediaFile(state.projectRoot, id, image.bytes, ext);
            return {
                name,
                ok: true,
                summary: `${saved.src} · ${image.kind}`,
                detail: [
                    `src: ${saved.src}`,
                    `size: ${image.width}×${image.height}`,
                    `aspect: ${aspect}`,
                    `kind: ${image.kind}`,
                    image.note,
                    `media: ${listMedia(state.projectRoot).join(", ")}`,
                ].join("\n"),
                payload: {
                    src: saved.src,
                    width: image.width,
                    height: image.height,
                    aspect,
                    kind: image.kind,
                    note: image.note,
                },
            };
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return {
                name,
                ok: false,
                summary: "generate failed",
                detail,
                payload: { error: detail, painted: false },
            };
        }
    }
    if (name === "search_image") {
        const id = String(args.id ?? "").trim();
        const query = String(args.query ?? "").trim();
        if (!id || !query) {
            return {
                name,
                ok: false,
                summary: "id+query required",
                detail: "search_image needs id and query",
                payload: { error: "id and query required" },
            };
        }
        if (!state.imageSearch) {
            return {
                name,
                ok: true,
                summary: "no search port",
                detail: "imageSearch is not configured — do not write src. Design without a bitmap.",
                payload: { kind: "none", note: "no image search port" },
            };
        }
        const hit = await state.imageSearch.search(query);
        if ("kind" in hit && hit.kind === "none") {
            return {
                name,
                ok: true,
                summary: "no image",
                detail: hit.note,
                payload: { kind: "none", note: hit.note },
            };
        }
        if (!state.projectRoot) {
            return {
                name,
                ok: false,
                summary: "no project",
                detail: "search_image needs a project root to write media/",
                payload: { error: "no projectRoot" },
            };
        }
        const found = hit;
        const ext = found.mime === "image/jpeg" ? "jpg" : found.mime === "image/webp" ? "webp" : "png";
        const saved = saveMediaFile(state.projectRoot, id, found.bytes, ext);
        return {
            name,
            ok: true,
            summary: `${saved.src} · search`,
            detail: [
                `src: ${saved.src}`,
                found.width && found.height ? `size: ${found.width}×${found.height}` : "",
                found.note,
                `media: ${listMedia(state.projectRoot).join(", ")}`,
            ]
                .filter(Boolean)
                .join("\n"),
            payload: {
                src: saved.src,
                width: found.width,
                height: found.height,
                kind: "search",
                note: found.note,
                attribution: found.attribution,
            },
        };
    }
    if (name === "render_page") {
        const pages = writtenPages(state);
        if (!pages.length) {
            return {
                name,
                ok: false,
                summary: "need pages",
                detail: "write_page first",
                payload: { error: "need pages" },
            };
        }
        let index = typeof args.pageIndex === "number" ? Math.floor(args.pageIndex) : -1;
        const pageId = String(args.pageId ?? "").trim();
        if (index < 0 && pageId) {
            index = pages.findIndex((p) => p.id === pageId);
        }
        if (index < 0)
            index = pages.length - 1;
        if (index < 0 || index >= pages.length) {
            return {
                name,
                ok: false,
                summary: "bad page",
                detail: "render_page pageId / pageIndex not found",
                payload: { error: "page not found" },
            };
        }
        const port = state.raster ?? createPageRasterPort();
        const shot = await port.render({
            projectRoot: state.projectRoot ?? "",
            pageIndex: index,
        });
        let src;
        let dataUrl;
        if (shot.kind === "native-slide" && shot.bytes && state.projectRoot) {
            const saved = savePageRaster(state.projectRoot, pages[index].id, shot.bytes);
            src = saved.src;
            dataUrl = rasterToDataUrl(shot.bytes);
        }
        state.lastRaster = { ...shot, pageId: pages[index].id, src };
        return {
            name,
            ok: shot.kind === "native-slide",
            summary: shot.kind === "native-slide"
                ? `${pages[index].id} · native #slide`
                : "did not see the slide",
            detail: [shot.note, src ? `src: ${src}` : "", `page: ${pages[index].id}`]
                .filter(Boolean)
                .join("\n"),
            payload: {
                pageId: pages[index].id,
                pageIndex: index,
                src,
                width: shot.width,
                height: shot.height,
                kind: shot.kind,
                note: shot.note,
                dataUrl,
                layout: shot.layout,
            },
        };
    }
    return executeGenerateTool(name, args, state);
}
//# sourceMappingURL=agent-tools.js.map