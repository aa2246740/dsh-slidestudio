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
  PRODUCE_SEARCH_IMAGE_NAME,
  PRODUCE_GENERATE_IMAGE_NAME,
] as const;

const CAPABILITY_FILTERED_PRODUCE_TOOLS = new Set<string>(CAPABILITY_FILTERED_PRODUCE_TOOL_NAMES);

export const PRODUCE_WEB_SEARCH_DESCRIPTION =
  "Search the web for current information. Provide 1–4 queries in the required queries array. Use a one-item array for a single search. Returns facts and source URLs. First-class produce tool via xAI when inspect_capabilities.research.configured. Assistant prose is not a search.";

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
export function stripProductWebSearchTools(tools: readonly ToolSchema[] | undefined): ToolSchema[] {
  return (tools ?? []).filter((tool) => tool.name !== PRODUCE_WEB_SEARCH_NAME);
}

export function filterUnavailableProduceTools(
  tools: readonly ToolSchema[] | undefined,
  allowed?: ReadonlySet<string>,
): ToolSchema[] {
  const withoutFunctionWebSearch = stripProductWebSearchTools(tools);
  if (!allowed) return withoutFunctionWebSearch;
  return withoutFunctionWebSearch.filter(
    (tool) =>
      (tool.name !== "write_page" || allowed.has("write_page")) &&
      (!CAPABILITY_FILTERED_PRODUCE_TOOLS.has(tool.name) || allowed.has(tool.name)),
  );
}

export function patchProduceAssembly<
  T extends { sections: readonly ProducePromptSection[]; tools?: readonly ToolSchema[] },
>(assembly: T, allowed?: ReadonlySet<string>): Omit<T, "tools"> & { tools: ToolSchema[] } {
  return {
    ...assembly,
    sections: allowed?.has("ask_user_question")
      ? [
          ...assembly.sections.filter((section) => section.name !== "slides:conversation-interaction"),
          {
            name: "slides:conversation-interaction",
            text: "与用户交互集中在对话中。用户已明确要求的修改直接执行，不重复确认。只有缺少影响结果的关键信息，或用户明确要求先选择时，调用 ask_user_question；不要用正文中的‘回复 A/B’或‘说开始改’代替问题卡。用户已授权‘选完就改’时，工具返回回答后在同一轮继续完成修改，不再要求用户发一条消息。取消或未回答不等于同意，不执行依赖该回答的修改。只讨论的轮次仍然只读。",
          },
        ]
      : assembly.sections,
    tools: filterUnavailableProduceTools(assembly.tools, allowed),
  };
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
