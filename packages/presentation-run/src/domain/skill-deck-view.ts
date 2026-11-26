/**
 * Plan and timeline view of a skill deck (skillToCompose) and the page file name compose uses.
 * Moved out of skill-pages.ts unchanged; the disk SSOT stays the PPTD pages.
 */
import type { ChartElement, PptdElement, TextElement } from "@open-slidestudio/pptd-v2";
import type { ComposeDeck, ComposePage, ComposeRole } from "./compose-ir.js";
import type { SkillDeckInput, SkillPageInput } from "./skill-pages.js";

const ROLES: ComposeRole[] = ["cover", "toc", "content", "evidence", "timeline", "matrix", "close"];

export function textOf(el: PptdElement): string | undefined {
  if (el.elementType !== "text") return undefined;
  const content = (el as TextElement).content;
  return content?.text?.trim() || undefined;
}

function pageTitle(page: SkillPageInput): string {
  for (const el of page.elements) {
    const text = textOf(el);
    if (text) return text.slice(0, 80);
  }
  return page.id;
}

function pageRole(page: SkillPageInput, index: number, last: number): ComposeRole {
  const raw = (page.pageType || "").toLowerCase();
  if (ROLES.includes(raw as ComposeRole)) return raw as ComposeRole;
  if (index === 0) return "cover";
  if (index === last) return "close";
  if (page.elements.some((el) => el.elementType === "chart" || el.elementType === "table")) {
    return "evidence";
  }
  return "content";
}

/** Plan/timeline view of a skill deck. Disk SSOT is still the PPTD pages. */
export function skillToCompose(deck: SkillDeckInput): ComposeDeck {
  const last = Math.max(0, deck.pages.length - 1);
  const pages: ComposePage[] = deck.pages.map((page, index) => {
    const texts = page.elements.map((el) => textOf(el)).filter((t): t is string => Boolean(t));
    const role = pageRole(page, index, last);
    const title = texts[0] ?? page.id;
    const rest = texts.slice(1);
    const chartEl = page.elements.find((el) => el.elementType === "chart") as ChartElement | undefined;
    return {
      role,
      title,
      bullets: role === "toc" ? undefined : rest.length ? rest : undefined,
      items: role === "toc" ? rest : undefined,
      chart: chartEl
        ? {
            title: typeof chartEl.title === "string" ? chartEl.title : title,
            cols: chartEl.data.cols,
            rows: chartEl.data.rows,
          }
        : undefined,
    };
  });
  return { title: deck.title.slice(0, 80), pages };
}

export function pageFileName(index: number, pageType?: string): string {
  const role = (pageType || "page").replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 24) || "page";
  return `pages/${String(index + 1).padStart(2, "0")}_${role}.page`;
}
