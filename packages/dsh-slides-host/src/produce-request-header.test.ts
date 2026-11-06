import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalHeader } from "@deepseek-ai/dsh-session";
import type { ToolSchema } from "@deepseek-ai/dsh-llm";
import {
  NATIVE_WEB_FORBID_SENTENCE,
  PRODUCE_GENERATE_IMAGE_NAME,
  PRODUCE_SEARCH_IMAGE_NAME,
  patchProduceAssembly,
  assemblyForbidsNativeWeb,
  requestHeaderHasWebSearch,
  renderProduceSystem,
  serializeProduceRequestHeader,
  stripProductWebSearchTools,
  type ProduceAssembly,
} from "./produce-request-header.js";

const SEARCH_IMAGE: ToolSchema = {
  name: PRODUCE_SEARCH_IMAGE_NAME,
  description: "Search images.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" },
      query: { type: "string" },
    },
    required: ["id", "query"],
  },
};

const GENERATE_IMAGE: ToolSchema = {
  name: PRODUCE_GENERATE_IMAGE_NAME,
  description: "Generate an image.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" },
      prompt: { type: "string" },
    },
    required: ["id", "prompt"],
  },
};

const OFFICIAL_WEB_SEARCH: ToolSchema = {
  name: "web_search",
  description: "Official DSH web_search over ctx.web",
  parameters: {
    type: "object",
    properties: {
      queries: { type: "array", items: { type: "string" } },
    },
    required: ["queries"],
  },
};

/** dsh-oauth native-tools guidance that the old patch deleted. */
function grokNativeAssembly(): ProduceAssembly {
  return {
    sections: [
      {
        name: "deployment:persona",
        text: "search_image and generate_image remain product tools that write media/ for PPTD.",
      },
      {
        name: "oauth:native-tools",
        text: NATIVE_WEB_FORBID_SENTENCE,
      },
    ],
    tools: [OFFICIAL_WEB_SEARCH, SEARCH_IMAGE, GENERATE_IMAGE],
  };
}

describe("live produce request/header serialization", () => {
  it("patches the prompt before DSH populates the tool list", () => {
    const sections = [{ name: "deployment:persona", text: "Slide director." }];
    for (const assembly of [{ sections }, { sections, tools: undefined }, { sections, tools: [] }]) {
      const patched = patchProduceAssembly(assembly);
      assert.deepEqual(patched.tools, []);
      assert.deepEqual(patched.sections, sections);
    }
  });

  it("keeps dsh-oauth native-tools guidance and drops function-calling web_search", () => {
    const header = serializeProduceRequestHeader(grokNativeAssembly(), {
      provider: "pi-xai",
      model: "grok-4.6",
    });
    const json = JSON.parse(JSON.stringify(header)) as {
      system?: string;
      tools?: Array<{ name?: string }>;
    };
    const names = (json.tools ?? []).map((tool) => tool.name);
    assert.equal(names.includes("web_search"), false, JSON.stringify(names));
    assert.equal(names.includes("search_image"), true, JSON.stringify(names));
    assert.equal(names.includes("generate_image"), true, JSON.stringify(names));
    const system = renderProduceSystem(grokNativeAssembly());
    assert.ok(system);
    assert.equal(system.includes(NATIVE_WEB_FORBID_SENTENCE), true);
    assert.match(system, /Do not call web_search or web_fetch/);
    assert.equal(requestHeaderHasWebSearch(header), false);
    assert.equal(assemblyForbidsNativeWeb(grokNativeAssembly()), true);

    const loopShape = canonicalHeader({
      config: { provider: "pi-xai", model: "grok-4.6" },
      tools: header.tools,
    });
    assert.equal(
      loopShape.tools?.some((tool) => tool.name === "web_search"),
      false,
    );
  });

  it("strips leaked function web_search without touching search_image", () => {
    const tools = stripProductWebSearchTools([OFFICIAL_WEB_SEARCH, SEARCH_IMAGE, GENERATE_IMAGE]);
    assert.equal(
      tools.some((tool) => tool.name === "web_search"),
      false,
    );
    assert.equal(
      tools.some((tool) => tool.name === "search_image"),
      true,
    );
    assert.equal(
      tools.some((tool) => tool.name === "generate_image"),
      true,
    );
  });

  it("leaves oauth native-tools guidance in patched sections", () => {
    const patched = patchProduceAssembly({
      sections: [
        {
          name: "oauth:native-tools",
          text: NATIVE_WEB_FORBID_SENTENCE,
        },
      ],
      tools: [OFFICIAL_WEB_SEARCH, SEARCH_IMAGE],
    });
    assert.match(patched.sections[0]?.text ?? "", /Do not call web_search or web_fetch/);
    assert.equal(
      patched.tools.some((tool) => tool.name === "web_search"),
      false,
    );
  });
});

it("adds native question guidance to existing sessions once without changing tool scope", () => {
  const assembly = grokNativeAssembly();
  const allowed = new Set(["ask_user_question"]);
  const patched = patchProduceAssembly(patchProduceAssembly(assembly, allowed), allowed);
  assert.equal(patched.sections.filter((section) => section.name === "slides:conversation-interaction").length, 1);
  assert.match(renderProduceSystem(patched), /ask_user_question/);
  assert.equal(
    patched.tools.some((tool) => tool.name === "write_page"),
    false,
  );
  assert.deepEqual(patchProduceAssembly(assembly).sections, assembly.sections);
});
