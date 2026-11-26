/**
 * Live produce `request/header` serialization.
 *
 * Grok search and conversational image generation are dsh-oauth native hosted
 * tools on the provider request. Do not re-inject function-calling `web_search`
 * or delete the native-tools guidance — that fight caused host-forced sidecar
 * search (session 3612938f: `hosted web_search failed: This operation was aborted`).
 */
import { canonicalHeader, type EpochHeader } from "@deepseek-ai/dsh-session";
import type { LlmCallConfig, ToolSchema } from "@deepseek-ai/dsh-llm";
import { WEB_SEARCH_DESCRIPTION } from "@open-slidestudio/slides-tools";

export const NATIVE_WEB_FORBID_SENTENCE =
  "Do not call web_search or web_fetch — those DSH tools are not available on this route.";

export const PRODUCE_WEB_SEARCH_NAME = "web_search";
export const PRODUCE_SEARCH_IMAGE_NAME = "search_image";
export const PRODUCE_GENERATE_IMAGE_NAME = "generate_image";

export const CAPABILITY_FILTERED_PRODUCE_TOOL_NAMES = [
  "edit_elements",
  "edit_page_background",
  "delete_pages",
  "reorder_pages",
  "update_deck",
  "review_page",
  "view_material",
  "record_material_notes",
  PRODUCE_SEARCH_IMAGE_NAME,
  PRODUCE_GENERATE_IMAGE_NAME,
] as const;

const CAPABILITY_FILTERED_PRODUCE_TOOLS = new Set<string>(CAPABILITY_FILTERED_PRODUCE_TOOL_NAMES);

/** Page, layout and plan writes that a turn's allowlist can withhold (review, element, editor and layout locks). */
const ALLOWLIST_GATED_PRODUCE_TOOLS = new Set<string>([
  "write_page",
  "write_layout",
  "write_todo",
  "batch_remove_footers",
]);

/** Single source: the canonical web_search tool description. */
export const PRODUCE_WEB_SEARCH_DESCRIPTION = WEB_SEARCH_DESCRIPTION;

/** Official dsh-tool-web / grok-4.6 shape: `queries[]`, not a lone `query` string. */
export const PRODUCE_WEB_SEARCH_SCHEMA: ToolSchema = {
  name: PRODUCE_WEB_SEARCH_NAME,
  description: PRODUCE_WEB_SEARCH_DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      queries: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 4,
        description:
          "Required search queries; accepts 1–4 non-empty strings. Use a one-item array for a single search.",
      },
    },
    required: ["queries"],
  },
};

export type ProducePromptSection = {
  name: string;
  text: string;
};

export type ProduceAssembly = {
  sections: ProducePromptSection[];
  contexts?: Array<{ name: string; text: string }>;
  tools: ToolSchema[];
  variables?: Record<string, string | undefined>;
};

const FORBID_SENTENCE_PATTERNS: readonly RegExp[] = [
  /Do not call web_search or web_fetch\s*[—–-]\s*those DSH tools are not available on this route\.?/g,
  /Do not call web_search or web_fetch[^.]*\./g,
  /those DSH tools are not available on this route\.?/g,
];

export function stripNativeWebForbid(text: string): string {
  let out = text;
  for (const pattern of FORBID_SENTENCE_PATTERNS) {
    out = out.replace(pattern, "");
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Drop leaked function-calling `web_search` so dsh-oauth hosted tools own the route. */
export function stripProductWebSearchTools(tools: readonly ToolSchema[]): ToolSchema[] {
  return tools.filter((tool) => tool.name !== PRODUCE_WEB_SEARCH_NAME);
}

/**
 * 步级工具是否还能出现在本轮。始终去掉函数调用形态的 web_search。
 * `allowed` 存在时，write_page 与能力裁剪工具必须在集合里。
 */
export function isProduceToolAllowed(toolName: string, allowed?: ReadonlySet<string>): boolean {
  if (toolName === PRODUCE_WEB_SEARCH_NAME) return false;
  if (!allowed) return true;
  return (
    (!ALLOWLIST_GATED_PRODUCE_TOOLS.has(toolName) || allowed.has(toolName)) &&
    (!CAPABILITY_FILTERED_PRODUCE_TOOLS.has(toolName) || allowed.has(toolName))
  );
}

export function filterUnavailableProduceTools(
  tools: readonly ToolSchema[],
  allowed?: ReadonlySet<string>,
): ToolSchema[] {
  return tools.filter((tool) => isProduceToolAllowed(tool.name, allowed));
}

const CONVERSATION_INTERACTION_TEXT =
  "与用户交互集中在对话中。用户已明确要求的修改直接执行，不重复确认。只有缺少影响结果的关键信息，或用户明确要求先选择时，调用 ask_user_question；不要用正文中的‘回复 A/B’或‘说开始改’代替问题卡。用户已授权‘选完就改’时，工具返回回答后在同一轮继续完成修改，不再要求用户发一条消息。取消或未回答不等于同意，不执行依赖该回答的修改。只讨论的轮次仍然只读。";

export function patchProduceAssembly<
  T extends { sections: readonly ProducePromptSection[]; tools?: readonly ToolSchema[] },
>(assembly: T, allowed?: ReadonlySet<string>): T {
  const sections = allowed?.has("ask_user_question")
    ? [
        ...assembly.sections.filter((section) => section.name !== "slides:conversation-interaction"),
        { name: "slides:conversation-interaction", text: CONVERSATION_INTERACTION_TEXT },
      ]
    : assembly.sections;
  // rc.2 的装配结果带 tools 数组；rc.5 的 PromptPresentation 没有这个字段。
  if (Array.isArray(assembly.tools)) {
    return {
      ...assembly,
      sections,
      tools: filterUnavailableProduceTools(assembly.tools, allowed),
    };
  }
  const patched = { ...assembly, sections };
  if ("tools" in patched) delete patched.tools;
  return patched;
}

export function renderProduceSystem(assembly: ProduceAssembly): string {
  return assembly.sections
    .map((section) => section.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

export type ProduceRequestHeaderConfig = Pick<LlmCallConfig, "provider" | "model"> & Partial<LlmCallConfig>;

/**
 * Same JSON shape the agent loop appends as `request/header` (`canonicalHeader`).
 */
export function serializeProduceRequestHeader(
  assembly: ProduceAssembly,
  config: ProduceRequestHeaderConfig,
): EpochHeader {
  const patched = patchProduceAssembly(assembly);
  return canonicalHeader({
    config,
    ...(patched.tools.length > 0 ? { tools: patched.tools } : {}),
  });
}

export function requestHeaderHasWebSearch(header: EpochHeader): boolean {
  return Boolean(header.tools?.some((tool) => tool.name === PRODUCE_WEB_SEARCH_NAME));
}

export function assemblyForbidsNativeWeb(assembly: ProduceAssembly): boolean {
  const system = renderProduceSystem(assembly);
  return (
    system.includes(NATIVE_WEB_FORBID_SENTENCE) ||
    /Do not call web_search or web_fetch/.test(system) ||
    /those DSH tools are not available on this route/.test(system)
  );
}
