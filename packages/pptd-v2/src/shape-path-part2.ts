import { poly } from "./shape-path-draw.js";

export type ShapePathPart = (shapeName: string, adj: number[] | undefined) => string | undefined;

export function shapePathPart6(shapeName: string, _adj: number[] | undefined): string | undefined {
  switch (shapeName) {
    case "notchedRightArrow":
    case "stripedRightArrow":
    case "swooshArrow":
      return poly([
        [6, 38],
        [60, 38],
        [60, 18],
        [94, 50],
        [60, 82],
        [60, 62],
        [6, 62],
        [16, 50],
      ]);
    case "bentArrow":
    case "bentUpArrow":
    case "uturnArrow":
      return "M 12 78 H 60 Q 88 78 88 50 Q 88 22 60 22 H 40 V 10 L 16 32 L 40 54 V 42 H 56 Q 70 42 70 50 Q 70 58 56 58 H 12 Z";
    case "circularArrow":
    case "leftCircularArrow":
    case "leftRightCircularArrow":
    case "curvedRightArrow":
    case "curvedLeftArrow":
    case "curvedUpArrow":
    case "curvedDownArrow":
      return "M 20 70 A 32 32 0 1 1 78 42 L 88 34 L 70 28 L 74 48";
    case "leftRightUpArrow":
    case "leftUpArrow":
      return poly([
        [8, 70],
        [28, 50],
        [28, 62],
        [44, 62],
        [44, 28],
        [32, 28],
        [50, 8],
        [68, 28],
        [56, 28],
        [56, 78],
        [28, 78],
        [28, 90],
      ]);
    default:
      return undefined;
  }
}

export function shapePathPart7(shapeName: string, _adj: number[] | undefined): string | undefined {
  switch (shapeName) {
    case "rightArrowCallout":
    case "leftArrowCallout":
    case "upArrowCallout":
    case "downArrowCallout":
    case "leftRightArrowCallout":
    case "upDownArrowCallout":
    case "quadArrowCallout":
      return poly([
        [8, 28],
        [58, 28],
        [58, 16],
        [92, 50],
        [58, 84],
        [58, 72],
        [8, 72],
      ]);
    default:
      return undefined;
  }
}

export function shapePathPart8(shapeName: string, _adj: number[] | undefined): string | undefined {
  switch (shapeName) {
    case "wedgeRectCallout":
    case "wedgeRoundRectCallout":
    case "wedgeEllipseCallout":
    case "cloudCallout":
    case "borderCallout1":
    case "borderCallout2":
    case "borderCallout3":
    case "accentCallout1":
    case "accentCallout2":
    case "accentCallout3":
    case "accentBorderCallout1":
    case "accentBorderCallout2":
    case "accentBorderCallout3":
    case "callout1":
    case "callout2":
    case "callout3":
      return "M 10 12 H 90 V 68 H 42 L 22 90 L 34 68 H 10 Z";
    case "leftBrace":
      return "M 70 8 Q 30 8 30 28 T 8 50 T 30 72 T 70 92";
    default:
      return undefined;
  }
}

export function shapePathPart9(shapeName: string, _adj: number[] | undefined): string | undefined {
  switch (shapeName) {
    case "rightBrace":
      return "M 30 8 Q 70 8 70 28 T 92 50 T 70 72 T 30 92";
    case "leftBracket":
      return "M 70 8 H 36 V 92 H 70";
    case "rightBracket":
      return "M 30 8 H 64 V 92 H 30";
    case "bracePair":
      return "M 28 8 Q 8 8 8 50 Q 8 92 28 92 M 72 8 Q 92 8 92 50 Q 92 92 72 92";
    case "bracketPair":
      return "M 28 8 H 12 V 92 H 28 M 72 8 H 88 V 92 H 72";
    case "ribbon":
    case "ribbon2":
    case "ellipseRibbon":
    case "ellipseRibbon2":
    case "leftRightRibbon":
      return poly([
        [8, 38],
        [20, 50],
        [8, 62],
        [78, 62],
        [92, 50],
        [78, 38],
      ]);
    case "horizontalScroll":
      return "M 16 28 H 84 Q 96 28 96 40 V 68 Q 96 80 84 80 H 16 Q 4 80 4 68 V 40 Q 4 28 16 28 Z M 16 28 Q 24 20 24 40 V 68";
    case "verticalScroll":
      return "M 28 16 V 84 Q 28 96 40 96 H 68 Q 80 96 80 84 V 16 Q 80 4 68 4 H 40 Q 28 4 28 16 Z";
    case "mathMinus":
      return poly([
        [12, 42],
        [88, 42],
        [88, 58],
        [12, 58],
      ]);
    case "mathMultiply":
    case "chartX":
    case "flowChartSummingJunction":
      return "M 22 18 L 50 42 L 78 18 L 86 26 L 58 50 L 86 74 L 78 82 L 50 58 L 22 82 L 14 74 L 42 50 L 14 26 Z";
    case "mathDivide":
      return "M 50 18 A 6 6 0 1 1 49.9 18 Z M 14 46 H 86 V 54 H 14 Z M 50 76 A 6 6 0 1 1 49.9 76 Z";
    default:
      return undefined;
  }
}

export function shapePathPart10(shapeName: string, _adj: number[] | undefined): string | undefined {
  switch (shapeName) {
    case "mathEqual":
      return "M 14 34 H 86 V 44 H 14 Z M 14 56 H 86 V 66 H 14 Z";
    case "mathNotEqual":
      return "M 14 34 H 86 V 44 H 14 Z M 14 56 H 86 V 66 H 14 Z M 30 18 L 70 82";
    case "cornerTabs":
    case "squareTabs":
    case "plaqueTabs":
      return "M 8 8 H 28 V 28 H 8 Z M 72 8 H 92 V 28 H 72 Z M 8 72 H 28 V 92 H 8 Z M 72 72 H 92 V 92 H 72 Z";
    case "actionButtonHome":
      return poly([
        [16, 52],
        [50, 18],
        [84, 52],
        [84, 84],
        [62, 84],
        [62, 62],
        [38, 62],
        [38, 84],
        [16, 84],
      ]);
    case "actionButtonHelp":
      return "M 50 8 A 40 40 0 1 1 49.9 8 Z M 40 36 Q 40 24 50 24 Q 62 24 62 36 Q 62 46 50 50 V 60 M 50 72 A 4 4 0 1 1 49.9 72 Z";
    case "actionButtonInformation":
      return "M 50 8 A 40 40 0 1 1 49.9 8 Z M 50 28 A 5 5 0 1 1 49.9 28 Z M 44 42 H 54 V 74 H 44 Z";
    case "actionButtonBackPrevious":
    case "actionButtonBeginning":
      return poly([
        [72, 20],
        [28, 50],
        [72, 80],
      ]);
    case "actionButtonForwardNext":
    case "actionButtonEnd":
      return poly([
        [28, 20],
        [72, 50],
        [28, 80],
      ]);
    case "actionButtonReturn":
      return "M 30 28 H 70 V 48 L 88 36 L 70 70 V 56 H 24 V 28";
    case "actionButtonDocument":
      return poly([
        [28, 10],
        [68, 10],
        [78, 22],
        [78, 90],
        [28, 90],
      ]);
    case "actionButtonMovie":
      return poly([
        [16, 28],
        [70, 28],
        [70, 42],
        [86, 30],
        [86, 70],
        [70, 58],
        [70, 72],
        [16, 72],
      ]);
    case "actionButtonSound":
      return (
        poly([
          [18, 40],
          [36, 40],
          [54, 24],
          [54, 76],
          [36, 60],
          [18, 60],
        ]) + " M 64 40 Q 78 50 64 60"
      );
    case "flowChartDocument":
      return "M 10 14 H 90 V 72 Q 70 88 50 72 T 10 72 Z";
    default:
      return undefined;
  }
}

export function shapePathPart11(shapeName: string, _adj: number[] | undefined): string | undefined {
  switch (shapeName) {
    case "flowChartMultidocument":
      return "M 18 10 H 86 V 20 H 92 V 76 Q 74 90 56 76 T 18 76 Z M 12 20 H 18 V 82 H 80";
    case "flowChartInputOutput":
    case "flowChartManualOperation":
      return poly([
        [22, 16],
        [92, 16],
        [78, 84],
        [8, 84],
      ]);
    case "flowChartPredefinedProcess":
      return "M 10 18 H 90 V 82 H 10 Z M 22 18 V 82 M 78 18 V 82";
    case "flowChartInternalStorage":
      return "M 12 16 H 88 V 84 H 12 Z M 12 32 H 88 M 28 16 V 84";
    case "flowChartManualInput":
      return poly([
        [12, 28],
        [88, 12],
        [88, 86],
        [12, 86],
      ]);
    case "flowChartDelay":
      return "M 16 18 H 62 A 24 32 0 0 1 62 82 H 16 Z";
    case "flowChartTerminator":
      return "M 28 20 H 72 Q 90 20 90 50 Q 90 80 72 80 H 28 Q 10 80 10 50 Q 10 20 28 20 Z";
    case "flowChartOffpageConnector":
      return poly([
        [16, 12],
        [84, 12],
        [84, 68],
        [50, 90],
        [16, 68],
      ]);
    case "flowChartPunchedCard":
      return poly([
        [24, 14],
        [88, 14],
        [88, 86],
        [12, 86],
        [12, 28],
      ]);
    case "flowChartPunchedTape":
      return "M 10 28 Q 30 12 50 28 T 90 28 V 72 Q 70 88 50 72 T 10 72 Z";
    case "flowChartCollate":
      return poly([
        [16, 14],
        [84, 14],
        [50, 50],
        [84, 86],
        [16, 86],
        [50, 50],
      ]);
    case "flowChartSort":
      return poly([
        [50, 8],
        [90, 50],
        [50, 92],
        [10, 50],
      ]);
    case "flowChartExtract":
      return poly([
        [16, 86],
        [84, 86],
        [50, 16],
      ]);
    case "flowChartMerge":
      return poly([
        [16, 16],
        [84, 16],
        [50, 86],
      ]);
    case "flowChartOr":
      return "M 50 8 A 40 40 0 1 1 49.9 8 Z M 50 8 V 92 M 10 50 H 90";
    case "flowChartOnlineStorage":
      return "M 22 18 H 78 C 94 18 94 82 78 82 H 22 C 6 82 6 18 22 18 Z";
    default:
      return undefined;
  }
}

export function shapePathPart12(shapeName: string, _adj: number[] | undefined): string | undefined {
  switch (shapeName) {
    case "flowChartMagneticDisk":
    case "flowChartMagneticDrum":
      return "M 18 28 C 18 14 82 14 82 28 V 72 C 82 86 18 86 18 72 Z M 18 28 C 18 42 82 42 82 28";
    case "flowChartMagneticTape":
      return "M 50 16 A 34 34 0 1 1 28 78 L 16 88";
    case "flowChartOfflineStorage":
      return poly([
        [16, 16],
        [84, 16],
        [68, 86],
        [32, 86],
      ]);
    case "flowChartDisplay":
      return "M 20 20 H 78 L 92 50 L 78 80 H 20 Q 8 80 8 50 Q 8 20 20 20 Z";
    default:
      return undefined;
  }
}

export const shapePathParts2: ShapePathPart[] = [
  shapePathPart6,
  shapePathPart7,
  shapePathPart8,
  shapePathPart9,
  shapePathPart10,
  shapePathPart11,
  shapePathPart12,
];
