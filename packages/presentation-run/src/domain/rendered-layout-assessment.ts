import { footerZoneTopForSlide } from "@open-slidestudio/pptd-v2";
import { isExpandedTemplateElement } from "./template-component-expand.js";

export type RenderedLayoutIssueKind =
  | "text-overflow-x"
  | "text-overflow-y"
  | "text-contrast"
  | "text-contrast-unresolved"
  | "text-collision"
  | "line-text-intersection"
  | "line-text-clearance"
  | "element-outside-slide"
  | "non-footer-text-in-footer-zone"
  | "footer-outside-footer-zone"
  | "font-not-ready";

export type RenderedLayoutWarningKind = "text-collision";

export type RenderedLayoutIssue = {
  kind: RenderedLayoutIssueKind;
  elementId?: string;
  detail: string;
};

export type RenderedLayoutWarning = {
  kind: RenderedLayoutWarningKind;
  elementIds: [string, string];
  detail: string;
};

export type RenderedLayoutNode = {
  id: string;
  type: string;
  layoutRole?: "footer" | "content" | "decoration";
  /** A master or layout copy on the page (`data-inherited`); the page cannot edit it. */
  inherited?: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  textColor?: string;
  backgroundColor?: string;
  backgroundSource?: string;
  contrastRatio?: number;
  requiredContrast?: number;
  contrastUnresolvedSource?: string;
};

export type RenderedLayoutSnapshot = {
  slideWidth: number;
  slideHeight: number;
  fontsReady: boolean;
  nodes: RenderedLayoutNode[];
};

export type PageLayoutDiagnostics = {
  checked: true;
  fontsReady: boolean;
  footerZoneTop: number;
  hardIssues: RenderedLayoutIssue[];
  warnings: RenderedLayoutWarning[];
  ok: boolean;
};

/**
 * Classify high-confidence layout faults from one rendered DOM snapshot.
 * This compares text with text, not labels with their diagram shapes, so a
 * material overlap is a real compose blocker. Sub-pixel contact stays a
 * warning to avoid renderer-noise failures.
 */
function collectRenderedContrastIssue(
  node: RenderedLayoutSnapshot["nodes"][number],
  hardIssues: RenderedLayoutIssue[],
): void {
  if (node.contrastUnresolvedSource) {
    hardIssues.push({
      kind: "text-contrast-unresolved",
      elementId: node.id,
      detail: `contrast could not be measured against ${node.contrastUnresolvedSource}; strict compose requires a deterministic contrast result`,
    });
    return;
  }
  if (
    node.contrastRatio !== undefined &&
    node.requiredContrast !== undefined &&
    node.contrastRatio + 0.01 < node.requiredContrast
  ) {
    hardIssues.push({
      kind: "text-contrast",
      elementId: node.id,
      detail: `contrast ${node.contrastRatio.toFixed(2)} is below ${node.requiredContrast.toFixed(2)} (${node.textColor ?? "unknown"} on ${node.backgroundColor ?? "unknown"}${node.backgroundSource ? ` via ${node.backgroundSource}` : ""})`,
    });
  }
}

function collectRenderedNodeIssues(
  node: RenderedLayoutSnapshot["nodes"][number],
  snapshot: RenderedLayoutSnapshot,
  epsilon: number,
  footerZoneTop: number,
  hardIssues: RenderedLayoutIssue[],
): void {
  // A template component keeps the overhang it had in the template; the slide clips it.
  if (
    !isExpandedTemplateElement({ elementId: node.id, layoutRole: node.layoutRole }) &&
    (node.left < -epsilon ||
      node.top < -epsilon ||
      node.right > snapshot.slideWidth + epsilon ||
      node.bottom > snapshot.slideHeight + epsilon)
  ) {
    hardIssues.push({
      kind: "element-outside-slide",
      elementId: node.id,
      detail: `rendered bounds ${node.left.toFixed(1)},${node.top.toFixed(1)}–${node.right.toFixed(1)},${node.bottom.toFixed(1)} exceed ${snapshot.slideWidth}×${snapshot.slideHeight}`,
    });
  }
  collectRenderedContrastIssue(node, hardIssues);
  if (node.type !== "text") return;
  // A layout or master copy cannot be re-flowed on this page; its overflow is checked once
  // when the layout is written. Its overlap with the page's own text still counts below.
  if (!node.inherited && node.scrollWidth > node.clientWidth + epsilon) {
    hardIssues.push({
      kind: "text-overflow-x",
      elementId: node.id,
      detail: `scrollWidth ${node.scrollWidth} exceeds clientWidth ${node.clientWidth}`,
    });
  }
  if (!node.inherited && node.scrollHeight > node.clientHeight + epsilon) {
    hardIssues.push({
      kind: "text-overflow-y",
      elementId: node.id,
      detail: `scrollHeight ${node.scrollHeight} exceeds clientHeight ${node.clientHeight}`,
    });
  }
  if (node.layoutRole === "footer" && node.top < footerZoneTop - epsilon) {
    hardIssues.push({
      kind: "footer-outside-footer-zone",
      elementId: node.id,
      detail: `footer begins at ${node.top.toFixed(1)} above the footer reserve starting at ${footerZoneTop.toFixed(1)}; move the whole footer into the reserve`,
    });
  } else if (node.layoutRole !== "footer" && node.bottom > footerZoneTop + epsilon) {
    hardIssues.push({
      kind: "non-footer-text-in-footer-zone",
      elementId: node.id,
      detail: `text reaches ${node.bottom.toFixed(1)} inside footer reserve starting at ${footerZoneTop.toFixed(1)}; mark an intentional footer as layoutRole=footer or move body text above the reserve`,
    });
  }
}

function collectRuleTextIssues(
  rules: RenderedLayoutSnapshot["nodes"],
  texts: RenderedLayoutSnapshot["nodes"],
  epsilon: number,
  slideScale: number,
  minimumRuleOverlap: number,
  minimumRuleClearance: number,
  hardIssues: RenderedLayoutIssue[],
): void {
  for (const rule of rules) {
    for (const text of texts) {
      const overlapWidth = Math.min(rule.right, text.right) - Math.max(rule.left, text.left);
      if (overlapWidth < minimumRuleOverlap) continue;
      const overlapHeight = Math.min(rule.bottom, text.bottom) - Math.max(rule.top, text.top);
      if (overlapHeight > epsilon) {
        hardIssues.push({
          kind: "line-text-intersection",
          elementId: `${rule.id},${text.id}`,
          detail: `${rule.id} crosses ${text.id} by ${overlapWidth.toFixed(1)}×${overlapHeight.toFixed(1)} rendered pixels`,
        });
        continue;
      }
      const clearance = text.top - rule.bottom;
      if (clearance >= -epsilon && clearance + epsilon < minimumRuleClearance) {
        hardIssues.push({
          kind: "line-text-clearance",
          elementId: `${rule.id},${text.id}`,
          detail: `${rule.id} leaves only ${(clearance / slideScale).toFixed(1)} slide pixels above ${text.id}; at least 14.0 are required to remain legible after scaling`,
        });
      }
    }
  }
}

function collectTextCollisionIssues(
  texts: RenderedLayoutSnapshot["nodes"],
  epsilon: number,
  hardIssues: RenderedLayoutIssue[],
  warnings: RenderedLayoutWarning[],
): void {
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i]!;
      const b = texts[j]!;
      const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlapWidth >= 4 && overlapHeight >= 4) {
        hardIssues.push({
          kind: "text-collision",
          elementId: `${a.id},${b.id}`,
          detail: `${a.id} and ${b.id} overlap by ${overlapWidth.toFixed(1)}×${overlapHeight.toFixed(1)}`,
        });
      } else if (overlapWidth > epsilon && overlapHeight > epsilon) {
        warnings.push({
          kind: "text-collision",
          elementIds: [a.id, b.id],
          detail: `text bounds overlap by ${overlapWidth.toFixed(1)}×${overlapHeight.toFixed(1)}`,
        });
      }
    }
  }
}

export function assessRenderedLayout(snapshot: RenderedLayoutSnapshot): PageLayoutDiagnostics {
  const footerZoneTop = footerZoneTopForSlide(snapshot.slideHeight);
  const hardIssues: RenderedLayoutIssue[] = [];
  const warnings: RenderedLayoutWarning[] = [];
  const epsilon = 0.5;

  if (!snapshot.fontsReady) {
    hardIssues.push({
      kind: "font-not-ready",
      detail: "document fonts were not ready; rendered text measurements are not trustworthy",
    });
  }

  for (const node of snapshot.nodes) {
    collectRenderedNodeIssues(node, snapshot, epsilon, footerZoneTop, hardIssues);
  }

  const texts = snapshot.nodes.filter((node) => node.type === "text" && node.layoutRole !== "decoration");
  const slideScale = snapshot.slideWidth > 0 ? snapshot.slideWidth / 960 : 1;
  const minimumRuleClearance = 14 * slideScale;
  const minimumRuleOverlap = Math.max(4, 8 * slideScale);
  const rules = snapshot.nodes.filter((node) => node.type === "rule");
  collectRuleTextIssues(rules, texts, epsilon, slideScale, minimumRuleOverlap, minimumRuleClearance, hardIssues);
  collectTextCollisionIssues(texts, epsilon, hardIssues, warnings);

  return {
    checked: true,
    fontsReady: snapshot.fontsReady,
    footerZoneTop,
    hardIssues,
    warnings,
    ok: hardIssues.length === 0,
  };
}
