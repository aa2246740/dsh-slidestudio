import type { Schema } from "./write-page-schema.js";
import { isSupportedShapeName } from "./shape-catalog.js";

export function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : undefined;
}

export function typeIssue(path: string, expected: string, value: unknown): string {
  const received = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  // Types, not page content or primitive values, keep diagnostics private and
  // repeated-invalid-argument fingerprints stable.
  return `${path} must be ${expected} (received ${received})`;
}

/** Preserve oneOf validation, but explain the branch the model actually sent. */
export function unionIssues(
  branches: readonly Schema[],
  value: unknown,
  path: string,
  validate: (schema: Schema, value: unknown, path: string) => string[],
): string[] {
  const results = branches.map((branch) => validate(branch, value, path));
  const matches = results.filter((issues) => issues.length === 0);
  if (matches.length === 1) return [];
  if (matches.length > 1) return [`${path} matches more than one schema branch`];
  const candidate = record(value);
  if (!candidate && branches.every((branch) => "type" in branch && branch.type === "object")) {
    return [typeIssue(path, "an object", value)];
  }
  const elementTypes = branches.flatMap((branch) => {
    if (!("type" in branch) || branch.type !== "object") return [];
    const property = branch.properties?.elementType;
    return property && "const" in property && property.const ? [property.const] : [];
  });
  if (candidate && elementTypes.length === branches.length) {
    const discriminant = candidate.elementType;
    if (typeof discriminant !== "string" || !elementTypes.includes(discriminant)) {
      const hint =
        typeof discriminant === "string" && isSupportedShapeName(discriminant)
          ? `; use elementType "shape" with shapeName "${discriminant}"`
          : "";
      return [`${path}.elementType must be one of ${elementTypes.join(", ")}${hint}`];
    }
  }
  for (const key of ["elementType", "type"]) {
    const discriminant = candidate?.[key];
    if (typeof discriminant !== "string") continue;
    const matching = branches.filter((branch) => {
      if (!("type" in branch) || branch.type !== "object") return false;
      const property = branch.properties?.[key];
      return property && "const" in property && property.const === discriminant;
    });
    if (matching.length === 1) return validate(matching[0]!, value, path);
  }
  return [`${path} does not match any schema branch`];
}
