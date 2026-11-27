/**
 * Shared page-count semantics for the existing director guidance, plan,
 * write, compose and delivery seams. Exact, approximate, an explicit range and
 * unspecified stay distinct; an approximate goal never gains an invented
 * tolerance, and reference-material page counts are not user targets.
 */
export type PageCountRequirement =
  | Readonly<{ kind: "exact"; count: number }>
  | Readonly<{ kind: "approximate"; count: number }>
  | Readonly<{ kind: "range"; min: number; max: number }>
  | Readonly<{ kind: "unspecified" }>;

const COUNT = "([0-9零〇一二两三四五六七八九十百]+)";
const ASCII_COUNT = "([0-9]+)";
const RANGE_SEPARATOR = "(?:[-–—~～]|到|至)";
const REFERENCE_WORD = "(?:参考(?:资料|稿|附件|文件|模板)?|附件|资料|模板|原稿|源稿|示例|样例)";
const CLAUSE_BOUNDARY = /[，,。；;！？!?\n]/;
const USER_ASK_VERB = "(?:做成|制作|生成|做|需要|只要|保持|改成|改为|固定|要求)";
const RAW_COUNT = "[0-9零〇一二两三四五六七八九十百]+";
const PAGE_COUNT =
  `(?:约|大约|大概|差不多)?\\s*${RAW_COUNT}` +
  `(?:\\s*${RANGE_SEPARATOR}\\s*${RAW_COUNT})?\\s*页(?:\\s*(?:左右|上下))?`;
const ARTICLE = "(?:一份|一个|一套|这份|该|此)?";
// What a reference noun does as a subject: its own passive/aspect verbs, copulas,
// totals and approximations. A bare 做/制作/生成 is not here; after a noun it is the
// user's ask ("参考稿做 3 页").
const REFERENCE_PREDICATE =
  "(?:由[^，,。；;]{0,16}?(?:生成|制作|做成|做|产出|整理|导出|编制|撰写)" +
  "|(?:制作|生成|做|写|编制|整理|导出)(?:了|过|出)|做成|被|已经|已|曾经|曾|均|都|仅|只" +
  "|总共|一共|合计|共|大约|大概|差不多|约|是|为(?![准主])|有|范围)";
const SIBLING_REFERENCE = `(?:\\s*(?:与|和|及|、|跟)\\s*${REFERENCE_WORD})*`;
// A reference noun the user does not hand a task to: after 按/以/参考… or a user
// verb it is the object or modifier of the user's own request.
const REFERENCE_AS_OBJECT =
  `(?:${USER_ASK_VERB}|按照|按|依照|依据|依|照|仿照|参照|沿用|沿袭|基于|根据|对照|以|用|套用|使用|采用|结合|参考)` +
  `\\s*${ARTICLE}\\s*`;
// The reference noun as subject, through the end of the first page count its
// predicate states; anything after that count is a new phrase and stays.
const REFERENCE_SUBJECT_CLAUSE = new RegExp(
  `(?<!${REFERENCE_AS_OBJECT})${REFERENCE_WORD}${SIBLING_REFERENCE}\\s*` +
    `(?:(?:(?:的\\s*)?(?:页数|页码|篇幅)\\s*[:：]?\\s*(?:为|是|约|大约|共)*\\s*${RAW_COUNT}` +
    `(?:\\s*${RANGE_SEPARATOR}\\s*${RAW_COUNT})?\\s*页?(?:\\s*(?:左右|上下))?)` +
    `|(?:(?:${REFERENCE_PREDICATE}\\s*)+(?:(?!${USER_ASK_VERB})[^，,。；;]){0,12}?)?${PAGE_COUNT})`,
  "g",
);
// "12 页的参考稿": the count modifies the reference noun, unless a user verb
// introduces that noun phrase ("做一份 12 页的参考稿风格汇报").
const COUNT_BEFORE_REFERENCE = new RegExp(
  `(?<!${USER_ASK_VERB}\\s*${ARTICLE}\\s*)(?<!${RAW_COUNT})${PAGE_COUNT}\\s*的\\s*(?=${REFERENCE_WORD})`,
  "g",
);
const PAGE_REFERENCE_PREFIX = "(?:第|最?前(?:面)?|最?后(?:面)?|开头|结尾|末尾|其余|剩(?:下|余)(?:的)?|另外|其他|中间)";
const PAGE_REFERENCES = new RegExp(
  `${PAGE_REFERENCE_PREFIX}\\s*${RAW_COUNT}(?:\\s*${RANGE_SEPARATOR}\\s*${RAW_COUNT})?\\s*页`,
  "g",
);

function asciiDigits(text: string): string {
  return text.replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xfee0));
}

/**
 * Drop counts for reference materials, page ordinals and slices (前 3 页).
 * A count is the task's total only as the object of the user's
 * request. A reference noun that is a clause subject owns the count in its
 * predicate ("参考稿由系统生成约 12 页"), so the owner, not a verb in the same
 * clause, decides; a reference noun that only modifies the user's request
 * ("制作一份参考附件风格的 7 页汇报") leaves the user's count untouched. A
 * clause is bounded by punctuation, so a reference count never reaches into
 * another clause's total.
 */
function withoutNonTotalPageCounts(text: string): string {
  const kept = text
    .split(CLAUSE_BOUNDARY)
    .map((clause) => clause.replace(COUNT_BEFORE_REFERENCE, "").replace(REFERENCE_SUBJECT_CLAUSE, " "));
  return kept.join("，").replace(PAGE_REFERENCES, " ");
}

function chineseCount(raw: string): number | undefined {
  const value = Number(raw);
  if (Number.isFinite(value)) return Number.isInteger(value) && value > 0 ? value : undefined;
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  let total = 0;
  let digit = 0;
  for (const char of raw) {
    if (char === "十" || char === "百") {
      total += (digit || 1) * (char === "十" ? 10 : 100);
      digit = 0;
    } else {
      const next = digits[char];
      if (next === undefined) return undefined;
      digit = next;
    }
  }
  const valueFromChinese = total + digit;
  return Number.isInteger(valueFromChinese) && valueFromChinese > 0 ? valueFromChinese : undefined;
}

function positiveCount(raw: string | undefined): number | undefined {
  return raw === undefined ? undefined : chineseCount(raw);
}

/**
 * The user's total-page requirement. Ordinals, page slices and reference-material
 * counts are ignored, and an approximate count
 * carries no invented tolerance: it has no min/max field at all.
 */
export function pageCountRequirementFromBrief(brief: string): PageCountRequirement {
  const text = withoutNonTotalPageCounts(asciiDigits(brief));
  const range = new RegExp(`${COUNT}\\s*(?:[-–—~～]|到|至)\\s*${COUNT}\\s*页`).exec(text);
  if (range) {
    const left = positiveCount(range[1]);
    const right = positiveCount(range[2]);
    if (left !== undefined && right !== undefined) {
      return { kind: "range", min: Math.min(left, right), max: Math.max(left, right) };
    }
  }
  const approximate =
    new RegExp(`(?:约|大约|大概|差不多)\\s*${COUNT}\\s*页`).exec(text) ??
    new RegExp(`${COUNT}\\s*页\\s*(?:左右|上下)`).exec(text);
  if (approximate) {
    const count = positiveCount(approximate[1]);
    if (count !== undefined) return { kind: "approximate", count };
  }
  const patterns = [
    new RegExp(`页数\\s*[:：为是]?\\s*${COUNT}`),
    new RegExp(`(?:总共|一共|合计|共|做成|制作|生成|做|需要|只要|保持|改成|改为)\\s*${COUNT}\\s*页`),
    new RegExp(`^\\s*${COUNT}\\s*页(?:$|[，,。.!！\\s]|即可|就好|的)`),
    // A bare count is read only for ASCII digits: Chinese 一页 can be a
    // component ("一页章节"), so it needs one of the explicit contexts above.
    new RegExp(`(?<![第0-9])${ASCII_COUNT}\\s*页`),
  ];
  for (const pattern of patterns) {
    const count = positiveCount(text.match(pattern)?.[1]);
    if (count !== undefined) return { kind: "exact", count };
  }
  return { kind: "unspecified" };
}

/**
 * The count authority for plan, compose and delivery: exact means equality and
 * a range means both bounds. An approximate or unspecified total never rejects
 * a count here; the Agent explains deviation and review judges the content.
 */
export function pageCountFits(requirement: PageCountRequirement, actual: number): boolean {
  switch (requirement.kind) {
    case "exact":
      return actual === requirement.count;
    case "range":
      return actual >= requirement.min && actual <= requirement.max;
    case "approximate":
    case "unspecified":
      return true;
  }
}

/**
 * The lowest page count a legacy minimum-only check may accept. Approximate and
 * unspecified totals have no authorized minimum, so they contribute nothing.
 */
export function minimumPageCount(requirement: PageCountRequirement): number | undefined {
  switch (requirement.kind) {
    case "exact":
      return requirement.count;
    case "range":
      return requirement.min;
    case "approximate":
    case "unspecified":
      return undefined;
  }
}

export function pageCountRequirementSummary(requirement: PageCountRequirement): string {
  switch (requirement.kind) {
    case "exact":
      return `固定 ${requirement.count} 页`;
    case "approximate":
      return `约 ${requirement.count} 页（近似目标，不是固定或最低页数）`;
    case "range":
      return `${requirement.min}–${requirement.max} 页`;
    case "unspecified":
      return "未指定总页数";
  }
}

/**
 * Explain a plan whose count does not fit the user's requirement. The Host
 * reports the mismatch; it does not choose a page count for the Agent.
 */
export function pageCountPlanHint(requirement: PageCountRequirement, plannedCount: number): string | undefined {
  switch (requirement.kind) {
    case "exact":
      return plannedCount === requirement.count
        ? undefined
        : `用户明确要求固定 ${requirement.count} 页，当前计划为 ${plannedCount} 页；计划和最终交付必须相等。`;
    case "approximate":
      return plannedCount === requirement.count
        ? undefined
        : `用户要求约 ${requirement.count} 页（近似目标，不是固定或最低页数），当前计划为 ${plannedCount} 页；请按任务依据说明偏离。`;
    case "range":
      return plannedCount >= requirement.min && plannedCount <= requirement.max
        ? undefined
        : `用户明确要求 ${requirement.min}–${requirement.max} 页，当前计划为 ${plannedCount} 页；请调整到该范围内。`;
    case "unspecified":
      return undefined;
  }
}

/**
 * Explain why a delivered page count cannot satisfy the user's requirement.
 * Only exact totals and explicit ranges reject; an approximate or unspecified
 * total has no Host-side tolerance and no implied target.
 */
export function pageCountDeliveryHint(requirement: PageCountRequirement, deliveredCount: number): string | undefined {
  switch (requirement.kind) {
    case "exact":
      return deliveredCount === requirement.count
        ? undefined
        : `用户明确要求固定 ${requirement.count} 页，当前文稿为 ${deliveredCount} 页；计划和最终交付必须相等。`;
    case "range":
      return deliveredCount >= requirement.min && deliveredCount <= requirement.max
        ? undefined
        : `用户明确要求 ${requirement.min}–${requirement.max} 页，当前文稿为 ${deliveredCount} 页；请调整到该范围内。`;
    case "approximate":
    case "unspecified":
      return undefined;
  }
}
