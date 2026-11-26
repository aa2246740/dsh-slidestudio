/** Structured deck IR the playbook brain (LLM or deterministic) must emit. */
import {
  minimumPageCount,
  pageCountDeliveryHint,
  pageCountRequirementFromBrief,
  type PageCountRequirement,
} from "./page-count-requirement.js";

export type ComposeRole = "cover" | "toc" | "content" | "evidence" | "timeline" | "matrix" | "close";

export type ComposeChart = {
  title: string;
  cols: string[];
  rows: (string | number | null)[][];
  note?: string;
};

export type ComposePage = {
  kicker?: string;
  role: ComposeRole;
  title: string;
  subtitle?: string;
  chapter?: string;
  bullets?: string[];
  items?: string[];
  soWhat?: string;
  chart?: ComposeChart;
  note?: string;
};

export type ComposeDeck = {
  title: string;
  pages: ComposePage[];
};

const ROLES: ComposeRole[] = ["cover", "toc", "content", "evidence", "timeline", "matrix", "close"];

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asStringList(v: unknown, max = 8): string[] | undefined {
  if (typeof v === "string" && v.trim()) {
    const parts = v
      .split(/\n+|；|;|。/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
    return parts.length ? parts.slice(0, max) : undefined;
  }
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string" && x.trim()) {
      out.push(x.trim());
      continue;
    }
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const t = o.text ?? o.title ?? o.item ?? o.point ?? o.body;
      if (typeof t === "string" && t.trim()) out.push(t.trim());
    }
  }
  return out.length ? out.slice(0, max) : undefined;
}

/** Models often put body copy in points/body/content instead of bullets. */
export function collectPageLines(p: Record<string, unknown>, max = 8): string[] | undefined {
  const keys = ["bullets", "items", "points", "body", "content", "lines", "texts", "paragraphs"];
  for (const key of keys) {
    if (key === "content" && typeof p.content === "string" && !p.content.includes("\n")) {
      continue;
    }
    const list = asStringList(p[key], max);
    if (list?.length) return list;
  }
  return undefined;
}

function asChart(v: unknown): ComposeChart | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const title = asString(o.title) ?? "示意";
  if (!Array.isArray(o.cols) || !Array.isArray(o.rows)) return undefined;
  const cols = o.cols.filter((c): c is string => typeof c === "string").slice(0, 6);
  if (cols.length < 2) return undefined;
  const rows: (string | number | null)[][] = [];
  for (const row of o.rows.slice(0, 8)) {
    if (!Array.isArray(row)) continue;
    rows.push(
      row.slice(0, cols.length).map((cell) => {
        if (typeof cell === "number" && Number.isFinite(cell)) return cell;
        if (typeof cell === "string") return cell;
        return null;
      }),
    );
  }
  if (!rows.length) return undefined;
  return { title, cols, rows, note: asString(o.note) };
}

export function parseComposeDeck(raw: unknown): ComposeDeck {
  if (!raw || typeof raw !== "object") {
    throw new Error("compose IR must be an object");
  }
  const o = raw as Record<string, unknown>;
  const title = asString(o.title);
  if (!title) throw new Error("compose IR.title required");
  if (!Array.isArray(o.pages) || o.pages.length < 1) {
    throw new Error("compose IR.pages must have at least 1 page");
  }
  const pages: ComposePage[] = [];
  for (const item of o.pages) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const role = asString(p.role) as ComposeRole | undefined;
    const pageTitle = asString(p.title);
    if (!role || !ROLES.includes(role) || !pageTitle) continue;
    const lines = collectPageLines(p, role === "toc" ? 10 : 8);
    const items = asStringList(p.items, 10) ?? (role === "toc" ? lines : undefined);
    const bullets = asStringList(p.bullets) ?? (role === "toc" ? undefined : lines);
    pages.push({
      role,
      title: pageTitle,
      kicker: asString(p.kicker),
      subtitle: asString(p.subtitle),
      chapter: asString(p.chapter),
      bullets,
      items,
      soWhat: asString(p.soWhat),
      chart: asChart(p.chart),
      note: asString(p.note),
    });
  }
  if (pages.length < 1) {
    throw new Error("compose IR produced no valid pages");
  }
  return { title: title.slice(0, 80), pages };
}

export type ComposeTodo = { title: string; note?: string };

function splitNote(note: string): string[] {
  return note
    .split(/\n+|；|;|。/)
    .map((s) => s.replace(/^[-·\d.\s]+/, "").trim())
    .filter((s) => s.length >= 4)
    .slice(0, 6);
}

/** If compose omitted or underfilled bodies, reuse write_todo notes. */
export function fillComposeFromTodos(deck: ComposeDeck, todos: ComposeTodo[]): ComposeDeck {
  if (!todos.length) return deck;
  return {
    ...deck,
    pages: deck.pages.map((p, i) => {
      const existing = [...(p.items ?? []), ...(p.bullets ?? [])];
      if (p.role === "cover" || p.chart || existing.length >= 3) return p;
      const todo =
        todos[i] ??
        todos.find(
          (t) =>
            (t.title && p.title.includes(t.title.slice(0, 6))) || (t.title && t.title.includes(p.title.slice(0, 6))),
        );
      if (!todo?.note) return p;
      const extra = splitNote(todo.note).filter((line) => !existing.includes(line));
      if (extra.length === 0) return p;
      const merged = [...existing, ...extra].slice(0, 6);
      if (merged.length < 2) return p;
      if (p.role === "toc") return { ...p, items: merged };
      return { ...p, bullets: merged };
    }),
  };
}

export function assertComposeHasBody(
  deck: ComposeDeck,
  opts: {
    minPages?: number;
    minBullets?: number;
    pageCount?: PageCountRequirement;
  } = {},
): void {
  const minPages = opts.minPages ?? 5;
  const minBullets = opts.minBullets ?? 3;
  const problems: string[] = [];
  const countProblem = pageCountDeliveryHint(opts.pageCount ?? { kind: "unspecified" }, deck.pages.length);
  if (countProblem) problems.push(countProblem);
  else if (deck.pages.length < minPages) {
    problems.push(`need at least ${minPages} pages with bodies, got ${deck.pages.length}`);
  }
  for (const [i, p] of deck.pages.entries()) {
    if (p.role === "cover") continue;
    if (p.role === "evidence" && p.chart) continue;
    const n = (p.bullets?.length ?? 0) + (p.items?.length ?? 0);
    const need = p.role === "close" ? Math.min(2, minBullets) : minBullets;
    if (n < need) {
      problems.push(`page ${i + 1} 「${p.title}」 (${p.role}) needs ≥${need} bullets/items, got ${n}`);
    }
  }
  if (problems.length) {
    throw new Error(`compose IR too thin — title-only pages are rejected:\n${problems.join("\n")}`);
  }
}

/**
 * The numeric count legacy minimum-only callers consume. Exact totals and
 * explicit ranges contribute a lower bound; approximate and unspecified totals
 * never become a minimum because the user authorized no such bound.
 */
export function requestedPageCountFromBrief(brief: string): number | undefined {
  return minimumPageCount(pageCountRequirementFromBrief(brief));
}

export type ComposeBodyRules = Readonly<{
  /** Structural floor only; exact and range lower bounds still come from the user. */
  minPages: number;
  minBullets: number;
  /** The count authority carried to compose and delivery checks. */
  pageCount: PageCountRequirement;
}>;

/**
 * Body richness rules plus the user's page-count requirement. A numeric legacy
 * override is a fixed total; production passes the shared PageCountRequirement.
 */
export function composeBodyRules(
  brief: string,
  _categoryId?: string,
  requestedPageCount?: number | PageCountRequirement,
): ComposeBodyRules {
  const pageCount: PageCountRequirement =
    typeof requestedPageCount === "number"
      ? Number.isInteger(requestedPageCount) && requestedPageCount > 0
        ? { kind: "exact", count: requestedPageCount }
        : pageCountRequirementFromBrief(brief)
      : (requestedPageCount ?? pageCountRequirementFromBrief(brief));
  const minPages = pageCount.kind === "exact" ? pageCount.count : pageCount.kind === "range" ? pageCount.min : 1;
  return { minPages, minBullets: 3, pageCount };
}

/** Parse + fill from todos + reject title-only pages. Agent compose must go through here. */
export function finalizeComposeDeck(
  raw: unknown,
  todos: ComposeTodo[] = [],
  opts: {
    minPages?: number;
    minBullets?: number;
    pageCount?: PageCountRequirement;
  } = {},
): ComposeDeck {
  const filled = fillComposeFromTodos(parseComposeDeck(raw), todos);
  assertComposeHasBody(filled, opts);
  return filled;
}

/** Split a user brief into title + claim bullets without inventing facts. */
export function briefToOutline(brief: string): { title: string; claims: string[] } {
  const lines = brief.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*#{1,6}\s+\S/.test(line));
  const headerTitle = headerIndex >= 0 ? lines[headerIndex]!.replace(/^\s*#{1,6}\s+/, "").trim() : "";
  const body = headerIndex >= 0 ? lines.filter((_, index) => index !== headerIndex).join("\n") : brief;
  const cleaned = body
    .replace(/(\d)\s*[:：]\s*(\d)/g, "$1∶$2")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned
    .split(/[。；;：:\n]|[，,](?=\s)/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  const title = (headerTitle || parts[0] || cleaned).slice(0, 40);
  const claims = (headerTitle ? parts : parts.length > 1 ? parts.slice(1) : parts).slice(0, 5);
  if (!claims.length) claims.push(cleaned.slice(0, 80));
  return { title, claims };
}

/** Pull source names + verbatim lines from `## 参考: <name>` blocks. Never invent numbers. */
export function extractReferenceLines(referenceText?: string): {
  names: string[];
  lines: string[];
} {
  if (!referenceText?.trim()) return { names: [], lines: [] };
  const names: string[] = [];
  const lines: string[] = [];
  for (const raw of referenceText.split(/\r?\n/)) {
    const header = /^##\s*参考:\s*(.+)\s*$/.exec(raw);
    if (header) {
      const name = header[1]!.trim();
      if (name) names.push(name);
      continue;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    lines.push(line.slice(0, 60));
  }
  return { names, lines };
}

/** Offline outline family. Not official research — just which recipe to use. */
export type DeckIntent = "teach" | "decide" | "report" | "promo" | "academic" | "travel";

const TEACH_RE =
  /小学|小学生|中学生|高中生|幼儿园|课堂|课件|课程|科普|教学|讲解|讲一讲|讲讲|讲清楚|[一二三四五六七八九十]年级|小朋友|孩子们|培训课件|培训课程|培训教材|培训讲义|新员工培训|入门|怎么学|怎么记|面向.{0,12}学生|面向孩子|勾股|课文|口诀|种子.{0,8}发芽|怎么发芽|lesson|courseware|pupils|classroom|teach/i;
const ACADEMIC_RE = /开题|答辩|论文|综述|实验方法|课题组|thesis|defense/i;
const TRAVEL_RE = /旅游|攻略|旅行|行程|景点|度假|手册|东京|京都|大阪|北海道|itinerary|travel guide|city guide/i;
const PROMO_RE = /品牌|发布会|营销|推广|海报|活动视觉|创意|brand|campaign/i;
const REPORT_RE = /周报|月报|年报|汇报|述职|OKR|进度|工作报告/i;
const DECIDE_RE = /复盘|增长|试点|决策|判断|战略|投资|渠道|Q[1-4]|季度/;
const PERFORMANCE_RE =
  /述职|履职报告|绩效复盘|晋升答辩|转正答辩|个人(?:年中|年度|年终)总结|(?:年中|年度|年终)个人总结/i;
const WORK_REPORT_RE =
  /工作汇报|工作总结|项目(?:阶段|进展)汇报|项目进度(?:汇报|报告)|阶段性汇报|专项汇报|部门汇报|团队汇报/i;
const TRAINING_RE = /培训课件|培训课程|培训教材|培训讲义|新员工培训|岗前培训|操作培训|业务培训|内训|工作坊/i;
const TEACHING_RE = /教学课件|课堂课件|课程课件|教案|授课|课堂教学|教学设计|面向.{0,12}(?:学生|学员).{0,12}课件/i;
const PROJECT_PROPOSAL_RE = /项目立项|立项方案|项目方案|实施方案|解决方案|项目提案|项目建议书|可行性方案/i;

function categoryIntent(categoryId?: string): DeckIntent | undefined {
  switch (categoryId) {
    case "education-training":
      return "teach";
    case "brand-creative":
      return "promo";
    case "academic-research":
      return "academic";
    case "management-report":
      return "report";
    case "analysis-decision":
    case "business-plan":
    case "tech-engineering":
      return "decide";
    default:
      return undefined;
  }
}

/**
 * Strip “不要做成经营月报 / 不要做成课件 / 不是产品立项 / 不要个人答辩”
 * so the negation is not a document type.
 * 「开题 + 小学」is a defense, not courseware. 「发布会」is promo, not a lesson.
 */
export function briefWithoutNegatedDocTypes(brief: string): string {
  return brief
    .replace(/(?:不是|并非|不做|不要(?:做成)?|无需|无须|非)\s*(?:一份)?\s*(?:科普|课件|课程|培训|教学|讲解)/gi, " ")
    .replace(
      /(?:不是|并非|不做|避免|不要(?:做成|使用|采用)?|无需|无须|非)\s*(?:一份)?\s*(?:门店)?(?:经营)?(?:月报|年报|周报|汇报)(?:换皮|样式|风格)?/gi,
      " ",
    )
    .replace(/(?:不是|并非|不做|不要(?:做成)?|无需|无须|非)\s*(?:一份)?\s*(?:产品)?立项/gi, " ")
    .replace(/(?:不是|并非|不做|不要(?:做成)?|无需|无须|非)\s*(?:一份)?\s*(?:个人)?答辩/gi, " ")
    .replace(/(?:不是|并非|不做|不要(?:做成)?|无需|无须|非)\s*(?:一份)?\s*(?:花哨)?营销(?:页)?/gi, " ")
    .replace(
      /(?:不是|并非|不做|不要(?:做成)?|无需|无须|非)\s*(?:一次|一份|一场)?\s*(?:内部)?(?:「)?(?:学习分享|分享会|内部分享)/gi,
      " ",
    )
    .replace(
      /(?:不是|并非|不做|不要(?:做成|做)?|无需|无须|非)\s*(?:一份)?\s*(?:(?:董事(?:会)?|经营层)\s*(?:的|看的|用的)?\s*)?(?:上半年|半年度|半年)\s*(?:经营)?\s*(?:检讨|检视|复盘|汇报|审议|简报|报)/gi,
      " ",
    )
    .replace(
      /(?:不是|并非|不做|不要(?:做成)?|无需|无须|非)\s*(?:一份)?\s*(?:个人)?(?:述职|履职报告|晋升答辩|转正答辩)/gi,
      " ",
    )
    .replace(
      /(?:不是|并非|不做|不要(?:做成)?|无需|无须|非)\s*(?:一份)?\s*(?:项目|部门|团队)?(?:阶段)?(?:工作汇报|工作总结|项目进展汇报)/gi,
      " ",
    )
    .replace(
      /(?:不是|并非|不做|不要(?:做成)?|无需|无须|非)\s*(?:一份)?\s*(?:新员工|岗前|操作|业务)?(?:培训课件|培训课程|培训教材|培训讲义|培训)/gi,
      " ",
    )
    .replace(
      /(?:不是|并非|不做|不要(?:做成)?|无需|无须|非)\s*(?:一份)?\s*(?:项目)?(?:立项方案|项目方案|实施方案|解决方案|项目提案)/gi,
      " ",
    )
    .replace(/(?:not|no|without)\s+(?:a\s+)?(?:lesson|courseware|course|training|tutorial)/gi, " ")
    .replace(/(?:not|no|without)\s+(?:a\s+)?(?:monthly\s+)?(?:operating\s+)?report/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Page-plan kind. Not a Host design-system pick. */
export type BriefKind =
  | "cover-only"
  | "board-h1"
  | "product-intro"
  | "retail-monthly"
  | "performance-review"
  | "work-report"
  | "project-proposal"
  | "academic"
  | "teach-pythagoras"
  | "teaching"
  | "training"
  | "learn-share"
  | "other";

function isCoverOnlyBrief(text: string): boolean {
  if (isLearnShareBrief(text)) return false;
  return /封面/.test(text) && /一页|单页|一张/.test(text) && !/20\s*页|二十页|约\s*20/.test(text);
}

function isBoardHalfYearBrief(text: string): boolean {
  return (
    /上半年经营汇报|半年经营审议|半年经营汇报/.test(text) ||
    (/董事会/.test(text) && /经营(?:汇报|审议)/.test(text)) ||
    /(?:董事(?:会)?|经营层).{0,40}(?:上半年|半年度|半年).{0,20}(?:经营)?(?:检讨|检视|复盘|汇报|审议|简报)/.test(text) ||
    /(?:上半年|半年度|半年).{0,20}(?:经营)?(?:检讨|检视|复盘|汇报|审议|简报).{0,40}(?:董事(?:会)?|经营层)/.test(text)
  );
}

function isProductIntroBrief(text: string): boolean {
  if (/产品介绍/.test(text)) return true;
  if (/办公立项/.test(text) || /立项用/.test(text)) return true;
  return false;
}

function isRetailMonthlyBrief(text: string): boolean {
  if (/经营月报/.test(text)) return true;
  if (/月报/.test(text) && /经营/.test(text)) return true;
  if (/20\s*页|二十页/.test(text) && /月报/.test(text)) return true;
  return false;
}

function isAcademicBrief(text: string): boolean {
  return ACADEMIC_RE.test(text);
}

function isLearnShareBrief(text: string): boolean {
  return /学习分享|知识分享|经验分享|教学分享|分享会|内部分享/.test(text);
}

/**
 * Director page-plan kind after negations are stripped.
 * 董事会半年经营汇报 is not 立项 and not a 20-page 澄光月报.
 * 不要做成经营月报 is not a monthly. 产品介绍 / 办公立项用 is not a monthly.
 * 开题/答辩 is academic, not 勾股 courseware.
 * 学习分享 / 分享会 / 内部分享 is not other, not 澄光月报, not 立项.
 */
export function classifyBriefKind(brief: string): BriefKind {
  const text = briefWithoutNegatedDocTypes(brief);
  if (isCoverOnlyBrief(text)) return "cover-only";
  if (isBoardHalfYearBrief(text)) return "board-h1";
  if (isProductIntroBrief(text)) return "product-intro";
  if (PERFORMANCE_RE.test(text)) return "performance-review";
  if (WORK_REPORT_RE.test(text)) return "work-report";
  if (PROJECT_PROPOSAL_RE.test(text)) return "project-proposal";
  if (isAcademicBrief(text)) return "academic";
  if (isLearnShareBrief(text)) return "learn-share";
  if (TRAINING_RE.test(text)) return "training";
  if (TEACHING_RE.test(text)) return "teaching";
  if (isRetailMonthlyBrief(text)) return "retail-monthly";
  if (/勾股|小学/.test(text)) return "teach-pythagoras";
  return "other";
}

export function inferDeckIntent(brief: string, categoryId?: string): DeckIntent {
  const kind = classifyBriefKind(brief);
  if (kind === "board-h1" || kind === "retail-monthly") return "report";
  if (kind === "performance-review" || kind === "work-report") return "report";
  if (kind === "product-intro" || kind === "project-proposal") return "decide";
  if (kind === "academic") return "academic";
  if (kind === "teach-pythagoras" || kind === "teaching" || kind === "training" || kind === "learn-share")
    return "teach";
  const text = briefWithoutNegatedDocTypes(brief);
  if (TRAVEL_RE.test(text)) return "travel";
  if (REPORT_RE.test(text)) return "report";
  if (PROMO_RE.test(text)) return "promo";
  if (TEACH_RE.test(text)) return "teach";
  if (DECIDE_RE.test(text)) return "decide";
  return categoryIntent(categoryId) ?? "decide";
}

/** Named classroom facts the host may state without a citation. Not every teach brief. */
export function isNamedClassroomFact(text: string): boolean {
  return /勾股|直角三角|毕达哥拉斯|pythagor/i.test(text);
}
