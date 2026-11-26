import { latestPageFacts } from "./page-revision-ledger.js";
import {
  factId,
  mutateLedger,
  nowIso,
  readRunLedger,
  type PageEditAuthorizationFact,
  type PageEditAuthorizationInput,
} from "./run-ledger.js";

function editRefusal(message: string, code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...extra });
}

export function authorizePageEdits(
  root: string,
  inputs: readonly PageEditAuthorizationInput[],
): readonly PageEditAuthorizationFact[] {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 64) {
    throw new Error("editor edit pages must contain between 1 and 64 exact page revisions");
  }
  const ids = new Set<string>();
  const normalized = inputs.map((input) => {
    const authorizationId = input.authorizationId.trim();
    const pageId = input.pageId.trim();
    if (!authorizationId || authorizationId.length > 200) {
      throw new Error("editor edit authorizationId is required and must be at most 200 characters");
    }
    if (!pageId || !Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new Error("editor edit pageId and revision are required");
    }
    if (ids.has(pageId)) throw new Error(`editor edit page is duplicated: ${pageId}`);
    ids.add(pageId);
    if (!/^[a-f0-9]{64}$/.test(input.pageSha256)) {
      throw new Error("editor edit pageSha256 must be the current 64-character sha256");
    }
    return { ...input, authorizationId, pageId };
  });
  if (!readRunLedger(root)) {
    throw editRefusal("the run ledger is not initialized before the editor Agent turn", "EDIT_PAGE_LEDGER_MISSING");
  }
  let committed: readonly PageEditAuthorizationFact[] = [];
  mutateLedger(root, (ledger) => {
    const pages = latestPageFacts(ledger);
    const at = nowIso();
    const facts = normalized.map((input) => {
      const current = pages.get(input.pageId);
      if (!current) {
        throw editRefusal(
          `${input.pageId} has no committed page revision before the editor Agent turn started`,
          "EDIT_PAGE_LEDGER_MISSING",
          { pageId: input.pageId },
        );
      }
      if (current.revision !== input.revision) {
        throw editRefusal(
          `${input.pageId} changed before the editor Agent turn started (revision ${input.revision} is not current ${current.revision})`,
          "EDIT_PAGE_REVISION_STALE",
          { pageId: input.pageId },
        );
      }
      if (current.pageSha256 !== input.pageSha256) {
        throw editRefusal(
          `${input.pageId} content changed before the editor Agent turn started (pageSha256 does not match the current revision)`,
          "EDIT_PAGE_SHA_STALE",
          { pageId: input.pageId },
        );
      }
      const ttlMs = Math.min(15 * 60_000, Math.max(30_000, input.ttlMs ?? 10 * 60_000));
      const payload = {
        authorizationId: input.authorizationId,
        source: "editor-agent" as const,
        pageId: input.pageId,
        revision: current.revision,
        pageSha256: current.pageSha256,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      };
      return {
        type: "page.edit-authorized" as const,
        factId: factId("page.edit-authorized", payload),
        at,
        ...payload,
      };
    });
    committed = facts;
    const newFacts = facts.filter((fact) => !ledger.facts.some((existing) => existing.factId === fact.factId));
    return newFacts.length ? { ...ledger, updatedAt: at, facts: [...ledger.facts, ...newFacts] } : ledger;
  });
  return committed;
}

export function authorizePageEdit(root: string, input: PageEditAuthorizationInput): PageEditAuthorizationFact {
  return authorizePageEdits(root, [input])[0]!;
}
