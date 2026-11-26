export function tasteDraft(): Record<string, unknown> & {
  slidePlan: Array<{
    pageId: string;
    title: string;
    narrativeJob: string;
    layoutFamily: string;
    focalPoint: string;
  }>;
} {
  const layouts = ["cover", "chart-led", "table-led", "editorial-asymmetric", "process-diagram", "conclusion"];
  return {
    audience: "内部团队",
    scene: "现场培训",
    purpose: "让团队理解并开始使用 AI 助手",
    designRead: "纸白底色承载内容，深蓝建立层级，强调色只标记关键动作",
    necessaryJudgment: {
      removeOrDemote: ["平均卡片墙"],
      mustRemain: ["结论、证据、动作"],
      inevitableRelationships: ["为什么、怎么做、下一步"],
    },
    tasteDials: {
      visualVariance: 4,
      informationDensity: 3,
      brandDistinction: 4,
      typeExpressiveness: 3,
      experimentRisk: 2,
    },
    typeSystem: {
      personality: "清晰、理性、有编辑感",
      title: "结论式标题",
      body: "紧凑中文正文",
      data: "数字优先",
      mixedScript: "中英文层级一致",
    },
    palette: {
      background: "#FDFAF5",
      text: "#172033",
      primary: "#153B63",
      accent: "#F5987E",
      neutral: "#8290A3",
      areaRules: ["深蓝不超过页面三分之一"],
    },
    grid: "12 栏和 48px 安全边距",
    densityRules: ["一页一个判断"],
    chartGrammar: ["关键值直接标注"],
    visualMemory: { feature: "细珊瑚色标尺", recurrence: "章节转换", avoid: "不铺满每页" },
    referenceUse: { adopt: ["纸白层级"], adapt: ["深蓝覆盖主色"], doNotCopy: ["不复制示例文案"] },
    antiDefaultLocks: ["禁止平均卡片墙", "禁止每页同一分栏"],
    slidePlan: layouts.map((layoutFamily, index) => ({
      pageId: `page-${String(index + 1).padStart(2, "0")}`,
      title: ["开始使用", "先看判断", "证据清单", "工作方式", "执行流程", "下一步"][index]!,
      narrativeJob: `完成叙事任务 ${index + 1}`,
      layoutFamily,
      focalPoint: `焦点 ${index + 1}`,
    })),
    userOverrides: [
      { quote: "深蓝", effect: "覆盖参考主色" },
      { quote: "16:9", effect: "使用宽屏比例" },
    ],
  };
}
