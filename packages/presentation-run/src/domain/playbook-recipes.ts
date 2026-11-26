/**
 * Official OpenKimi recipes for classroom produce.
 * Source: academic/paper-white-courseware + education-training.
 * Not kids-courseware doodles. write_page executes these page-by-page.
 */
import type { Bounds, PptdElement, ShapeElement, TextElement } from "@open-slidestudio/pptd-v2";
import type { SkillPageInput } from "./skill-pages.js";

/** Paper-white PART B tokens. */
export const PAPER_WHITE = {
  paper: "#FDFAF5",
  title: "#44712E",
  body: "#56687A",
  muted: "#8A9690",
  coral: "#F5987E",
  leaf: "#D7EBCE",
  blush: "#F9DED8",
  white: "#FFFFFF",
} as const;

/** @deprecated Use PAPER_WHITE. Kept so old imports keep compiling. */
export const KIDS_INK = PAPER_WHITE;

export type RecipeKind = "cover" | "route" | "concept" | "method" | "demo" | "transfer";

export type RecipeOpts = {
  brief: string;
  index: number;
  pageCount?: number;
  /** Ignored. Official recipes apply to every classroom page. */
  body?: boolean;
  /** Existing media src (search/generate/upload). Empty = official no-image layout. */
  imageSrc?: string;
  imageAvailable?: boolean;
};

function shape(elementId: string, shapeName: string, bounds: Bounds, color: string): ShapeElement {
  return {
    elementId,
    elementType: "shape",
    shapeName,
    bounds,
    fill: { type: "solid", color },
  };
}

function label(
  elementId: string,
  bounds: Bounds,
  text: string,
  opts: { size?: number; color?: string; bold?: boolean } = {},
): TextElement {
  return {
    elementId,
    elementType: "text",
    bounds,
    content: {
      text,
      fontSize: opts.size ?? 16,
      color: opts.color ?? PAPER_WHITE.body,
      bold: opts.bold,
      wrap: true,
    },
  };
}

function firstLines(text: string, n: number): string[] {
  return text
    .split(/\n+/)
    .map((s) => s.replace(/^【|】$/g, "").trim())
    .filter(Boolean)
    .slice(0, n);
}

/** YAML notes: and host scaffolding must never become visible title text. */
export function isHostNoteCopy(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^(Cover|Path|Concept|Remember|Exhibit|Takeaway|Close|Route|Method|Demo|Transfer)\s+page\b/i.test(t)) {
    return true;
  }
  if (/\bpage:\s/i.test(t) && /cream|background|anatomy|requirem|#([0-9A-Fa-f]{3,8})/i.test(t)) {
    return true;
  }
  return false;
}

export function fallbackTitle(brief: string, kind: RecipeKind): string {
  if (/种子|发芽|萌芽/.test(brief)) {
    switch (kind) {
      case "cover":
        return "种子怎么发芽";
      case "route":
        return "一粒种子要走过哪几步";
      case "concept":
        return "种子里面有什么";
      case "method":
        return "发芽要什么条件";
      case "demo":
        return "睡着的种子和醒来的种子";
      case "transfer":
        return "回家种一粒，看它会不会醒来";
    }
  }
  const talk = brief
    .replace(/^给.+讲一讲/, "")
    .replace(/[。！？].*$/, "")
    .trim();
  return talk.slice(0, 16) || "看一看";
}

function isGradeChip(text: string): boolean {
  return /^[一二三四五六七八九十]年级$/.test(text.trim());
}

export function isFragmentTitle(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/[：:]$/.test(t)) return true;
  if (/^[（(].+[）)]$/.test(t)) return true;
  if (/（.+）/.test(t) && t.length <= 12 && !/怎么|什么|哪|要|看|回家/.test(t)) return true;
  return false;
}

function classroomTitle(raw: string | undefined, brief: string, kind: RecipeKind): string {
  if ((kind === "cover" || kind === "route" || kind === "concept") && /种子|发芽|萌芽/.test(brief)) {
    return fallbackTitle(brief, kind);
  }
  const t = (raw || "").replace(/🌱\s*/g, "").trim();
  if (!t || isHostNoteCopy(t) || isGradeChip(t) || isFragmentTitle(t)) return fallbackTitle(brief, kind);
  const clause = (t.split(/[：:]/)[0] ?? t).trim();
  const pick = clause !== t && clause.length >= 4 && clause.length <= 16 && !isFragmentTitle(clause) ? clause : t;
  if (kind === "cover" && (pick.length > 12 || /[。！？]/.test(pick))) {
    return fallbackTitle(brief, kind);
  }
  if (pick.length > 16 || /[。！？]/.test(pick)) return fallbackTitle(brief, kind);
  return pick.replace(/[？?]$/, "").slice(0, kind === "cover" ? 12 : 16);
}

function pageCopy(
  page: SkillPageInput,
  brief: string,
  kind: RecipeKind,
): {
  title: string;
  lines: string[];
} {
  const texts = page.elements
    .filter((el) => el.elementType === "text")
    .map((el) => {
      const text = el as TextElement;
      return { id: text.elementId, t: text.content?.text?.trim() ?? "" };
    })
    .filter(({ id, t }) => t && !isHostNoteCopy(t) && !isGradeChip(t) && !isChromeCopy(t, id))
    .map(({ t }) => t);
  const titleEl = page.elements.find((el) => {
    if (el.elementType !== "text" || el.elementId !== "title") return false;
    const t = (el as TextElement).content?.text?.trim() ?? "";
    return Boolean(t) && !isHostNoteCopy(t);
  }) as TextElement | undefined;
  const title = classroomTitle(titleEl?.content?.text ?? texts[0], brief, kind);
  const rest = texts.filter((t) => t !== title).join("\n");
  let lines = firstLines(rest, 6);
  if (!lines.length) lines = fallbackLines(brief, kind);
  return { title, lines };
}

function fallbackLines(brief: string, kind: RecipeKind): string[] {
  if (/种子|发芽|萌芽/.test(brief)) {
    switch (kind) {
      case "cover":
        return ["二年级科学课", "看一粒种子怎样醒来"];
      case "route":
        return ["先喝饱水", "种皮裂开", "小根钻出来", "芽顶出土"];
      case "concept":
        return ["种皮保护里面的小生命。", "胚以后会变成根和叶。", "子叶是出发前的便当。"];
      case "method":
        return ["要喝水", "要呼吸", "要暖一暖"];
      case "demo":
        return ["还在睡觉：种皮完整，没有根。", "已经醒来：种皮裂开，钻出小芽。"];
      case "transfer":
        return ["回家找一粒种子，放在湿棉花上，看它会不会醒来。"];
    }
  }
  if (kind === "route") return ["先看问题", "拆开步骤", "对照检查"];
  if (kind === "method") return ["先认对象", "再记规则", "最后检查"];
  if (kind === "demo") return ["还没做对的样子", "做对之后的样子"];
  if (kind === "concept") return ["先说它是什么。", "再说边界在哪里。", "再用一个例子钉住。"];
  return ["看图，指一指，再说给旁边的人听。"];
}

function isChromeCopy(text: string, elementId?: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^[0-9]{1,2}$/.test(t) || /^\d{2}\/\d{2}$/.test(t)) return true;
  if (/^«|｜/.test(t) || /种子发芽｜/.test(t)) return true;
  if (
    elementId === "chapter" ||
    elementId === "footer" ||
    elementId === "guillemets" ||
    elementId === "chip" ||
    elementId?.startsWith("well-n") ||
    elementId?.startsWith("step-n")
  ) {
    return true;
  }
  return false;
}

/** One official name+note set per page type. Never mash leftovers onto a second list. */
export function officialCopyPairs(brief: string, kind: RecipeKind): Array<{ name: string; note: string }> {
  if (/种子|发芽|萌芽/.test(brief)) {
    if (kind === "route") {
      return [
        { name: "先喝饱水", note: "种皮喝饱了才会软。" },
        { name: "种皮裂开", note: "软了之后，壳会裂开一条缝。" },
        { name: "小根钻出来", note: "小根先出来，抓住下面。" },
        { name: "芽顶出土", note: "芽再往上顶，钻出土。" },
      ];
    }
    if (kind === "concept") {
      return [
        { name: "种皮", note: "外衣，保护里面的小生命。" },
        { name: "子叶", note: "出发前的便当，给小苗吃。" },
        { name: "胚", note: "以后会变成根和叶。" },
      ];
    }
    if (kind === "method") {
      return [
        { name: "要喝水", note: "没有水，种皮不会软。" },
        { name: "要呼吸", note: "没有空气，胚不能呼吸。" },
        { name: "要暖一暖", note: "太冷了，它会再睡一会儿。" },
      ];
    }
  }
  const lines = fallbackLines(brief, kind);
  return lines.map((name) => ({ name, note: "" }));
}

export function kindCopyMatches(elements: PptdElement[], kind: RecipeKind, brief: string): boolean {
  const blob = elements
    .filter((el) => el.elementType === "text")
    .map((el) => (el as TextElement).content?.text ?? "")
    .join("\n");
  if (kind === "route") {
    if (elements.some((el) => el.elementId === "panel-0")) return false;
    if (/认识种子|发芽条件|小小的身躯|缺一不可/.test(blob)) return false;
    const names = elements
      .filter((el) => el.elementId.startsWith("item-n-"))
      .map((el) => ((el as TextElement).content?.text ?? "").trim());
    if (names.some((t) => /^[0-9]{1,2}$/.test(t))) return false;
    const officialPath =
      elements.some((el) => el.elementId === "path-spine") &&
      elements.some((el) => el.elementId === "step-0") &&
      names.length >= 2;
    if (officialPath) return true;
    if (/种子|发芽/.test(brief) && !/先喝饱水/.test(blob)) return false;
    return true;
  }
  if (kind === "concept") {
    if (/适量的水|充足的空气|合适的温度/.test(blob)) return false;
    if (/它由三部分组成/.test(blob) && /水|空气|温度/.test(blob) && !/种皮/.test(blob)) {
      return false;
    }
    if (/种子|发芽/.test(brief) && !/种皮/.test(blob)) return false;
    return true;
  }
  return true;
}

function gradeChip(brief: string): string {
  const m = brief.match(/([一二三四五六七八九十])年级/);
  return m ? `${m[1]}年级` : "课堂";
}

function shortDocName(brief: string): string {
  if (/种子|发芽/.test(brief)) return "种子发芽";
  return (
    brief
      .replace(/^给.+讲一讲/, "")
      .replace(/[。！？].*$/, "")
      .trim()
      .slice(0, 8) || "课堂"
  );
}

export function recipeKind(page: SkillPageInput, index: number): RecipeKind {
  const t = (page.pageType || "").toLowerCase();
  if (t === "cover") return "cover";
  if (t === "close" || t === "takeaway" || t === "transfer") return "transfer";
  if (t === "path" || t === "toc" || t === "route") return "route";
  if (t === "concept") return "concept";
  if (t === "remember" || t === "method") return "method";
  if (t === "exhibit" || t === "demo" || t === "comparison" || t === "practice") return "demo";
  if (index === 0) return "cover";
  if (index === 1) return "route";
  if (index === 2) return "concept";
  if (index === 3) return "method";
  if (index === 4) return "demo";
  return "transfer";
}

function officialPageType(kind: RecipeKind): string {
  switch (kind) {
    case "cover":
      return "cover";
    case "route":
      return "route";
    case "concept":
      return "concept";
    case "method":
      return "method";
    case "demo":
      return "demo";
    case "transfer":
      return "transfer";
  }
}

function chrome(copyTitle: string, chapter: string, footerName: string, pageNo: string): PptdElement[] {
  return [
    shape("rule", "rect", [48, 88, 72, 6], PAPER_WHITE.coral),
    label("title", [48, 28, 720, 52], copyTitle, {
      size: 32,
      color: PAPER_WHITE.title,
      bold: true,
    }),
    label("chapter", [820, 16, 108, 72], chapter, {
      size: 56,
      color: PAPER_WHITE.coral,
      bold: true,
    }),
    label("guillemets", [48, 508, 40, 20], "« »", { size: 12, color: PAPER_WHITE.muted }),
    label("footer", [640, 508, 280, 20], `${footerName}｜${pageNo}`, {
      size: 12,
      color: PAPER_WHITE.muted,
    }),
  ];
}

function coverSub(copy: ReturnType<typeof pageCopy>, brief: string): string {
  const line = (copy.lines[0] ?? "").trim();
  if (!line || line.length > 16 || /让我们一起/.test(line) || /[。！]/.test(line)) {
    return fallbackLines(brief, "cover")[1] ?? "看一粒种子怎样醒来";
  }
  return line;
}

function seatedOnBand(el: PptdElement | undefined, band: PptdElement | undefined): boolean {
  if (!el || !band) return false;
  return (
    el.bounds[1] >= band.bounds[1] - 4 &&
    el.bounds[1] + el.bounds[3] <= band.bounds[1] + band.bounds[3] + 8 &&
    el.bounds[0] >= band.bounds[0] - 4
  );
}

function coverTitleSeated(elements: PptdElement[]): boolean {
  const band = elements.find((el) => el.elementId === "title-band");
  const title = elements.find((el) => el.elementId === "title" && el.elementType === "text") as TextElement | undefined;
  return seatedOnBand(title, band);
}

function coverNoImage(copy: ReturnType<typeof pageCopy>, brief: string): PptdElement[] {
  return [
    shape("circle", "ellipse", [-70, -30, 430, 430], PAPER_WHITE.blush),
    shape("title-band", "rect", [36, 348, 560, 156], PAPER_WHITE.leaf),
    shape("band-mark", "rect", [36, 348, 12, 156], PAPER_WHITE.coral),
    label("chip", [64, 364, 120, 24], gradeChip(brief), {
      size: 14,
      color: PAPER_WHITE.title,
      bold: true,
    }),
    label("title", [64, 392, 500, 64], copy.title, {
      size: 32,
      color: PAPER_WHITE.title,
      bold: true,
    }),
    label("sub", [64, 458, 500, 32], coverSub(copy, brief), { size: 16, color: PAPER_WHITE.body }),
    label("guillemets", [48, 508, 40, 20], "« »", { size: 12, color: PAPER_WHITE.muted }),
    label("footer", [640, 508, 280, 20], `${shortDocName(brief)}｜01`, {
      size: 12,
      color: PAPER_WHITE.muted,
    }),
  ];
}

function coverPhoto(copy: ReturnType<typeof pageCopy>, brief: string, src: string): PptdElement[] {
  return [
    {
      elementId: "photo-band",
      elementType: "image",
      bounds: [0, 0, 960, 220],
      src,
    } as PptdElement,
    shape("title-band", "rect", [36, 248, 560, 220], PAPER_WHITE.leaf),
    shape("band-mark", "rect", [36, 248, 12, 220], PAPER_WHITE.coral),
    label("chip", [64, 268, 120, 24], gradeChip(brief), {
      size: 14,
      color: PAPER_WHITE.title,
      bold: true,
    }),
    label("title", [64, 304, 500, 80], copy.title, {
      size: 34,
      color: PAPER_WHITE.title,
      bold: true,
    }),
    label("sub", [64, 396, 500, 48], coverSub(copy, brief), { size: 16, color: PAPER_WHITE.body }),
    label("guillemets", [48, 508, 40, 20], "« »", { size: 12, color: PAPER_WHITE.muted }),
    label("footer", [640, 508, 280, 20], `${shortDocName(brief)}｜01`, {
      size: 12,
      color: PAPER_WHITE.muted,
    }),
  ];
}

function listPanels(items: Array<{ name: string; note: string }>, y0: number): PptdElement[] {
  const els: PptdElement[] = [];
  const h = items.length >= 4 ? 78 : 96;
  items.forEach((item, i) => {
    const y = y0 + i * (h + 10);
    const fill = i % 2 ? PAPER_WHITE.blush : PAPER_WHITE.leaf;
    els.push(shape(`panel-${i}`, "roundRect", [48, y, 864, h], fill));
    els.push(shape(`well-${i}`, "ellipse", [68, y + (h - 48) / 2, 48, 48], PAPER_WHITE.white));
    els.push(
      label(`well-n-${i}`, [68, y + (h - 28) / 2, 48, 28], String(i + 1).padStart(2, "0"), {
        size: 16,
        color: PAPER_WHITE.coral,
        bold: true,
      }),
    );
    els.push(
      label(`item-n-${i}`, [136, y + 12, 740, 28], item.name, {
        size: 18,
        color: PAPER_WHITE.title,
        bold: true,
      }),
    );
    els.push(
      label(`item-d-${i}`, [136, y + 42, 740, 28], item.note, {
        size: 15,
        color: PAPER_WHITE.body,
      }),
    );
  });
  return els;
}

function routePage(copy: ReturnType<typeof pageCopy>, brief: string, pageNo: string): PptdElement[] {
  const items = officialCopyPairs(brief, "route").slice(0, 4);
  const els: PptdElement[] = [
    ...chrome(copy.title, "02", shortDocName(brief), pageNo),
    shape("path-spine", "rect", [77, 124, 4, 348], PAPER_WHITE.coral),
  ];
  items.forEach((item, i) => {
    const y = 112 + i * 92;
    els.push(shape(`step-${i}`, "ellipse", [58, y + 10, 42, 42], PAPER_WHITE.blush));
    els.push(
      label(`step-n-${i}`, [58, y + 16, 42, 28], String(i + 1).padStart(2, "0"), {
        size: 14,
        color: PAPER_WHITE.coral,
        bold: true,
      }),
    );
    els.push(
      label(`item-n-${i}`, [124, y + 6, 760, 32], item.name, {
        size: 22,
        color: PAPER_WHITE.title,
        bold: true,
      }),
    );
    els.push(
      label(`item-d-${i}`, [124, y + 42, 760, 32], item.note, {
        size: 16,
        color: PAPER_WHITE.body,
      }),
    );
  });
  return els;
}

function conceptPage(copy: ReturnType<typeof pageCopy>, brief: string, pageNo: string): PptdElement[] {
  const parts = officialCopyPairs(brief, "concept");
  const lines = parts.map((p) => `${p.name}：${p.note}`);
  return [
    ...chrome(copy.title, "03", shortDocName(brief), pageNo),
    label("lead", [48, 116, 400, 72], "先记住这一句：种子不是空的，里面已经带着明天的植物。", {
      size: 16,
      color: PAPER_WHITE.body,
    }),
    label("col-h", [48, 200, 400, 28], "它由三部分组成", {
      size: 16,
      color: PAPER_WHITE.title,
      bold: true,
    }),
    label("l1", [48, 236, 400, 72], lines[0] ?? "种皮：外衣，保护里面的小生命。", {
      size: 16,
      color: PAPER_WHITE.body,
    }),
    label("l2", [48, 316, 400, 72], lines[1] ?? "子叶：出发前的便当，给小苗吃。", {
      size: 16,
      color: PAPER_WHITE.body,
    }),
    label("l3", [48, 396, 400, 72], lines[2] ?? "胚：以后会变成根和叶。", {
      size: 16,
      color: PAPER_WHITE.body,
    }),
    shape("aside", "rect", [480, 116, 432, 360], PAPER_WHITE.leaf),
    shape("aside-rule", "rect", [480, 116, 432, 8], PAPER_WHITE.coral),
    label("aside-h", [500, 136, 392, 28], "组成，而不是装饰", {
      size: 16,
      color: PAPER_WHITE.title,
      bold: true,
    }),
    shape("ring-outer", "ellipse", [560, 196, 200, 140], PAPER_WHITE.blush),
    shape("ring-mid", "ellipse", [600, 228, 120, 76], PAPER_WHITE.white),
    shape("ring-in", "ellipse", [636, 248, 48, 36], PAPER_WHITE.title),
    label("a1", [500, 352, 392, 36], "外圈种皮 · 中圈子叶 · 中间胚", {
      size: 14,
      color: PAPER_WHITE.body,
    }),
    label("a2", [500, 392, 392, 60], "指着三个部分说一遍，再说给旁边的人听。", {
      size: 14,
      color: PAPER_WHITE.body,
    }),
  ];
}

function methodPage(copy: ReturnType<typeof pageCopy>, brief: string, pageNo: string): PptdElement[] {
  const items = officialCopyPairs(brief, "method").slice(0, 3);
  return [...chrome(copy.title, "04", shortDocName(brief), pageNo), ...listPanels(items, 120)];
}

function demoPage(copy: ReturnType<typeof pageCopy>, brief: string, pageNo: string): PptdElement[] {
  const left = copy.lines[0] ?? fallbackLines(brief, "demo")[0]!;
  const right = copy.lines[1] ?? fallbackLines(brief, "demo")[1] ?? copy.lines[0] ?? "";
  return [
    shape("pink-band", "rect", [0, 0, 960, 108], PAPER_WHITE.blush),
    label("title", [48, 28, 720, 52], copy.title, {
      size: 30,
      color: PAPER_WHITE.title,
      bold: true,
    }),
    label("chapter", [820, 24, 108, 60], "05", {
      size: 48,
      color: PAPER_WHITE.coral,
      bold: true,
    }),
    shape("col-l", "rect", [48, 128, 420, 236], PAPER_WHITE.leaf),
    shape("col-r", "rect", [492, 128, 420, 236], PAPER_WHITE.leaf),
    label("lh", [68, 144, 380, 28], "还在睡觉", {
      size: 18,
      color: PAPER_WHITE.title,
      bold: true,
    }),
    label("rh", [512, 144, 380, 28], "已经醒来", {
      size: 18,
      color: PAPER_WHITE.title,
      bold: true,
    }),
    label("lb", [68, 184, 380, 160], left, { size: 16, color: PAPER_WHITE.body }),
    label("rb", [512, 184, 380, 160], right, { size: 16, color: PAPER_WHITE.body }),
    shape("result-bar", "rect", [48, 384, 864, 108], PAPER_WHITE.title),
    label("result-k", [72, 400, 520, 28], "看这一处就够了", {
      size: 14,
      color: PAPER_WHITE.white,
    }),
    label("result-v", [72, 432, 520, 40], "裂开，并且钻出小根", {
      size: 22,
      color: PAPER_WHITE.white,
      bold: true,
    }),
    label("result-n", [620, 404, 260, 68], "醒来", {
      size: 40,
      color: PAPER_WHITE.coral,
      bold: true,
    }),
    label("guillemets", [48, 508, 40, 20], "« »", { size: 12, color: PAPER_WHITE.muted }),
    label("footer", [640, 508, 280, 20], `${shortDocName(brief)}｜${pageNo}`, {
      size: 12,
      color: PAPER_WHITE.muted,
    }),
  ];
}

function transferPage(copy: ReturnType<typeof pageCopy>, brief: string, pageNo: string): PptdElement[] {
  return [
    shape("result-bar", "rect", [48, 36, 864, 120], PAPER_WHITE.title),
    label("result-k", [72, 52, 600, 28], "离开教室以后", {
      size: 14,
      color: PAPER_WHITE.white,
    }),
    label("title", [72, 84, 800, 52], copy.title, {
      size: 28,
      color: PAPER_WHITE.white,
      bold: true,
    }),
    shape("panel", "rect", [48, 176, 864, 300], PAPER_WHITE.leaf),
    shape("panel-rule", "rect", [48, 176, 864, 8], PAPER_WHITE.coral),
    label("body", [72, 204, 800, 160], copy.lines.join("\n"), {
      size: 18,
      color: PAPER_WHITE.body,
    }),
    label("check-h", [72, 372, 800, 28], "怎么才算做完", {
      size: 16,
      color: PAPER_WHITE.title,
      bold: true,
    }),
    label("check", [72, 404, 800, 48], "找到种子 · 保持湿润 · 连续看三天 · 画出你看见的变化", {
      size: 16,
      color: PAPER_WHITE.body,
    }),
    label("chapter", [820, 16, 108, 72], "06", {
      size: 48,
      color: PAPER_WHITE.coral,
      bold: true,
    }),
    label("guillemets", [48, 508, 40, 20], "« »", { size: 12, color: PAPER_WHITE.muted }),
    label("footer", [640, 508, 280, 20], `${shortDocName(brief)}｜${pageNo}`, {
      size: 12,
      color: PAPER_WHITE.muted,
    }),
  ];
}

function pageNoOf(index: number, count?: number): string {
  const n = Math.max(count ?? index + 1, index + 1);
  return String(index + 1).padStart(2, "0") + "/" + String(n).padStart(2, "0");
}

export function paintOfficialRecipePage(page: SkillPageInput, opts: RecipeOpts): SkillPageInput {
  const kind = recipeKind(page, opts.index);
  const copy = pageCopy(page, opts.brief, kind);
  const pageNo = pageNoOf(opts.index, opts.pageCount);
  let elements: PptdElement[];
  if (kind === "cover" && opts.imageSrc && opts.imageAvailable !== false) {
    elements = coverPhoto(copy, opts.brief, opts.imageSrc);
  } else if (kind === "cover") {
    elements = coverNoImage(copy, opts.brief);
  } else if (kind === "route") {
    elements = routePage(copy, opts.brief, pageNo);
  } else if (kind === "concept") {
    elements = conceptPage(copy, opts.brief, pageNo);
  } else if (kind === "method") {
    elements = methodPage(copy, opts.brief, pageNo);
  } else if (kind === "demo") {
    elements = demoPage(copy, opts.brief, pageNo);
  } else {
    elements = transferPage(copy, opts.brief, pageNo);
  }
  return {
    id: page.id,
    pageType: officialPageType(kind),
    notes: page.notes,
    background: { type: "solid", color: PAPER_WHITE.paper },
    elements,
  };
}

function shapeName(el: PptdElement): string {
  return el.elementType === "shape" ? String((el as ShapeElement).shapeName || "").toLowerCase() : "";
}

function hexOf(el: PptdElement): string {
  if (el.elementType !== "shape") return "";
  const fill = (el as ShapeElement).fill;
  if (fill && typeof fill === "object" && "color" in fill) {
    return String((fill as { color?: string }).color || "").toUpperCase();
  }
  return "";
}

/** Homemade 4-step numbered circles in a row — forbidden when list/tool exists. */
export function hasHomemadeFourCircles(elements: PptdElement[]): boolean {
  const circles = elements.filter((el) => {
    if (shapeName(el) !== "ellipse") return false;
    const [, , w, h] = el.bounds;
    return w >= 70 && w <= 130 && h >= 70 && h <= 130;
  });
  if (circles.length < 4) return false;
  const ys = circles.map((el) => el.bounds[1]).sort((a, b) => a - b);
  const band = circles.filter((el) => Math.abs(el.bounds[1] - ys[0]!) < 48);
  if (band.length < 4) return false;
  const xs = band.map((el) => el.bounds[0]).sort((a, b) => a - b);
  return xs[3]! - xs[0]! >= 400;
}

/** Soil / sun / sprout cartoon — not an official recipe. */
export function hasKidsDoodle(elements: PptdElement[]): boolean {
  const ids = elements.map((el) => el.elementId).join(" ");
  if (/\b(soil|sprout|cover-sun|need-sun|before-sun|after-sun)\b/.test(ids)) return true;
  const suns = elements.filter((el) => shapeName(el) === "ellipse" && hexOf(el) === "#F4C542");
  const soils = elements.filter((el) => /soil|#8B5A2B/i.test(`${el.elementId}${hexOf(el)}`));
  return suns.length >= 1 && soils.length >= 1;
}

/** Kind-specific official finish. List pills alone are not a concept/cover recipe. */
export function hasOfficialRecipeKind(elements: PptdElement[], kind: RecipeKind): boolean {
  const ids = new Set(elements.map((el) => el.elementId));
  if (kind === "cover") {
    const ellipses = elements.filter((el) => shapeName(el) === "ellipse");
    const giant = ellipses.filter((el) => el.bounds[2] >= 280 && el.bounds[3] >= 280);
    const extras = ellipses.filter((el) => el.bounds[2] < 280);
    const chip = elements.find((el) => el.elementId === "chip");
    const band = elements.find((el) => el.elementId === "title-band");
    const junkAbove = elements.some((el) => {
      if (!band || el.elementType !== "text") return false;
      const text = el as TextElement;
      const t = text.content?.text ?? "";
      if (/让我们一起/.test(t) || /[。！]/.test(t)) return true;
      if (seatedOnBand(el, band)) return false;
      return (
        el.bounds[1] + el.bounds[3] < band.bounds[1] && text.elementId !== "guillemets" && text.elementId !== "footer"
      );
    });
    return (
      giant.length === 1 &&
      extras.length === 0 &&
      ids.has("title-band") &&
      ids.has("chip") &&
      ids.has("title") &&
      coverTitleSeated(elements) &&
      seatedOnBand(chip, band) &&
      !junkAbove
    );
  }
  if (kind === "route") {
    return ids.has("rule") && ids.has("chapter") && ids.has("path-spine") && ids.has("step-0") && !ids.has("panel-0");
  }
  if (kind === "method") {
    return ids.has("rule") && ids.has("chapter") && ids.has("panel-0") && ids.has("well-0");
  }
  if (kind === "concept") {
    return ids.has("aside") && ids.has("ring-outer") && ids.has("rule");
  }
  if (kind === "demo") {
    return ids.has("pink-band") && ids.has("result-bar");
  }
  if (kind === "transfer") {
    return ids.has("result-bar") && ids.has("panel-rule");
  }
  return false;
}

export function hasOfficialRecipe(elements: PptdElement[], kind?: RecipeKind): boolean {
  if (kind) return hasOfficialRecipeKind(elements, kind);
  const ids = new Set(elements.map((el) => el.elementId));
  if (ids.has("circle") && ids.has("title-band") && coverTitleSeated(elements)) return true;
  if (ids.has("rule") && ids.has("chapter") && ids.has("path-spine") && ids.has("step-0")) return true;
  if (ids.has("rule") && ids.has("chapter") && ids.has("panel-0") && ids.has("well-0")) return true;
  if (ids.has("aside") && ids.has("ring-outer")) return true;
  if (ids.has("pink-band") && ids.has("result-bar")) return true;
  if (ids.has("result-bar") && ids.has("panel-rule")) return true;

  const shapes = elements.filter((el) => el.elementType === "shape");
  const giant = shapes.some((el) => shapeName(el) === "ellipse" && el.bounds[2] >= 280 && el.bounds[3] >= 280);
  const titleBand = shapes.some((el) => el.elementId === "title-band" && el.bounds[1] >= 240 && el.bounds[2] >= 400);
  const coralRule = shapes.some(
    (el) => shapeName(el) === "rect" && hexOf(el) === "#F5987E" && el.bounds[2] <= 120 && el.bounds[3] <= 16,
  );
  const palePanels = shapes.filter((el) => {
    const hex = hexOf(el);
    const name = shapeName(el);
    return (
      (name === "roundrect" || name === "round_rect" || name === "rect") &&
      (hex === "#D7EBCE" || hex === "#F9DED8") &&
      el.bounds[2] >= 700 &&
      el.bounds[3] >= 60 &&
      el.bounds[3] <= 140
    );
  });
  const wells = shapes.filter((el) => shapeName(el) === "ellipse" && hexOf(el) === "#FFFFFF" && el.bounds[2] <= 64);
  const resultBar = shapes.some(
    (el) => hexOf(el) === "#44712E" && el.bounds[2] >= 700 && el.bounds[3] >= 80 && el.bounds[3] <= 160,
  );
  const pinkBand = shapes.some(
    (el) => hexOf(el) === "#F9DED8" && el.bounds[0] <= 2 && el.bounds[2] >= 900 && el.bounds[3] <= 140,
  );
  if (giant && titleBand) return true;
  if (coralRule && palePanels.length >= 3 && wells.length >= 3) return true;
  if (resultBar && pinkBand) return true;
  return false;
}

function pageHasCopy(page: SkillPageInput): boolean {
  return page.elements.some((el) => {
    if (el.elementType !== "text") return false;
    const t = (el as TextElement).content?.text?.trim() ?? "";
    return Boolean(t) && !isHostNoteCopy(t);
  });
}

function isTriangleExhibit(el: PptdElement): boolean {
  const id = el.elementId.toLowerCase();
  const name = shapeName(el);
  return id.includes("triangle") || name.includes("triangle");
}

/** Keep a real exhibit (勾股 triangle / chart / table / photo). Homemade ellipses are not an exhibit. */
function hasKeptExhibit(elements: PptdElement[]): boolean {
  if (elements.some((el) => el.elementType === "image" || el.elementType === "table" || el.elementType === "chart")) {
    return true;
  }
  return elements.some(isTriangleExhibit);
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
}

function rewriteHostNoteTitles(page: SkillPageInput, opts: RecipeOpts): SkillPageInput {
  const kind = recipeKind(page, opts.index);
  const copy = pageCopy(page, opts.brief, kind);
  let changed = false;
  const elements = page.elements.map((el) => {
    if (el.elementType !== "text") return el;
    const text = el as TextElement;
    const raw = text.content?.text ?? "";
    if (!isHostNoteCopy(raw)) return el;
    changed = true;
    const next =
      text.elementId === "title" || text.content?.bold
        ? fallbackTitle(opts.brief, kind)
        : (copy.lines[0] ?? fallbackTitle(opts.brief, kind));
    return { ...text, content: { ...text.content, text: next, wrap: text.content?.wrap ?? true } };
  });
  return changed ? { ...page, elements } : page;
}

/** Keep the agent's official chrome. Make the visible title a short whole classroom line. */
function rewriteClassroomTitles(page: SkillPageInput, opts: RecipeOpts): SkillPageInput {
  const kind = recipeKind(page, opts.index);
  const titleEl = page.elements.find((el) => el.elementType === "text" && el.elementId === "title") as
    TextElement | undefined;
  const firstText = page.elements.find((el) => el.elementType === "text") as TextElement | undefined;
  const raw = (titleEl ?? firstText)?.content?.text?.trim() ?? "";
  const looksLikeTitle =
    Boolean(titleEl) || (Boolean(raw) && (raw.length <= 24 || isFragmentTitle(raw) || /[？?]/.test(raw)));
  const target = looksLikeTitle ? (titleEl ?? firstText) : undefined;
  const nextTitle = target ? classroomTitle(target.content?.text, opts.brief, kind) : "";
  let changed = false;
  let elements = page.elements.map((el) => {
    if (!target || el !== target) return el;
    const text = el as TextElement;
    if (text.content?.text?.trim() === nextTitle && text.elementId === "title") return el;
    changed = true;
    return {
      ...text,
      elementId: "title",
      content: { ...text.content, text: nextTitle, wrap: true, bold: true },
    };
  });

  if (kind === "cover") {
    const band = elements.find((el) => el.elementId === "title-band");
    const title = elements.find((el) => el.elementType === "text" && el.elementId === "title") as
      TextElement | undefined;
    if (band && title) {
      const seated: Bounds = [
        band.bounds[0] + 28,
        band.bounds[1] + 40,
        Math.max(200, band.bounds[2] - 48),
        Math.min(64, Math.max(40, band.bounds[3] - 56)),
      ];
      if (title.bounds[1] + 8 < band.bounds[1] || title.bounds[2] > band.bounds[2] || title.bounds[3] > 80) {
        elements = elements.map((el) => {
          if (el.elementId !== "title" || el.elementType !== "text") return el;
          const text = el as TextElement;
          return {
            ...text,
            bounds: seated,
            content: { ...text.content, color: text.content.color ?? "#44712E" },
          };
        });
        changed = true;
      }
      const titleIdx = elements.findIndex((el) => el.elementId === "title" && el.elementType === "text");
      const bandIdx = elements.findIndex((el) => el.elementId === "title-band");
      if (titleIdx >= 0 && bandIdx >= 0 && titleIdx < bandIdx) {
        const [moved] = elements.splice(titleIdx, 1);
        const nextBand = elements.findIndex((el) => el.elementId === "title-band");
        elements.splice(nextBand + 1, 0, moved!);
        changed = true;
      }
      elements = elements.map((el) => {
        if (el.elementType !== "text" || el.elementId === "title" || el.elementId === "chip") return el;
        const text = el as TextElement;
        if (!boundsOverlap(text.bounds, band.bounds)) return el;
        const gap = 8;
        const nextH = Math.max(24, band.bounds[1] - text.bounds[1] - gap);
        if (nextH >= text.bounds[3]) return el;
        changed = true;
        return { ...text, bounds: [text.bounds[0], text.bounds[1], text.bounds[2], nextH] };
      });
    }
  }
  return changed ? { ...page, elements } : page;
}

function writtenStepNames(page: SkillPageInput): string[] {
  return page.elements
    .filter((el) => el.elementType === "text")
    .map((el) => (el as TextElement).content?.text?.trim() ?? "")
    .filter((t) => t && !isHostNoteCopy(t) && !isGradeChip(t) && !/^[0-9]{1,2}$/.test(t) && t.length <= 18);
}

/** Title rewrite only. Never replace the agent's written elements with a host recipe. */
export function keepWrittenClassroomPage(
  page: SkillPageInput,
  opts: RecipeOpts,
): { page: SkillPageInput; applied: boolean; painted: false; restamped: false } {
  const next = rewriteClassroomTitles(rewriteHostNoteTitles(page, opts), opts);
  return { page: next, applied: next !== page, painted: false, restamped: false };
}

/** Keep the agent's official header/list/box page. Only fix titles. Do not restamp leftovers. */
export function ensureOfficialRecipePage(
  page: SkillPageInput,
  opts: RecipeOpts,
): { page: SkillPageInput; applied: boolean; painted: boolean } {
  const cleaned = rewriteClassroomTitles(rewriteHostNoteTitles(page, opts), opts);
  if (hasHomemadeFourCircles(cleaned.elements)) {
    const names = writtenStepNames(cleaned);
    const next = paintOfficialRecipePage(
      {
        ...cleaned,
        pageType: cleaned.pageType || "route",
        elements: names.length
          ? names.map((name, i) => ({
              elementId: `item-${i}`,
              elementType: "text" as const,
              bounds: [48, 120 + i * 40, 800, 32] as Bounds,
              content: { text: name, wrap: true },
            }))
          : cleaned.elements,
      },
      opts,
    );
    return { page: next, applied: true, painted: false };
  }
  if (hasKidsDoodle(cleaned.elements)) {
    const copy = writtenStepNames(cleaned);
    const next = paintOfficialRecipePage(
      {
        ...cleaned,
        elements: copy.length
          ? copy.map((name, i) => ({
              elementId: i === 0 ? "title" : `line-${i}`,
              elementType: "text" as const,
              bounds: [48, 36 + i * 48, 800, 40] as Bounds,
              content: { text: name, wrap: true, bold: i === 0 },
            }))
          : cleaned.elements.filter((el) => el.elementType === "text"),
      },
      opts,
    );
    return { page: next, applied: true, painted: false };
  }
  const kind = recipeKind(cleaned, opts.index);
  if (
    hasOfficialRecipeKind(cleaned.elements, kind) &&
    pageHasCopy(cleaned) &&
    kindCopyMatches(cleaned.elements, kind, opts.brief)
  ) {
    const applied = cleaned !== page;
    return { page: cleaned, applied, painted: false };
  }
  if (hasKeptExhibit(cleaned.elements) && pageHasCopy(cleaned)) {
    const applied = cleaned !== page;
    return { page: cleaned, applied, painted: false };
  }
  const next = paintOfficialRecipePage(cleaned, opts);
  return { page: next, applied: true, painted: false };
}

export { officialRecipesMarkdown } from "./playbook-recipes-doc.js";

export function isCoursewareBodyPage(page: SkillPageInput, index: number, last: number): boolean {
  const t = (page.pageType || "").toLowerCase();
  if (t === "cover" || t === "close" || t === "toc" || t === "transfer") return false;
  if (index === 0 || index === last) return false;
  return true;
}
