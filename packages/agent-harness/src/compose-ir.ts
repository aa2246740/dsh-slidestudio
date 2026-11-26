/** Structured deck IR the playbook brain (LLM or deterministic) must emit. */

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
  if (!Array.isArray(o.pages) || o.pages.length < 2) {
    throw new Error("compose IR.pages must have at least 2 pages");
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
  if (pages.length < 2) {
    throw new Error("compose IR produced fewer than 2 valid pages");
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

export function assertComposeHasBody(deck: ComposeDeck, opts: { minPages?: number; minBullets?: number } = {}): void {
  const minPages = opts.minPages ?? 5;
  const minBullets = opts.minBullets ?? 3;
  const problems: string[] = [];
  if (deck.pages.length < minPages) {
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

/** Respect an explicit user page count before applying genre defaults. */
export function requestedPageCountFromBrief(brief: string): number | undefined {
  const patterns = [/页数\s*[:：]?\s*(\d+)/, /(\d+)\s*页\s*左右/, /约\s*(\d+)\s*页/, /(\d+)\s*页/];
  for (const pattern of patterns) {
    const value = Number(brief.match(pattern)?.[1]);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

/** Classroom lessons need a full path only when the user omitted a count. */
export function composeBodyRules(brief: string, categoryId?: string): { minPages: number; minBullets: number } {
  const requestedPages = requestedPageCountFromBrief(brief);
  return {
    minPages: requestedPages ?? (inferDeckIntent(brief, categoryId) === "teach" ? 6 : 4),
    minBullets: 3,
  };
}

/** Parse + fill from todos + reject title-only pages. Agent compose must go through here. */
export function finalizeComposeDeck(
  raw: unknown,
  todos: ComposeTodo[] = [],
  opts: { minPages?: number; minBullets?: number } = {},
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
const LEARN_SHARE_RE = /学习分享|知识分享|经验分享|教学分享|分享会|内部分享/i;

const INTENT_CATEGORY: Record<DeckIntent, string> = {
  teach: "education-training",
  decide: "analysis-decision",
  report: "management-report",
  promo: "brand-creative",
  academic: "academic-research",
  travel: "brand-creative",
};

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

function looseHubCategory(categoryId?: string): boolean {
  const id = (categoryId || "").trim();
  return !id || id === "analysis-decision" || id === "All";
}

/** Remove document types that the brief explicitly rejects before routing. */
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

/**
 * Document-type markers beat audience words.
 * 「开题 + 小学」is a defense, not courseware. 「发布会」is promo, not a lesson.
 */
export function inferDeckIntent(brief: string, categoryId?: string): DeckIntent {
  const text = briefWithoutNegatedDocTypes(brief);
  if (ACADEMIC_RE.test(text)) return "academic";
  if (TRAVEL_RE.test(text)) return "travel";
  if (LEARN_SHARE_RE.test(text)) return "teach";
  if (REPORT_RE.test(text)) return "report";
  if (PROMO_RE.test(text)) return "promo";
  if (TEACH_RE.test(text)) return "teach";
  if (DECIDE_RE.test(text)) return "decide";
  return categoryIntent(categoryId) ?? "decide";
}

/** Skill category to load. Hub All + a classroom brief must not stay on consulting. */
export function resolvePlaybookCategory(brief: string, hubCategory?: string): string {
  const hub = (hubCategory || "").trim();
  const intent = inferDeckIntent(brief, looseHubCategory(hub) ? undefined : hub);
  if (intent !== "decide") return INTENT_CATEGORY[intent];
  if (hub && !looseHubCategory(hub)) return hub;
  return INTENT_CATEGORY.decide;
}

/** Hub Freestyle / unset tile. Not a user-picked consulting system. */
export const HUB_DEFAULT_DESIGN = "consulting/pine-green-strategy";
export const DEFAULT_TEACH_DESIGN = "academic/paper-white-courseware";
export const DEFAULT_ACADEMIC_DESIGN = "academic/teal-green-academic-defense";
export const DEFAULT_PROMO_DESIGN = "promotion/cream-collage";
export const DEFAULT_REPORT_DESIGN = "work/warm-jade-annual-report";
export const DEFAULT_TRAVEL_DESIGN = "promotion/travel-green-handbook";

const DEFAULT_DESIGN_BY_INTENT: Record<DeckIntent, string> = {
  teach: DEFAULT_TEACH_DESIGN,
  academic: DEFAULT_ACADEMIC_DESIGN,
  promo: DEFAULT_PROMO_DESIGN,
  report: DEFAULT_REPORT_DESIGN,
  travel: DEFAULT_TRAVEL_DESIGN,
  decide: HUB_DEFAULT_DESIGN,
};

/**
 * Hub Freestyle / pine-green remaps by brief intent.
 * An explicit wall tile other than Freestyle / pine-green still wins.
 */
export function resolveGenerateDesign(brief: string, requested?: string, categoryId?: string): string {
  const req = (requested || "").trim();
  const category = categoryId || resolvePlaybookCategory(brief);
  const isHubDefault = !req || req === HUB_DEFAULT_DESIGN || req === "freestyle";
  if (!isHubDefault) return req;
  const intent = inferDeckIntent(brief, category);
  return DEFAULT_DESIGN_BY_INTENT[intent];
}

/** Named classroom facts the host may state without a citation. Not every teach brief. */
export function isNamedClassroomFact(text: string): boolean {
  return /勾股|直角三角|毕达哥拉斯|pythagor/i.test(text);
}

/**
 * Per-intent produce rules for the tool loop. The 勾股 triangle is not the
 * default exhibit. A classroom skeleton is not the default path.
 */
export function intentComposeGuidance(intent: DeckIntent, brief: string): string[] {
  const shared = [
    "compose_deck page shape: each page has elements[] with elementType and bounds [x,y,w,h] on 960×540.",
    '{ "id": "page-03", "pageType": "content", "elements": [',
    '  { "elementId": "title", "elementType": "text", "bounds": [40, 36, 880, 48], "content": { "text": "这一页只讲一件事", "bold": true, "fontSize": 22 } },',
    '  { "elementId": "exhibit", "elementType": "shape", "bounds": [80, 140, 320, 240], "shapeName": "rect", "fill": { "type": "solid", "color": "#1F4E79" } },',
    '  { "elementId": "support", "elementType": "text", "bounds": [440, 160, 440, 200], "content": { "text": "主展品在左，说明在右。换题目就换展品，不要复制这一页。", "fontSize": 16 } }',
    "] }",
    "A unified system does not mean copying the same 2-column or 3-column plate onto every page.",
    "If you only send role+title+bullets, the host stamps a linear fallback and the skill did NOT produce the page.",
  ];
  if (intent === "teach") {
    const exhibit = isNamedClassroomFact(brief)
      ? "This brief is about 勾股: the exhibit may be an rtTriangle plus 斜边 copy. 3-4-5 is practice, not research."
      : "The exhibit is what the learner must do or see — a sequence, a labeled object, a before/after. Do not draw a right triangle unless the brief is about triangles.";
    return [
      ...shared,
      "Path: cover → route → concept → method → demo → transfer (6 pages minimum). Official paper-white recipes only.",
      "Education red lines: no homemade 4-step circles, no soil/sun doodles, no cream+black walls. Pale list panels and a result bar are official.",
      exhibit,
    ];
  }
  if (intent === "academic") {
    return [
      ...shared,
      "Path: cover → question → method boundary → materials/gaps → close. This is a defense / proposal, not courseware.",
      "No fabricated results, citations, or charts of uncollected data. Mark 占位.",
      "Do not use a classroom lesson outline or a Pythagorean triangle example.",
    ];
  }
  if (intent === "travel") {
    return [
      ...shared,
      "Path: cover (place) → days/areas → one exhibit each → close. This is a handbook, not a consulting recap.",
      "You may use generate_image for a place photo; you may also design with type, map-like shapes, or a table. Media is not required.",
      "Do not invent 人均/价格/评分. A research gap must stay 占位. Do not fill empty pages with three text columns.",
    ];
  }
  if (intent === "promo") {
    return [
      ...shared,
      "Path: cover → one memory point → one visual exhibit → close. Not a lesson outline and not a consulting recap.",
      "Do not invent sales, ratings, or influencer quotes. Do not default to 3 equal text columns or 4-card stamps.",
    ];
  }
  if (intent === "report") {
    return [
      ...shared,
      "Path follows the material: cover (period status) → one exhibit per table / region / blocker cluster → next asks.",
      "If the attachment has 7+ distinct exhibits, write that many body pages. Do not collapse a 月报 into a 6-page consulting or classroom stamp.",
      "Quote only numbers that appear in the brief or attachments. No company name + no numeric facts → do not write_page. 示意/演示占位 is still fabricating.",
      "A metric the brief marks 缺失/待补 must appear on a page as that name plus 缺失，待补. Do not summarize as 三项数据.",
      "If the brief lists table columns, the header must include every column (including 负责人) and listed owner names stay in cells.",
      "If you skip a table, region, named owner, or next-ask from the attachment, list those omitted headings in think(). Do not silently clip.",
    ];
  }
  return [
    ...shared,
    "Path: cover → judgment → evidence (table/chart or 占位) → so-what → next action.",
    "Missing data stays 占位. Do not invent statistics.",
  ];
}

function stripIntro(title: string): string {
  return title.replace(/^(介绍一下|讲讲|聊聊|说说)/, "").trim() || title;
}

function audienceFromBrief(brief: string): string | undefined {
  const m = brief.match(/面向([^，。,\n]{2,16})/);
  return m?.[1]?.trim() || undefined;
}

function isPythagoras(brief: string): boolean {
  return isNamedClassroomFact(brief);
}

function placeholderChart(): ComposeChart {
  return {
    title: "示意序列（待替换）",
    cols: ["项", "值"],
    rows: [
      ["A", 3],
      ["B", 5],
      ["C", 2],
      ["D", 4],
    ],
    note: "placeholder",
  };
}

function evidenceNote(refs: { names: string[] }): string {
  return refs.names.length ? `来源：${refs.names.join("、")}，数值为占位` : "图表数值为结构占位，非正式统计。";
}

function coverPage(title: string, subtitle?: string): ComposePage {
  return {
    role: "cover",
    title,
    subtitle: subtitle?.slice(0, 60),
  };
}

function teachDeck(
  brief: string,
  title: string,
  claims: string[],
  refs: { names: string[]; lines: string[] },
): ComposeDeck {
  const topic = isPythagoras(brief) ? "勾股定理" : stripIntro(title);
  const audience = audienceFromBrief(brief);
  const extra = claims.filter((c) => !/^面向/.test(c));
  const quotes = refs.lines.slice(0, 2);
  const py = isPythagoras(brief);

  const conceptBullets = py
    ? [
        "直角对着的那条边叫斜边，另外两条边叫直角边。",
        "勾股定理：两条直角边的平方加起来，等于斜边的平方。",
        audience ? `讲给${audience}听时，先指边，再写公式。` : "先指边，再写公式，再举一个数。",
        ...quotes,
      ]
    : [
        `先用一句话能讲出「${topic}」是什么。`,
        ...extra.slice(0, 3),
        audience ? `用${audience}能懂的词，少堆术语。` : "用听众能懂的词，少堆术语。",
        ...quotes,
      ].filter(Boolean);

  const rememberBullets = py
    ? [
        "先找到直角，直角对面就是斜边。",
        "公式写成 a² + b² = c²，c 一定是斜边。",
        "3、4、5 是课堂上最常用的一组数，用来检查，不是统计数据。",
      ]
    : [
        `用一句能复述的话记住「${topic}」。`,
        extra[0] ? String(extra[0]).slice(0, 60) : "先分清对象，再记关系，最后用例子核对。",
        "能讲给旁边的人听，才算记住。",
      ];

  const pages: ComposePage[] = [
    coverPage(title, audience ? `面向${audience}` : (extra[0] ?? claims[0])),
    {
      role: "toc",
      title: "今天要搞懂什么",
      items: py
        ? ["直角边和斜边是什么", "怎么用三边关系记住", "3-4-5 课堂例子"]
        : ["它在说什么", "怎么记住", "用一个例子走一遍"],
      soWhat: "先看今天要搞懂什么，再学概念，最后用例子带走一句能复述的话。",
    },
    {
      role: "content",
      title: py ? "直角三角形里，斜边最长，另外两边叫直角边" : `${topic}是什么，先讲清再往下走`,
      chapter: "01 概念",
      bullets: conceptBullets,
      soWhat: "这一页只建立对象，不考试，不堆课外统计。",
    },
    {
      role: "content",
      title: py ? "记住：先找直角，再认斜边，最后写 a²+b²=c²" : `记住「${topic}」的一句话`,
      chapter: "02 记住",
      bullets: rememberBullets,
      soWhat: "能复述，才算过关。",
    },
  ];

  if (py) {
    pages.push({
      role: "evidence",
      title: "课堂例子：3、4、5 正好能围成直角三角形",
      chapter: "03 例子",
      note: "课堂练习数字，不是统计。3²+4²=9+16=25=5²。",
      chart: {
        title: "课堂练习：三边长度",
        cols: ["边", "长度"],
        rows: [
          ["短直角边", 3],
          ["长直角边", 4],
          ["斜边", 5],
        ],
        note: "课堂练习数字，不是统计",
      },
    });
  } else {
    pages.push({
      role: "content",
      title: `用一个例子看「${topic}」`,
      chapter: "03 例子",
      bullets: [
        extra[1] ?? `把「${topic}」放到一个具体情境里走一遍。`,
        "例子用来降低抽象，不编造课外调查。",
        refs.names.length ? `只引用：${refs.names.join("、")}。` : "没有参考资料时，例子保持示意并标明占位。",
      ],
      soWhat: "例子服务于理解，不是证据链。",
    });
  }

  pages.push({
    role: "close",
    title: "今天带走什么",
    chapter: "04 收束",
    bullets: py
      ? ["能指认直角边和斜边。", "能写出 a²+b²=c²，并说明 c 是斜边。", "回去画一个直角三角形，用 3、4、5 检查一次。"]
      : [
          `能用自己的话讲清「${topic}」。`,
          "能举一个例子，并指出容易搞混的地方。",
          "缺材料的位置保持占位，不编造出处。",
        ],
  });

  return { title, pages };
}

function decideDeck(
  brief: string,
  title: string,
  claims: string[],
  refs: { names: string[]; lines: string[] },
): ComposeDeck {
  const needEvidence = refs.names.length > 0 || /数据|增长|试点|证据|对比|口径|成效/.test(brief);
  const needTimeline = /阶段|下周|试点|节奏|路线|里程碑/.test(brief);
  const needMatrix = /四象限|支撑面|矩阵|对照面/.test(brief);
  const quotes = refs.lines.slice(0, 3);
  const contentBullets = quotes.length ? [...claims, ...quotes] : claims;
  const toc = ["问题与范围", "当前判断"];
  if (needEvidence) toc.push("证据结构");
  if (needTimeline) toc.push("推进节奏");
  if (needMatrix) toc.push("结构对照");
  toc.push("结论与动作");

  const pages: ComposePage[] = [
    coverPage(title, claims[0]),
    { role: "toc", title: "本篇结构", items: toc },
    {
      role: "content",
      title: claims[0] ?? title,
      chapter: "01 判断",
      bullets: contentBullets,
      soWhat: "以下页只放结构示意，不编造外部数据。",
    },
  ];

  if (needEvidence) {
    pages.push({
      role: "evidence",
      title: "证据位：待补真实序列",
      chapter: "02 证据",
      note: evidenceNote(refs),
      chart: placeholderChart(),
    });
  }
  if (needTimeline) {
    const items = claims.slice(0, 7);
    pages.push({
      role: "timeline",
      title: "节奏：分阶段推进",
      chapter: "03 节奏",
      items: items.length >= 2 ? items : ["启动", "试点", "扩量", "复盘"],
      soWhat: "阶段节奏按任务推进，不按日历堆叠。",
    });
  }
  if (needMatrix) {
    const items = claims.slice(0, 4);
    pages.push({
      role: "matrix",
      title: "结构：四个支撑面",
      chapter: "03 结构",
      items: items.length >= 2 ? items : ["目标", "能力", "资源", "风险"],
      soWhat: "四象限只作结构对照，不替代证据。",
    });
  }

  pages.push({
    role: "close",
    title: /下周/.test(brief) ? "结论与下周动作" : "结论与下一步",
    chapter: "04 收束",
    bullets: [
      `围绕「${title}」先核对数据来源`,
      needEvidence ? "把占位图换成带单位与时间窗的真实序列" : "缺数据的位置保持占位，不编造外部统计",
      /下周/.test(brief) ? "动作项需指定负责人与截止日期后再定稿" : "下一步只写已经能核对的动作，不发明截止日期",
    ],
  });

  return { title, pages };
}

function reportDeck(title: string, claims: string[], refs: { names: string[]; lines: string[] }): ComposeDeck {
  const needEvidence = refs.names.length > 0 || /数据|指标|完成率/.test(title + claims.join(""));
  const pages: ComposePage[] = [
    coverPage(title, claims[0]),
    { role: "toc", title: "汇报结构", items: ["进展", "问题", "下一步"] },
    {
      role: "content",
      title: claims[0] ?? title,
      chapter: "01 进展",
      bullets: refs.lines.length ? [...claims, ...refs.lines.slice(0, 2)] : claims,
      soWhat: "只汇报已发生的事，缺口标成待补。",
    },
  ];
  if (needEvidence) {
    pages.push({
      role: "evidence",
      title: "指标位：待补真实序列",
      chapter: "02 指标",
      note: evidenceNote(refs),
      chart: placeholderChart(),
    });
  }
  pages.push({
    role: "close",
    title: "问题与下一步",
    chapter: "03 收束",
    bullets: [`围绕「${title}」先核对口径`, "未完成项保持占位，不编造完成率", "下一步只写能在下一汇报核验的动作"],
  });
  return { title, pages };
}

function promoDeck(title: string, claims: string[]): ComposeDeck {
  return {
    title,
    pages: [
      coverPage(title, claims[0]),
      { role: "toc", title: "这一页之后记住什么", items: ["记忆点", "主张", "下一步"] },
      {
        role: "content",
        title: claims[0] ?? title,
        chapter: "01 主张",
        bullets: claims,
        soWhat: "品牌页靠记忆点，不编造客户案例。",
      },
      {
        role: "close",
        title: "带走的记忆点",
        chapter: "02 收束",
        bullets: [`一句话记住「${title}」`, "缺素材的位置保持占位，不编造评价", "下一步只写已经能沟通的动作"],
      },
    ],
  };
}

function academicDeck(title: string, claims: string[], refs: { names: string[]; lines: string[] }): ComposeDeck {
  const pages: ComposePage[] = [
    coverPage(title, claims[0]),
    { role: "toc", title: "报告结构", items: ["问题", "方法", "结论"] },
    {
      role: "content",
      title: claims[0] ?? title,
      chapter: "01 问题",
      bullets: refs.lines.length ? [...claims, ...refs.lines.slice(0, 2)] : claims,
      soWhat: "只陈述问题与方法边界，不编造实验结果。",
    },
  ];
  if (refs.names.length) {
    pages.push({
      role: "evidence",
      title: "材料摘录：只引用已给来源",
      chapter: "02 材料",
      note: evidenceNote(refs),
      chart: placeholderChart(),
    });
  }
  pages.push({
    role: "close",
    title: "结论与待补",
    chapter: "03 收束",
    bullets: [
      `围绕「${title}」先核对问题表述`,
      refs.names.length ? `只引用：${refs.names.join("、")}` : "没有参考文献时，不出现假出处",
      "缺实验数据的位置保持占位",
    ],
  });
  return { title, pages };
}

export function deterministicDeck(
  brief: string,
  designSystemId: string,
  referenceText?: string,
  categoryId?: string,
): ComposeDeck {
  void designSystemId;
  const { title, claims } = briefToOutline(brief);
  const refs = extractReferenceLines(referenceText);
  const intent = inferDeckIntent(brief, categoryId);
  if (intent === "teach") return teachDeck(brief, title, claims, refs);
  if (intent === "report") return reportDeck(title, claims, refs);
  if (intent === "promo" || intent === "travel") return promoDeck(title, claims);
  if (intent === "academic") return academicDeck(title, claims, refs);
  return decideDeck(brief, title, claims, refs);
}
