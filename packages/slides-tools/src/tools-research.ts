/** Research and media ports: web search, image search and image generation. */
import { webSearchQueriesFromArgs } from "@open-slidestudio/presentation-run";
import type { SlideToolDefinition } from "./contract.js";
import { present, receiptResult, slideTool, type SlideToolRuntimeDeps } from "./tool-kit.js";

export const WEB_SEARCH_DESCRIPTION =
  "Search the web for current information. Provide 1–4 queries in the required queries array. Use a one-item array for a single search. Returns facts and source URLs. First-class produce tool via xAI when inspect_capabilities.research.configured. Assistant prose is not a search.";

export function searchImageTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "search_image",
    description:
      "Search a unique image into media/ when inspect_capabilities.imageSearch.configured. Call this in a batch for every photo-led page (cover, section, closer, body photo) BEFORE write_page. Do not reuse one cover file on later pages. Assistant prose is not a search.",
    parameters: {
      id: { type: "string", required: true, description: "Media id written under media/" },
      query: { type: "string", required: true, description: "Image search query" },
    },
    readOnly: false,
    async execute(args, ctx) {
      deps.ensureMediaEnv?.();
      return receiptResult(await present(deps, ctx, "search_image", args));
    },
  });
}

export function generateImageTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "generate_image",
    description:
      "Generate a unique image into media/ via grok-imagine when inspect_capabilities.imageGenerate.configured. Pass the planned photo frame width and height in page pixels (the write_page image bounds). Host maps that slot to the nearest API aspect so the file matches the frame. Call once per photo-led page BEFORE write_page. Do not default to 16:9 and cover-crop into a portrait column. Fails closed if the image API cannot run — no placeholder PNG.",
    parameters: {
      id: { type: "string", required: true, description: "Media id written under media/" },
      prompt: { type: "string", required: true, description: "Image generation prompt" },
      width: { type: "number", required: true, description: "Planned image frame width in page pixels" },
      height: { type: "number", required: true, description: "Planned image frame height in page pixels" },
      aspect: { type: "string", description: "Fallback only if width/height cannot be known: 16:9, 1:1, or 3:4" },
    },
    readOnly: false,
    async execute(args, ctx) {
      deps.ensureMediaEnv?.();
      return receiptResult(await present(deps, ctx, "generate_image", args));
    },
  });
}

export function webSearchTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "web_search",
    description: WEB_SEARCH_DESCRIPTION,
    parameters: {
      queries: {
        type: "array",
        required: true,
        items: { type: "string" },
        description: "Required search queries; accepts 1–4 items and merges their results.",
      },
    },
    readOnly: false,
    async execute(args, ctx) {
      deps.ensureMediaEnv?.();
      const queries = webSearchQueriesFromArgs(args);
      return receiptResult(await present(deps, ctx, "web_search", { ...args, queries, query: queries[0] ?? "" }));
    },
  });
}
