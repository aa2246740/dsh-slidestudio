/**
 * Fail-closed fingerprint of the produce gates.
 * A stale DSH profile copy that lacks these must not serve Hub generate.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyProject, elementFillPaint, loadProject, toRgbHex } from "@open-slidestudio/pptd-v2";
import { visualReviewIsClaimable } from "./capabilities.js";
import {
  EMPTY_CLOSER_PRODUCE_NEXT,
  HOST_SEED_PRODUCE_NEXT,
  isPlaceholderReviewIssue,
  isWritePageCloser,
  pageCoverage,
  pageHasVisibleContent,
  persistPageKey,
  persistPagePathFromId,
  pageIdMatchesFile,
  tableEmptyCellIssues,
  writePageSchemaError,
  writePageSchemaIssues,
  composedPageLeftoverIssues,
  renderedLayoutBlocksCompose,
  isHostOpenedSeedPath,
} from "./domain/layout-qa.js";
import { inferDeckIntent, classifyBriefKind } from "./domain/compose-ir.js";
import { kindThemePackIssue, packColorWriteContextFrom, sourceIdList, PACK_COLOR_ERROR } from "./domain/theme-pack.js";
import { readMaterialChunk } from "./domain/material-content.js";
import { verifyMaterial, materialCapabilityEntries } from "./domain/material-pack.js";
import { probeTemplateDesignPaletteGate, probeTemplateDesignSourceFiles } from "./template-design-gate-probes.js";
import type { SkillPageInput } from "./domain/skill-pages.js";
import { PRODUCE_GATE_REL_FILES } from "./produce-gate-files.js";

export { PRODUCE_GATE_REL_FILES } from "./produce-gate-files.js";

export const PRODUCE_GATES_ID = "edith-twenty-five-v1";

const navy: SkillPageInput["elements"][number] = {
  elementId: "cl-bg",
  elementType: "shape",
  shapeName: "rect",
  bounds: [0, 0, 960, 540],
  fill: { type: "solid", color: "#06223F" },
};

function textEl(
  id: string,
  text: string,
  bounds: [number, number, number, number],
): SkillPageInput["elements"][number] {
  return {
    elementId: id,
    elementType: "text",
    bounds,
    content: { text, fontSize: 18, color: "#FFFFFF" },
  };
}

import { liveApi, type ProduceGateApi } from "./produce-gate-api.js";
export type { ProduceGateApi };

export type ProduceGateReport = {
  readonly ok: boolean;
  readonly id: string;
  readonly missing: readonly string[];
  readonly failed: readonly string[];
};

function missingFn(api: ProduceGateApi, name: keyof ProduceGateApi): boolean {
  return typeof api[name] !== "function" && name !== "EMPTY_CLOSER_PRODUCE_NEXT" && name !== "HOST_SEED_PRODUCE_NEXT";
}

export function inspectProduceGates(api: ProduceGateApi = liveApi): ProduceGateReport {
  const missing: string[] = [];
  const failed: string[] = [];
  const keys: (keyof ProduceGateApi)[] = [
    "pageHasVisibleContent",
    "pageCoverage",
    "persistPageKey",
    "persistPagePathFromId",
    "pageIdMatchesFile",
    "tableEmptyCellIssues",
    "writePageSchemaIssues",
    "writePageSchemaError",
    "isWritePageCloser",
    "visualReviewIsClaimable",
    "isPlaceholderReviewIssue",
    "composedPageLeftoverIssues",
    "renderedLayoutBlocksCompose",
    "verifyMaterial",
    "readMaterialChunk",
    "materialCapabilityEntries",
  ];
  for (const key of keys) {
    if (missingFn(api, key)) missing.push(String(key));
  }
  if (typeof api.EMPTY_CLOSER_PRODUCE_NEXT !== "string") missing.push("EMPTY_CLOSER_PRODUCE_NEXT");
  if (typeof api.HOST_SEED_PRODUCE_NEXT !== "string") missing.push("HOST_SEED_PRODUCE_NEXT");
  if (missing.length) {
    return { ok: false, id: PRODUCE_GATES_ID, missing, failed };
  }

  const navyPage: SkillPageInput = { id: "16_content", pageType: "content", elements: [navy] };
  if (api.pageHasVisibleContent(navyPage) !== false) failed.push("has-content");
  if (api.pageCoverage(navyPage.elements) < 1) failed.push("coverage-still-full");

  const leftoverCtx = { lastDiskBasename: "16_content", diskPageCount: 16 };
  if (!api.isWritePageCloser(navyPage, leftoverCtx)) failed.push("empty_closer-last-disk");
  const leftoverErr = api.writePageSchemaError(api.writePageSchemaIssues(navyPage, leftoverCtx), navyPage, leftoverCtx);
  if (leftoverErr?.error !== "empty_closer") failed.push("empty_closer-schema");
  if (
    !/write_page/.test(api.EMPTY_CLOSER_PRODUCE_NEXT) ||
    !/Host will not paint leftover/.test(api.EMPTY_CLOSER_PRODUCE_NEXT)
  ) {
    failed.push("empty_closer-produce-next");
  }
  if (
    !/write_page/.test(api.HOST_SEED_PRODUCE_NEXT) ||
    !/1_cover\.page/.test(api.HOST_SEED_PRODUCE_NEXT) ||
    !/Host will not paint leftover/.test(api.HOST_SEED_PRODUCE_NEXT)
  ) {
    failed.push("host-seed-produce-next");
  }

  const seedTitle: SkillPageInput["elements"][number] = {
    elementId: "title",
    elementType: "text",
    bounds: [80, 200, 800, 80],
    content: { text: "澄光生活 2026年7月经营月报", fontSize: 36, color: "#111111" },
  };
  const agentCover: SkillPageInput["elements"][number][] = [
    navy,
    textEl("t1", "差 140 万不是客单下跌", [50, 170, 700, 80]),
    textEl("t2", "2026年7月经营月报已核实数字", [50, 270, 800, 40]),
  ];
  const withSeed = [
    { path: "pages/1_cover.page", page: { pageType: "cover" as const, elements: [seedTitle] } },
    { path: "pages/p01_cover.page", page: { pageType: "cover" as const, elements: agentCover } },
  ];
  if (!api.composedPageLeftoverIssues(withSeed).some((issue) => issue.kind === "host_seed")) {
    failed.push("host-seed-leftover");
  }
  if (api.composedPageLeftoverIssues(withSeed.slice(1)).some((issue) => issue.kind === "host_seed")) {
    failed.push("host-seed-false-positive");
  }
  if (!api.renderedLayoutBlocksCompose("fail")) failed.push("layout-fail-blocks");
  if (api.renderedLayoutBlocksCompose("missing")) failed.push("layout-missing-deadlock");
  if (api.renderedLayoutBlocksCompose("unavailable")) failed.push("layout-unavailable-deadlock");
  if (api.renderedLayoutBlocksCompose("pass")) failed.push("layout-pass-false-positive");
  if (!api.renderedLayoutBlocksCompose("missing", true)) failed.push("layout-required-missing-pass");
  if (!api.renderedLayoutBlocksCompose("unavailable", true)) failed.push("layout-required-unavailable-pass");
  if (api.renderedLayoutBlocksCompose("pass", true)) failed.push("layout-required-pass-false-positive");

  if (api.persistPageKey("01_cover") !== api.persistPageKey("1_cover")) failed.push("persist-by-id-pad");
  if (api.persistPageKey("16_final") === api.persistPageKey("15_final")) failed.push("persist-by-id-distinct");
  if (api.persistPagePathFromId("1_cover") !== "pages/1_cover.page") failed.push("persist-id-path");
  if (api.persistPagePathFromId("1_cover.page") !== "pages/1_cover.page") failed.push("persist-dot-id");
  if (api.persistPagePathFromId("12_div_ops") !== "pages/12_div_ops.page") failed.push("persist-div-ops");
  if (api.persistPagePathFromId("12_div_ops.page") !== "pages/12_div_ops.page") failed.push("persist-div-ops-dot");
  if (api.persistPagePathFromId("p01_cover") !== "pages/p01_cover.page") failed.push("persist-p01");
  if (api.persistPageKey(api.persistPagePathFromId("1_cover.page")) !== api.persistPageKey("1_cover.page")) {
    failed.push("persist-roundtrip");
  }
  if (!api.pageIdMatchesFile("1_cover.page", "pages/1_cover.page")) failed.push("persist-match-dot-id");
  if (!api.pageIdMatchesFile("1_cover", "pages/1_cover.page")) failed.push("persist-match-id");
  if (api.pageIdMatchesFile("1_cover.page", "pages/1_coverpage.page")) failed.push("persist-match-stripped-dot");
  if (api.pageIdMatchesFile("1_cover", "pages/02_cover.page")) failed.push("persist-match-numbered-leftover");

  const tablePage: SkillPageInput = {
    id: "stock",
    pageType: "content",
    elements: [
      navy,
      textEl("t", "缺货表", [40, 36, 800, 40]),
      {
        elementId: "tbl",
        elementType: "table",
        bounds: [44, 178, 872, 190],
        rows: [
          [{ text: "SKU" }, { text: "缺货天数" }],
          [{ text: "杯" }, { text: "" }],
        ],
      } as SkillPageInput["elements"][number],
    ],
  };
  if (!api.tableEmptyCellIssues(tablePage).some((issue) => issue.code === "empty_cell")) {
    failed.push("empty-cell");
  }

  const overflowPage: SkillPageInput = {
    id: "overflow",
    pageType: "content",
    elements: [navy, textEl("wide", "溢出标题足够长了用于测试", [0, 0, 2000, 80])],
  };
  const overflowErr = api.writePageSchemaError(api.writePageSchemaIssues(overflowPage), overflowPage);
  if (overflowErr?.error !== "overflow") failed.push("bounds-overflow");

  const overlapPage: SkillPageInput = {
    id: "overlap",
    pageType: "content",
    elements: [
      navy,
      textEl("a", "第一段可读文字足够", [80, 80, 400, 80]),
      textEl("b", "第二段可读文字足够", [100, 90, 400, 80]),
    ],
  };
  const overlapErr = api.writePageSchemaError(api.writePageSchemaIssues(overlapPage), overlapPage);
  if (overlapErr?.error !== "overlap") failed.push("bounds-overlap");

  const omitted = api.writePageSchemaIssues(
    { id: "omit", pageType: "content", elements: [navy, textEl("t", "有字", [80, 80, 200, 40])] },
    {},
    {
      id: "omit",
      pageType: "content",
      elements: [{ elementId: "ghost", elementType: "text", content: { text: "有字" } }],
    },
  );
  if (!omitted.some((issue) => issue.code === "bounds_omitted")) failed.push("bounds-omitted");

  const footerPage: SkillPageInput = {
    id: "footer",
    pageType: "content",
    elements: [navy, textEl("src", "来源：内部核对", [40, 508, 400, 20])],
  };
  const footerErr = api.writePageSchemaError(api.writePageSchemaIssues(footerPage), footerPage);
  if (footerErr?.error !== "footer_zone") failed.push("footer-zone-reject");
  const footerOk: SkillPageInput = {
    id: "footer-ok",
    pageType: "content",
    elements: [
      navy,
      {
        ...textEl("src", "来源：内部核对", [40, 508, 400, 20]),
        layoutRole: "footer",
      },
    ],
  };
  if (api.writePageSchemaError(api.writePageSchemaIssues(footerOk), footerOk)) {
    failed.push("footer-zone-false-positive");
  }

  if (api.visualReviewIsClaimable({ SLIDESTUDIO_VISION_REVIEWER: "", SLIDESTUDIO_LLM_IMAGE: "0" })) {
    failed.push("review-vision-none");
  }
  if (!api.isPlaceholderReviewIssue("none")) failed.push("review-issues-none");

  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    probeTemplateDesignSourceFiles(here, failed);
    const qaJs = path.join(here, "domain", "layout-qa.js");
    const toolsJs = path.join(here, "domain", "agent-tools.js");
    const qa = fs.readFileSync(qaJs, "utf8");
    if (
      !qa.includes("pageHasVisibleContent") ||
      !qa.includes("isWritePageCloser") ||
      !qa.includes("composedPageLeftoverIssues") ||
      !qa.includes("persistPagePathFromId") ||
      !qa.includes("pageIdMatchesFile") ||
      !qa.includes("background-color") ||
      !qa.includes("@style.") ||
      !qa.includes("pack_color") ||
      !qa.includes("did not rebind Theme.colors")
    ) {
      failed.push("layout-qa-symbols");
    }
    const composeJs = path.join(here, "domain", "compose-ir.js");
    const composeBody = fs.readFileSync(composeJs, "utf8");
    if (!composeBody.includes("classifyBriefKind") || !composeBody.includes("board-h1")) {
      failed.push("brief-kind-classify");
    }
    if (!composeBody.includes('"academic"')) failed.push("academic-kind-classify");
    if (!composeBody.includes("learn-share") || !composeBody.includes("学习分享")) {
      failed.push("learn-share-kind-classify");
    }
    const body = fs.readFileSync(toolsJs, "utf8");
    if (/writtenPages\.length\s*<\s*2/.test(body)) failed.push("compose-skip");
    if (!/next:\s*"write_page"/.test(body)) failed.push("leftover-produce-next");
    if (!body.includes("persistPagePathFromId")) failed.push("persist-path-from-id");
    if (!body.includes("packColorWriteContext") || !body.includes("state.projectRoot")) {
      failed.push("pack-color-write");
    }
    if (/page\.id\.replace\(\/\(\[\^a-zA-Z0-9_-\]\+\)\/g/.test(body)) failed.push("persist-id-strip-dot");
    const pptdDist = path.dirname(fileURLToPath(import.meta.resolve("@open-slidestudio/pptd-v2")));
    const parseJs = path.join(pptdDist, "parse.js");
    const parseBody = fs.readFileSync(parseJs, "utf8");
    if (/pages:\s*\[\s*["']pages\/1_cover\.page["']/.test(parseBody)) {
      failed.push("create-lists-seed-source");
    }
    const exportJs = path.resolve(here, "../../exporter-native/dist/export-pptd.js");
    const exportBody = fs.readFileSync(exportJs, "utf8");
    if (/if\s*\(\s*!fill\s*\)\s*return\s*\{\s*color:\s*["']FFFFFF["']\s*\}/.test(exportBody)) {
      failed.push("export-missing-fill-white");
    }
    if (!exportBody.includes("elementFillPaint")) {
      failed.push("export-shared-fill-paint");
    }
    if (/hex\(\s*st\.color\b/.test(exportBody)) {
      failed.push("export-css-as-pptd-color");
    }
    if (!exportBody.includes("colorHex")) {
      failed.push("export-text-colorhex");
    }
    const themeJs = path.join(pptdDist, "theme.js");
    const themeBody = fs.readFileSync(themeJs, "utf8");
    if (!themeBody.includes("elementFillPaint")) {
      failed.push("shared-fill-paint");
    }
    if (/if\s*\(\s*!v\.startsWith\(\s*["']#["']\s*\)\s*\)\s*return fallback/.test(themeBody)) {
      failed.push("unprefixed-hex-fallback");
    }
    if (!themeBody.includes("officialPptdColorKind") || !themeBody.includes("InvalidPptdColorError")) {
      failed.push("unprefixed-hex-parse");
    }
    const shapePaintJs = path.resolve(here, "../../../apps/native-web/public/shape-paint.js");
    if (fs.existsSync(shapePaintJs)) {
      const shapePaintBody = fs.readFileSync(shapePaintJs, "utf8");
      if (/fillCss\s*\|\|\s*["']#2563EB["']/.test(shapePaintBody)) {
        failed.push("hub-svg-default-blue");
      }
    }
  } catch {
    failed.push("compose-source-unreadable");
  }

  if (elementFillPaint("shape", undefined, 0.3).type !== "none") {
    failed.push("omitted-fill-shape-paint");
  }
  const iconPaint = elementFillPaint("icon", undefined, 1);
  if (iconPaint.type !== "solid" || iconPaint.hex !== "#000000") {
    failed.push("omitted-fill-icon-paint");
  }

  const assertUnprefixedNeverBlack = (raw: string, want: string) => {
    try {
      const got = toRgbHex(raw);
      if (got.replace("#", "").toUpperCase() === "000000") failed.push("unprefixed-hex-black");
      if (got.replace("#", "").toUpperCase() !== want) failed.push("unprefixed-hex-invented");
    } catch {
      /* official requires #RRGGBB: reject is the inversion */
    }
  };
  assertUnprefixedNeverBlack("0E0807", "0E0807");
  assertUnprefixedNeverBlack("E8DED7", "E8DED7");
  if (toRgbHex("#0E0807") !== "#0E0807" || toRgbHex("#E8DED7") !== "#E8DED7") {
    failed.push("prefixed-hex-roundtrip");
  }
  const unprefixedPage: SkillPageInput = {
    id: "19_final",
    pageType: "final",
    elements: [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "0E0807" },
      },
      textEl("recap", "我把一条事故频发的发布线改造成可回滚。", [60, 120, 840, 80]),
      {
        elementId: "ask",
        elementType: "text",
        bounds: [60, 312, 840, 80],
        content: { text: "下个月请评委给三件事反馈。", fontSize: 16, color: "E8DED7" },
      },
    ],
  };
  const unprefixedErr = api.writePageSchemaError(api.writePageSchemaIssues(unprefixedPage), unprefixedPage);
  if (unprefixedErr?.error !== "invalid_color") failed.push("unprefixed-write-reject");

  const assertUnresolvedThemeNeverBlack = (raw: string) => {
    try {
      const got = toRgbHex(raw);
      if (got.replace("#", "").toUpperCase() === "000000") failed.push("unresolved-theme-black");
    } catch {
      /* official $theme must exist in Theme.colors */
    }
  };
  assertUnresolvedThemeNeverBlack("$nope");
  if (toRgbHex("$primary", { colors: { primary: "#2563EB" } }) !== "#2563EB") {
    failed.push("resolved-theme-roundtrip");
  }
  const unresolvedThemePage: SkillPageInput = {
    id: "19_final",
    pageType: "final",
    elements: [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "#0E0807" },
      },
      textEl("recap", "我把一条事故频发的发布线改造成可回滚。", [60, 120, 840, 80]),
      {
        elementId: "ask",
        elementType: "text",
        bounds: [60, 312, 840, 80],
        content: { text: "下个月请评委给三件事反馈。", fontSize: 16, color: "$nope" },
      },
    ],
  };
  const unresolvedThemeErr = api.writePageSchemaError(
    api.writePageSchemaIssues(unresolvedThemePage),
    unresolvedThemePage,
  );
  if (unresolvedThemeErr?.error !== "invalid_color") failed.push("unresolved-theme-write-reject");
  const resolvedTheme = { colors: { primary: "#2563EB", text: "#111111" } };
  const resolvedThemePage: SkillPageInput = {
    id: "19_final",
    pageType: "final",
    elements: [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "$primary" },
      },
      textEl("recap", "我把一条事故频发的发布线改造成可回滚。", [60, 120, 840, 80]),
      {
        elementId: "ask",
        elementType: "text",
        bounds: [60, 312, 840, 80],
        content: { text: "下个月请评委给三件事反馈。", fontSize: 16, color: "$text" },
      },
    ],
  };
  const resolvedThemeErr = api.writePageSchemaError(
    api.writePageSchemaIssues(resolvedThemePage, { theme: resolvedTheme }),
    resolvedThemePage,
    { theme: resolvedTheme },
  );
  if (resolvedThemeErr) failed.push("resolved-theme-write-accept");

  const htmlUnprefixedPage: SkillPageInput = {
    id: "19_final",
    pageType: "final",
    elements: [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "#0E0807" },
      },
      {
        elementId: "recap",
        elementType: "text",
        bounds: [60, 120, 840, 80],
        content: {
          text: '<p><span style="color:0E0807">我把一条事故频发的发布线改造成可回滚。</span></p>',
          fontSize: 18,
          color: "#E8DED7",
        },
      },
      {
        elementId: "ask",
        elementType: "text",
        bounds: [60, 312, 840, 80],
        content: {
          text: "<p>下个月请评委给三件事反馈。</p>",
          fontSize: 16,
          color: "#E8DED7",
        },
      },
    ],
  };
  const htmlUnprefixedErr = api.writePageSchemaError(api.writePageSchemaIssues(htmlUnprefixedPage), htmlUnprefixedPage);
  if (htmlUnprefixedErr?.error !== "invalid_color") failed.push("html-unprefixed-write-reject");
  const htmlOfficialTheme = { colors: { primary: "#2563EB", text: "#111111" } };
  const htmlOfficialPage: SkillPageInput = {
    id: "19_final",
    pageType: "final",
    elements: [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "#0E0807" },
      },
      {
        elementId: "recap",
        elementType: "text",
        bounds: [60, 120, 840, 80],
        content: {
          text: '<p><span style="color:#E8DED7">我把一条事故频发的发布线改造成可回滚。</span></p>',
          fontSize: 18,
          color: "#E8DED7",
        },
      },
      {
        elementId: "ask",
        elementType: "text",
        bounds: [60, 312, 840, 80],
        content: {
          text: '<p><span style="color:$primary; background-color:#f00">下个月请评委给三件事反馈。</span></p>',
          fontSize: 16,
          color: "#E8DED7",
        },
      },
    ],
  };
  const htmlOfficialErr = api.writePageSchemaError(
    api.writePageSchemaIssues(htmlOfficialPage, { theme: htmlOfficialTheme }),
    htmlOfficialPage,
    { theme: htmlOfficialTheme },
  );
  if (htmlOfficialErr) failed.push("html-official-write-accept");
  const htmlPlainHexPage: SkillPageInput = {
    id: "19_final",
    pageType: "final",
    elements: [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "#0E0807" },
      },
      textEl(
        "recap",
        "<p>我把一条事故频发的发布线改造成可回滚。主色 0E0807 写在正文里，没有 style 属性。</p>",
        [60, 120, 840, 80],
      ),
      textEl("ask", "<p>下个月请评委给三件事反馈。</p>", [60, 312, 840, 80]),
    ],
  };
  const htmlPlainHexErr = api.writePageSchemaError(api.writePageSchemaIssues(htmlPlainHexPage), htmlPlainHexPage);
  if (htmlPlainHexErr) failed.push("html-plaintext-hex-false-positive");

  const pinePack = packColorWriteContextFrom({
    designSystemId: "consulting/pine-green-strategy",
  });
  if (!pinePack.adoptedPackHexes?.has("#03522C") || !pinePack.adoptedPackHexes.has("#FFFFFF")) {
    failed.push("pine-green-palette");
  }
  if (pinePack.adoptedPackHexes?.has("#FDC356")) failed.push("pine-green-includes-jade");
  if (!pinePack.otherPackHexes?.has("#FDC356")) failed.push("jade-other-palette");
  const foreignPackPage: SkillPageInput = {
    id: "cover",
    pageType: "cover",
    elements: [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "#FDC356" },
      },
      textEl("t", "北麓制造 2026 上半年经营汇报", [80, 160, 800, 80]),
    ],
  };
  const foreignPackErr = api.writePageSchemaError(
    api.writePageSchemaIssues(foreignPackPage, pinePack),
    foreignPackPage,
    pinePack,
  );
  if (foreignPackErr?.error !== PACK_COLOR_ERROR) failed.push("pack-color-foreign-reject");
  const navyPackPage: SkillPageInput = {
    id: "cover",
    pageType: "cover",
    elements: [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "#06223F" },
      },
      textEl("t", "北麓制造 2026 上半年经营汇报", [80, 160, 800, 80]),
    ],
  };
  const navyPackErr = api.writePageSchemaError(
    api.writePageSchemaIssues(navyPackPage, pinePack),
    navyPackPage,
    pinePack,
  );
  if (navyPackErr?.error !== PACK_COLOR_ERROR) failed.push("pack-color-navy-reject");
  const hostBluePage: SkillPageInput = {
    id: "cover",
    pageType: "cover",
    elements: [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "#2563EB" },
      },
      textEl("t", "北麓制造 2026 上半年经营汇报", [80, 160, 800, 80]),
    ],
  };
  const hostBlueErr = api.writePageSchemaError(
    api.writePageSchemaIssues(hostBluePage, pinePack),
    hostBluePage,
    pinePack,
  );
  if (hostBlueErr?.error !== PACK_COLOR_ERROR) failed.push("pack-color-host-blue-reject");
  const emptyPrimaryPage: SkillPageInput = {
    id: "cover",
    pageType: "cover",
    elements: [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "$primary" },
      },
      textEl("t", "北麓制造 2026 上半年经营汇报", [80, 160, 800, 80]),
    ],
  };
  const emptyPrimaryTheme = { colors: { primary: "#2563EB" } };
  const emptyPrimaryCtx = { ...pinePack, theme: emptyPrimaryTheme };
  const emptyPrimaryErr = api.writePageSchemaError(
    api.writePageSchemaIssues(emptyPrimaryPage, emptyPrimaryCtx),
    emptyPrimaryPage,
    emptyPrimaryCtx,
  );
  if (emptyPrimaryErr?.error !== PACK_COLOR_ERROR) failed.push("pack-color-empty-primary-reject");
  const adoptedPackPage: SkillPageInput = {
    id: "cover",
    pageType: "cover",
    elements: [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "#03522C" },
      },
      textEl("t", "北麓制造 2026 上半年经营汇报", [80, 160, 800, 80]),
    ],
  };
  if (api.writePageSchemaError(api.writePageSchemaIssues(adoptedPackPage, pinePack), adoptedPackPage, pinePack)) {
    failed.push("pack-color-adopted-accept");
  }
  const packPrimaryPage: SkillPageInput = {
    id: "cover",
    pageType: "cover",
    elements: [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "$primary" },
      },
      textEl("t", "北麓制造 2026 上半年经营汇报", [80, 160, 800, 80]),
    ],
  };
  const packPrimaryTheme = { colors: { primary: "#03522C" } };
  const packPrimaryCtx = { ...pinePack, theme: packPrimaryTheme };
  if (
    api.writePageSchemaError(
      api.writePageSchemaIssues(packPrimaryPage, packPrimaryCtx),
      packPrimaryPage,
      packPrimaryCtx,
    )
  ) {
    failed.push("pack-color-pack-theme-primary-accept");
  }
  const emptyAdoptPackErr = api.writePageSchemaError(api.writePageSchemaIssues(foreignPackPage), foreignPackPage);
  if (emptyAdoptPackErr) failed.push("pack-color-empty-adopt-skip");
  const emptyAdoptNavyErr = api.writePageSchemaError(api.writePageSchemaIssues(navyPackPage), navyPackPage);
  if (emptyAdoptNavyErr) failed.push("pack-color-empty-adopt-navy-skip");

  const beiluH1 =
    "给公司董事会做一份「北麓制造 2026 上半年经营汇报」。办公场景，给董事会的半年经营审议，不是门店月报，不是产品立项。16 页左右。不要澄光生活，不要个人答辩。";
  if (classifyBriefKind(beiluH1) !== "board-h1") failed.push("board-h1-kind");
  if (inferDeckIntent(beiluH1) === "academic") failed.push("board-h1-academic");
  const qinglanIntro = "给管理层做一份「青岚费控」产品介绍，办公立项用。16 页左右。不要做成经营月报，不要澄光生活。";
  if (classifyBriefKind(qinglanIntro) !== "product-intro") failed.push("product-intro-kind");
  if (inferDeckIntent(qinglanIntro) === "report") failed.push("product-intro-monthly");
  if (classifyBriefKind("闸门复现灯开关。不要做成经营月报，不要做成课件。") === "retail-monthly") {
    failed.push("harness-monthly");
  }
  if (classifyBriefKind("澄光生活 2026年7月经营月报，约 20 页。") !== "retail-monthly") {
    failed.push("chengguang-monthly");
  }
  if (
    !kindThemePackIssue({
      brief: beiluH1,
      adoptedSourceIds: ["work/warm-jade-annual-report"],
    })
  ) {
    failed.push("board-h1-warm-jade");
  }
  if (
    kindThemePackIssue({
      brief: beiluH1,
      adoptedSourceIds: ["consulting/pine-green-strategy"],
    })
  ) {
    failed.push("board-h1-consulting");
  }
  if (
    !kindThemePackIssue({
      brief: qinglanIntro,
      adoptedSourceIds: ["work/blue-flame-brand"],
    })
  ) {
    failed.push("product-intro-work");
  }
  if (
    kindThemePackIssue({
      brief: "澄光生活 2026年7月经营月报，约 20 页。",
      adoptedSourceIds: ["work/warm-jade-annual-report"],
    })
  ) {
    failed.push("chengguang-warm-jade");
  }
  if (kindThemePackIssue({ brief: beiluH1 })?.code !== "missing_theme_pack") {
    failed.push("board-h1-missing-pack");
  }
  if (
    kindThemePackIssue({
      brief: beiluH1,
      adoptedSourceIds: ["agent-self-directed-plan"],
    })?.code !== "missing_theme_pack"
  ) {
    failed.push("board-h1-self-directed");
  }
  if (kindThemePackIssue({ brief: qinglanIntro })?.code !== "missing_theme_pack") {
    failed.push("product-intro-missing-pack");
  }
  const defense = "开题报告：城市热岛。只有方法边界，没有实验数据。";
  if (classifyBriefKind(defense) !== "academic") failed.push("academic-kind");
  if (kindThemePackIssue({ brief: defense })?.code !== "missing_theme_pack") {
    failed.push("academic-missing-pack");
  }
  if (
    kindThemePackIssue({
      brief: defense,
      adoptedSourceIds: ["academic/paper-white-courseware"],
    })
  ) {
    failed.push("academic-pack-accept");
  }
  const learnShare =
    "给同事做一次内部「学习分享」。办公场景，约 30 分钟的知识分享会，不是经营月报，不是产品立项。16–20 页。";
  if (classifyBriefKind(learnShare) !== "learn-share") failed.push("learn-share-kind");
  if (inferDeckIntent(learnShare) === "report") failed.push("learn-share-monthly");
  if (kindThemePackIssue({ brief: learnShare })?.code !== "missing_theme_pack") {
    failed.push("learn-share-missing-pack");
  }
  if (
    kindThemePackIssue({
      brief: learnShare,
      adoptedSourceIds: ["agent-self-directed-plan"],
    })?.code !== "missing_theme_pack"
  ) {
    failed.push("learn-share-self-directed");
  }
  if (
    kindThemePackIssue({
      brief: learnShare,
      adoptedSourceIds: ["consulting/pine-green-strategy"],
    })
  ) {
    failed.push("learn-share-consulting");
  }
  if (
    kindThemePackIssue({
      brief: learnShare,
      adoptedSourceIds: ["promotion/silk-yellow-magazine"],
    })
  ) {
    failed.push("learn-share-promotion");
  }
  if (
    kindThemePackIssue({
      brief: learnShare,
      adoptedSourceIds: sourceIdList({
        item: "openkimi:reference/design_system/01_strategy/04/en/red-black-business.md",
      }),
    })
  ) {
    failed.push("learn-share-minimax-item-adopt");
  }
  if (
    kindThemePackIssue({
      brief: learnShare,
      adoptedSourceIds: sourceIdList({ sourceId: "consulting/pine-green-strategy" }),
    })
  ) {
    failed.push("learn-share-minimax-sourceid-adopt");
  }
  if (
    kindThemePackIssue({
      brief: learnShare,
      adoptedSourceIds: sourceIdList({ kind: "promotion", name: "silk-yellow-magazine" }),
    })
  ) {
    failed.push("learn-share-minimax-kind-name-adopt");
  }
  if (
    kindThemePackIssue({
      brief: learnShare,
      adoptedSourceIds: sourceIdList({ sourceId: {} }),
    })?.code !== "missing_theme_pack"
  ) {
    failed.push("learn-share-empty-sourceid-object");
  }
  if (
    kindThemePackIssue({
      brief: defense,
      adoptedSourceIds: sourceIdList({ sourceId: "academic/paper-white-courseware" }),
    })
  ) {
    failed.push("academic-minimax-sourceid-adopt");
  }
  if (
    kindThemePackIssue({
      brief: defense,
      adoptedSourceIds: sourceIdList({ kind: "academic", name: "paper-white-courseware" }),
    })
  ) {
    failed.push("academic-minimax-kind-name-adopt");
  }
  if (
    kindThemePackIssue({
      brief: defense,
      adoptedSourceIds: sourceIdList({ kind: "academic" }),
    })?.code !== "missing_theme_pack"
  ) {
    failed.push("academic-kind-only-object");
  }
  if (
    kindThemePackIssue({
      brief: learnShare,
      adoptedSourceIds: sourceIdList({ id: "consulting/pine-green-strategy" }),
    })
  ) {
    failed.push("learn-share-minimax-id-adopt");
  }
  if (
    kindThemePackIssue({
      brief: learnShare,
      adoptedSourceIds: sourceIdList({ packId: "promotion/silk-yellow-magazine" }),
    })
  ) {
    failed.push("learn-share-minimax-packid-adopt");
  }
  if (
    kindThemePackIssue({
      brief: learnShare,
      adoptedSourceIds: sourceIdList({ id: {} }),
    })?.code !== "missing_theme_pack"
  ) {
    failed.push("learn-share-empty-id-object");
  }
  if (
    kindThemePackIssue({
      brief: learnShare,
      adoptedSourceIds: sourceIdList({ id: "1_cover" }),
    })?.code !== "missing_theme_pack"
  ) {
    failed.push("learn-share-pageid-object");
  }
  if (
    kindThemePackIssue({
      brief: defense,
      adoptedSourceIds: sourceIdList({ packId: "academic/paper-white-courseware" }),
    })
  ) {
    failed.push("academic-minimax-packid-adopt");
  }
  if (
    kindThemePackIssue({
      brief: defense,
      adoptedSourceIds: sourceIdList({ id: "academic/paper-white-courseware" }),
    })
  ) {
    failed.push("academic-minimax-id-adopt");
  }
  if (
    !kindThemePackIssue({
      brief: learnShare,
      adoptedSourceIds: ["work/warm-jade-annual-report"],
    })
  ) {
    failed.push("learn-share-warm-jade");
  }
  const learnShareChapters =
    "给AI产品同学做一场内部学习分享：Agent 怎么把需求拆成可执行计划。封面之后分三部分：问题、方法、例子。每部分先一张章节页再展开。收尾一页把步骤收成清单。";
  if (classifyBriefKind(learnShareChapters) !== "learn-share") {
    failed.push("learn-share-not-cover-only");
  }
  if (kindThemePackIssue({ brief: learnShareChapters })?.code !== "missing_theme_pack") {
    failed.push("learn-share-chapters-missing-pack");
  }
  if (kindThemePackIssue({ brief: "澄光生活 2026年7月经营月报，约 20 页。" })) {
    failed.push("chengguang-empty-adopt-closed");
  }
  if (kindThemePackIssue({ brief: "只要一张封面：光合作用。" })) {
    failed.push("cover-only-empty-adopt-closed");
  }
  probeTemplateDesignPaletteGate(beiluH1, failed);

  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "empty-create-gate-"));
  try {
    const created = createEmptyProject(emptyRoot, { title: "empty create gate" });
    const loaded = loadProject(emptyRoot);
    const listed = [
      ...created.presentation.pages,
      ...loaded.presentation.pages,
      ...created.pages.map((page) => page.path),
      ...loaded.pages.map((page) => page.path),
    ];
    if (created.pages.length !== 0 || loaded.pages.length !== 0) failed.push("empty-create-pages");
    if (listed.some((rel) => isHostOpenedSeedPath(rel))) {
      failed.push("empty-create-lists-seed");
    }
    if (fs.existsSync(path.join(emptyRoot, "pages", "1_cover.page"))) {
      failed.push("empty-create-seed-file");
    }
  } catch {
    failed.push("empty-create-unreadable");
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }

  return { ok: failed.length === 0, id: PRODUCE_GATES_ID, missing, failed };
}

export function assertProduceGates(api?: ProduceGateApi): ProduceGateReport {
  const report = inspectProduceGates(api);
  if (!report.ok) {
    throw new Error(
      `produce gates missing or stale (id=${report.id} missing=${report.missing.join(",") || "-"} failed=${report.failed.join(",") || "-"}). Hub generate refused. Run dsh:slides so the profile dist is synced. Did not fall back to Gemini.`,
    );
  }
  return report;
}
