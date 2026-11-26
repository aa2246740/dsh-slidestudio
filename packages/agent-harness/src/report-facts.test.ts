import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractListedPeople,
  extractMarkedGaps,
  extractRequiredTableColumns,
  hasNamedCompany,
  hasNumericFacts,
  hasOperatingFacts,
  missingLockedPageFacts,
  missingOperatingFactsReason,
  reportFactIssues,
  skillPagesPlainText,
} from "./report-facts.js";
import type { SkillPageInput } from "./skill-pages.js";

describe("report facts gate", () => {
  it("refuses a bare 经营月报 brief", () => {
    const brief = "做一份公司经营月报";
    assert.equal(hasNamedCompany(brief), false);
    assert.equal(hasNumericFacts(brief), false);
    assert.equal(hasOperatingFacts(brief), false);
    assert.match(missingOperatingFactsReason(brief) ?? "", /公司名和至少一组/);
  });

  it("does not treat a one-page cover request as a data report", () => {
    const brief = "为《澄光生活》做一页月报封面";
    assert.equal(hasNamedCompany(brief), true);
    assert.equal(missingOperatingFactsReason(brief), undefined);
    assert.equal(missingOperatingFactsReason("澄光生活月报封面"), undefined);
    assert.equal(
      missingOperatingFactsReason("为《澄光生活》做一页可读的 2026 年 7 月经营月报封面。放一两个 KPI（虚构演示）。"),
      undefined,
    );
  });

  it("accepts a work report naming a team with real numbers", () => {
    const brief = "交易平台后端组 2026 年 Q3 工作汇报。订单峰值 QPS 从 8,000 提升到 15,000，平均延迟 95 毫秒。";
    assert.equal(hasNamedCompany(brief), true);
    assert.equal(hasOperatingFacts(brief), true);
  });

  it("still refuses a report brief without any named org", () => {
    const brief = "写一份 Q3 工作汇报，核心指标：QPS 提升 8000 到 15000。";
    assert.equal(hasNamedCompany(brief), false);
    assert.equal(hasOperatingFacts(brief), false);
  });

  it("accepts Hub attachments that already contain numbers", () => {
    assert.equal(
      hasOperatingFacts("根据附件写月报", "## 参考: 2026-07-经营月报-虚构演示.md\nGMV 1,840 万（虚构演示）"),
      true,
    );
  });

  it("accepts dense demo tables pasted into the Hub brief", () => {
    const brief = [
      "用下面渠道和门店表做一份高密度数据页演示（8 到 12 页）。每个图表必须有 claim、dataRef、whyChart。虚构演示。",
      "## 参考: 渠道周报-虚构演示.md",
      "| 渠道 | GMV | 订单 | 退货率% | 贡献毛利 |",
      "| 旗舰店 | 1840 | 12600 | 3.2 | 412 |",
    ].join("\n");
    assert.equal(hasNamedCompany(brief), false);
    assert.equal(hasNumericFacts(brief), true);
    assert.equal(hasOperatingFacts(brief), true);
    assert.equal(missingOperatingFactsReason(brief), undefined);
  });

  it("accepts 星河零售 with sourced numbers", () => {
    const brief = "根据下面数据做一份「星河零售 2026年7月经营月报」。营收 1860万，完成率 93%。";
    assert.equal(hasNamedCompany(brief), true);
    assert.equal(hasNumericFacts(brief), true);
    assert.equal(missingOperatingFactsReason(brief), undefined);
  });

  it("does not treat the year 2026 as a KPI set", () => {
    assert.equal(hasNumericFacts("做一份 2026 经营月报"), false);
  });

  it("reads 澄光生活 before 7月经营月报 as a company", () => {
    assert.equal(hasNamedCompany("澄光生活 7月经营月报，营收 1860万"), true);
  });

  it("extracts named gaps from the B brief", () => {
    const brief = "以下三个数缺失，待补，禁止估算或补全：华南客单价；复购；线下毛利。";
    assert.deepEqual(extractMarkedGaps(brief), ["华南客单价", "复购", "线下毛利"]);
  });

  it("extracts 8 columns and owner names", () => {
    const brief = [
      "列固定为：营收/环比/同比/毛利/库存天/退货率/渠道/负责人。",
      "SKU01 晨光纯奶 186 +3.1 -1.2 28.4 41 1.8 线上 刘洋",
      "SKU02 星河鲜肉 172 +1.4 -4.6 18.2 52 2.4 线下 陈凯",
    ].join("\n");
    assert.deepEqual(extractRequiredTableColumns(brief), [
      "营收",
      "环比",
      "同比",
      "毛利",
      "库存天",
      "退货率",
      "渠道",
      "负责人",
    ]);
    assert.deepEqual(extractListedPeople(brief), ["刘洋", "陈凯"]);
  });

  it("flags a deck that only says 三项数据 without naming gaps", () => {
    const brief = "以下三个数缺失，待补：华南客单价；复购；线下毛利。";
    const page: SkillPageInput = {
      id: "page-02",
      pageType: "route",
      elements: [
        {
          elementId: "n3",
          elementType: "text",
          bounds: [40, 40, 800, 40],
          content: { text: "三项数据标「缺失，待补」", fontSize: 16 },
        },
      ],
    };
    const issues = reportFactIssues(brief, [page]);
    assert.ok(issues.some((i) => i.code === "unnamed_gap" && /华南客单价/.test(i.message)));
  });

  it("requires the 12-row SKU table itself to keep 负责人, not a 2-row cover table", () => {
    const brief = [
      "「星河零售」营收 1860万。列固定为：营收/环比/同比/毛利/库存天/退货率/渠道/负责人。",
      "SKU01 晨光纯奶 186 +3.1 -1.2 28.4 41 1.8 线上 刘洋",
      "SKU02 星河鲜肉 172 +1.4 -4.6 18.2 52 2.4 线下 陈凯",
      "SKU03 青禾蔬菜 154 +6.8 +2.1 22.0 9 3.1 线下 王敏",
      "SKU04 南风零食 148 +8.2 +12.4 34.6 38 4.7 线上 赵倩",
      "SKU05 泊湾水产 141 -2.3 -8.5 19.8 11 5.2 线下 周宁",
      "SKU06 暖屋日化 138 +0.8 +1.1 41.2 46 1.2 线上 孙悦",
      "SKU07 北麓粮油 129 -1.6 -3.3 15.4 61 0.9 线下 马超",
      "SKU08 澄光乳酪 121 +4.5 +0.6 31.0 29 1.5 线上 林芳",
      "SKU09 秋田水果 116 +9.0 +5.8 24.7 7 6.3 线下 黄蕾",
      "SKU10 石桥酒水 110 -5.1 -9.4 36.8 55 0.6 线下 郑伟",
      "SKU11 云端咖啡 98 +11.2 +18.0 48.5 33 2.1 线上 吴桐",
      "SKU12 巷口烘焙 87 +2.0 -0.8 39.1 22 3.4 线下 何洁",
    ].join("\n");
    const cover: SkillPageInput = {
      id: "page-01",
      pageType: "cover",
      elements: [
        {
          elementId: "hdr",
          elementType: "table",
          bounds: [40, 300, 860, 80],
          columnWidths: [100, 100, 100, 100, 100, 100, 100, 100],
          rows: [
            ["营收", "环比", "同比", "毛利", "库存天", "退货率", "渠道", "负责人"].map((text) => ({
              text,
            })),
            ["万元", "%", "%", "%", "天", "%", "线上/下", "姓名入格"].map((text) => ({ text })),
          ],
        },
      ],
    };
    const dense: SkillPageInput = {
      id: "page-03",
      pageType: "demo",
      elements: [
        {
          elementId: "skuTable",
          elementType: "table",
          bounds: [12, 68, 936, 440],
          columnWidths: [112, 76, 72, 72, 72, 72, 72, 76],
          rows: [
            ["品名", "营收", "环比", "同比", "毛利", "库存天", "退货率", "渠道"].map((text) => ({
              text,
            })),
            ...Array.from({ length: 12 }, (_, i) =>
              [`sku${i}`, "1", "1", "1", "1", "1", "1", "线上"].map((text) => ({ text })),
            ),
          ],
        },
      ],
    };
    const issues = reportFactIssues(brief, [cover, dense]);
    assert.ok(issues.some((i) => /dense SKU table header/.test(i.message)));
  });

  it("passes when each gap is named with 缺失，待补", () => {
    const brief = "以下三个数缺失，待补：华南客单价；复购；线下毛利。";
    const page: SkillPageInput = {
      id: "page-05",
      pageType: "content",
      elements: [
        {
          elementId: "gaps",
          elementType: "text",
          bounds: [40, 40, 800, 80],
          content: {
            text: "华南客单价：缺失，待补\n复购：缺失，待补\n线下毛利：缺失，待补",
            fontSize: 16,
          },
        },
      ],
    };
    assert.equal(reportFactIssues(brief, [page]).length, 0);
    assert.match(skillPagesPlainText([page]), /华南客单价/);
  });

  it("requires every locked page number instead of accepting one token", () => {
    const brief = [
      "【第1页 封面】营业收入 1.286 亿。",
      "【第2页 KPI】净利率 7.9%，预算达成 105.4%。",
      "【第3页 库存】周转 19.0 天，鲜食报损 3.9%。",
    ].join("\n");
    const textPage = (id: string, text: string): SkillPageInput => ({
      id,
      elements: [
        {
          elementId: `${id}-text`,
          elementType: "text",
          bounds: [40, 40, 800, 120],
          content: { text },
        },
      ],
    });
    const issues = missingLockedPageFacts(brief, [
      textPage("page-01", "营业收入 1.286 亿"),
      textPage("page-02", "净利率七点九，预算达成 105%"),
      textPage("page-03", "周转 19 天，鲜食报损 3.9%"),
    ]);
    assert.deepEqual(issues, [{ pageId: "page-02", missing: ["7.9%", "105.4%"] }]);
  });

  it("does not let a positive value satisfy a locked negative fact", () => {
    const brief = ["【第1页 封面】营收 1.286 亿。", "【第2页 趋势】闭店 -18 万。", "【第3页 结论】净利率 7.9%。"].join(
      "\n",
    );
    const pages: SkillPageInput[] = [
      {
        id: "page-01",
        elements: [
          {
            elementId: "a",
            elementType: "text",
            bounds: [0, 0, 100, 20],
            content: { text: "1.286 亿" },
          },
        ],
      },
      {
        id: "page-02",
        elements: [
          {
            elementId: "b",
            elementType: "text",
            bounds: [0, 0, 100, 20],
            content: { text: "闭店 18 万" },
          },
        ],
      },
      {
        id: "page-03",
        elements: [
          {
            elementId: "c",
            elementType: "text",
            bounds: [0, 0, 100, 20],
            content: { text: "7.9%" },
          },
        ],
      },
    ];
    assert.deepEqual(missingLockedPageFacts(brief, pages), [{ pageId: "page-02", missing: ["-18 万"] }]);
  });
});
