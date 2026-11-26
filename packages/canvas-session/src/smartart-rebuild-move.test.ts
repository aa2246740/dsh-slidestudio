/**
 * VAL-SMART-008 editor half (guard): a SmartArt component rebuilt from texts is a set of ordinary
 * shapes — no shared groupId — so selecting one node selects only it, and moving it moves only
 * that node and its paired label (the other nodes stay put). Companion-following itself is
 * existing SmartArt behaviour (session.test.ts); this file pins the rebuilt-shape contract.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createEmptyProject,
  loadProject,
  saveProject,
  titleOnlyCoverPage,
  listComposedPage,
  type PptdElement,
} from "@open-slidestudio/pptd-v2";
import { openSession, goToPage, persist, renderModel, selectElement, setSelectedBounds } from "./index.js";

const DIAGRAM = "s1-1";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "canvas-smartart-rebuild-"));
}

/** The 4-node process rebuild the host writes for texts of length 4 (geometry from the fixture). */
function rebuiltNode(index: number, centreX: number): PptdElement {
  return {
    elementId: `tpl-smartart-s1-1-e${index * 2 + 1}`,
    elementType: "shape",
    shapeName: "roundRect",
    bounds: [centreX - 63.01, 206.28, 126.01, 75.6],
    fill: { type: "solid", color: "#C00000" },
    layoutRole: "decoration",
    smartArt: { id: DIAGRAM, layout: "process", role: "node", index, pinned: true },
  } as PptdElement;
}

function rebuiltLabel(index: number, centreX: number, text: string): PptdElement {
  return {
    elementId: `tpl-smartart-s1-1-e${index * 2 + 2}`,
    elementType: "text",
    bounds: [centreX - 62.17, 206.89, 120, 72],
    content: { text, fontSize: 18.29 },
    layoutRole: "decoration",
    smartArt: { id: DIAGRAM, layout: "process", role: "label", index },
  } as PptdElement;
}

function rebuiltConnector(index: number, centreX: number): PptdElement {
  return {
    elementId: `tpl-smartart-s1-1-x${index + 1}`,
    elementType: "shape",
    shapeName: "rightArrow",
    bounds: [centreX - 12, 206.28, 24, 75.6],
    fill: { type: "solid", color: "#992525" },
    layoutRole: "decoration",
    smartArt: { id: DIAGRAM, layout: "process", role: "connector" },
  } as PptdElement;
}

function rebuiltProject(dir: string): void {
  const project = createEmptyProject(dir, { title: "Rebuild" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("Rebuild"));
  const centres = [214.51, 382.51, 550.51, 718.51];
  const labels = ["调研", "方案", "落地", "复盘"];
  project.presentation.pages.push("pages/p1.page");
  project.pages.push({
    path: "pages/p1.page",
    page: {
      elements: [
        ...centres.map((centre, i) => rebuiltNode(i, centre)),
        ...centres.map((centre, i) => rebuiltLabel(i, centre, `<p>${labels[i]}</p>`)),
        ...[298.51, 466.51, 634.51].map((centre, i) => rebuiltConnector(i, centre)),
      ],
    },
  });
  saveProject(project);
}

describe("rebuilt SmartArt nodes (VAL-SMART-008, guard)", () => {
  it("selects and moves one rebuilt node without moving the others", () => {
    const dir = tmp();
    rebuiltProject(dir);
    const session = openSession(dir, { allowedControlIds: ["element.bounds.set"] });
    goToPage(session, 1);

    // No shared groupId: selecting a node selects exactly that one ordinary shape.
    selectElement(session, "tpl-smartart-s1-1-e3");
    assert.deepEqual(session.selection, {
      kind: "element",
      pageIndex: 1,
      elementId: "tpl-smartart-s1-1-e3",
    });

    const before = renderModel(session);
    const nodeBefore = before.elements.find((e) => e.id === "tpl-smartart-s1-1-e3")!;
    const labelBefore = before.elements.find((e) => e.id === "tpl-smartart-s1-1-e4")!;
    const otherBefore = before.elements.find((e) => e.id === "tpl-smartart-s1-1-e5")!;
    const connectorBefore = before.elements.find((e) => e.id === "tpl-smartart-s1-1-x2")!;

    const [x, y, w, h] = nodeBefore.bounds;
    setSelectedBounds(session, "element.bounds.set", [x + 40, y + 20, w, h]);

    const after = renderModel(session);
    const nodeAfter = after.elements.find((e) => e.id === "tpl-smartart-s1-1-e3")!;
    const labelAfter = after.elements.find((e) => e.id === "tpl-smartart-s1-1-e4")!;
    const otherAfter = after.elements.find((e) => e.id === "tpl-smartart-s1-1-e5")!;
    const connectorAfter = after.elements.find((e) => e.id === "tpl-smartart-s1-1-x2")!;
    assert.deepEqual(nodeAfter.bounds, [x + 40, y + 20, w, h], "the node itself moved");
    assert.deepEqual(
      labelAfter.bounds,
      [labelBefore.bounds[0] + 40, labelBefore.bounds[1] + 20, labelBefore.bounds[2], labelBefore.bounds[3]],
      "the paired label follows its node",
    );
    assert.deepEqual(otherAfter.bounds, otherBefore.bounds, "the next node stays put");
    assert.deepEqual(connectorAfter.bounds, connectorBefore.bounds, "the gap arrow stays put");

    persist(session);
    const saved = loadProject(dir).pages.find((p) => p.path === "pages/p1.page")!.page.elements as Array<
      Record<string, unknown>
    >;
    assert.equal(saved.length, 11);
    assert.equal(
      saved.some((element) => typeof element.groupId === "string"),
      false,
      "the rebuild persists as ungrouped ordinary shapes",
    );
    const savedNode = saved.find((e) => e.elementId === "tpl-smartart-s1-1-e3")!;
    assert.deepEqual(savedNode.bounds, [x + 40, y + 20, w, h]);
    assert.equal((savedNode.smartArt as { pinned?: boolean }).pinned, true);
  });
});
