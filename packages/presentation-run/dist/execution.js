import { parseCanonicalPagePlan } from "./domain/page-plan.js";
/** Pure projection over supplied observations. No filesystem, clock, environment, or writes. */
export function projectExecution(input) {
    const { ledger, identity, inspection } = input;
    const blockers = [];
    const add = (code, detail, pageIds, next) => {
        blockers.push({ code, detail, pageIds: [...pageIds], next });
    };
    const latestTodo = ledger?.facts.filter((fact) => fact.type === "todo.committed").at(-1);
    let plan = { kind: "missing" };
    if (latestTodo) {
        try {
            plan = { kind: "complete", pages: parseCanonicalPagePlan(latestTodo.pagePlan) };
        }
        catch {
            plan = { kind: "legacy-incomplete" };
        }
    }
    const identityBlocked = identity.kind !== "resolved";
    if (identity.kind === "unreadable")
        add("project_unreadable", identity.detail, [], null);
    if (identity.kind === "collision") {
        add("identity_collision", identity.conflicts.map((item) => `${item.key}: ${item.paths.join(", ")}`).join("; "), identity.conflicts.map((item) => item.key), null);
    }
    if (!inspection.referencesComplete && inspection.missingReferenceChunks.length) {
        add("missing_references", `${inspection.missingReferenceChunks.length} required reference chunks remain unread in this context`, [], "read_reference");
    }
    if (plan.kind !== "complete") {
        add(plan.kind === "missing" ? "missing_plan" : "legacy_incomplete_plan", "Commit an explicit complete ordered page plan; legacy or absent metadata is not a complete plan", [], "commit_design");
    }
    if (plan.kind === "complete" && identity.kind === "resolved") {
        const ids = plan.pages.map((page) => page.pageId);
        const missing = ids.filter((id) => !identity.pages.has(id));
        const extra = [...identity.pages.keys()].filter((id) => !ids.includes(id));
        if (missing.length)
            add("missing_pages", "Planned pages are not yet written", missing, "write_page");
        if (extra.length)
            add("extra_pages", "Current document pages are not represented in the plan", extra, "write_todo");
        if (!missing.length && !extra.length) {
            for (const id of ids) {
                const evidence = inspection.pages.find((page) => page.pageId === id);
                if (!evidence || !evidence.raster || evidence.layout === "missing" || evidence.layout === "unavailable") {
                    add("page_render_needed", "A current deterministic page render/layout result is required", [id], "render_page");
                }
                else if (evidence.layout !== "pass") {
                    add("page_needs_revision", "Current rendered layout failed", [id], "write_page");
                }
                if (input.capability.vision.mode === "main-model") {
                    if (!evidence?.imageEmitted)
                        add("page_image_needed", "The current page image must actually be delivered to the image-capable model", [id], "render_page");
                    else if (evidence.visualReview === "revise")
                        add("page_needs_revision", "The current visual review requires revision", [id], "write_page");
                    else if (evidence.visualReview !== "pass")
                        add("page_visual_review_needed", "Review the current delivered image", [id], "review_page");
                }
            }
            if (inspection.structuralReview !== "pass")
                add("structural_review_needed", "A passing current structural review is required", ids, "review_pages");
            if (!blockers.length && !inspection.composeReady) {
                add("compose_blocked", inspection.composeBlockers.join("; ") || "Current domain compose gates are not satisfied", [], null);
            }
            if (!blockers.length && !inspection.composed)
                add("compose_needed", "Compose the current reviewed document", ids, "compose_deck");
            if (!blockers.length && inspection.composed && !input.verifiedDelivery)
                add("export_needed", "Export the current composed document", [], "export_deck");
        }
    }
    const activityKnown = typeof input.agentBusy === "boolean";
    if (!activityKnown)
        add("activity_unknown", "The Host has not supplied authoritative live Agent activity", [], null);
    const fault = input.terminalFault && (!input.currentAttemptId || !input.terminalFault.attemptId || input.terminalFault.attemptId === input.currentAttemptId)
        ? input.terminalFault : undefined;
    let kind;
    // Fault codes written by the Host (agent-fault.ts): provider-*/operator-stop/
    // bounded-guard codes all pause the run; anything else is a failed attempt.
    // Legacy snake_case codes are kept so pre-rename fault files still project.
    const PAUSED_FAULT_CODES = new Set([
        "provider-quota",
        "provider-auth",
        "provider-token-plan",
        "provider-rate-limit",
        "provider-unavailable",
        "operator-stop",
        "host-interrupted",
        "tool-invalid-args-loop",
        "repeated-invalid-args",
        "repeated-business-rejection",
        "planning-no-progress-budget",
        "production-no-progress-budget",
        "rate_limit",
        "quota_exhausted",
        "operator_stop",
    ]);
    // A verified delivery survives a late turn fault (e.g. the model's closing
    // message fails after export_deck): the artifact is current, so the run is
    // delivered and the fault stays visible on the turn row instead of reopening
    // a resumable failure that would just fault again.
    const delivered = !blockers.length && Boolean(input.verifiedDelivery) && input.agentBusy === false;
    if (fault && !delivered)
        kind = fault.phase === "paused" || PAUSED_FAULT_CODES.has(fault.code ?? "") ? "paused" : "failed";
    else if (identityBlocked || !activityKnown)
        kind = "blocked";
    else if (delivered)
        kind = "delivered";
    else if (input.exporting)
        kind = "exporting";
    else if (plan.kind !== "complete")
        kind = "planning";
    else if (blockers.some((item) => ["missing_pages", "extra_pages"].includes(item.code)))
        kind = "authoring";
    else if (blockers.some((item) => item.code.startsWith("page_") || item.code === "structural_review_needed"))
        kind = "reviewing";
    else if (blockers[0]?.code === "compose_needed")
        kind = "ready-to-compose";
    else if (blockers[0]?.code === "export_needed")
        kind = "ready-to-export";
    else
        kind = blockers.length ? "blocked" : "authoring";
    let recovery;
    if (kind === "delivered")
        recovery = { kind: "none" };
    else if (input.agentBusy === true || input.retryScheduled)
        recovery = { kind: "wait-or-stop" };
    else if (!activityKnown || identityBlocked || fault?.recoverable === false)
        recovery = { kind: "resolve", reason: fault?.message ?? blockers[0]?.detail };
    else
        recovery = { kind: "continue", reason: fault?.message ?? blockers[0]?.detail };
    const delivery = kind === "delivered" ? input.verifiedDelivery : undefined;
    return {
        status: { kind, ...(delivery ? { delivery } : {}) }, blockers, plan, recovery,
        next: blockers[0]?.next ?? null,
        attemptId: input.currentAttemptId ?? fault?.attemptId ?? null,
        model: {
            provider: input.binding?.provider?.providerId ?? "unknown", model: input.binding?.provider?.modelId ?? "unknown",
            ...(input.binding?.provider?.reasoningEffort ? { reasoningEffort: input.binding.provider.reasoningEffort } : {}),
        },
        ...(delivery ? { delivery } : {}),
    };
}
//# sourceMappingURL=execution.js.map