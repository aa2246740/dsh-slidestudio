import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  applyCommands,
  undoCommand,
  createEmptyDeck,
  createSampleResearchDeck,
  parseDeck,
  safeParseDeck,
  validateDeckInvariants,
  cmdAddElement,
  cmdUpdateElement,
  cmdDeleteElement,
  cmdAddSlide,
  cmdDeleteSlide,
  cmdReorderSlide,
  cmdUpdateTheme,
  cmdUpdateDeckMeta,
  cmdUpdateChartData,
  cmdUpdateSmartArt,
  cmdReplaceAsset,
  createEmptySlide,
  solidFill,
  DEFAULT_SLIDE_SIZE,
  DEFAULT_THEME,
  type TextElement,
  type ChartElement,
  type ImageElement,
  type SmartArtElement,
} from "./index.js";

function makeText(id: string, text: string): TextElement {
  return {
    kind: "text",
    id,
    x: 10,
    y: 20,
    width: 400,
    height: 80,
    rotation: 0,
    opacity: 1,
    zIndex: 1,
    paragraphs: [{ runs: [{ text, fontSize: 18 }] }],
  };
}

describe("createEmptyDeck", () => {
  it("creates a 16:9 deck with one blank slide at 1920x1080", () => {
    const deck = createEmptyDeck({ title: "Test" });
    assert.equal(deck.title, "Test");
    assert.equal(deck.aspectRatio, "16:9");
    assert.equal(deck.slides.length, 1);
    const slide = deck.slides[0]!;
    assert.equal(slide.size.width, DEFAULT_SLIDE_SIZE.width);
    assert.equal(slide.size.height, DEFAULT_SLIDE_SIZE.height);
    assert.equal(slide.elements.length, 0);
    assert.deepEqual(deck.theme.name, DEFAULT_THEME.name);
  });

  it("can create a deck with no slides", () => {
    const deck = createEmptyDeck({ withSlide: false });
    assert.equal(deck.slides.length, 0);
  });
});

describe("createSampleResearchDeck", () => {
  it("builds a multi-slide research deck that passes schema + invariants", () => {
    const deck = createSampleResearchDeck();
    assert.ok(deck.slides.length >= 5);
    assert.equal(deck.meta?.product, "DSH SlideStudio");
    assert.doesNotMatch(JSON.stringify(deck), /kimi/i);

    const parsed = parseDeck(deck);
    assert.equal(parsed.id, deck.id);

    const invariants = validateDeckInvariants(deck);
    assert.deepEqual(invariants, []);

    // Collect kinds including nested group children (connectors live inside process group)
    const kinds = new Set<string>();
    const walk = (els: { kind: string; children?: unknown[] }[]) => {
      for (const e of els) {
        kinds.add(e.kind);
        if (e.kind === "group" && Array.isArray((e as { children?: unknown[] }).children)) {
          walk((e as { children: { kind: string; children?: unknown[] }[] }).children);
        }
      }
    };
    for (const s of deck.slides) walk(s.elements as { kind: string; children?: unknown[] }[]);
    // Offline sample prefers shape panels over external image assets so
    // export/smoke never depends on disk media paths.
    for (const k of [
      "text",
      "shape",
      "table",
      "chart",
      "smartart",
      "connector",
      "group",
    ] as const) {
      assert.ok(kinds.has(k), `expected element kind ${k}`);
    }
  });
});

describe("applyCommand + undoCommand", () => {
  it("addElement / updateElement / deleteElement round-trip", () => {
    const deck = createEmptyDeck();
    const slideId = deck.slides[0]!.id;
    const el = makeText("t1", "Hello");

    const added = applyCommand(deck, cmdAddElement(slideId, el));
    assert.equal(added.deck.slides[0]!.elements.length, 1);
    assert.equal(added.deck.slides[0]!.elements[0]!.kind, "text");

    const updated = applyCommand(
      added.deck,
      cmdUpdateElement(slideId, "t1", {
        x: 100,
        paragraphs: [{ runs: [{ text: "World", fontSize: 24 }] }],
      }),
    );
    const text = updated.deck.slides[0]!.elements[0] as TextElement;
    assert.equal(text.x, 100);
    assert.equal(text.paragraphs[0]!.runs[0]!.text, "World");
    assert.ok(updated.command.type === "updateElement" && updated.command.before);

    const undoneUpdate = undoCommand(updated.deck, updated.command);
    const restored = undoneUpdate.slides[0]!.elements[0] as TextElement;
    assert.equal(restored.x, 10);
    assert.equal(restored.paragraphs[0]!.runs[0]!.text, "Hello");

    const deleted = applyCommand(undoneUpdate, cmdDeleteElement(slideId, "t1"));
    assert.equal(deleted.deck.slides[0]!.elements.length, 0);
    assert.ok(deleted.command.type === "deleteElement" && deleted.command.before);

    const undoneDelete = undoCommand(deleted.deck, deleted.command);
    assert.equal(undoneDelete.slides[0]!.elements.length, 1);
    assert.equal(undoneDelete.slides[0]!.elements[0]!.id, "t1");

    const undoneAdd = undoCommand(added.deck, added.command);
    assert.equal(undoneAdd.slides[0]!.elements.length, 0);
  });

  it("addSlide / deleteSlide / reorderSlide", () => {
    const deck = createEmptyDeck({ title: "Reorder" });
    const s0 = deck.slides[0]!.id;

    const s1 = createEmptySlide(1);
    const s2 = createEmptySlide(2);
    const result = applyCommands(deck, [
      cmdAddSlide(s1),
      cmdAddSlide(s2),
    ]);
    assert.equal(result.deck.slides.length, 3);
    assert.deepEqual(
      result.deck.slides.map((s) => s.order),
      [0, 1, 2],
    );

    const reordered = applyCommand(
      result.deck,
      cmdReorderSlide(s0, 0, 2),
    );
    assert.equal(reordered.deck.slides[2]!.id, s0);
    assert.deepEqual(
      reordered.deck.slides.map((s) => s.order),
      [0, 1, 2],
    );

    const undoneReorder = undoCommand(reordered.deck, reordered.command);
    assert.equal(undoneReorder.slides[0]!.id, s0);

    const deleted = applyCommand(result.deck, cmdDeleteSlide(s1.id));
    assert.equal(deleted.deck.slides.length, 2);
    assert.ok(!deleted.deck.slides.some((s) => s.id === s1.id));

    const undoneDel = undoCommand(deleted.deck, deleted.command);
    assert.equal(undoneDel.slides.length, 3);
    assert.ok(undoneDel.slides.some((s) => s.id === s1.id));
  });

  it("updateTheme and updateDeckMeta undo", () => {
    const deck = createEmptyDeck();
    const themeCmd = applyCommand(
      deck,
      cmdUpdateTheme({
        ...DEFAULT_THEME,
        name: "Night",
        colors: { ...DEFAULT_THEME.colors, ink: "#FFFFFF", background: "#000000" },
      }),
    );
    assert.equal(themeCmd.deck.theme.name, "Night");
    const undoneTheme = undoCommand(themeCmd.deck, themeCmd.command);
    assert.equal(undoneTheme.theme.name, DEFAULT_THEME.name);

    const metaCmd = applyCommand(
      deck,
      cmdUpdateDeckMeta({ title: "Renamed", meta: { a: "1" } }),
    );
    assert.equal(metaCmd.deck.title, "Renamed");
    assert.equal(metaCmd.deck.meta?.a, "1");
    const undoneMeta = undoCommand(metaCmd.deck, metaCmd.command);
    assert.equal(undoneMeta.title, deck.title);
  });

  it("updateChartData and updateSmartArt", () => {
    const sample = createSampleResearchDeck();
    const chartSlide = sample.slides.find((s) =>
      s.elements.some((e) => e.kind === "chart"),
    )!;
    const chart = chartSlide.elements.find((e) => e.kind === "chart") as ChartElement;

    const chartRes = applyCommand(
      sample,
      cmdUpdateChartData(chartSlide.id, chart.id, {
        categories: ["A", "B"],
        series: [{ name: "X", values: [1, 2] }],
        chartType: "line",
      }),
    );
    const afterChart = chartRes.deck.slides
      .find((s) => s.id === chartSlide.id)!
      .elements.find((e) => e.id === chart.id) as ChartElement;
    assert.equal(afterChart.chartType, "line");
    assert.deepEqual(afterChart.categories, ["A", "B"]);
    const undoneChart = undoCommand(chartRes.deck, chartRes.command);
    const restoredChart = undoneChart.slides
      .find((s) => s.id === chartSlide.id)!
      .elements.find((e) => e.id === chart.id) as ChartElement;
    assert.equal(restoredChart.chartType, chart.chartType);
    assert.deepEqual(restoredChart.categories, chart.categories);

    const smartSlide = sample.slides.find((s) =>
      s.elements.some((e) => e.kind === "smartart"),
    )!;
    const smart = smartSlide.elements.find((e) => e.kind === "smartart") as SmartArtElement;
    const smartRes = applyCommand(
      sample,
      cmdUpdateSmartArt(smartSlide.id, smart.id, {
        layout: "list",
        nodes: [{ id: "only", text: "Solo" }],
        edges: [],
      }),
    );
    const afterSmart = smartRes.deck.slides
      .find((s) => s.id === smartSlide.id)!
      .elements.find((e) => e.id === smart.id) as SmartArtElement;
    assert.equal(afterSmart.layout, "list");
    assert.equal(afterSmart.nodes.length, 1);
    const undoneSmart = undoCommand(smartRes.deck, smartRes.command);
    const restoredSmart = undoneSmart.slides
      .find((s) => s.id === smartSlide.id)!
      .elements.find((e) => e.id === smart.id) as SmartArtElement;
    assert.equal(restoredSmart.layout, smart.layout);
    assert.equal(restoredSmart.nodes.length, smart.nodes.length);
  });

  it("replaceAsset on image element", () => {
    const deck = createEmptyDeck();
    const slideId = deck.slides[0]!.id;
    const img: ImageElement = {
      kind: "image",
      id: "img1",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      rotation: 0,
      opacity: 1,
      zIndex: 1,
      src: "assets/a.png",
      alt: "A",
    };
    const withImg = applyCommand(deck, cmdAddElement(slideId, img)).deck;
    const replaced = applyCommand(
      withImg,
      cmdReplaceAsset(slideId, "img1", "assets/b.png"),
    );
    const el = replaced.deck.slides[0]!.elements[0] as ImageElement;
    assert.equal(el.src, "assets/b.png");
    const undone = undoCommand(replaced.deck, replaced.command);
    assert.equal((undone.slides[0]!.elements[0] as ImageElement).src, "assets/a.png");
  });

  it("batch undo reverses in reverse order", () => {
    const deck = createEmptyDeck();
    const slideId = deck.slides[0]!.id;
    const batch = applyCommands(deck, [
      cmdAddElement(slideId, makeText("a", "A")),
      cmdAddElement(slideId, makeText("b", "B")),
      cmdUpdateElement(slideId, "a", { x: 50 }),
    ]);
    assert.equal(batch.deck.slides[0]!.elements.length, 2);
    assert.equal(batch.deck.slides[0]!.elements[0]!.x, 50);

    const undone = undoCommand(batch.deck, batch.command);
    assert.equal(undone.slides[0]!.elements.length, 0);
  });
});

describe("schema validation", () => {
  it("safeParseDeck rejects invalid payloads", () => {
    const bad = safeParseDeck({ title: "nope" });
    assert.equal(bad.success, false);
  });

  it("parseDeck accepts empty deck factory output", () => {
    const deck = createEmptyDeck();
    assert.equal(parseDeck(JSON.parse(JSON.stringify(deck))).id, deck.id);
  });

  it("validateDeckInvariants catches duplicate element ids", () => {
    const deck = createEmptyDeck();
    const slide = deck.slides[0]!;
    slide.elements.push(makeText("dup", "one"), makeText("dup", "two"));
    const errors = validateDeckInvariants(deck);
    assert.ok(errors.some((e) => e.includes("Duplicate element")));
  });

  it("background fill helper works", () => {
    const f = solidFill("#abc");
    assert.equal(f.type, "solid");
    assert.equal(f.color, "#abc");
  });
});
