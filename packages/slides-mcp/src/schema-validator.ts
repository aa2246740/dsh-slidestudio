/**
 * Zero-dependency JSON Schema validator for the canonical slide tool schemas.
 *
 * It covers exactly the vocabulary `@open-slidestudio/slides-tools` emits
 * (`type`, `integer`, `required`, `properties`, `additionalProperties`,
 * `items`, `enum`, `const`, `oneOf`) and words its violations like the DSH
 * host validator, so the shared issue localizers (`localizePlanArgIssues`)
 * rewrite them the same way for every host. Cardinality keywords
 * (`minItems`/`maxItems`) are annotations here, as they are for DSH, so one
 * argument set is accepted or refused identically by every host.
 */
import type { SlideSchemaValidator } from "@open-slidestudio/slides-tools";

type Schema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function label(path: string): string {
  return path === "" ? "arguments" : path;
}

function childPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkScalar(schema: Schema, value: unknown, path: string): string[] {
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => sameJson(allowed, value))) {
    return [`"${label(path)}" must be one of ${JSON.stringify(schema.enum)}`];
  }
  if (Object.hasOwn(schema, "const") && !sameJson(schema.const, value)) {
    return [`"${label(path)}" must be ${JSON.stringify(schema.const)}`];
  }
  return [];
}

function checkObject(schema: Schema, value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`"${label(path)}" must be an object`];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const out: string[] = [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === "string" && (!Object.hasOwn(value, key) || value[key] === undefined)) {
      out.push(`missing required property "${childPath(path, key)}"`);
    }
  }
  for (const [key, child] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) continue;
    if (isRecord(child)) out.push(...checkNode(child, value[key], childPath(path, key)));
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        out.push(`"${childPath(path, key)}" is not a declared property (additionalProperties: false)`);
      }
    }
  } else if (isRecord(schema.additionalProperties)) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        out.push(...checkNode(schema.additionalProperties, value[key], childPath(path, key)));
      }
    }
  }
  return out;
}

function checkArray(schema: Schema, value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return [`"${label(path)}" must be an array`];
  const items = schema.items;
  if (!isRecord(items)) return [];
  const out: string[] = [];
  value.forEach((entry, index) => out.push(...checkNode(items, entry, `${path}[${index}]`)));
  return out;
}

function checkNumber(schema: Schema, value: unknown, path: string, integer: boolean): string[] {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return [`"${label(path)}" must be ${integer ? "an integer" : "a number"}`];
  }
  if (integer && !Number.isInteger(value)) return [`"${label(path)}" must be an integer`];
  return checkScalar(schema, value, path);
}

function checkTyped(schema: Schema, type: unknown, value: unknown, path: string): string[] {
  switch (type) {
    case "object":
      return checkObject(schema, value, path);
    case "array":
      return checkArray(schema, value, path);
    case "string":
      return typeof value === "string" ? checkScalar(schema, value, path) : [`"${label(path)}" must be a string`];
    case "number":
      return checkNumber(schema, value, path, false);
    case "integer":
      return checkNumber(schema, value, path, true);
    case "boolean":
      return typeof value === "boolean" ? checkScalar(schema, value, path) : [`"${label(path)}" must be a boolean`];
    case "null":
      return value === null ? [] : [`"${label(path)}" must be null`];
    default:
      return checkScalar(schema, value, path);
  }
}

function checkNode(schema: Schema, value: unknown, path: string): string[] {
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.filter(isRecord);
    const matches = branches.filter((branch) => checkNode(branch, value, path).length === 0).length;
    return matches === 1 ? [] : [`"${label(path)}" must match exactly one oneOf branch (matched ${matches})`];
  }
  if (Array.isArray(schema.type)) {
    const ok = schema.type.some((type) => checkTyped(schema, type, value, path).length === 0);
    return ok ? [] : [`"${label(path)}" must be one of the types ${JSON.stringify(schema.type)}`];
  }
  return checkTyped(schema, schema.type, value, path);
}

/** Validate `value` against `schema`; an empty list means valid. */
export function validateJsonSchema(schema: Record<string, unknown>, value: unknown, path = ""): string[] {
  return checkNode(schema, value, path);
}

/** The validator handed to `SlideToolRuntimeDeps.validateSchema`. */
export const slideSchemaValidator: SlideSchemaValidator = (schema, value) => validateJsonSchema(schema, value, "");
