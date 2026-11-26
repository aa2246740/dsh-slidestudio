import fs from "node:fs";
import path from "node:path";
import type { DesignAspect } from "./design-aspects.js";
import { authorityCatalogPackId, readDesignAuthority } from "./design-authority.js";

// Keep these product names aligned with the Hub; a parity test checks the public catalog labels.
const STYLE_NAMES: Readonly<Record<string, string>> = {
  "consulting/apricot-white-brief": "杏白简报",
  "consulting/indigo-due-diligence": "靛蓝尽调",
  "consulting/marine-blue-research": "海蓝研究",
  "consulting/moss-green-transformation": "苔绿转型",
  "consulting/pine-green-strategy": "松绿战略",
  "consulting/red-black-growth": "红黑增长",
  "finance/black-gold-ledger": "黑金台账",
  "finance/ebony-ledger": "乌木台账",
  "finance/honey-orange-memo": "蜜橙备忘",
  "finance/lake-blue-memo": "湖蓝备忘",
  "finance/prospect-annual": "展望年报",
  "finance/rice-paper-annual": "宣纸年报",
  "work/blue-flame-brand": "蓝焰品牌",
  "work/electric-violet-business": "电紫商务",
  "work/moon-white-imagery": "月白影像",
  "work/sky-blue-wayfinding": "天蓝导向",
  "work/warm-clay-works": "暖陶作品",
  "work/warm-jade-annual-report": "暖玉年报",
  "promotion/aqua-charity-report": "水色公益",
  "promotion/cream-collage": "奶油拼贴",
  "promotion/pine-soot-pictorial": "松烟画报",
  "promotion/silk-yellow-magazine": "丝黄杂志",
  "promotion/silver-gray-luxury-magazine": "银灰杂志",
  "promotion/travel-green-handbook": "旅行手册",
  "academic/blue-line-courseware": "蓝线课件",
  "academic/deep-blue-atlas": "深蓝图集",
  "academic/paper-white-courseware": "纸白课件",
  "academic/pastel-derivation": "粉彩推导",
  "academic/teal-green-academic-defense": "青绿答辩",
  "academic/wine-red-data": "酒红数据",
  "extra/color-stripes-documentary": "彩条纪实",
  "extra/dark-themed-data": "深色数据",
  "extra/dusk-violet-consulting": "暮紫咨询",
  "extra/fresh-brand": "清新品牌",
  "extra/gold-orange-type-journal": "金橙刊物",
  "extra/ink-green-market-trends": "墨绿趋势",
  "extra/lead-gray-quarterly": "铅灰季报",
  "extra/map-strategy": "地图战略",
  "extra/mist-blue-travelogue": "雾蓝游记",
  "extra/orange-tech": "橙色科技",
  "extra/pink-purple-diagnosis": "粉紫诊断",
  "extra/red-black-business": "红黑商务",
  "extra/red-white-business": "红白商务",
  "extra/xuan-paper-annual": "宣纸年刊",
};

export function stylePackDisplayName(id: string): string {
  return STYLE_NAMES[id] ?? id;
}

/**
 * Structured request/runtime only; attachment or brief wording never grants style authority.
 * A valid current authority replaces the Hub pack; a material authority means no catalog
 * pack governs, and `hub-choice` keeps the original Hub choice.
 */
export function selectedStylePackId(root: string, requested?: string): string | undefined {
  if (requested !== undefined) {
    const explicit = requested.trim();
    return explicit && explicit !== "freestyle" ? explicit : undefined;
  }
  let hub: unknown;
  const file = path.join(root, "_agent", "runtime.json");
  if (fs.existsSync(file)) {
    hub = (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>).designSystemId;
  }
  const hubId = typeof hub === "string" ? hub.trim() : "";
  const reading = readDesignAuthority(root);
  const effective = reading.kind === "valid" ? authorityCatalogPackId(reading.authority, hubId) : hubId;
  return effective && effective !== "freestyle" ? effective : undefined;
}

export function attachmentStylePriorityRefusal(
  packId: string | undefined,
  name: string,
  aspects: readonly DesignAspect[],
): string | undefined {
  if (!packId || !aspects.some((aspect) => ["palette", "fonts", "decorations"].includes(aspect))) {
    return undefined;
  }
  return (
    `你在首页选择了风格「${stylePackDisplayName(packId)}」，配色和字体以该风格为准；` +
    `附件「${name}」可用于 Logo、照片、内容和数据，版式仅作参考。` +
    "若用户明确要求按该附件风格制作，请按用户原话或本轮有效回答声明 designAuthority: material:<id>，并声明对应的视觉用途；不要让用户回首页改设置。"
  );
}
