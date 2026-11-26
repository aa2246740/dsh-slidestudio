/**
 *  Style-pack display names shared by the Hub picker and the editor's restored style-priority hint, so one pack always reads under the same name.
 */

/** @typedef {Readonly<{label?: string, title?: string}>} NamedStyle */

/** Hub display names; the catalog's label is the fallback. */
export const STYLE_NAME_TABLE = {
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

export const STYLE_NAMES = new Map(Object.entries(STYLE_NAME_TABLE));

/** One display-name rule for every surface that names a style pack.
 * @param {string} styleId @param {NamedStyle|undefined} style */
export function styleDisplayName(styleId, style) {
  return STYLE_NAMES.get(styleId) || style?.label || style?.title || styleId;
}
