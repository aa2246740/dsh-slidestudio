import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, loadProject, type ChartElement } from "@open-slidestudio/pptd-v2";
import { createAgentBrain, loadPlaybook, runGenerateAsync } from "./index.js";
import { executeGenerateTool } from "./agent-tools.js";
import { applySkillDeck, parseBounds, parseSkillDeck, parseSkillPage, skillToCompose } from "./skill-pages.js";
import type { LlmChatMessage, LlmPort, LlmTurnResult } from "./llm-port.js";

describe("parseBounds MiniMax wrapper", () => {
  it("unwraps {item: string numbers}", () => {
    assert.deepEqual(parseBounds({ item: ["90", "120", "820", "100"] }), [90, 120, 820, 100]);
    assert.deepEqual(parseBounds({ item: { item: [0, 0, 960, 540] } }), [0, 0, 960, 540]);
  });
});

const skillLesson = {
  title: "勾股小课堂",
  pages: [
    {
      id: "page-01",
      pageType: "cover",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [80, 180, 800, 80],
          content: { text: "勾股小课堂", bold: true, fontSize: 32 },
        },
      ],
    },
    {
      id: "page-02",
      pageType: "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [40, 36, 880, 48],
          content: { text: "今天要搞懂什么", bold: true, fontSize: 22 },
        },
        {
          elementId: "path",
          elementType: "text",
          bounds: [40, 120, 880, 200],
          content: { text: "先认三条边。再记公式。最后用 3-4-5 检查。", fontSize: 16 },
        },
      ],
    },
    {
      id: "page-03",
      pageType: "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [40, 36, 880, 48],
          content: { text: "直角对着的边叫斜边", bold: true, fontSize: 22 },
        },
        {
          elementId: "triangle",
          elementType: "shape",
          bounds: [80, 140, 320, 240],
          shapeName: "rtTriangle",
          fill: { type: "solid", color: "#1F4E79" },
        },
        {
          elementId: "support",
          elementType: "text",
          bounds: [440, 160, 440, 200],
          content: { text: "先指直角，再认斜边。另外两边叫直角边。", fontSize: 16 },
        },
      ],
    },
    {
      id: "page-04",
      pageType: "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [40, 36, 880, 48],
          content: { text: "写成 a²+b²=c²，c 一定是斜边", bold: true, fontSize: 20 },
        },
        {
          elementId: "formula",
          elementType: "text",
          bounds: [80, 160, 800, 80],
          content: { text: "a² + b² = c²", bold: true, fontSize: 36 },
        },
      ],
    },
    {
      id: "page-05",
      pageType: "evidence",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [40, 36, 880, 48],
          content: { text: "课堂例子：3、4、5", bold: true, fontSize: 22 },
        },
        {
          elementId: "chart",
          elementType: "chart",
          bounds: [80, 140, 800, 280],
          data: {
            cols: ["边", "长度"],
            rows: [
              ["短直角边", 3],
              ["长直角边", 4],
              ["斜边", 5],
            ],
          },
          series: [{ type: "bar", name: "长度", encode: { x: "边", y: "长度" } }],
        },
      ],
    },
    {
      id: "page-06",
      pageType: "close",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [40, 36, 880, 48],
          content: { text: "今天带走什么", bold: true, fontSize: 22 },
        },
        {
          elementId: "take",
          elementType: "text",
          bounds: [40, 140, 880, 200],
          content: { text: "能指认三边。能写出公式。用 3-4-5 检查一次。", fontSize: 16 },
        },
      ],
    },
  ],
};

function call(name: string, args: unknown, id = name): LlmTurnResult {
  return {
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function scriptedPort(turns: LlmTurnResult[]): LlmPort {
  let i = 0;
  return {
    async completeJson() {
      throw new Error("completeJson should not run when completeTurn exists");
    },
    async completeTurn(_messages: LlmChatMessage[]) {
      if (i >= turns.length) return { content: "done", toolCalls: [] };
      return turns[i++]!;
    },
  };
}
