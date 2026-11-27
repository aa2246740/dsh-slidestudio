import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { buildCatalogDto, loadReferenceCatalog, resolveRepoRoot } from "./catalog.js";
import {
  buildDesignSystemDirectory,
  canonicalDesignSystemId,
  designSystemSelectionRows,
  loadDesignSystemCards,
} from "./design-system-cards.js";
import { createPresentationRun } from "./run.js";

const repoRoot = resolveRepoRoot();
const cards = loadDesignSystemCards(repoRoot);

async function listing(t: TestContext, args: Record<string, unknown>) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "design-cards-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const run = createPresentationRun({ repoRoot });
  const handle = await run.open({
    projectRoot,
    sessionId: "design-cards",
    editorBaseUrl: "",
    brief: "风格卡验收",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "test" },
  });
  return run.execute(
    { name: "list_references", args },
    { ...handle, abortSignal: new AbortController().signal, toolCallId: "cards" },
  );
}

describe("design-system directory", () => {
  it("lists each canonical pack once and folds numbered guides and Hub slugs in as aliases", () => {
    assert.equal(cards.length, 43);
    const ids = cards.map((card) => card.id);
    assert.equal(new Set(ids).size, ids.length);
    const aliases = cards.flatMap((card) => card.aliases);
    assert.equal(aliases.length, 17);
    for (const alias of aliases) assert.equal(ids.includes(alias), false, `${alias} is listed only as an alias`);
    const pine = cards.find((card) => card.id === "consulting/pine-green-strategy")!;
    assert.deepEqual(pine.aliases, ["extra/pine-green-strategy"]);
    assert.equal(pine.sourceId, "openkimi:reference/design_system/consulting/pine-green-strategy/design.md");
    const jade = cards.find((card) => card.id === "work/warm-jade-annual-report")!;
    assert.deepEqual([...jade.aliases].sort(), ["extra/lead-gray-quarterly", "extra/warm-jade-annual-report"]);
    assert.equal(canonicalDesignSystemId(cards, "extra/honey-orange-memo"), "finance/honey-orange-memo");
    assert.equal(canonicalDesignSystemId(cards, "lead-gray"), "work/warm-jade-annual-report");
    assert.equal(canonicalDesignSystemId(cards, "extra/mist-blue-travelogue"), "extra/mist-blue-travelogue");
    assert.equal(buildDesignSystemDirectory(repoRoot), cards);
  });

  it("gives every pack a compact card with palette, tone and best fit taken from its source", () => {
    for (const card of cards) {
      assert.ok(card.palette.length >= 3 && card.palette.length <= 5, card.id);
      for (const hex of card.palette) assert.match(hex, /^#[0-9A-F]{6}$/);
      assert.ok(card.tone.length > 10 && card.tone.length <= 80, `${card.id} tone`);
      assert.ok(card.fit.length > 10 && card.fit.length <= 64, `${card.id} fit`);
      assert.ok(card.card.length <= 220, `${card.id} card is ${card.card.length} chars`);
      assert.equal(card.card.includes("\n"), false);
      assert.ok(card.card.startsWith(card.palette.join(" ")));
    }
    const pine = cards.find((card) => card.id === "consulting/pine-green-strategy")!;
    assert.deepEqual(pine.palette.slice(0, 2), ["#FFFFFF", "#F1F1F1"]);
    assert.match(pine.tone, /^use darkened technology photography as the header background/);
  });

  it("maps every catalog style and visual preview to exactly one card", () => {
    for (const style of buildCatalogDto(repoRoot).styles) {
      assert.ok(canonicalDesignSystemId(cards, style.id), style.id);
    }
    for (const visual of loadReferenceCatalog(repoRoot).visuals) {
      assert.ok(canonicalDesignSystemId(cards, visual.designSystemId ?? ""), visual.sourceId);
    }
  });
});

describe("list_references design-system cards", () => {
  it('kind:"design" returns every canonical pack once within 16 KiB', async (t) => {
    const result = await listing(t, { kind: "design" });
    const rows = result.payload.designSystems as ReturnType<typeof designSystemSelectionRows>;
    assert.equal(rows.length, 43);
    assert.equal(result.payload.sources, undefined);
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    t.diagnostic(`kind:design receipt ${bytes} bytes for ${rows.length} packs`);
    assert.ok(bytes <= 16 * 1024, `${bytes} bytes`);
    for (const row of rows)
      assert.deepEqual(
        Object.keys(row).sort(),
        row.aliases ? ["aliases", "card", "id", "sourceId"] : ["card", "id", "sourceId"],
      );
    const filtered = await listing(t, { kind: "design", family: "finance", tag: "memo" });
    assert.deepEqual(
      (filtered.payload.designSystems as { id: string }[]).map((row) => row.id),
      ["finance/honey-orange-memo", "finance/lake-blue-memo"],
    );
  });

  it("adds deduplicated cards to a family listing without changing its rows", async (t) => {
    const numbered = await listing(t, { family: "05_academic" });
    assert.equal((numbered.payload.sources as unknown[]).length, 6);
    const ids = (numbered.payload.designSystems as { id: string }[]).map((row) => row.id);
    assert.deepEqual(ids, [
      "academic/blue-line-courseware",
      "academic/paper-white-courseware",
      "academic/pastel-derivation",
      "academic/teal-green-academic-defense",
      "extra/dark-themed-data",
      "extra/pink-purple-diagnosis",
    ]);
    const academic = await listing(t, { family: "academic" });
    assert.equal((academic.payload.sources as unknown[]).length, 12, "design.md + preview rows are unchanged");
    assert.equal((academic.payload.designSystems as unknown[]).length, 6, "each pack appears once");
  });
});
