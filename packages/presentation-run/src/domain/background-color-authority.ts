import fs from "node:fs";
import path from "node:path";
import { persistPageKey } from "./layout-qa.js";

export type BackgroundColorWriteAuthority = {
  readonly backgroundColorOverride?: true;
  readonly persistedBackgroundColor?: string;
};

export type BackgroundColorWriteAuthorityInput = {
  readonly projectRoot?: string;
  readonly pageId: string;
  readonly persistedBackgroundColor?: unknown;
  readonly includeActiveOverride?: boolean;
  readonly now?: number;
};

function activeBackgroundColorOverride(projectRoot: string, pageId: string, now: number): boolean {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "_agent", "ai-review-lock.v1.json"), "utf8"),
    ) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const expiresAt = typeof value.expiresAt === "number" ? value.expiresAt : Date.parse(String(value.expiresAt ?? ""));
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
    const scope = value.scope;
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false;
    const record = scope as Record<string, unknown>;
    const kind = String(record.kind ?? "");
    if (record.backgroundColorOverride !== true || !["page", "pages", "deck"].includes(kind)) {
      return false;
    }
    if (!Array.isArray(record.targetPageIds) || record.targetPageIds.length === 0) return false;
    const targetPageIds = record.targetPageIds.map((target) =>
      typeof target === "string" && target.trim() ? persistPageKey(target) : "",
    );
    if (targetPageIds.some((target) => !target) || new Set(targetPageIds).size !== targetPageIds.length) {
      return false;
    }
    if (kind === "page") {
      const scopedPageId = typeof record.pageId === "string" ? persistPageKey(record.pageId) : "";
      if (targetPageIds.length !== 1 || targetPageIds[0] !== scopedPageId) return false;
    }
    const key = persistPageKey(pageId);
    return Boolean(key) && targetPageIds.includes(key);
  } catch {
    return false;
  }
}

/**
 * Build the only pack-color exceptions a page write may receive.
 *
 * The active exception is project-local, expires with the editor lock, and is
 * limited to the lock's exact page set. A persisted solid background is a
 * baseline only: layout QA still compares the incoming canonical
 * `background.color` against it and does not extend the exception to elements.
 */
export function backgroundColorWriteAuthority({
  projectRoot,
  pageId,
  persistedBackgroundColor,
  includeActiveOverride = true,
  now = Date.now(),
}: BackgroundColorWriteAuthorityInput): BackgroundColorWriteAuthority {
  const authority: BackgroundColorWriteAuthority = {
    ...(typeof persistedBackgroundColor === "string" && persistedBackgroundColor.trim()
      ? { persistedBackgroundColor }
      : {}),
  };
  if (includeActiveOverride && projectRoot && activeBackgroundColorOverride(projectRoot, pageId, now)) {
    return { ...authority, backgroundColorOverride: true };
  }
  return authority;
}
