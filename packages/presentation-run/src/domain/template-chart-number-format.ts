type DecimalValue = Readonly<{
  negative: boolean;
  digits: string;
  scale: number;
}>;

type NumberCondition = Readonly<{
  operator: "<" | "<=" | "=" | "<>" | ">=" | ">";
  threshold: DecimalValue;
}>;

type NumberSection = Readonly<{
  decimals: number;
  percent: boolean;
  condition?: NumberCondition;
}>;

const DECIMAL_PATTERN = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i;
const CONDITION_PREFIX_PATTERN = /^(?:<=|>=|<>|=|<|>)/;
const CONDITION_PATTERN = /^(<=|>=|<>|=|<|>)([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/;

function parseDecimal(value: string): DecimalValue | undefined {
  const match = DECIMAL_PATTERN.exec(value.trim().replace(/,/g, "").replace(/%$/, ""));
  if (!match) return undefined;
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return undefined;
  let digits = `${integer}${fraction}`.replace(/^0+/, "") || "0";
  let scale = fraction.length - exponent;
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  if (scale > 1000) return undefined;
  const zero = /^0+$/.test(digits);
  return {
    negative: !zero && match[1] === "-",
    digits,
    scale,
  };
}

function compareAbsolute(left: DecimalValue, right: DecimalValue): number {
  const scale = Math.max(left.scale, right.scale);
  const leftDigits = `${left.digits}${"0".repeat(scale - left.scale)}`.replace(/^0+/, "") || "0";
  const rightDigits = `${right.digits}${"0".repeat(scale - right.scale)}`.replace(/^0+/, "") || "0";
  if (leftDigits.length !== rightDigits.length) {
    return leftDigits.length < rightDigits.length ? -1 : 1;
  }
  return leftDigits === rightDigits ? 0 : leftDigits < rightDigits ? -1 : 1;
}

function compareDecimal(left: DecimalValue, right: DecimalValue): number {
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  const magnitude = compareAbsolute(left, right);
  return left.negative ? -magnitude : magnitude;
}

function shiftDecimal(value: DecimalValue, places: number): DecimalValue {
  const scale = value.scale - places;
  return scale >= 0 ? { ...value, scale } : { ...value, digits: `${value.digits}${"0".repeat(-scale)}`, scale: 0 };
}

function incrementDigits(value: string): string {
  const digits = value.split("");
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (digits[index] !== "9") {
      digits[index] = String(Number(digits[index]) + 1);
      return digits.join("");
    }
    digits[index] = "0";
  }
  return `1${digits.join("")}`;
}

/** Decimal half ties round away from zero, matching the spreadsheet display. */
function roundDecimal(value: DecimalValue, decimals: number): DecimalValue {
  if (value.scale <= decimals) return value;
  const padded = value.digits.padStart(value.scale + 1, "0");
  const keptLength = padded.length - (value.scale - decimals);
  let kept = padded.slice(0, keptLength) || "0";
  if ((padded[keptLength] ?? "") >= "5") kept = incrementDigits(kept);
  return {
    negative: value.negative && !/^0+$/.test(kept),
    digits: kept.replace(/^0+/, "") || "0",
    scale: decimals,
  };
}

function splitSections(format: string): string[] | undefined {
  const sections: string[] = [];
  let section = "";
  let quoted = false;
  for (let index = 0; index < format.length; index += 1) {
    const char = format[index]!;
    if (char === "\\") {
      if (index + 1 >= format.length) return undefined;
      section += char + format[++index]!;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      section += char;
      continue;
    }
    if (char === "[" && !quoted) {
      const close = format.indexOf("]", index + 1);
      if (close < 0) return undefined;
      section += format.slice(index, close + 1);
      index = close;
      continue;
    }
    if (char === ";" && !quoted) {
      sections.push(section);
      section = "";
      continue;
    }
    section += char;
  }
  if (quoted) return undefined;
  sections.push(section);
  return sections;
}

function readNumberPattern(section: string): { pattern: string; condition?: NumberCondition } | undefined {
  let pattern = "";
  let quoted = false;
  let condition: NumberCondition | undefined;
  for (let index = 0; index < section.length; index += 1) {
    const char = section[index]!;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === "[") {
      const close = section.indexOf("]", index + 1);
      if (close < 0) return undefined;
      const bracket = section.slice(index + 1, close).trim();
      if (CONDITION_PREFIX_PATTERN.test(bracket)) {
        const match = CONDITION_PATTERN.exec(bracket);
        const threshold = match ? parseDecimal(match[2]!) : undefined;
        if (!match || !threshold || condition) return undefined;
        condition = {
          operator: match[1] as NumberCondition["operator"],
          threshold,
        };
      }
      index = close;
      continue;
    }
    if (char === "_" || char === "*") {
      index += 1;
      continue;
    }
    pattern += char;
  }
  if (quoted) return undefined;
  return { pattern, ...(condition ? { condition } : {}) };
}

function parseSection(section: string): NumberSection | undefined {
  const read = readNumberPattern(section);
  if (!read) return undefined;
  const { pattern, condition } = read;
  if (/[Ee][+-]?[0#]+/.test(pattern) || pattern.includes("?")) return undefined;
  const numberFormat = /[0#][0#,.]*/.exec(pattern)?.[0];
  if (!numberFormat || /,$/.test(numberFormat)) return undefined;
  const decimalPoint = numberFormat.indexOf(".");
  const decimalPattern = decimalPoint < 0 ? "" : numberFormat.slice(decimalPoint + 1);
  if (decimalPoint >= 0 && !/^[0#]+$/.test(decimalPattern)) return undefined;
  const parsed: NumberSection = {
    decimals: decimalPattern.length,
    percent: pattern.includes("%"),
    ...(condition ? { condition } : {}),
  };
  return parsed.decimals <= 100 ? parsed : undefined;
}

function conditionMatches(condition: NumberCondition, value: DecimalValue): boolean {
  const order = compareDecimal(value, condition.threshold);
  switch (condition.operator) {
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case "=":
      return order === 0;
    case "<>":
      return order !== 0;
    case ">=":
      return order >= 0;
    case ">":
      return order > 0;
  }
}

function sectionForValue(sections: readonly NumberSection[], value: DecimalValue): NumberSection | undefined {
  if (sections.some((section) => section.condition)) {
    return (
      sections.find((section) => section.condition && conditionMatches(section.condition, value)) ??
      sections.find((section) => !section.condition)
    );
  }
  const sign = compareDecimal(value, { negative: false, digits: "0", scale: 0 });
  const index = sections.length <= 1 ? 0 : sections.length === 2 ? (sign < 0 ? 1 : 0) : sign > 0 ? 0 : sign < 0 ? 1 : 2;
  return sections[index];
}

/** Compare chart caches using the section selected by each cached value. */
export function displayedChartValuesMatch(
  written: readonly (string | null)[],
  cached: readonly (string | null)[],
  numFmt: string | undefined,
): boolean {
  if (!numFmt || written.length !== cached.length) return false;
  const sections = splitSections(numFmt)?.map(parseSection);
  if (!sections?.length || sections.some((section) => !section)) return false;
  const parsedSections = sections as NumberSection[];
  return written.every((writtenValue, index) => {
    const cachedValue = cached[index];
    if (writtenValue === undefined || cachedValue === undefined) return false;
    if (writtenValue === null || cachedValue === null) return writtenValue === cachedValue;
    const sourcePercent = cachedValue.endsWith("%");
    const writtenPercent = writtenValue.endsWith("%");
    const source = parseDecimal(cachedValue);
    const writtenNumber = parseDecimal(writtenValue);
    if (!source || !writtenNumber) return false;
    const section = sectionForValue(parsedSections, source);
    if (!section || (!section.percent && (sourcePercent || writtenPercent))) return false;
    const displayed = roundDecimal(section.percent ? shiftDecimal(source, 2) : source, section.decimals);
    return writtenNumber.scale <= section.decimals && compareDecimal(writtenNumber, displayed) === 0;
  });
}
