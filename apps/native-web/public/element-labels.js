import { t } from "./i18n.js";

/** @type {Record<string, string>} */
export const SHAPE_GROUP_LABELS = {
  "Basic Shapes": t("基本形状"),
  "Rectangle Variants": t("矩形"),
  "Stars and Bursts": t("星形"),
  "Arrow Shapes": t("箭头"),
  "Arrow Callouts": t("箭头标注"),
  Callouts: t("标注"),
  "Brackets and Braces": t("括号"),
  Ribbons: t("丝带"),
  Scrolls: t("卷轴"),
  "Math Symbols": t("数学"),
  "Chart Shapes": t("图表"),
  "Tab Shapes": t("选项卡"),
  "Action Buttons": t("动作按钮"),
  "Flowchart Shapes": t("流程图"),
};

/** @type {Record<string, string>} */
export const ELEMENT_TYPE_LABELS = {
  text: t("文字"),
  shape: t("形状"),
  image: t("图片"),
  table: t("表格"),
  chart: t("图表"),
  line: t("线条"),
  icon: t("图标"),
};
