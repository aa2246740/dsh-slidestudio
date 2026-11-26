/**
 * userColors (CAP-18, VAL-DATA-011, VAL-TPL-010/011): colours the user states, declared by the Agent
 * through commit_design/write_todo, are allowed on top of every palette restriction, with the
 * documented tints and shades. The Host never reads a colour from the brief and never rewrites the
 * theme. Every check runs through the registered tools and the four pack_color callers.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createEmptyProject, loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "@open-slidestudio/exporter-native";
import type { PresentationRun } from "../index.js";
import { createPresentationRun } from "../run.js";
import { executeGenerateTool, type AgentToolState } from "./agent-tools.js";
import { SOURCE_ID, readMissingReferences, readTemplateDesign, writeTemplate } from "./deck-template.testkit.js";
import { buildDeliveryProvenance } from "./delivery-provenance.js";
import { writeDomainRuntime } from "./domain-hands.js";
import { writePageColorIssues } from "./layout-qa.js";
import { projectPackColorContext } from "./pack-color-context.js";
import { loadPlaybook } from "./playbook.js";
import { inspectRunLedger, type DeckComposedFact } from "./run-ledger.js";
import type { SkillPageInput } from "./skill-pages.js";
import { PACK_COLOR_ERROR } from "./theme-pack.js";
import {
  MAX_USER_COLORS,
  parseUserColors,
  readUserColors,
  resolvePlanningUserColors,
  userColorPalette,
} from "./user-colors.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const BRIEF = "给董事会做一份上半年经营汇报。";
const PACK = "consulting/pine-green-strategy";
const USER_BLUE = "#1F4E9A";
const REASON = "用户要求主色换成蓝色";
const USER_COLORS = [{ hex: USER_BLUE, reason: REASON }];
const FOREIGN = "#3366FF";
/** The documented 20/40/60% white tints and black shades of USER_BLUE, worked out by hand. */
const BLUE_TINTS = ["#4C71AE", "#7995C2", "#A5B8D7"];
const BLUE_SHADES = ["#193E7B", "#132F5C", "#0C1F3E"];
/** One channel off by 14 from USER_BLUE and by more than 8 from every tint and shade of it. */
const NEAR_MISS = "#1F4EA8";

const plan = () => [{ pageId: "cover", title: "公司介绍", layoutFamily: "cover", exhibits: [] }];

function colorPage(color: string): SkillPageInput {
  return {
    id: "cover",
    pageType: "cover",
    elements: [
      {
        elementId: "brand",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 600, 400],
        fill: { type: "solid", color },
      },
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 80, 480, 80],
        content: { text: "品牌公司介绍", fontSize: 36, color },
      },
    ],
  };
}

/** One layout whose only element fills with `fill`, so the colour check is the only input. */
const bandLayout = (fill: string) => ({
  scope: "layout",
  id: "body",
  name: "正文",
  elements: [{ elementId: "band", elementType: "shape", bounds: [0, 0, 960, 40], content: { fill } }],
});

function paintCover(projectRoot: string, color: string): void {
  const project = loadProject(projectRoot);
  const shape = project.pages[0]?.page.elements[0];
  const text = project.pages[0]?.page.elements[1];
  if (shape?.elementType === "shape") shape.fill = { type: "solid", color };
  if (text?.elementType === "text") {
    text.content = { text: "品牌公司介绍", fontSize: 36, color };
  }
  saveProject(project);
}

type Session = {
  projectRoot: string;
  brief: string;
  /** A colour the adopted design always allows; it seeds the cover page the ledger check repaints. */
  ownColor: string;
  designSystemId?: string;
  run: PresentationRun;
  context: {
    runId: string;
    sessionId: string;
    projectRoot: string;
    abortSignal: AbortSignal;
  };
  commit(label: string, extra?: Record<string, unknown>): ReturnType<PresentationRun["execute"]>;
  todo(label: string, extra?: Record<string, unknown>): ReturnType<PresentationRun["execute"]>;
  call(
    name: "write_page" | "write_layout",
    args: Record<string, unknown>,
    label: string,
  ): ReturnType<PresentationRun["execute"]>;
};

async function openSession(
  t: TestContext,
  options: { sessionId: string; template: boolean; designSystemId?: string; brief?: string },
): Promise<Session> {
  const brief = options.brief ?? BRIEF;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `${options.sessionId}-`));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const projectRoot = path.join(temp, "project");
  createEmptyProject(projectRoot, { title: "公司介绍" });
  if (options.template) writeTemplate(projectRoot);
  writeDomainRuntime(projectRoot, {
    brief,
    designDirection: "self-directed",
    ...(options.designSystemId ? { designSystemId: options.designSystemId } : {}),
    editorBaseUrl: "http://127.0.0.1:55200",
    strictExecution: true,
  });
  const run = createPresentationRun({ repoRoot: REPO_ROOT });
  const handle = await run.open({
    projectRoot,
    sessionId: options.sessionId,
    brief,
    editorBaseUrl: "http://127.0.0.1:55200",
    design: options.designSystemId
      ? { kind: "explicit-style", designSystemId: options.designSystemId }
      : { kind: "self-directed" },
    provider: { providerId: "test", modelId: "offline" },
  });
  const context = {
    runId: handle.runId,
    sessionId: handle.sessionId,
    projectRoot,
    abortSignal: new AbortController().signal,
  };
  if (options.template) await readTemplateDesign(run, context, projectRoot, options.sessionId);
  await readMissingReferences(run, context, options.sessionId);
  const adopted = options.template ? { adoptedSourceIds: [SOURCE_ID] } : {};
  return {
    projectRoot,
    brief,
    ownColor: options.template ? "#C8102E" : "#03522C",
    designSystemId: options.designSystemId,
    run,
    context,
    commit: (label, extra = {}) =>
      run.execute(
        { name: "commit_design", args: { slidePlan: plan(), ...adopted, ...extra } },
        { ...context, toolCallId: `${options.sessionId}-${label}` },
      ),
    todo: (label, extra = {}) =>
      run.execute(
        { name: "write_todo", args: { items: plan(), ...adopted, ...extra } },
        { ...context, toolCallId: `${options.sessionId}-${label}` },
      ),
    call: (name, args, label) =>
      run.execute({ name, args }, { ...context, toolCallId: `${options.sessionId}-${label}` }),
  };
}

function runtimeFile(projectRoot: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, "_agent", "runtime.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function agentState(session: Session): AgentToolState {
  return {
    brief: session.brief,
    playbook: loadPlaybook({
      ...(session.designSystemId ? { designSystemId: session.designSystemId } : {}),
      hostDefaults: false,
    }),
    todos: [],
    researchNotes: [],
    writtenPages: [],
    projectRoot: session.projectRoot,
  };
}

const sealed = (): DeckComposedFact => ({
  type: "deck.composed",
  factId: "user-colors-seal",
  at: "2026-01-01T00:00:00.000Z",
  contextEpochId: "user-colors-epoch",
  title: "公司介绍",
  deckSha256: "b".repeat(64),
  pageRevisions: {},
});

/** Every pack_color caller on one colour: write_page, write_layout, the agent write tool, the ledger. */
async function refusedBy(session: Session, color: string, label: string): Promise<string[]> {
  const refused: string[] = [];
  const page = await session.call("write_page", colorPage(color) as never, `${label}-page`);
  if (!page.ok) {
    assert.equal(page.payload.error, PACK_COLOR_ERROR, page.detail);
    refused.push("write_page");
  }
  const layout = await session.call("write_layout", bandLayout(color), `${label}-layout`);
  if (!layout.ok) {
    assert.equal(layout.payload.error, PACK_COLOR_ERROR, layout.detail);
    refused.push("write_layout");
  }
  const agent = executeGenerateTool("write_page", colorPage(color), agentState(session));
  if (!agent.ok) {
    assert.equal((agent.payload as Record<string, unknown>).error, PACK_COLOR_ERROR, agent.detail);
    refused.push("agent-tools");
  }
  if (!loadProject(session.projectRoot).pages.length) {
    const seeded = await session.call("write_page", colorPage(session.ownColor) as never, `${label}-seed`);
    assert.equal(seeded.ok, true, seeded.detail);
  }
  paintCover(session.projectRoot, color);
  if (inspectRunLedger(session.projectRoot).composeBlockers.some((line) => line.includes(PACK_COLOR_ERROR))) {
    refused.push("run-ledger");
  }
  return refused;
}

const ALL_CALLERS = ["write_page", "write_layout", "agent-tools", "run-ledger"];

describe("userColors over an adopted template (VAL-DATA-011, VAL-TPL-010)", () => {
  it("refuses the user colour everywhere until the Agent declares it, then accepts it and its variants", async (t) => {
    const session = await openSession(t, { sessionId: "user-colors-template", template: true });
    const plain = await session.commit("plain");
    assert.equal(plain.ok, true, plain.detail);
    assert.deepEqual(await refusedBy(session, USER_BLUE, "before"), ALL_CALLERS);
    const themeBefore = JSON.stringify(loadProject(session.projectRoot).presentation.theme);

    const declared = await session.commit("declared", { userColors: USER_COLORS });
    assert.equal(declared.ok, true, declared.detail);
    assert.deepEqual(declared.payload.userColors, USER_COLORS);

    for (const color of [USER_BLUE, ...BLUE_TINTS, ...BLUE_SHADES]) {
      assert.deepEqual(await refusedBy(session, color, `ok-${color.slice(1)}`), [], color);
    }
    // The template's own palette keeps working beside the user colour.
    assert.deepEqual(await refusedBy(session, "#C8102E", "template"), []);

    const foreign = await session.call("write_page", colorPage(FOREIGN) as never, "foreign-page");
    assert.equal(foreign.ok, false);
    assert.equal(foreign.payload.error, PACK_COLOR_ERROR);
    assert.match(foreign.detail, /已采用的设计源/);
    assert.match(foreign.detail, /#3366FF/);
    assert.match(foreign.detail, /#1F4E9A/, "the refusal lists the user colour among the allowed");
    assert.deepEqual(await refusedBy(session, FOREIGN, "foreign"), ALL_CALLERS);
    assert.deepEqual(await refusedBy(session, NEAR_MISS, "near-miss"), ALL_CALLERS);

    assert.equal(
      JSON.stringify(loadProject(session.projectRoot).presentation.theme),
      themeBefore,
      "declaring a user colour never rewrites the theme",
    );
  });

  it("keeps theme1.xml on the template's colours when the Agent paints with a user colour", async (t) => {
    const session = await openSession(t, { sessionId: "user-colors-theme", template: true });
    const declared = await session.commit("declared", { userColors: USER_COLORS });
    assert.equal(declared.ok, true, declared.detail);
    const page = await session.call("write_page", colorPage(USER_BLUE) as never, "page");
    assert.equal(page.ok, true, page.detail);
    const { default: JSZip } = await import("jszip");
    const exported = await exportProjectToPptx(loadProject(session.projectRoot));
    const zip = await JSZip.loadAsync(exported.data);
    const theme = await zip.file("ppt/theme/theme1.xml")!.async("string");
    assert.match(theme, /C8102E/i, "the adopted accent still seeds the exported theme");
    assert.doesNotMatch(theme, /1F4E9A/i);
    const slide = await zip.file("ppt/slides/slide1.xml")!.async("string");
    assert.match(slide, /1F4E9A/i, "the slide itself paints the user colour");
  });

  it("never reads a colour from the brief: stating it in words without userColors still refuses it", async (t) => {
    const session = await openSession(t, {
      sessionId: "user-colors-brief",
      template: true,
      brief: "给董事会做一份上半年经营汇报，主色换成蓝色 #1F4E9A。",
    });
    const committed = await session.commit("plain");
    assert.equal(committed.ok, true, committed.detail);
    assert.deepEqual(await refusedBy(session, USER_BLUE, "brief"), ALL_CALLERS);
    assert.equal("userColors" in runtimeFile(session.projectRoot), false);
  });

  it("persists userColors in runtime.json, keeps them across a plan update that omits the field, and clears them with []", async (t) => {
    const session = await openSession(t, { sessionId: "user-colors-persist", template: true });
    const declared = await session.commit("declared", { userColors: USER_COLORS });
    assert.equal(declared.ok, true, declared.detail);
    assert.deepEqual(runtimeFile(session.projectRoot).userColors, USER_COLORS);

    const kept = await session.todo("omitted");
    assert.equal(kept.ok, true, kept.detail);
    assert.deepEqual(runtimeFile(session.projectRoot).userColors, USER_COLORS);
    assert.deepEqual(kept.payload.userColors, USER_COLORS);
    assert.deepEqual(await refusedBy(session, USER_BLUE, "kept"), []);

    const replaced = await session.todo("replaced", {
      userColors: [{ hex: "#aa5500", reason: "用户要求强调色用橙棕" }],
    });
    assert.equal(replaced.ok, true, replaced.detail);
    assert.deepEqual(runtimeFile(session.projectRoot).userColors, [{ hex: "#AA5500", reason: "用户要求强调色用橙棕" }]);
    assert.deepEqual(await refusedBy(session, USER_BLUE, "replaced"), ALL_CALLERS);
    assert.deepEqual(await refusedBy(session, "#AA5500", "replaced-new"), []);

    const cleared = await session.commit("cleared", { userColors: [] });
    assert.equal(cleared.ok, true, cleared.detail);
    assert.equal("userColors" in runtimeFile(session.projectRoot), false);
    assert.deepEqual(await refusedBy(session, "#AA5500", "cleared"), ALL_CALLERS);
  });

  it("refuses an invalid hex or an empty reason in Chinese and changes nothing", async (t) => {
    const session = await openSession(t, { sessionId: "user-colors-invalid", template: true });
    const before = fs.readFileSync(path.join(session.projectRoot, "_agent", "runtime.json"), "utf8");
    const cases: Array<[unknown, RegExp]> = [
      [[{ hex: "blue", reason: REASON }], /#RRGGBB/],
      [[{ hex: "#12345", reason: REASON }], /#RRGGBB/],
      [[{ hex: USER_BLUE, reason: "   " }], /reason/],
      [[{ hex: USER_BLUE }], /reason/],
      [[{ reason: REASON }], /#RRGGBB/],
      ["#1F4E9A", /userColors/],
    ];
    for (const [index, [userColors, expected]] of cases.entries()) {
      const result = await session.commit(`bad-${index}`, { userColors });
      assert.equal(result.ok, false, `case ${index}`);
      assert.match(result.detail, expected, `case ${index}: ${result.detail}`);
      assert.match(result.detail, /[一-鿿]/, "the refusal is Chinese");
    }
    assert.equal(
      fs.readFileSync(path.join(session.projectRoot, "_agent", "runtime.json"), "utf8"),
      before,
      "a refused declaration leaves the saved design untouched",
    );
  });

  it("records the entries in the delivery provenance as the palette origin", async (t) => {
    const session = await openSession(t, { sessionId: "user-colors-provenance", template: true });
    const declared = await session.commit("declared", { userColors: USER_COLORS });
    assert.equal(declared.ok, true, declared.detail);
    const built = buildDeliveryProvenance(session.projectRoot, sealed());
    assert.deepEqual(built.file.design.userColors, USER_COLORS);
    const withoutColors = await openSession(t, {
      sessionId: "user-colors-provenance-none",
      template: true,
    });
    const plain = await withoutColors.commit("plain");
    assert.equal(plain.ok, true, plain.detail);
    assert.deepEqual(buildDeliveryProvenance(withoutColors.projectRoot, sealed()).file.design.userColors, []);
  });
});

describe("userColors over a Hub style pack (VAL-DATA-011)", () => {
  it("accepts the user colour and its variants on pages and layouts beside the pack's own palette", async (t) => {
    const session = await openSession(t, {
      sessionId: "user-colors-pack",
      template: false,
      designSystemId: PACK,
    });
    const plain = await session.commit("plain");
    assert.equal(plain.ok, true, plain.detail);
    assert.deepEqual(await refusedBy(session, USER_BLUE, "before"), ALL_CALLERS);
    assert.deepEqual(await refusedBy(session, "#03522C", "pack-own"), []);

    const declared = await session.commit("declared", { userColors: USER_COLORS });
    assert.equal(declared.ok, true, declared.detail);
    assert.deepEqual(runtimeFile(session.projectRoot).userColors, USER_COLORS);
    for (const color of [USER_BLUE, ...BLUE_TINTS, ...BLUE_SHADES]) {
      assert.deepEqual(await refusedBy(session, color, `ok-${color.slice(1)}`), [], color);
    }
    assert.deepEqual(await refusedBy(session, "#03522C", "pack-still"), []);
    assert.deepEqual(await refusedBy(session, FOREIGN, "foreign"), ALL_CALLERS);
    const issues = writePageColorIssues(colorPage(NEAR_MISS), undefined, projectPackColorContext(session.projectRoot));
    assert.equal(issues[0]?.code, "pack_color");
  });

  it("does not turn an unrestricted project into a restricted one", async (t) => {
    const session = await openSession(t, {
      sessionId: "user-colors-free",
      template: false,
      brief: "做一份说明。",
    });
    const declared = await session.commit("declared", { userColors: USER_COLORS });
    assert.equal(declared.ok, true, declared.detail);
    assert.deepEqual(projectPackColorContext(session.projectRoot), {});
    assert.deepEqual(await refusedBy(session, FOREIGN, "free"), []);
  });
});

describe("userColors parsing and the palette they grant (VAL-TPL-011)", () => {
  const projectWith = (t: TestContext, runtime: string | undefined): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "user-colors-unit-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    if (runtime !== undefined) fs.writeFileSync(path.join(root, "_agent", "runtime.json"), runtime);
    return root;
  };

  it("normalizes hex to uppercase, trims the reason and keeps the first of a repeated colour", () => {
    assert.deepEqual(parseUserColors(undefined), []);
    assert.deepEqual(parseUserColors([]), []);
    assert.deepEqual(
      parseUserColors([
        { hex: " #1f4e9a ", reason: `  ${REASON} ` },
        { hex: "#1F4E9A", reason: "重复的颜色" },
        { hex: "#aa5500", reason: "强调色" },
      ]),
      [
        { hex: USER_BLUE, reason: REASON },
        { hex: "#AA5500", reason: "强调色" },
      ],
    );
  });

  it("refuses unreadable input in Chinese, naming the field and the fix", () => {
    const bad: Array<[unknown, RegExp]> = [
      ["#1F4E9A", /userColors 的格式不对/],
      [null, /userColors 的格式不对/],
      [{ hex: USER_BLUE, reason: REASON }, /userColors 的格式不对/],
      [[{ hex: "#FFF", reason: REASON }], /「#FFF」不是 #RRGGBB/],
      [[{ hex: "1F4E9A", reason: REASON }], /「1F4E9A」不是 #RRGGBB/],
      [[{ hex: "#GG4E9A", reason: REASON }], /不是 #RRGGBB/],
      [[{ hex: 123456, reason: REASON }], /不是 #RRGGBB/],
      [[{ hex: USER_BLUE, reason: "" }], /「#1F4E9A」缺少 reason/],
      [[{ hex: USER_BLUE, reason: 7 }], /缺少 reason/],
      [[{ hex: USER_BLUE, reason: "蓝".repeat(121) }], /reason 超过 120 字/],
      [
        Array.from({ length: MAX_USER_COLORS + 1 }, (_, index) => ({
          hex: `#10101${index.toString(16)}`,
          reason: "要求",
        })),
        new RegExp(`最多 ${MAX_USER_COLORS} 个颜色`),
      ],
    ];
    for (const [value, expected] of bad) {
      assert.throws(() => parseUserColors(value), expected, JSON.stringify(value));
    }
  });

  it("reads the saved declaration and grants nothing from an unreadable or invalid file", (t) => {
    const saved = JSON.stringify({ brief: "x", userColors: USER_COLORS });
    assert.deepEqual(readUserColors(projectWith(t, saved)), USER_COLORS);
    assert.deepEqual(readUserColors(projectWith(t, JSON.stringify({ brief: "x" }))), []);
    assert.deepEqual(readUserColors(projectWith(t, undefined)), []);
    assert.deepEqual(readUserColors(projectWith(t, "{not json")), []);
    const invalid = JSON.stringify({ userColors: [{ hex: "blue", reason: REASON }] });
    assert.deepEqual(readUserColors(projectWith(t, invalid)), []);
    assert.deepEqual(readUserColors(path.join(os.tmpdir(), "oss-user-colors-missing-dir")), []);
  });

  it("keeps the saved declaration when a plan omits the field and replaces it otherwise", (t) => {
    const root = projectWith(t, JSON.stringify({ userColors: USER_COLORS }));
    assert.deepEqual(resolvePlanningUserColors(root, {}), USER_COLORS);
    assert.deepEqual(resolvePlanningUserColors(root, { userColors: undefined }), USER_COLORS);
    assert.deepEqual(resolvePlanningUserColors(root, { userColors: [] }), []);
    assert.deepEqual(resolvePlanningUserColors(root, { userColors: [{ hex: "#aa5500", reason: "强调色" }] }), [
      { hex: "#AA5500", reason: "强调色" },
    ]);
    assert.throws(() => resolvePlanningUserColors(root, { userColors: [{ hex: "x", reason: REASON }] }), /#RRGGBB/);
  });

  it("grants each colour with exactly the documented 20/40/60% white tints and black shades", (t) => {
    const root = projectWith(t, JSON.stringify({ userColors: USER_COLORS }));
    assert.deepEqual([...userColorPalette(root)].sort(), [USER_BLUE, ...BLUE_TINTS, ...BLUE_SHADES].sort());
    assert.equal(userColorPalette(projectWith(t, JSON.stringify({}))).size, 0);
  });

  it("shares one tint/shade function with the material palette", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sourceDir = path.join(here, "..", "..", "src", "domain");
    const consumers = ["user-colors.ts", "theme-pack.ts", "palette-source.ts"];
    for (const file of consumers) {
      assert.match(
        fs.readFileSync(path.join(sourceDir, file), "utf8"),
        /palette-variants\.js/,
        `${file} takes its variants from palette-variants`,
      );
    }
  });
});
