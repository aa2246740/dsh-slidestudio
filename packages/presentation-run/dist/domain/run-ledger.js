import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { parseCanonicalPagePlan } from "./page-plan.js";
import { isCloserPage, pageHasReadableCopy, isPlaceholderReviewIssue, persistPageKey, writePageSchemaIssues, writePageSchemaError, composedPageLeftoverIssues, renderedLayoutBlocksCompose, } from "./layout-qa.js";
import { inspectProjectCapabilities } from "../capabilities.js";
import { listSourceReceipts } from "../receipts.js";
import { packColorWriteContextFrom } from "./theme-pack.js";
import { MISSING_HOSTED_WEB_SEARCH_RECEIPT, hostedResearchNeedsWebSearchReceipt, ledgerHasSuccessfulWebSearch, } from "./hosted-web-search.js";
import { spinWait, writeFileAtomic } from "./atomic-file.js";
export const RUN_LEDGER_REL = path.join("_agent", "run-ledger.v1.json");
/** Bump whenever rendered layout acceptance semantics change. */
export const RENDERED_LAYOUT_GATE_VERSION = "rendered-layout-gate-v8";
/** Bump whenever structural review rules change. */
export const STRUCTURAL_REVIEW_GATE_VERSION = "structural-review-gate-v6";
function nowIso() {
    return new Date().toISOString();
}
function asRecord(raw) {
    return raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw
        : undefined;
}
function stableValue(raw) {
    if (Array.isArray(raw))
        return raw.map(stableValue);
    const rec = asRecord(raw);
    if (!rec)
        return raw;
    return Object.fromEntries(Object.keys(rec)
        .sort()
        .map((key) => [key, stableValue(rec[key])]));
}
export function stableSha256(raw) {
    return crypto
        .createHash("sha256")
        .update(JSON.stringify(stableValue(raw) ?? null))
        .digest("hex");
}
export function bytesSha256(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}
function factId(type, payload) {
    return `${type}:${stableSha256(payload)}`;
}
function parseRequirements(raw) {
    if (!Array.isArray(raw))
        throw new Error("run ledger source requirements must be an array");
    return raw.map((item) => {
        const rec = asRecord(item);
        if (!rec)
            throw new Error("invalid run ledger source requirement");
        const sourceId = typeof rec.sourceId === "string" ? rec.sourceId : "";
        const fileSha256 = typeof rec.fileSha256 === "string" ? rec.fileSha256 : "";
        const reason = rec.reason;
        const chunkIndexes = Array.isArray(rec.chunkIndexes)
            ? rec.chunkIndexes.filter((n) => Number.isInteger(n) && Number(n) >= 0)
            : [];
        if (!sourceId || !fileSha256 || !chunkIndexes.length) {
            throw new Error("invalid run ledger source requirement fields");
        }
        if (reason !== "skill" &&
            reason !== "pptd" &&
            reason !== "category-guide" &&
            reason !== "scenario" &&
            reason !== "preset-design") {
            throw new Error("invalid run ledger source requirement reason");
        }
        return { sourceId, fileSha256, chunkIndexes, reason };
    });
}
function parseExecutionPolicy(raw) {
    if (raw === undefined)
        return undefined;
    const rec = asRecord(raw);
    if (!rec ||
        typeof rec.currentRenderedLayoutRequired !== "boolean" ||
        typeof rec.structuralReviewRequired !== "boolean") {
        throw new Error("invalid run ledger execution policy");
    }
    return {
        currentRenderedLayoutRequired: rec.currentRenderedLayoutRequired,
        structuralReviewRequired: rec.structuralReviewRequired,
    };
}
function parseLedger(raw) {
    const rec = asRecord(raw);
    if (!rec || rec.schemaVersion !== 1)
        throw new Error("invalid run ledger schema");
    const pack = asRecord(rec.sourcePack);
    if (!pack)
        throw new Error("invalid run ledger source pack");
    if (!Array.isArray(rec.facts))
        throw new Error("invalid run ledger facts");
    return {
        schemaVersion: 1,
        runId: String(rec.runId ?? ""),
        createdAt: String(rec.createdAt ?? ""),
        updatedAt: String(rec.updatedAt ?? ""),
        sourcePack: {
            manifestSha256: String(pack.manifestSha256 ?? ""),
            requirementsId: String(pack.requirementsId ?? ""),
            requirements: parseRequirements(pack.requirements),
            executionPolicy: parseExecutionPolicy(pack.executionPolicy),
        },
        facts: rec.facts,
    };
}
function ledgerFile(root) {
    return path.join(root, RUN_LEDGER_REL);
}
export function readRunLedger(root) {
    const file = ledgerFile(root);
    if (!fs.existsSync(file))
        return undefined;
    return parseLedger(JSON.parse(fs.readFileSync(file, "utf8")));
}
function acquireLock(root) {
    const dir = path.join(root, "_agent");
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, "run-ledger.lock");
    for (let attempt = 0; attempt < 40; attempt++) {
        try {
            const fd = fs.openSync(lock, "wx");
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }), "utf8");
            fs.closeSync(fd);
            return () => {
                try {
                    fs.unlinkSync(lock);
                }
                catch {
                    // Another recovery path may already have removed a stale lock.
                }
            };
        }
        catch (error) {
            const code = error.code;
            if (code !== "EEXIST")
                throw error;
            try {
                const age = Date.now() - fs.statSync(lock).mtimeMs;
                if (age > 30_000) {
                    fs.unlinkSync(lock);
                    continue;
                }
            }
            catch {
                continue;
            }
            if (attempt === 39)
                throw new Error("run ledger is locked by another process");
            spinWait(5);
        }
    }
    throw new Error("run ledger lock unavailable");
}
function writeLedger(root, ledger) {
    writeFileAtomic(ledgerFile(root), `${JSON.stringify(ledger, null, 2)}\n`);
}
function mutateLedger(root, apply) {
    const release = acquireLock(root);
    try {
        const current = readRunLedger(root);
        if (!current)
            throw new Error("run ledger is not initialized");
        const next = apply(current);
        // Reducers return the same object when nothing changed; a read-only
        // mutation (e.g. an unchanged execution-policy ensure on a state poll)
        // must not rewrite the whole ledger on disk.
        if (next !== current)
            writeLedger(root, next);
        return next;
    }
    finally {
        release();
    }
}
function mergeCompatibleSourcePack(current, sourcePack) {
    if (current.sourcePack.manifestSha256 !== sourcePack.manifestSha256 ||
        current.sourcePack.requirementsId !== sourcePack.requirementsId ||
        (current.sourcePack.executionPolicy !== undefined &&
            stableSha256(current.sourcePack.executionPolicy) !== stableSha256(sourcePack.executionPolicy))) {
        throw new Error("run ledger source requirements changed for an active run");
    }
    if (current.sourcePack.executionPolicy || !sourcePack.executionPolicy)
        return current;
    return {
        ...current,
        updatedAt: nowIso(),
        sourcePack: { ...current.sourcePack, executionPolicy: sourcePack.executionPolicy },
    };
}
export function ensureRunLedgerExecutionPolicy(root, executionPolicy) {
    const existing = readRunLedger(root);
    if (!existing)
        return undefined;
    // Cheap early-out before taking the lock: hydrate() calls this on every
    // /slides/state poll, so an already-matching policy must not churn the
    // lock file or rewrite the ledger. The locked mutation re-validates below.
    if (existing.sourcePack.executionPolicy !== undefined &&
        stableSha256(existing.sourcePack.executionPolicy) === stableSha256(executionPolicy)) {
        return existing;
    }
    return mutateLedger(root, (current) => {
        const currentPolicy = current.sourcePack.executionPolicy;
        if (currentPolicy && stableSha256(currentPolicy) !== stableSha256(executionPolicy)) {
            throw new Error("run ledger execution policy changed for an active run");
        }
        if (currentPolicy)
            return current;
        return {
            ...current,
            updatedAt: nowIso(),
            sourcePack: { ...current.sourcePack, executionPolicy },
        };
    });
}
export function ensureRunLedger(root, sourcePack) {
    const existing = readRunLedger(root);
    if (existing) {
        const merged = mergeCompatibleSourcePack(existing, sourcePack);
        return merged === existing
            ? existing
            : mutateLedger(root, (current) => mergeCompatibleSourcePack(current, sourcePack));
    }
    const release = acquireLock(root);
    try {
        const raced = readRunLedger(root);
        if (raced) {
            const merged = mergeCompatibleSourcePack(raced, sourcePack);
            if (merged !== raced)
                writeLedger(root, merged);
            return merged;
        }
        const at = nowIso();
        const created = {
            schemaVersion: 1,
            runId: crypto.randomUUID(),
            createdAt: at,
            updatedAt: at,
            sourcePack,
            facts: [],
        };
        writeLedger(root, created);
        return created;
    }
    finally {
        release();
    }
}
function appendFact(root, fact) {
    return mutateLedger(root, (current) => {
        if (current.facts.some((item) => item.factId === fact.factId))
            return current;
        return { ...current, updatedAt: fact.at, facts: [...current.facts, fact] };
    });
}
export function recordReferenceChunk(root, context, input) {
    const payload = { ...input, contextEpochId: context.contextEpochId };
    appendFact(root, {
        type: "reference.chunk-returned",
        factId: factId("reference.chunk-returned", payload),
        at: nowIso(),
        ...payload,
    });
}
export function recordTodo(root, context, items) {
    const pagePlan = parseCanonicalPagePlan(items);
    const ledger = readRunLedger(root);
    if (!ledger)
        throw new Error("run ledger is not initialized");
    const pageIds = pagePlan.map((item) => item.pageId);
    const payload = {
        contextEpochId: context.contextEpochId,
        todoSha256: stableSha256(pagePlan),
        itemCount: pagePlan.length,
        ...(pageIds.length ? { pageIds } : {}),
        pagePlan,
    };
    appendFact(root, {
        type: "todo.committed",
        factId: factId("todo.committed", payload),
        at: nowIso(),
        ...payload,
    });
    return pagePlan;
}
function latestPageFacts(ledger) {
    const pages = new Map();
    for (const fact of ledger.facts) {
        if (fact.type === "page.revision-committed")
            pages.set(fact.pageId, fact);
    }
    return pages;
}
export function recordPageRevision(root, context, pageId, page) {
    const ledger = readRunLedger(root);
    if (!ledger)
        throw new Error("run ledger is not initialized");
    const current = latestPageFacts(ledger).get(pageId);
    const pageSha256 = stableSha256(page);
    if (current?.pageSha256 === pageSha256) {
        const lastReview = [...ledger.facts]
            .reverse()
            .find((fact) => fact.type === "page.visual-review-recorded" &&
            fact.pageId === pageId &&
            fact.revision === current.revision &&
            fact.pageSha256 === pageSha256);
        if (lastReview?.verdict === "revise") {
            throw new Error(`${pageId} must change after a revise review`);
        }
        return current;
    }
    const payload = {
        contextEpochId: context.contextEpochId,
        pageId,
        revision: (current?.revision ?? 0) + 1,
        pageSha256,
    };
    const fact = {
        type: "page.revision-committed",
        factId: factId("page.revision-committed", payload),
        at: nowIso(),
        ...payload,
    };
    appendFact(root, fact);
    return fact;
}
export function currentPageRevision(root, pageId) {
    const ledger = readRunLedger(root);
    if (!ledger)
        return undefined;
    const pages = latestPageFacts(ledger);
    return pages.get(pageId) ?? pages.get(persistPageKey(pageId));
}
/**
 * Authorize one editor-originated Agent rewrite of an exact page revision.
 * The grant is deliberately short-lived and revision-bound: after the first
 * successful write changes the revision, the same grant cannot unlock another
 * write. Generation-time repaint protection therefore remains intact.
 */
export function authorizePageEdits(root, inputs) {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 64) {
        throw new Error("editor edit pages must contain between 1 and 64 exact page revisions");
    }
    const ids = new Set();
    const normalized = inputs.map((input) => {
        const authorizationId = input.authorizationId.trim();
        const pageId = input.pageId.trim();
        if (!authorizationId || authorizationId.length > 200) {
            throw new Error("editor edit authorizationId is required and must be at most 200 characters");
        }
        if (!pageId || !Number.isSafeInteger(input.revision) || input.revision < 1) {
            throw new Error("editor edit pageId and revision are required");
        }
        if (ids.has(pageId))
            throw new Error(`editor edit page is duplicated: ${pageId}`);
        ids.add(pageId);
        if (!/^[a-f0-9]{64}$/.test(input.pageSha256)) {
            throw new Error("editor edit pageSha256 must be the current 64-character sha256");
        }
        return { ...input, authorizationId, pageId };
    });
    let committed = [];
    mutateLedger(root, (ledger) => {
        const pages = latestPageFacts(ledger);
        const at = nowIso();
        const facts = normalized.map((input) => {
            const current = pages.get(input.pageId);
            if (!current ||
                current.revision !== input.revision ||
                current.pageSha256 !== input.pageSha256) {
                throw new Error(`${input.pageId} changed before the editor Agent turn started`);
            }
            const ttlMs = Math.min(15 * 60_000, Math.max(30_000, input.ttlMs ?? 10 * 60_000));
            const payload = {
                authorizationId: input.authorizationId,
                source: "editor-agent",
                pageId: input.pageId,
                revision: current.revision,
                pageSha256: current.pageSha256,
                expiresAt: new Date(Date.now() + ttlMs).toISOString(),
            };
            return {
                type: "page.edit-authorized",
                factId: factId("page.edit-authorized", payload),
                at,
                ...payload,
            };
        });
        committed = facts;
        const newFacts = facts.filter((fact) => !ledger.facts.some((existing) => existing.factId === fact.factId));
        return newFacts.length
            ? { ...ledger, updatedAt: at, facts: [...ledger.facts, ...newFacts] }
            : ledger;
    });
    return committed;
}
export function authorizePageEdit(root, input) {
    return authorizePageEdits(root, [input])[0];
}
function structuralPassLockReason(pageId, revision) {
    return (`${pageId} revision ${revision} already has a structural review pass. ` +
        "Do not rewrite or append to this page. Move to the next committed todo page. " +
        "A later write is allowed only when review_pages names this page as failing, or review_page explicitly returns revise for this current revision.");
}
function namesPageForRepair(pageId, issues) {
    return issues.some((issue) => issue === pageId || issue.startsWith(`${pageId}:`) || issue.includes(`[${pageId}]`));
}
function classifyPageRewrite(root, pageId) {
    const ledger = readRunLedger(root);
    const current = ledger ? latestPageFacts(ledger).get(pageId) : undefined;
    if (!ledger || !current)
        return { state: "no-revision" };
    const raster = [...ledger.facts]
        .reverse()
        .find((fact) => fact.type === "page.raster-committed" &&
        fact.pageId === current.pageId &&
        fact.revision === current.revision &&
        fact.pageSha256 === current.pageSha256 &&
        fact.layoutGateVersion === RENDERED_LAYOUT_GATE_VERSION);
    if (!raster || raster.layoutStatus !== "pass") {
        return {
            state: "layout-open",
            revision: current.revision,
            reason: raster
                ? `current deterministic layout is ${raster.layoutStatus}`
                : "current revision has no deterministic raster",
        };
    }
    const editorAuthorization = [...ledger.facts]
        .reverse()
        .find((fact) => fact.type === "page.edit-authorized" &&
        fact.source === "editor-agent" &&
        fact.pageId === current.pageId &&
        fact.revision === current.revision &&
        fact.pageSha256 === current.pageSha256 &&
        Date.parse(fact.expiresAt) > Date.now());
    if (editorAuthorization) {
        return {
            state: "editor-auth",
            revision: current.revision,
            authorizationId: editorAuthorization.authorizationId,
        };
    }
    const pageReview = [...ledger.facts]
        .reverse()
        .find((fact) => fact.type === "page.visual-review-recorded" &&
        fact.pageId === current.pageId &&
        fact.revision === current.revision &&
        fact.pageSha256 === current.pageSha256 &&
        fact.rasterSha256 === raster.rasterSha256);
    if (pageReview?.verdict === "revise") {
        return { state: "visual-revise", revision: current.revision };
    }
    const snapshot = currentRevisionSnapshot(ledger);
    const structuralFail = [...ledger.facts]
        .reverse()
        .find((fact) => fact.type === "deck.structural-review-recorded" &&
        fact.reviewGateVersion === STRUCTURAL_REVIEW_GATE_VERSION &&
        !fact.ok &&
        sameRevisionSnapshot(fact.pageRevisions, snapshot));
    if (structuralFail && namesPageForRepair(current.pageId, structuralFail.issues)) {
        return { state: "structural-fail", revision: current.revision };
    }
    const structuralPass = [...ledger.facts]
        .reverse()
        .find((fact) => fact.type === "deck.structural-review-recorded" &&
        fact.reviewGateVersion === STRUCTURAL_REVIEW_GATE_VERSION &&
        fact.ok &&
        sameRevisionSnapshot(fact.pageRevisions, snapshot) &&
        fact.pageRevisions[current.pageId] === current.pageSha256);
    if (structuralPass) {
        return { state: "structural-pass", revision: current.revision };
    }
    return { state: "open", revision: current.revision };
}
function gateFromRewriteLifecycle(pageId, life) {
    switch (life.state) {
        case "no-revision":
            return { allowed: true, pageId, reason: "page has no committed revision" };
        case "layout-open":
            return { allowed: true, pageId, revision: life.revision, reason: life.reason };
        case "editor-auth":
            return {
                allowed: true,
                pageId,
                revision: life.revision,
                reason: `editor Agent edit ${life.authorizationId} authorized this exact revision`,
            };
        case "visual-revise":
            return {
                allowed: true,
                pageId,
                revision: life.revision,
                reason: "current image review explicitly requires revision",
            };
        case "structural-fail":
            return {
                allowed: true,
                pageId,
                revision: life.revision,
                reason: "current structural review explicitly names this page for repair",
            };
        case "structural-pass":
            return {
                allowed: false,
                pageId,
                revision: life.revision,
                reason: structuralPassLockReason(pageId, life.revision),
            };
        case "open":
            return {
                allowed: true,
                pageId,
                revision: life.revision,
                reason: "current revision has no structural review pass",
            };
    }
}
export function pageRewriteGate(root, pageId) {
    return gateFromRewriteLifecycle(pageId, classifyPageRewrite(root, pageId));
}
export function recordRaster(root, page, input) {
    const rasterSha256 = bytesSha256(input.bytes);
    const payload = {
        pageId: page.pageId,
        revision: page.revision,
        pageSha256: page.pageSha256,
        rasterSha256,
        src: input.src,
        width: input.width,
        height: input.height,
        layoutGateVersion: RENDERED_LAYOUT_GATE_VERSION,
        layoutStatus: input.layoutStatus,
        layoutIssues: input.layoutIssues,
    };
    const fact = {
        type: "page.raster-committed",
        factId: factId("page.raster-committed", payload),
        at: nowIso(),
        ...payload,
    };
    appendFact(root, fact);
    return { fact, deliveryToken: crypto.randomUUID() };
}
export function recordImagePrepared(root, context, raster, deliveryToken) {
    const payload = {
        contextEpochId: context.contextEpochId,
        pageId: raster.pageId,
        revision: raster.revision,
        pageSha256: raster.pageSha256,
        rasterSha256: raster.rasterSha256,
        deliveryToken,
    };
    const fact = {
        type: "page.image-result-prepared",
        factId: factId("page.image-result-prepared", payload),
        at: nowIso(),
        ...payload,
    };
    appendFact(root, fact);
    return fact;
}
export function recordImageEmitted(root, context, deliveryToken) {
    const ledger = readRunLedger(root);
    if (!ledger)
        throw new Error("run ledger is not initialized");
    const prepared = [...ledger.facts]
        .reverse()
        .find((fact) => fact.type === "page.image-result-prepared" &&
        fact.deliveryToken === deliveryToken);
    if (!prepared)
        throw new Error("image delivery token is not prepared for this context epoch");
    const payload = {
        contextEpochId: context.contextEpochId,
        commandId: context.commandId,
        pageId: prepared.pageId,
        revision: prepared.revision,
        pageSha256: prepared.pageSha256,
        rasterSha256: prepared.rasterSha256,
        deliveryToken,
    };
    const fact = {
        type: "page.image-content-emitted",
        factId: factId("page.image-content-emitted", payload),
        at: nowIso(),
        ...payload,
    };
    appendFact(root, fact);
    return fact;
}
export function recordVisualReview(root, context, input, env = process.env) {
    if (inspectProjectCapabilities(root, env).vision.mode === "none") {
        throw new Error("review_page cannot claim a visual pass: no vision reviewer is configured and MiniMax text did not see the page raster. Do not send verdict=pass.");
    }
    const realIssues = input.issues.filter((issue) => !isPlaceholderReviewIssue(issue));
    if (input.verdict === "pass" && input.issues.some((issue) => isPlaceholderReviewIssue(issue))) {
        throw new Error('review_page cannot pass with issues:["none"] — that is not pixel proof. MiniMax text has not seen the raster.');
    }
    if (input.verdict === "pass" && realIssues.length) {
        throw new Error(`a passing page review cannot contain unresolved issues: ${realIssues.join("; ")}. Fix them and render again, or send verdict=revise.`);
    }
    if (input.verdict === "revise" && !realIssues.length) {
        throw new Error("a revise page review must name at least one issue");
    }
    const ledger = readRunLedger(root);
    if (!ledger)
        throw new Error("run ledger is not initialized");
    const current = latestPageFacts(ledger).get(input.pageId);
    if (!current || current.revision !== input.revision) {
        throw new Error("page review targets a stale page revision");
    }
    const emitted = [...ledger.facts]
        .reverse()
        .find((fact) => fact.type === "page.image-content-emitted" &&
        fact.pageId === input.pageId &&
        fact.revision === input.revision &&
        fact.pageSha256 === current.pageSha256 &&
        fact.deliveryToken === input.deliveryToken);
    if (!emitted) {
        throw new Error(`page image was not emitted for ${input.pageId} revision ${input.revision} with that delivery token. ` +
            "Call render_page for this page again, wait for the successful image result, and copy its exact full DELIVERY_TOKEN.");
    }
    const raster = [...ledger.facts]
        .reverse()
        .find((fact) => fact.type === "page.raster-committed" &&
        fact.pageId === input.pageId &&
        fact.revision === input.revision &&
        fact.pageSha256 === current.pageSha256 &&
        fact.rasterSha256 === emitted.rasterSha256 &&
        fact.layoutGateVersion === RENDERED_LAYOUT_GATE_VERSION);
    if (!raster)
        throw new Error("page review has no matching raster evidence");
    if (input.verdict === "pass" && raster.layoutStatus !== "pass") {
        const issues = raster.layoutIssues
            .map((issue) => `${issue.code}: ${issue.detail}`)
            .join("; ");
        throw new Error(`review_page cannot pass while rendered layout is ${raster.layoutStatus}: ${issues || "no trustworthy layout result"}. ` +
            "Record verdict=revise with these issues, rewrite the page, render it again, and review the new revision.");
    }
    if (input.verdict === "pass" && isCloserPage({ id: input.pageId })) {
        const project = loadProject(root);
        const last = project.pages.at(-1);
        if (last && !pageHasReadableCopy({ elements: last.page.elements })) {
            throw new Error("review_page cannot pass an empty closer — write_page a 结束页 with title, recap, and next-month ask, then render again");
        }
    }
    const payload = {
        contextEpochId: context.contextEpochId,
        pageId: current.pageId,
        revision: current.revision,
        pageSha256: current.pageSha256,
        rasterSha256: emitted.rasterSha256,
        deliveryToken: input.deliveryToken,
        verdict: input.verdict,
        issues: input.issues,
    };
    const fact = {
        type: "page.visual-review-recorded",
        factId: factId("page.visual-review-recorded", payload),
        at: nowIso(),
        ...payload,
    };
    appendFact(root, fact);
    return fact;
}
function currentRevisionSnapshot(ledger) {
    return Object.fromEntries([...latestPageFacts(ledger).values()]
        .sort((a, b) => a.pageId.localeCompare(b.pageId))
        .map((page) => [page.pageId, page.pageSha256]));
}
export function recordStructuralReview(root, ok, issues) {
    const ledger = readRunLedger(root);
    if (!ledger)
        throw new Error("run ledger is not initialized");
    const payload = {
        reviewGateVersion: STRUCTURAL_REVIEW_GATE_VERSION,
        pageRevisions: currentRevisionSnapshot(ledger),
        ok,
        issues,
    };
    const fact = {
        type: "deck.structural-review-recorded",
        factId: factId("deck.structural-review-recorded", payload),
        at: nowIso(),
        ...payload,
    };
    appendFact(root, fact);
    return fact;
}
function sameRevisionSnapshot(expected, actual) {
    return stableSha256(expected) === stableSha256(actual);
}
/** True when a vision reviewer is configured and a current page still lacks an image-backed pass. */
export function currentVisualReviewsMissing(root, pageCount, env = process.env) {
    if (pageCount < 1)
        return false;
    if (inspectProjectCapabilities(root, env).vision.mode === "none")
        return false;
    const inspection = inspectRunLedger(root, undefined, env);
    if (inspection.pages.length === 0)
        return true;
    return inspection.pages.some((page) => page.visualReview !== "pass");
}
function leftoverComposeBlockers(root) {
    if (!fs.existsSync(path.join(root, "deck.pptd")))
        return [];
    try {
        const seen = new Set();
        const blockers = [];
        for (const issue of composedPageLeftoverIssues(loadProject(root).pages)) {
            if (seen.has(issue.message))
                continue;
            seen.add(issue.message);
            blockers.push(issue.message);
        }
        return blockers;
    }
    catch (error) {
        // A manifest exists but cannot be read — that is a blocker, not "clean".
        return [`project unreadable: ${error instanceof Error ? error.message : String(error)}`];
    }
}
function yamlStructureBlockers(root) {
    const blockers = [];
    if (!fs.existsSync(path.join(root, "deck.pptd")))
        return blockers;
    try {
        const project = loadProject(root);
        const last = project.pages.at(-1);
        const lastBasename = last ? path.basename(last.path, ".page") : undefined;
        const diskPageCount = project.pages.length;
        const adoptedSourceIds = [];
        let designSystemId;
        try {
            const rec = JSON.parse(fs.readFileSync(path.join(root, "_agent", "runtime.json"), "utf8"));
            if (typeof rec.designSystemId === "string" && rec.designSystemId.trim()) {
                designSystemId = rec.designSystemId.trim();
            }
        }
        catch {
            designSystemId = undefined;
        }
        for (const row of listSourceReceipts(root)) {
            if (row.state === "adopted" || row.state === "executed")
                adoptedSourceIds.push(row.sourceId);
        }
        const packCtx = packColorWriteContextFrom({ designSystemId, adoptedSourceIds });
        for (const loaded of project.pages) {
            const page = {
                id: persistPageKey(loaded.path),
                pageType: loaded.page.pageType,
                elements: loaded.page.elements,
                background: loaded.page.background,
            };
            const ctx = {
                lastDiskBasename: lastBasename,
                diskPageCount,
                theme: project.presentation.theme,
                ...packCtx,
            };
            const err = writePageSchemaError(writePageSchemaIssues(page, ctx), page, ctx);
            if (err)
                blockers.push(`${page.id}: ${err.error}`);
        }
    }
    catch (error) {
        // A deck that exists but cannot be parsed is a blocker, not "no issues".
        blockers.push(`project unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return blockers;
}
function legacyExecutionPolicy(root) {
    const runtimePath = path.join(root, "_agent", "runtime.json");
    if (fs.existsSync(runtimePath)) {
        try {
            const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
            const strict = runtime.strictExecution === true;
            return {
                currentRenderedLayoutRequired: strict && typeof runtime.editorBaseUrl === "string" && runtime.editorBaseUrl.trim().length > 0,
                structuralReviewRequired: strict,
            };
        }
        catch {
            // A present but unreadable production runtime cannot safely opt out.
            return { currentRenderedLayoutRequired: true, structuralReviewRequired: true };
        }
    }
    const bindingPath = path.join(root, "_agent", "presentation-run.v1.json");
    if (!fs.existsSync(bindingPath)) {
        return { currentRenderedLayoutRequired: false, structuralReviewRequired: false };
    }
    try {
        const binding = JSON.parse(fs.readFileSync(bindingPath, "utf8"));
        const boundToEditor = typeof binding.editorBaseUrl === "string" && binding.editorBaseUrl.trim().length > 0;
        return {
            currentRenderedLayoutRequired: boundToEditor,
            structuralReviewRequired: true,
        };
    }
    catch {
        return { currentRenderedLayoutRequired: true, structuralReviewRequired: true };
    }
}
function executionPolicyFor(root, ledger) {
    return ledger.sourcePack.executionPolicy ?? legacyExecutionPolicy(root);
}
export function inspectRunLedger(root, contextEpochId, env = process.env, ledgerOverride) {
    const ledger = ledgerOverride ?? readRunLedger(root);
    if (!ledger) {
        return {
            initialized: false,
            contextEpochId: undefined,
            referencesComplete: false,
            missingReferenceChunks: [],
            todoCount: 0,
            pages: [],
            structuralReview: "missing",
            composeReady: false,
            composeBlockers: ["run ledger is not initialized"],
            composed: false,
        };
    }
    const epoch = contextEpochId ??
        [...ledger.facts]
            .reverse()
            .map((fact) => ("contextEpochId" in fact ? fact.contextEpochId : ""))
            .find((candidate) => Boolean(candidate)) ??
        "";
    const reads = new Set(ledger.facts
        .filter((fact) => fact.type === "reference.chunk-returned")
        .map((fact) => `${fact.sourceId}:${fact.fileSha256}:${fact.chunkIndex}:${fact.chunkSha256}`));
    const missingReferenceChunks = [];
    for (const requirement of ledger.sourcePack.requirements) {
        for (const chunkIndex of requirement.chunkIndexes) {
            const match = ledger.facts.some((fact) => fact.type === "reference.chunk-returned" &&
                (!epoch || fact.contextEpochId === epoch) &&
                fact.sourceId === requirement.sourceId &&
                fact.fileSha256 === requirement.fileSha256 &&
                fact.chunkIndex === chunkIndex &&
                reads.has(`${fact.sourceId}:${fact.fileSha256}:${fact.chunkIndex}:${fact.chunkSha256}`));
            if (!match)
                missingReferenceChunks.push({ sourceId: requirement.sourceId, chunkIndex });
        }
    }
    const todo = [...ledger.facts]
        .reverse()
        .find((fact) => fact.type === "todo.committed");
    const currentPages = latestPageFacts(ledger);
    const pages = [];
    for (const page of currentPages.values()) {
        const raster = [...ledger.facts]
            .reverse()
            .find((fact) => fact.type === "page.raster-committed" &&
            fact.pageId === page.pageId &&
            fact.revision === page.revision &&
            fact.pageSha256 === page.pageSha256 &&
            fact.layoutGateVersion === RENDERED_LAYOUT_GATE_VERSION);
        const emitted = raster
            ? [...ledger.facts]
                .reverse()
                .find((fact) => fact.type === "page.image-content-emitted" &&
                fact.pageId === page.pageId &&
                fact.revision === page.revision &&
                fact.pageSha256 === page.pageSha256 &&
                fact.rasterSha256 === raster.rasterSha256)
            : undefined;
        const review = emitted
            ? [...ledger.facts]
                .reverse()
                .find((fact) => fact.type === "page.visual-review-recorded" &&
                fact.pageId === page.pageId &&
                fact.revision === page.revision &&
                fact.pageSha256 === page.pageSha256 &&
                fact.rasterSha256 === raster?.rasterSha256)
            : undefined;
        pages.push({
            pageId: page.pageId,
            revision: page.revision,
            pageSha256: page.pageSha256,
            raster: Boolean(raster),
            imageEmitted: Boolean(emitted),
            visualReview: review?.verdict ?? "missing",
            layout: raster?.layoutStatus ?? "missing",
        });
    }
    pages.sort((a, b) => a.pageId.localeCompare(b.pageId));
    const revisionSnapshot = currentRevisionSnapshot(ledger);
    const structural = [...ledger.facts]
        .reverse()
        .find((fact) => fact.type === "deck.structural-review-recorded" &&
        fact.reviewGateVersion === STRUCTURAL_REVIEW_GATE_VERSION &&
        sameRevisionSnapshot(fact.pageRevisions, revisionSnapshot));
    const blockers = [];
    const capability = inspectProjectCapabilities(root, env);
    const claimVisual = capability.vision.mode !== "none";
    const executionPolicy = executionPolicyFor(root, ledger);
    const currentRenderedLayoutRequired = executionPolicy.currentRenderedLayoutRequired;
    // Source chunk reads are a kernel-agnostic preflight — they gate compose for
    // every model, including text-only ones that skip the image ceremony.
    if (missingReferenceChunks.length) {
        blockers.push(`${missingReferenceChunks.length} required source chunks unread`);
    }
    blockers.push(...yamlStructureBlockers(root));
    blockers.push(...leftoverComposeBlockers(root));
    for (const page of pages) {
        const raster = [...ledger.facts]
            .reverse()
            .find((fact) => fact.type === "page.raster-committed" &&
            fact.pageId === page.pageId &&
            fact.revision === page.revision &&
            fact.pageSha256 === page.pageSha256 &&
            fact.layoutGateVersion === RENDERED_LAYOUT_GATE_VERSION);
        const layout = raster?.layoutStatus ?? "missing";
        if (renderedLayoutBlocksCompose(layout, currentRenderedLayoutRequired)) {
            const codes = (raster?.layoutIssues ?? [])
                .filter((issue) => issue.severity === "error")
                .map((issue) => issue.code);
            const extra = codes.length ? ` (${codes.join(",")})` : "";
            const required = currentRenderedLayoutRequired && layout !== "fail"
                ? " (current deterministic raster pass required)"
                : "";
            blockers.push(`${page.pageId}: rendered layout ${layout}${extra}${required}`);
        }
    }
    // Plan coverage is kernel-agnostic: a text-only model still owes an explicit
    // todo and every planned page on disk. Only the image-delivery and visual
    // review ceremony is excused when the model cannot see images.
    if (!todo)
        blockers.push("write_todo missing");
    if (todo) {
        const planned = Array.isArray(todo.pageIds) && todo.pageIds.length
            ? todo.pageIds.map((pageId) => persistPageKey(pageId)).filter((key) => key.length > 0)
            : undefined;
        if (planned) {
            const current = pages.map((page) => persistPageKey(page.pageId));
            const missing = planned.filter((key) => !current.includes(key));
            const extra = current.filter((key) => !planned.includes(key));
            if (missing.length)
                blockers.push(`todo missing pages: ${missing.join(",")}`);
            if (extra.length)
                blockers.push(`pages not in todo: ${extra.join(",")}`);
        }
        else if (pages.length !== todo.itemCount) {
            blockers.push(`todo has ${todo.itemCount} pages but ${pages.length} current page revisions exist`);
        }
    }
    if (claimVisual) {
        for (const page of pages) {
            if (!page.imageEmitted)
                blockers.push(`${page.pageId}: image content not emitted to the model`);
            if (page.visualReview !== "pass")
                blockers.push(`${page.pageId}: visual review ${page.visualReview}`);
        }
    }
    if (executionPolicy.structuralReviewRequired) {
        if (!structural)
            blockers.push("current structural review missing");
        else if (!structural.ok)
            blockers.push("current structural review failed");
    }
    if (hostedResearchNeedsWebSearchReceipt(inspectProjectCapabilities(root, env).research) &&
        !ledgerHasSuccessfulWebSearch(ledger)) {
        blockers.push(MISSING_HOSTED_WEB_SEARCH_RECEIPT);
    }
    const composedFact = [...ledger.facts]
        .reverse()
        .find((fact) => fact.type === "deck.composed" &&
        (!epoch || fact.contextEpochId === epoch) &&
        sameRevisionSnapshot(fact.pageRevisions, revisionSnapshot));
    return {
        initialized: true,
        contextEpochId: epoch || undefined,
        referencesComplete: missingReferenceChunks.length === 0,
        missingReferenceChunks,
        todoCount: todo?.itemCount ?? 0,
        pages,
        structuralReview: structural ? (structural.ok ? "pass" : "fail") : "missing",
        composeReady: blockers.length === 0,
        composeBlockers: blockers,
        composed: Boolean(composedFact),
    };
}
export function requireReferencesComplete(root, contextEpochId) {
    const status = inspectRunLedger(root, contextEpochId);
    if (status.referencesComplete)
        return;
    const list = status.missingReferenceChunks
        .slice(0, 12)
        .map((item) => `${item.sourceId}#${item.chunkIndex}`)
        .join(", ");
    throw new Error(`read_reference is incomplete for this context epoch: ${list}`);
}
export function readCommittedPagePlan(root) {
    const todo = readRunLedger(root)?.facts.filter((fact) => fact.type === "todo.committed").at(-1);
    try {
        return parseCanonicalPagePlan(todo?.pagePlan);
    }
    catch {
        throw new Error("write_todo must commit a complete page plan before write_page; legacy ID-only plans require replan");
    }
}
export function requireTodo(root) {
    readCommittedPagePlan(root);
}
export function requireComposeReady(root, contextEpochId, env = process.env) {
    const status = inspectRunLedger(root, contextEpochId, env);
    if (!status.composeReady)
        throw new Error(`compose gate failed: ${status.composeBlockers.join("; ")}`);
    return status;
}
export function recordWebSearchExecuted(root, context, input) {
    const queries = [...new Set(input.queries.map((item) => item.trim()).filter(Boolean))];
    const payload = {
        contextEpochId: context.contextEpochId,
        commandId: context.commandId,
        queries,
        factCount: input.factCount,
        source: "pi-xai-hosted",
        ok: true,
    };
    const fact = {
        type: "web-search.executed",
        factId: factId("web-search.executed", payload),
        at: nowIso(),
        ...payload,
    };
    appendFact(root, fact);
    return fact;
}
export function recordCompose(root, context, title) {
    requireComposeReady(root, context.contextEpochId);
    const ledger = readRunLedger(root);
    if (!ledger)
        throw new Error("run ledger is not initialized");
    const pageRevisions = currentRevisionSnapshot(ledger);
    const payload = {
        contextEpochId: context.contextEpochId,
        title,
        deckSha256: stableSha256({ title, pageRevisions }),
        pageRevisions,
    };
    const fact = {
        type: "deck.composed",
        factId: factId("deck.composed", payload),
        at: nowIso(),
        ...payload,
    };
    appendFact(root, fact);
    return fact;
}
export function recordExportSucceeded(root, context, input) {
    const payload = {
        contextEpochId: context.contextEpochId,
        ...input,
    };
    const fact = {
        type: "export.succeeded",
        factId: factId("export.succeeded", payload),
        at: nowIso(),
        ...payload,
    };
    appendFact(root, fact);
    return fact;
}
export function contextFromToolArgs(args) {
    const meta = asRecord(args.__openSlideStudio);
    const commandId = typeof meta?.commandId === "string" ? meta.commandId.trim() : "";
    const contextEpochId = typeof meta?.contextEpochId === "string" ? meta.contextEpochId.trim() : "";
    if (!commandId || !contextEpochId) {
        throw new Error("agent execution context is missing");
    }
    const clean = { ...args };
    delete clean.__openSlideStudio;
    return { context: { commandId, contextEpochId }, args: clean };
}
//# sourceMappingURL=run-ledger.js.map