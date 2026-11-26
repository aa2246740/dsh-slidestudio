export type BlockingPage = Readonly<{ pageId: string; reason: string }>;
export type CompactBlockers = Readonly<{
  blockingPages: readonly BlockingPage[];
  blockingIssues: readonly string[];
}>;

export const COMPOSE_REFUSAL_MAX_BYTES = 4096;

function shortReason(blocker: string): string {
  if (/版式已变更/.test(blocker)) return "版式已变更";
  if (/还没有定义记录/.test(blocker)) return "版式未定义";
  if (/版式 .+ 不存在/.test(blocker)) return "版式缺失";
  if (/rendered layout fail/i.test(blocker)) return "layout";
  if (/rendered layout|raster/i.test(blocker)) return "render";
  if (/image content/i.test(blocker)) return "image";
  if (/visual review.*revise/i.test(blocker)) return "review-revise";
  if (/visual review/i.test(blocker)) return "review";
  if (/missing_requested_exhibit|requires .* editable PPTD|exhibit/i.test(blocker)) return "exhibit";
  if (/pack_color|palette/i.test(blocker)) return "palette";
  if (/todo missing pages/i.test(blocker)) return "not-written";
  if (/pages not in todo/i.test(blocker)) return "not-planned";
  if (/structural review/i.test(blocker)) return "structure";
  if (/source chunks unread|reference/i.test(blocker)) return "references";
  if (/write_todo/i.test(blocker)) return "plan";
  return "content";
}

/** Replace verbose compose diagnostics with page identities and short reason codes. */
export function compactComposeBlockers(blockers: readonly string[], knownPageIds: readonly string[]): CompactBlockers {
  const reasons = new Map<string, Set<string>>();
  const globalReasons = new Set<string>();
  const orderedIds = [...new Set(knownPageIds)];
  const matchIds = [...orderedIds].sort((left, right) => right.length - left.length);
  const addPage = (pageId: string, reason: string) => {
    const existing = reasons.get(pageId) ?? new Set<string>();
    existing.add(reason);
    reasons.set(pageId, existing);
  };

  for (const blocker of blockers) {
    const missing = blocker.match(/^todo missing pages:\s*(.*)$/);
    const extra = blocker.match(/^pages not in todo:\s*(.*)$/);
    if (missing || extra) {
      const reason = missing ? "not-written" : "not-planned";
      for (const pageId of (missing?.[1] ?? extra?.[1] ?? "").split(",").filter(Boolean)) {
        addPage(pageId.trim(), reason);
      }
      continue;
    }
    const pageId = matchIds.find((candidate) => blocker.startsWith(`${candidate}:`));
    if (pageId) {
      addPage(pageId, shortReason(blocker));
      continue;
    }
    const explicitPage = blocker.match(/^([^:\n]{1,80}):\s/)?.[1]?.trim();
    if (explicitPage) addPage(explicitPage, shortReason(blocker));
    else globalReasons.add(shortReason(blocker));
  }

  const pageOrder = [...orderedIds, ...[...reasons.keys()].filter((pageId) => !orderedIds.includes(pageId))];
  return {
    blockingPages: pageOrder
      .filter((pageId) => reasons.has(pageId))
      .map((pageId) => ({
        pageId,
        reason: [...reasons.get(pageId)!].join("+"),
      })),
    blockingIssues: [...globalReasons],
  };
}

type ComposeRefusalReceipt = Readonly<{
  ok: boolean;
  name: string;
  summary: string;
  detail: string;
  payload: Record<string, unknown>;
}>;

/** Keep model-facing compose refusals within the contract byte limit. */
export function boundComposeRefusal<T extends ComposeRefusalReceipt>(receipt: T): T {
  const payload = { ...receipt.payload };
  const result = () => ({ ...receipt, payload }) as T;
  const bytes = () => Buffer.byteLength(JSON.stringify(result()), "utf8");

  const missingReferences = payload.missingReferenceChunks;
  if (bytes() > COMPOSE_REFUSAL_MAX_BYTES && Array.isArray(missingReferences)) {
    if (missingReferences.length === 0) delete payload.missingReferenceChunks;
    else {
      payload.missingReferenceChunkCount = missingReferences.length;
      payload.missingReferenceChunks = missingReferences.slice(0, 8);
      payload.missingReferenceChunksTruncated = missingReferences.length > 8;
      // Preserve every page id before reference samples; drop the sample first.
      if (bytes() > COMPOSE_REFUSAL_MAX_BYTES) {
        delete payload.missingReferenceChunks;
        payload.missingReferenceChunksTruncated = true;
      }
    }
  }
  if (bytes() <= COMPOSE_REFUSAL_MAX_BYTES) return result();

  const allPages = Array.isArray(payload.blockingPages) ? [...payload.blockingPages] : [];
  payload.blockingPages = [];
  payload.blockingPageCount = allPages.length;
  payload.blockingPagesTruncated = allPages.length > 0;
  for (const page of allPages) {
    (payload.blockingPages as unknown[]).push(page);
    if (bytes() > COMPOSE_REFUSAL_MAX_BYTES) {
      (payload.blockingPages as unknown[]).pop();
      break;
    }
  }
  if ((payload.blockingPages as unknown[]).length === allPages.length) {
    delete payload.blockingPageCount;
    delete payload.blockingPagesTruncated;
  }

  if (bytes() > COMPOSE_REFUSAL_MAX_BYTES) {
    delete payload.missingReferenceChunks;
    delete payload.blockingIssues;
    delete payload.recoveryHint;
    const pages = payload.blockingPages as unknown[];
    while (pages.length > 0 && bytes() > COMPOSE_REFUSAL_MAX_BYTES) pages.pop();
    if (pages.length < allPages.length) {
      payload.blockingPageCount = allPages.length;
      payload.blockingPagesTruncated = true;
    }
  }
  return result();
}
