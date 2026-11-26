import { adjUnit, ngon, pick, poly, star } from "./shape-path-draw.js";

export type ShapePathPart = (shapeName: string, adj: number[] | undefined) => string | undefined;

export function shapePathPart1(shapeName: string, adj: number[] | undefined): string | undefined {
  const a0 = pick(adj, 0, 50000);
  switch (shapeName) {
    case "rect":
    case "actionButtonBlank":
    case "flowChartProcess":
      return poly([
        [4, 8],
        [96, 8],
        [96, 92],
        [4, 92],
      ]);
    case "roundRect":
    case "flowChartAlternateProcess":
    case "plaque": {
      const r = 4 + adjUnit(a0, 16667) * 28;
      return `M ${4 + r} 8 H ${96 - r} Q 96 8 96 ${8 + r} V ${92 - r} Q 96 92 ${96 - r} 92 H ${4 + r} Q 4 92 4 ${92 - r} V ${8 + r} Q 4 8 ${4 + r} 8 Z`;
    }
    case "ellipse":
    case "flowChartConnector":
      return "M 50 6 A 44 44 0 1 1 49.9 6 Z";
    case "triangle": {
      const x = 8 + adjUnit(a0, 50000) * 84;
      return poly([
        [x, 6],
        [96, 94],
        [4, 94],
      ]);
    }
    case "rtTriangle":
      return poly([
        [6, 6],
        [6, 94],
        [94, 94],
      ]);
    case "parallelogram": {
      const s = 8 + adjUnit(a0, 25000) * 30;
      return poly([
        [6 + s, 8],
        [96, 8],
        [96 - s, 92],
        [4, 92],
      ]);
    }
    case "trapezoid": {
      const s = 8 + adjUnit(a0, 25000) * 28;
      return poly([
        [6 + s, 8],
        [94 - s, 8],
        [94, 92],
        [6, 92],
      ]);
    }
    case "nonIsoscelesTrapezoid":
      return poly([
        [18, 8],
        [88, 8],
        [96, 92],
        [4, 92],
      ]);
    case "diamond":
    case "flowChartDecision":
      return poly([
        [50, 4],
        [96, 50],
        [50, 96],
        [4, 50],
      ]);
    case "pentagon":
      return ngon(5);
    default:
      return undefined;
  }
}

export function shapePathPart2(shapeName: string, adj: number[] | undefined): string | undefined {
  const a0 = pick(adj, 0, 50000);
  switch (shapeName) {
    case "hexagon":
    case "flowChartPreparation":
      return ngon(6);
    case "heptagon":
      return ngon(7);
    case "octagon":
      return ngon(8);
    case "decagon":
      return ngon(10);
    case "dodecagon":
      return ngon(12);
    case "plus":
    case "mathPlus":
    case "chartPlus": {
      const w = 12 + adjUnit(a0, 25000) * 18;
      return poly([
        [50 - w, 8],
        [50 + w, 8],
        [50 + w, 50 - w],
        [92, 50 - w],
        [92, 50 + w],
        [50 + w, 50 + w],
        [50 + w, 92],
        [50 - w, 92],
        [50 - w, 50 + w],
        [8, 50 + w],
        [8, 50 - w],
        [50 - w, 50 - w],
      ]);
    }
    case "homePlate":
      return poly([
        [6, 10],
        [68, 10],
        [94, 50],
        [68, 90],
        [6, 90],
      ]);
    case "chevron":
      return poly([
        [8, 10],
        [62, 10],
        [92, 50],
        [62, 90],
        [8, 90],
        [38, 50],
      ]);
    case "pie":
    case "pieWedge":
      return "M 50 50 L 50 8 A 42 42 0 0 1 88 62 Z";
    case "arc":
      return "M 16 70 A 40 40 0 0 1 84 70";
    case "chord":
      return "M 16 70 A 40 40 0 0 1 84 70 Z";
    case "blockArc":
      return "M 18 72 A 38 38 0 0 1 82 72 L 72 64 A 26 26 0 0 0 28 64 Z";
    case "teardrop":
      return "M 50 8 C 90 8 94 50 70 78 Q 50 96 30 78 C 6 50 10 8 50 8 Z";
    default:
      return undefined;
  }
}

export function shapePathPart3(shapeName: string, adj: number[] | undefined): string | undefined {
  const a0 = pick(adj, 0, 50000);
  switch (shapeName) {
    case "frame": {
      const t = 8 + adjUnit(a0, 12500) * 16;
      return `M 6 6 H 94 V 94 H 6 Z M ${6 + t} ${6 + t} V ${94 - t} H ${94 - t} V ${6 + t} Z`;
    }
    case "halfFrame":
      return poly([
        [8, 8],
        [92, 8],
        [92, 28],
        [28, 28],
        [28, 92],
        [8, 92],
      ]);
    case "corner":
      return poly([
        [8, 8],
        [92, 8],
        [92, 28],
        [28, 28],
        [28, 92],
        [8, 92],
      ]);
    case "diagStripe":
      return poly([
        [8, 70],
        [70, 8],
        [92, 8],
        [8, 92],
      ]);
    case "foldedCorner":
      return "M 8 8 H 92 V 72 L 72 92 H 8 Z M 72 92 V 72 H 92";
    case "donut": {
      const ir = 12 + adjUnit(a0, 25000) * 20;
      return `M 50 6 A 44 44 0 1 1 49.9 6 Z M 50 ${50 - ir} A ${ir} ${ir} 0 1 0 50.1 ${50 - ir} Z`;
    }
    case "noSmoking":
      return "M 50 8 A 40 40 0 1 1 49.9 8 Z M 22 30 L 70 78 M 30 22 L 78 70";
    case "heart":
      return "M 50 88 C 20 64 6 48 6 30 6 16 18 8 30 8 38 8 45 12 50 20 55 12 62 8 70 8 82 8 94 16 94 30 94 48 80 64 50 88 Z";
    case "lightningBolt":
      return poly([
        [58, 4],
        [28, 52],
        [48, 52],
        [38, 96],
        [78, 42],
        [56, 42],
      ]);
    case "sun":
      return star(12, 0.45);
    case "moon": {
      const c = 18 + adjUnit(a0, 50000) * 20;
      return `M 62 10 A 40 40 0 1 0 62 90 A ${c} ${c + 10} 0 1 1 62 10 Z`;
    }
    case "cloud":
      return "M 28 62 C 10 62 10 38 30 36 C 34 20 62 18 68 34 C 88 32 94 54 80 62 C 78 78 40 80 28 62 Z";
    case "smileyFace":
      return "M 50 8 A 40 40 0 1 1 49.9 8 Z M 35 40 A 4 4 0 1 1 34.9 40 Z M 65 40 A 4 4 0 1 1 64.9 40 Z M 32 62 Q 50 78 68 62";
    case "bevel":
      return "M 12 12 H 88 V 88 H 12 Z M 12 12 L 24 24 H 76 L 88 12 M 88 88 L 76 76 V 24 L 88 12 M 12 88 L 24 76 H 76 L 88 88";
    case "can":
      return "M 18 22 C 18 10 82 10 82 22 V 78 C 82 90 18 90 18 78 Z M 18 22 C 18 34 82 34 82 22";
    case "cube":
      return "M 20 28 L 50 10 L 80 28 V 72 L 50 90 L 20 72 Z M 20 28 L 50 46 L 80 28 M 50 46 V 90";
    case "funnel":
      return poly([
        [18, 10],
        [82, 10],
        [58, 48],
        [58, 90],
        [42, 90],
        [42, 48],
      ]);
    default:
      return undefined;
  }
}

export function shapePathPart4(shapeName: string, adj: number[] | undefined): string | undefined {
  const a0 = pick(adj, 0, 50000);
  switch (shapeName) {
    case "gear6":
      return star(6, 0.62);
    case "gear9":
      return star(9, 0.62);
    case "wave":
    case "doubleWave":
      return "M 6 50 Q 25 20 44 50 T 82 50 T 98 50 L 98 70 Q 80 90 62 70 T 26 70 T 6 70 Z";
    case "lineInv":
      return "M 8 92 L 92 8";
    case "round1Rect":
      return "M 8 8 H 72 Q 92 8 92 28 V 92 H 8 Z";
    case "round2DiagRect":
      return "M 28 8 H 92 V 72 Q 92 92 72 92 H 8 V 28 Q 8 8 28 8 Z";
    case "round2SameRect":
      return "M 28 8 H 72 Q 92 8 92 28 V 92 H 8 V 28 Q 8 8 28 8 Z";
    case "snip1Rect":
      return poly([
        [8, 8],
        [80, 8],
        [92, 20],
        [92, 92],
        [8, 92],
      ]);
    case "snip2DiagRect":
      return poly([
        [20, 8],
        [92, 8],
        [92, 80],
        [80, 92],
        [8, 92],
        [8, 20],
      ]);
    case "snip2SameRect":
      return poly([
        [20, 8],
        [80, 8],
        [92, 20],
        [92, 92],
        [8, 92],
        [8, 20],
      ]);
    case "snipRoundRect":
      return "M 8 28 Q 8 8 28 8 H 80 L 92 20 V 92 H 8 Z";
    case "star4":
      return star(4, adjUnit(a0, 12500) + 0.15);
    case "star5":
    case "chartStar":
      return star(5, adjUnit(a0, 19098) + 0.18);
    case "star6":
      return star(6, adjUnit(a0, 28868) + 0.18);
    case "star7":
      return star(7, adjUnit(a0, 34601) + 0.18);
    default:
      return undefined;
  }
}

export function shapePathPart5(shapeName: string, adj: number[] | undefined): string | undefined {
  const a0 = pick(adj, 0, 50000);
  switch (shapeName) {
    case "star8":
      return star(8, adjUnit(a0, 37500) + 0.18);
    case "star10":
      return star(10, adjUnit(a0, 42533) + 0.16);
    case "star12":
      return star(12, adjUnit(a0, 37500) + 0.18);
    case "star16":
      return star(16, adjUnit(a0, 37500) + 0.2);
    case "star24":
      return star(24, adjUnit(a0, 37500) + 0.22);
    case "star32":
      return star(32, adjUnit(a0, 37500) + 0.24);
    case "irregularSeal1":
    case "irregularSeal2":
      return star(11, 0.42);
    case "rightArrow":
      return poly([
        [6, 36],
        [58, 36],
        [58, 18],
        [94, 50],
        [58, 82],
        [58, 64],
        [6, 64],
      ]);
    case "leftArrow":
      return poly([
        [94, 36],
        [42, 36],
        [42, 18],
        [6, 50],
        [42, 82],
        [42, 64],
        [94, 64],
      ]);
    case "upArrow":
      return poly([
        [36, 94],
        [36, 42],
        [18, 42],
        [50, 6],
        [82, 42],
        [64, 42],
        [64, 94],
      ]);
    case "downArrow":
      return poly([
        [36, 6],
        [36, 58],
        [18, 58],
        [50, 94],
        [82, 58],
        [64, 58],
        [64, 6],
      ]);
    case "leftRightArrow":
      return poly([
        [6, 50],
        [28, 22],
        [28, 40],
        [72, 40],
        [72, 22],
        [94, 50],
        [72, 78],
        [72, 60],
        [28, 60],
        [28, 78],
      ]);
    case "upDownArrow":
      return poly([
        [50, 6],
        [22, 28],
        [40, 28],
        [40, 72],
        [22, 72],
        [50, 94],
        [78, 72],
        [60, 72],
        [60, 28],
        [78, 28],
      ]);
    case "quadArrow":
      return poly([
        [50, 4],
        [36, 22],
        [44, 22],
        [44, 44],
        [22, 44],
        [22, 36],
        [4, 50],
        [22, 64],
        [22, 56],
        [44, 56],
        [44, 78],
        [36, 78],
        [50, 96],
        [64, 78],
        [56, 78],
        [56, 56],
        [78, 56],
        [78, 64],
        [96, 50],
        [78, 36],
        [78, 44],
        [56, 44],
        [56, 22],
        [64, 22],
      ]);
    default:
      return undefined;
  }
}

export const shapePathParts1: ShapePathPart[] = [
  shapePathPart1,
  shapePathPart2,
  shapePathPart3,
  shapePathPart4,
  shapePathPart5,
];
