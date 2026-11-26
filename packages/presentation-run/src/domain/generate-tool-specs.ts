/**
 * The LLM-facing tool specs of the presentation-run generate path. Moved out of agent-tools.ts
 * unchanged (DECISIONS #50) so that file stays under its cap.
 */
import { TODO_EXHIBIT_KINDS } from "./page-plan.js";

export type LlmToolSpec = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export const GENERATE_TOOLS: LlmToolSpec[] = [
  {
    type: "function",
    function: {
      name: "think",
      description: "Record the audience, constraints, and what you will not invent. Call this first.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          detail: { type: "string" },
        },
        required: ["summary", "detail"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_playbook",
      description: "Read one playbook section. Do not guess the category rules — read them.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          section: {
            type: "string",
            enum: ["catalog", "skill", "images", "category", "guide", "design", "pptd"],
          },
        },
        required: ["section"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read uploaded reference attachments. Quote only; never invent beyond this text.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Optional substring filter" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "research",
      description: "Look up facts in attachments or record an honest gap. No public web. Never invent citations.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_todo",
      description:
        "Write or replace the complete page outline. Do not default to 6 pages. A classroom lesson is usually 6 (cover→path→concept→remember→exhibit→takeaway). A 月报/复盘 follows the attachment: one job per exhibit, no padding. If the brief specifies a page count or page-by-page script, keep every specified page. Each item needs a note and the exact editable exhibits the later page must implement. Mark photo-led pages with the photo exhibit; their media must exist before write_page. Use none only when the page truly requests no exhibit; prose never substitutes for a requested chart, table, or diagram. Revise the todo whenever the page structure changes — split sections are allowed, but the new pageIds must appear here BEFORE their first write_page.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                note: { type: "string" },
                exhibits: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", enum: [...TODO_EXHIBIT_KINDS] },
                },
              },
              required: ["title", "note", "exhibits"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for current information. Provide 1–4 queries in the required queries array. Use a one-item array for a single search. Only when inspect_capabilities.research.configured and via=pi-xai-hosted. Returns facts and citations. Do not pretend you searched if this tool was not called.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          queries: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 4,
            description: "Required search queries; 1–4 non-empty strings. Use a one-item array for a single search.",
          },
        },
        required: ["queries"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_image",
      description:
        "Optional. Query the configured image search port and write media/{id}.png. Only call this if the capability card says imageSearch=YES. No public-web scrape by the host. If the port is off or empty, you get kind=none — do not write src.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "File stem, e.g. cover or day1-sensoji" },
          query: { type: "string" },
        },
        required: ["id", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "Create a file in project media/ only when the capability card says imageGenerate=YES. Pass the planned photo frame width and height in page pixels so the file matches that slot. Do not default to 16:9 and later cover-crop into a portrait frame. Fails closed if the image API cannot run — it does not write a placeholder PNG.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "File stem, e.g. cover or day1-sensoji" },
          prompt: { type: "string" },
          width: { type: "number", description: "Planned image frame width in page pixels" },
          height: { type: "number", description: "Planned image frame height in page pixels" },
          aspect: {
            type: "string",
            description: "Only if width/height are unknown: 16:9, 4:3, 1:1, or 3:4",
          },
        },
        required: ["id", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_page",
      description:
        "Write ONE COMPLETE page as PPTD in a single call. This replaces the whole page; it never appends elements. Every revision must resend the full elements[] array, with bounds/style/fill/line/alignment inside each owning element. layoutStatus=pass is overflow-only, not a rewrite seal. The same pageId may be rewritten until review_pages records a current structural pass for that revision. After structural pass, rewrite only if the current revision has explicit editor edit authorization, review_pages names the page failing, or review_page says revise. An authorized editor edit uses read_page and expectedPageSha256; do not manufacture a visual review to enable it. Official recipe vocab: header|list|box|circle|band|text, or cover-botanical|title-band|coral-rule|chapter|page-title|route-path|method-panels|two-column-45-55|demo-band|two-column-body|result-bar|next-action|footer-chrome. pageType cover|route|concept|method|demo|transfer. Invalid parse returns error. The host will not rewrite your elements.",
      parameters: {
        type: "object",
        additionalProperties: true,
        properties: {
          id: { type: "string" },
          pageType: { type: "string" },
          notes: { type: "string" },
          background: { type: "object" },
          elements: { type: "array", minItems: 1 },
          expectedPageSha256: {
            type: "string",
            description:
              "When revising an existing page, pass the pageSha256 from the immediately preceding read_page. The write is rejected if that page changed before persistence.",
          },
        },
        required: ["id", "elements"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "render_page",
      description:
        "Screenshot native #slide for ONE written page. Classroom decks must call this for every page the user will see (pageIndex 0..n-1). page-1.png alone is rejected. If Playwright/editor is down, kind=unavailable.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pageId: { type: "string" },
          pageIndex: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "review_pages",
      description:
        "Native structural QA (not Kimi export_images.py). One written page is enough. Fails empty pages and unlabeled invented numbers. Does not require media. If you chose an image src, that file must exist. Call render_page first if you want to see the real #slide. If raster/vision is off, say you did not see the slide.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compose_deck",
      description:
        "Finalize the deck. Prefer pages already written with write_page, or send pages[] with elements. Images are optional. If you included src, the file must exist. Empty pages and unlabeled invented numbers are rejected. role+bullets without elements is an IR fallback.",
      parameters: {
        type: "object",
        additionalProperties: true,
        properties: {
          title: { type: "string" },
          pages: {
            type: "array",
            minItems: 5,
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                id: { type: "string" },
                pageType: { type: "string" },
                role: {
                  type: "string",
                  enum: ["cover", "toc", "content", "evidence", "timeline", "matrix", "close"],
                },
                title: { type: "string" },
                notes: { type: "string" },
                elements: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    additionalProperties: true,
                    properties: {
                      elementId: { type: "string" },
                      elementType: {
                        type: "string",
                        enum: ["text", "shape", "image", "table", "chart", "line", "icon"],
                      },
                      bounds: {
                        type: "array",
                        items: { type: "number" },
                        minItems: 4,
                        maxItems: 4,
                      },
                      content: { type: "object" },
                      shapeName: { type: "string" },
                      fill: {},
                      src: { type: "string" },
                      data: { type: "object" },
                      series: { type: "array" },
                      columnWidths: { type: "array" },
                      rows: { type: "array" },
                    },
                    required: ["elementType", "bounds"],
                  },
                },
                subtitle: { type: "string" },
                kicker: { type: "string" },
                chapter: { type: "string" },
                bullets: { type: "array", items: { type: "string" } },
                items: { type: "array", items: { type: "string" } },
                soWhat: { type: "string" },
                note: { type: "string" },
                chart: { type: "object" },
              },
              required: ["title"],
            },
          },
        },
        required: ["title"],
      },
    },
  },
];
