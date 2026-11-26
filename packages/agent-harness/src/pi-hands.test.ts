import { describe, it } from "node:test";
import { tasteDraft } from "./pi-hands.fixtures.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import {
  resolvePiHandsExtension,
  runPiHand,
  mergeSkillStackEvidence,
  skillStackEvidence,
  skillsExecutionMode,
  writePiRuntime,
} from "./pi-hands.js";
import { buildPiRpcArgs, resolveXaiAuthExtension } from "./pi-rpc.js";

function textPage(id: string, title: string, body: string) {
  return {
    id,
    pageType: id === "page-01" ? "cover" : "content",
    elements: [
      {
        elementId: "title",
        elementType: "text",
        bounds: [40, 36, 880, 48],
        content: { text: title, bold: true, fontSize: 22 },
      },
      {
        elementId: "body",
        elementType: "text",
        bounds: [40, 100, 880, 360],
        content: { text: body, fontSize: 16 },
      },
    ],
  };
}

describe("pi hands", () => {
  it("treats a one-shot skill-deck write as not the skill stack", () => {
    const ev = skillStackEvidence([
      { event: "agent_start" },
      { event: "tool:read:brief.txt" },
      { event: "tool:write:skill-deck.json" },
      { event: "agent_end" },
    ]);
    assert.equal(ev.ok, false);
    assert.equal(ev.oneShotDump, true);
    assert.match(ev.reason, /did not run as Pi tools/);
  });

  it("accepts write_todo + ≥2 write_page + review + compose", () => {
    const ev = skillStackEvidence([
      { event: "agent_start" },
      { event: "tool:write_todo" },
      { event: "tool:write_page" },
      { event: "tool:write_page" },
      { event: "tool:review_pages" },
      { event: "tool:compose_deck" },
      { event: "agent_end" },
    ]);
    assert.equal(ev.ok, true);
    assert.equal(ev.pageWrites, 2);
    assert.equal(ev.renderPages, 0);
    assert.equal(ev.renderCoverage, false);
    assert.equal(ev.review, true);
  });

  it("renderCoverage is every write_page, not a single page-1 raster", () => {
    const ev = skillStackEvidence([
      { event: "tool:write_todo" },
      { event: "tool:write_page" },
      { event: "tool:write_page" },
      { event: "tool:render_page" },
      { event: "tool:review_pages" },
      { event: "tool:compose_deck" },
    ]);
    assert.equal(ev.ok, true);
    assert.equal(ev.renderPages, 1);
    assert.equal(ev.renderCoverage, false);
    const full = skillStackEvidence([
      { event: "tool:write_todo" },
      { event: "tool:write_page" },
      { event: "tool:write_page" },
      { event: "tool:render_page" },
      { event: "tool:render_page" },
      { event: "tool:review_pages" },
      { event: "tool:compose_deck" },
    ]);
    assert.equal(full.renderCoverage, true);
  });

  it("merges hands-log write/render counts after a 503 overwrote RPC events", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hands-merge-"));
    const log = path.join(dir, "_agent", "hands-log.jsonl");
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const rows = [
      { name: "write_todo", ok: true },
      { name: "write_page", ok: true },
      { name: "write_page", ok: true },
      { name: "render_page", ok: true },
      { name: "render_page", ok: true },
      { name: "review_pages", ok: true },
      { name: "write_page", ok: false },
    ];
    fs.writeFileSync(log, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const merged = mergeSkillStackEvidence([{ event: "tool:write_todo" }, { event: "tool:write_page" }], dir, {
      compose: true,
    });
    assert.equal(merged.pageWrites, 2);
    assert.equal(merged.renderPages, 2);
    assert.equal(merged.renderCoverage, true);
    assert.equal(merged.ok, true);
    assert.match(merged.reason, /host composed/);
  });

  it("renderCoverage is one raster per page on disk, not every rewrite", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hands-pages-"));
    fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
    fs.mkdirSync(path.join(dir, "_agent", "rasters"), { recursive: true });
    for (let i = 1; i <= 6; i++) {
      fs.writeFileSync(path.join(dir, "pages", `0${i}_p.page`), "pageType: content\n");
      fs.writeFileSync(path.join(dir, "_agent", "rasters", `page-${i}.png`), "x");
    }
    const log = path.join(dir, "_agent", "hands-log.jsonl");
    const rows = [
      { name: "write_todo", ok: true },
      ...Array.from({ length: 7 }, () => ({ name: "write_page", ok: true })),
      ...Array.from({ length: 6 }, () => ({ name: "render_page", ok: true })),
      { name: "review_pages", ok: true },
      { name: "compose_deck", ok: true },
    ];
    fs.writeFileSync(log, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const merged = mergeSkillStackEvidence(
      rows.map((r) => ({ event: `tool:${r.name}` })),
      dir,
    );
    assert.equal(merged.pageWrites, 7);
    assert.equal(merged.renderPages, 6);
    assert.equal(merged.renderCoverage, true);
  });

  it("labels produce-tool events as pi-tools, not flags-only", () => {
    assert.equal(
      skillsExecutionMode([{ event: "agent_start" }, { event: "tool:write:skill-deck.json" }]),
      "flags-only",
    );
    assert.equal(skillsExecutionMode([{ event: "agent_start" }, { event: "tool:write_todo" }]), "pi-tools");
  });

  it("loads the hands extension on the Pi argv and does not allow generic write", () => {
    const args = buildPiRpcArgs({ cwd: process.cwd() });
    const tools = args[args.indexOf("--tools") + 1] ?? "";
    assert.match(tools, /write_todo/);
    assert.match(tools, /write_page/);
    assert.match(tools, /list_references/);
    assert.match(tools, /read_reference/);
    assert.match(tools, /view_design_reference/);
    assert.match(tools, /commit_design/);
    assert.match(tools, /read_design/);
    assert.match(tools, /review_page/);
    assert.match(tools, /review_pages/);
    assert.match(tools, /render_deck/);
    assert.match(tools, /review_deck/);
    assert.match(tools, /compose_deck/);
    assert.doesNotMatch(tools, /read_playbook/);
    assert.doesNotMatch(`,${tools},`, /,write,/);
    assert.ok(args.includes("-e"));
    assert.equal(args[args.indexOf("-e") + 1], resolvePiHandsExtension());
    assert.ok(fs.existsSync(resolvePiHandsExtension()));
  });

  it("locks production writes until every required original chunk was returned and keeps the selected design source", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hands-ledger-"));
    writePiRuntime(dir, {
      brief: "澄光生活 2026年7月经营月报，深蓝、白色、琥珀金，营收 12,860 万",
      categoryId: "management-report",
      designSystemId: "work/warm-jade-annual-report",
      designDirection: "user-design",
      strictExecution: true,
    });
    const context = (commandId: string) => ({ commandId, contextEpochId: "epoch-test" });
    const args = (commandId: string, value: Record<string, unknown> = {}) => ({
      ...value,
      __openSlideStudio: context(commandId),
    });
    const items = [
      { title: "封面", note: "月报" },
      { title: "总览", note: "营收" },
    ];

    const blocked = await runPiHand("write_todo", args("todo-blocked", { items }), dir);
    assert.equal(blocked.ok, false);
    assert.match(blocked.detail, /read_reference is incomplete/);

    const listed = await runPiHand("list_references", args("list"), dir);
    assert.equal(listed.ok, true, listed.detail);
    const sources =
      (
        listed.payload as {
          sources?: Array<{
            sourceId: string;
            reason: string;
            chunks: Array<{ chunkIndex: number }>;
          }>;
        }
      ).sources ?? [];
    assert.equal(sources.length, 5, "local color and ratio hints must not remove the selected OpenKimi design source");
    assert.ok(sources.some((source) => source.reason === "preset-design"));
    for (const source of sources) {
      for (const chunk of source.chunks) {
        const read = await runPiHand(
          "read_reference",
          args(`read-${source.sourceId}-${chunk.chunkIndex}`, {
            sourceId: source.sourceId,
            chunkIndex: chunk.chunkIndex,
          }),
          dir,
        );
        assert.equal(read.ok, true, read.detail);
        assert.doesNotMatch(read.detail, /\[truncated\]/);
      }
    }

    const todo = await runPiHand("write_todo", args("todo", { items }), dir);
    assert.equal(todo.ok, true, todo.detail);
    for (const [index, item] of items.entries()) {
      const page = await runPiHand(
        "write_page",
        args(`page-${index}`, textPage(`page-0${index + 1}`, item.title, item.note)),
        dir,
      );
      assert.equal(page.ok, true, page.detail);
    }
    const compose = await runPiHand("compose_deck", args("compose", { title: "澄光生活 2026年7月经营月报" }), dir);
    assert.equal(compose.ok, false);
    assert.match(compose.detail, /current raster missing/);
  });

  it("loads the xAI OAuth extension when the provider is xai-auth", () => {
    const args = buildPiRpcArgs({ cwd: process.cwd(), provider: "xai-auth" });
    assert.ok(args.includes("xai-auth"));
    const xai = resolveXaiAuthExtension();
    if (!xai) return;
    const loaded: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-e" && args[i + 1]) loaded.push(args[i + 1]!);
    }
    assert.ok(loaded.includes(xai));
  });

  it("enforces the selected preview and contract-bound taste sequence", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hands-taste-"));
    const brief = "为内部团队制作 6 页 AI 助手使用说明，深蓝，16:9";
    writePiRuntime(dir, {
      brief,
      categoryId: "education-training",
      designSystemId: "academic/paper-white-courseware",
      strictExecution: true,
      tasteExecution: true,
    });
    const args = (commandId: string, value: Record<string, unknown> = {}) => ({
      ...value,
      __openSlideStudio: { commandId, contextEpochId: "taste-epoch" },
    });
    const listed = await runPiHand("list_references", args("list"), dir);
    const sources =
      (
        listed.payload as {
          sources?: Array<{ sourceId: string; chunks: Array<{ chunkIndex: number }> }>;
        }
      ).sources ?? [];
    assert.equal(sources.length, 5);
    for (const source of sources) {
      for (const chunk of source.chunks) {
        const read = await runPiHand(
          "read_reference",
          args(`read-${source.sourceId}-${chunk.chunkIndex}`, {
            sourceId: source.sourceId,
            chunkIndex: chunk.chunkIndex,
          }),
          dir,
        );
        assert.equal(read.ok, true, read.detail);
      }
    }
    const preview = await runPiHand("view_design_reference", args("preview"), dir);
    assert.equal(preview.ok, true, preview.detail);
    assert.equal((preview.payload as { imageKind?: string }).imageKind, "design-reference");
    const token = String((preview.payload as { deliveryToken?: string }).deliveryToken ?? "");
    const blocked = await runPiHand("commit_design", args("blocked", tasteDraft()), dir);
    assert.equal(blocked.ok, false);
    assert.match(blocked.detail, /must emit the selected preview/);
    const blockedLog = fs
      .readFileSync(path.join(dir, "_agent", "hands-log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { name?: string; ok?: boolean; detail?: string })
      .reverse()
      .find((row) => row.name === "commit_design");
    assert.equal(blockedLog?.ok, false);
    assert.match(blockedLog?.detail ?? "", /must emit the selected preview/);
    const emitted = await runPiHand("_mark_image_emitted", args("emit-preview", { deliveryToken: token }), dir);
    assert.equal(emitted.ok, true, emitted.detail);
    const committed = await runPiHand("commit_design", args("commit", tasteDraft()), dir);
    assert.equal(committed.ok, true, committed.detail);
    const committedLog = fs
      .readFileSync(path.join(dir, "_agent", "hands-log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { name?: string; ok?: boolean })
      .reverse()
      .find((row) => row.name === "commit_design");
    assert.equal(committedLog?.ok, true);
    const reread = await runPiHand("read_design", args("read-design"), dir);
    assert.equal(reread.ok, true, reread.detail);

    const plan = tasteDraft().slidePlan as Array<{
      pageId: string;
      title: string;
      layoutFamily: string;
    }>;
    const todo = await runPiHand(
      "write_todo",
      args("todo", {
        items: plan.map((slide) => ({ ...slide, note: slide.title, exhibits: ["none"] })),
      }),
      dir,
    );
    assert.equal(todo.ok, true, todo.detail);
    const wrong = await runPiHand(
      "write_page",
      args("wrong-page", { ...textPage("page-02", "判断", "证据"), pageType: "cover" }),
      dir,
    );
    assert.equal(wrong.ok, false);
    assert.match(wrong.detail, /committed layout family chart-led/);
    const correct = await runPiHand(
      "write_page",
      args("right-page", {
        ...textPage("page-02", "判断", "证据"),
        pageType: "chart-led",
      }),
      dir,
    );
    assert.equal(correct.ok, true, correct.detail);
  });

  it("persists outline and pages through the Pi hand CLI path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hands-"));
    writePiRuntime(dir, {
      brief: "核验技能工具",
      categoryId: "education-training",
      designSystemId: "academic/paper-white-courseware",
    });
    const titles = ["封面", "水分", "阳光", "土壤", "展板", "收束"];
    const todo = await runPiHand(
      "write_todo",
      {
        items: titles.map((title) => ({ title, note: `${title}要点` })),
      },
      dir,
    );
    assert.equal(todo.ok, true, todo.detail);
    for (const [i, title] of titles.entries()) {
      const page = await runPiHand("write_page", textPage(`page-0${i + 1}`, title, `${title}的说明写在这一页。`), dir);
      assert.equal(page.ok, true, page.detail);
    }
    const review = await runPiHand("review_pages", {}, dir);
    assert.equal(review.ok, true, review.detail);
    const compose = await runPiHand("compose_deck", { title: "核验技能工具" }, dir);
    assert.equal(compose.ok, true, compose.detail);
    assert.ok(fs.existsSync(path.join(dir, "_agent", "outline.json")));
    const project = loadProject(dir);
    assert.ok(project.pages.length >= 6);
  });

  it("keeps every planned page for a 20-page report", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hands-long-outline-"));
    writePiRuntime(dir, {
      brief: "澄光生活 2026年7月经营月报，严格生成 20 页，营收 12,860 万",
      categoryId: "management-report",
      designSystemId: "consulting/pine-green-strategy",
    });
    const items = Array.from({ length: 20 }, (_, index) => ({
      title: `第${index + 1}页`,
      note: `第${index + 1}页必须出现的结论与数据`,
    }));

    const todo = await runPiHand("write_todo", { items }, dir);

    assert.equal(todo.ok, true, todo.detail);
    assert.equal((todo.payload as { items?: unknown[] }).items?.length, 20);
    const outline = JSON.parse(fs.readFileSync(path.join(dir, "_agent", "outline.json"), "utf8")) as {
      items?: unknown[];
    };
    assert.equal(outline.items?.length, 20);
  });

  it("rejects compose_deck before every write_todo page is written", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-clock-"));
    writePiRuntime(dir, {
      brief: "澄光生活 7月经营月报，营收 1860万",
      categoryId: "management-report",
      designSystemId: "consulting/pine-green-strategy",
    });
    const todo = await runPiHand(
      "write_todo",
      {
        items: ["封面", "KPI", "拆解", "利润表"].map((title) => ({ title, note: title })),
      },
      dir,
    );
    assert.equal(todo.ok, true, todo.detail);
    const page = await runPiHand("write_page", textPage("page-01", "封面", "澄光生活7月经营月报"), dir);
    assert.equal(page.ok, true, page.detail);
    const compose = await runPiHand("compose_deck", { title: "澄光" }, dir);
    assert.equal(compose.ok, false);
    assert.match(compose.detail ?? "", /write_todo has 4/);
    assert.match(compose.detail ?? "", /will not paint/);
  });

  it("refuses compose_deck when a listed 负责人 column is missing from the table", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-owner-col-"));
    writePiRuntime(dir, {
      brief:
        "「星河零售 2026年7月经营月报」营收 1860万。列固定为：营收/环比/同比/毛利/库存天/退货率/渠道/负责人。SKU01 晨光纯奶 186 +3.1 -1.2 28.4 41 1.8 线上 刘洋 SKU02 星河鲜肉 172 +1.4 -4.6 18.2 52 2.4 线下 陈凯 SKU03 青禾蔬菜 154 +6.8 +2.1 22.0 9 3.1 线下 王敏",
      categoryId: "management-report",
      designSystemId: "work/warm-jade-annual-report",
    });
    const todo = await runPiHand(
      "write_todo",
      { items: ["封面", "密表"].map((title) => ({ title, note: title })) },
      dir,
    );
    assert.equal(todo.ok, true, todo.detail);
    const cover = await runPiHand("write_page", textPage("page-01", "封面", "星河零售 1860万"), dir);
    assert.equal(cover.ok, true, cover.detail);
    const tablePage = {
      id: "page-02",
      pageType: "demo",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [40, 20, 880, 32],
          content: { text: "SKU 密表", fontSize: 18 },
        },
        {
          elementId: "tbl",
          elementType: "table",
          bounds: [16, 64, 928, 400],
          columnWidths: [118, 72, 78, 78, 72, 72, 72, 72],
          rows: [
            ["SKU", "营收", "环比", "同比", "毛利", "库存天", "退货率", "渠道"].map((text) => ({
              text,
            })),
            ["晨光纯奶", "186", "+3.1", "-1.2", "28.4", "41", "1.8", "线上"].map((text) => ({
              text,
            })),
          ],
        },
      ],
    };
    const page = await runPiHand("write_page", tablePage, dir);
    assert.equal(page.ok, true, page.detail);
    const review = await runPiHand("review_pages", {}, dir);
    assert.equal(review.ok, false, review.detail);
    assert.match(review.detail ?? "", /负责人/);
  });

  it("refuses write_page on a 经营月报 with no company and no numbers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nodata-hand-"));
    writePiRuntime(dir, {
      brief: "做一份公司经营月报",
      categoryId: "management-report",
      designSystemId: "work/warm-jade-annual-report",
    });
    const page = await runPiHand("write_page", textPage("page-01", "封面", "本月收入达成 94%，缺口在北区续约"), dir);
    assert.equal(page.ok, false);
    assert.match(page.detail ?? "", /公司名和至少一组/);
  });
});
