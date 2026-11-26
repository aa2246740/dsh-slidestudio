/**
 * Playbook brain: open-kimi SKILL + design_system → valid PPTD v2.
 * Offline default is deterministic (no network). Optional LlmPort when configured.
 */
import type { PptdProject } from "@open-slidestudio/pptd-v2";
import { composeBodyRules, deterministicDeck, finalizeComposeDeck, type ComposeDeck } from "./compose-ir.js";
import type { LlmPort } from "./llm-port.js";
import { materializeDeck } from "./materialize.js";
import { applySkillDeck, parseSkillDeck, skillToCompose, type SkillDeckInput } from "./skill-pages.js";
import { DEFAULT_CATEGORY, DEFAULT_DESIGN_SYSTEM, loadPlaybook, type PlaybookBundle } from "./playbook.js";
import { planFromDeck, thinkAboutBrief, type ReasonBlock } from "./reason.js";

export type PlaybookBrainOptions = {
  skillRoot?: string;
  designSystemId?: string;
  categoryId?: string;
  llm?: LlmPort;
  /** Parsed reference attachments. Quote only; never invent beyond this text. */
  referenceText?: string;
};

export type PlaybookBrain = {
  kind: "playbook";
  playbook: PlaybookBundle;
  readonly usedLlm: boolean;
  think: (brief: string) => ReasonBlock;
  plan: (brief: string) => ReasonBlock | Promise<ReasonBlock>;
  compose: (brief: string, project: PptdProject) => void | Promise<void>;
};

function buildSystemPrompt(bundle: PlaybookBundle): string {
  return [
    "You compose an Open SlideStudio deck as JSON only.",
    "Prefer pages[].elements PPTD (text/shape/chart/table + bounds). role+bullets is fallback only.",
    "Disk format is YAML PPTD v2. Do not mention Kimi trademarks.",
    "Cover copy comes from the user brief (title / subtitle), never from the product name or design-system id.",
    "Do not invent statistics, citations, or customer cases. Mark placeholders.",
    "No rounded cards. Use lines, whitespace, and type hierarchy.",
    "Every body title is a complete assertion sentence when possible.",
    "",
    "## Skill excerpt (ignore any export/iframe instructions)",
    bundle.skillExcerpt,
    "",
    "## Category guide",
    bundle.categoryGuideExcerpt,
    "",
    "## Scenario",
    bundle.categoryMarkdown,
    "",
    "## Design system",
    bundle.designSystemId,
    bundle.designMarkdown,
    "",
    "## Output JSON schema",
    JSON.stringify({
      title: "string",
      pages: [
        {
          role: "cover|toc|content|evidence|timeline|matrix|close",
          title: "string",
          subtitle: "optional",
          chapter: "optional",
          bullets: ["required on content/close — 3 to 6 short lines"],
          items: ["required on toc — at least 3"],
          soWhat: "optional",
          note: "optional, required if chart is placeholder",
          chart: {
            title: "string",
            cols: ["项", "值"],
            rows: [["A", 1]],
            note: "optional",
          },
        },
      ],
    }),
    "Page count follows the brief (typically 4–10). Do not force a consulting skeleton.",
    "Title-only pages are invalid. Every toc/content/close page needs 3–6 short bullets or items.",
    "A classroom explainer is orientation → concept → remember → example → takeaway (6 pages).",
    "Do not add evidence/timeline/matrix/「下周动作」 unless the brief asks for a recap or decision.",
    "A recap/decision deck may add evidence, timeline, or matrix only when the brief or attachments call for them.",
    "Never invent statistics. Classroom 3-4-5 style numbers must be labeled as practice, not research.",
  ].join("\n");
}

function buildUserPrompt(brief: string, referenceText?: string): string {
  const parts = [`User brief:\n${brief}`];
  if (referenceText?.trim()) {
    parts.push("## 参考资料（只可引用，不可编造超出内容）");
    parts.push(referenceText.trim());
  }
  parts.push("Emit the JSON object now.");
  return parts.join("\n\n");
}

export function createPlaybookBrain(opts: PlaybookBrainOptions = {}): PlaybookBrain {
  const playbook = loadPlaybook({
    skillRoot: opts.skillRoot,
    designSystemId: opts.designSystemId ?? DEFAULT_DESIGN_SYSTEM,
    categoryId: opts.categoryId ?? DEFAULT_CATEGORY,
  });

  let usedLlm = false;
  let plannedDeck: ComposeDeck | undefined;
  let plannedSkill: SkillDeckInput | undefined;

  const apply = (deck: ComposeDeck, project: PptdProject) => {
    if (plannedSkill) {
      applySkillDeck(project, plannedSkill, playbook.palette);
      return;
    }
    materializeDeck(project, deck, playbook.palette);
  };

  const acceptRaw = (raw: unknown, brief: string): ComposeDeck => {
    const skill = parseSkillDeck(raw);
    if (skill && skill.pages.length >= composeBodyRules(brief, playbook.categoryId).minPages) {
      plannedSkill = skill;
      return skillToCompose(skill);
    }
    plannedSkill = undefined;
    return finalizeComposeDeck(raw, [], composeBodyRules(brief, playbook.categoryId));
  };

  const applyRaw = (raw: unknown, brief: string, project: PptdProject): ComposeDeck => {
    const deck = acceptRaw(raw, brief);
    apply(deck, project);
    return deck;
  };

  const fallbackDeck = (brief: string): ComposeDeck =>
    deterministicDeck(brief, playbook.designSystemId, opts.referenceText, playbook.categoryId);

  const planOffline = (brief: string): ReasonBlock => {
    plannedSkill = undefined;
    plannedDeck = fallbackDeck(brief);
    return planFromDeck(plannedDeck);
  };

  return {
    kind: "playbook",
    playbook,
    get usedLlm() {
      return usedLlm;
    },
    think(brief) {
      return thinkAboutBrief(brief, opts.referenceText);
    },
    plan(brief) {
      if (!opts.llm) return planOffline(brief);
      const llm = opts.llm;
      return (async () => {
        try {
          const raw = await llm.completeJson(buildSystemPrompt(playbook), buildUserPrompt(brief, opts.referenceText));
          plannedDeck = acceptRaw(raw, brief);
          usedLlm = true;
          return planFromDeck(plannedDeck);
        } catch {
          return planOffline(brief);
        }
      })();
    },
    compose(brief, project) {
      if (plannedDeck) {
        apply(plannedDeck, project);
        return;
      }
      if (!opts.llm) {
        apply(fallbackDeck(brief), project);
        return;
      }
      const llm = opts.llm;
      return (async () => {
        try {
          const raw = await llm.completeJson(buildSystemPrompt(playbook), buildUserPrompt(brief, opts.referenceText));
          plannedDeck = applyRaw(raw, brief, project);
          usedLlm = true;
        } catch {
          apply(fallbackDeck(brief), project);
        }
      })();
    },
  };
}
