/**
 * Compile the compact parameter DSL used by slide tools (`required: true` on a
 * property, `type: "json"` for an unconstrained value) into the standard JSON
 * Schema every host publishes. The projection matches the DSH value-schema
 * compiler so the Hub request header does not change shape.
 */

type Node = Record<string, unknown>;

const ANNOTATIONS = ["description", "title", "default", "examples"] as const;
const SCALARS = new Set(["string", "number", "integer", "boolean", "null"]);

export class SchemaDslError extends Error {}

function isRecord(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyAnnotations(source: Node, target: Node): void {
  for (const key of ANNOTATIONS) if (Object.hasOwn(source, key)) target[key] = source[key];
}

function assertKeys(source: Node, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) throw new SchemaDslError(`${path}.${key} is not supported by the value schema DSL`);
  }
}

function compileObject(input: Node, path: string, keys: readonly string[]): Node {
  assertKeys(input, path, [...keys, "properties", "additionalProperties"]);
  if (typeof input.additionalProperties !== "boolean") {
    throw new SchemaDslError(`${path}.additionalProperties must be explicitly true or false`);
  }
  const node: Node = { type: "object" };
  copyAnnotations(input, node);
  node.additionalProperties = input.additionalProperties;
  if (Object.hasOwn(input, "properties")) {
    const map = compilePropertyMap(input.properties, `${path}.properties`);
    node.properties = map.properties;
    if (map.required.length) node.required = map.required;
  }
  return node;
}

function compileScalar(input: Node, path: string, keys: readonly string[], type: string): Node {
  assertKeys(input, path, [...keys, "enum", "const"]);
  const node: Node = { type };
  copyAnnotations(input, node);
  if (Object.hasOwn(input, "enum")) {
    if (!Array.isArray(input.enum) || input.enum.length === 0) {
      throw new SchemaDslError(`${path}.enum must be a non-empty array of scalar values`);
    }
    node.enum = [...input.enum];
  }
  if (Object.hasOwn(input, "const")) node.const = input.const;
  return node;
}

function compileValue(input: unknown, path: string, allowRequired: boolean): Node {
  if (!isRecord(input)) throw new SchemaDslError(`${path} must be a value schema object`);
  const keys = [...ANNOTATIONS, ...(allowRequired ? ["required"] : []), "type"];
  if (Object.hasOwn(input, "oneOf")) {
    assertKeys(input, path, [...keys.filter((key) => key !== "type"), "oneOf"]);
    const node: Node = {};
    copyAnnotations(input, node);
    if (!Array.isArray(input.oneOf)) throw new SchemaDslError(`${path}.oneOf must be an array`);
    node.oneOf = input.oneOf.map((branch, index) => compileValue(branch, `${path}.oneOf[${index}]`, false));
    return node;
  }
  const type = input.type;
  if (type === "json") {
    assertKeys(input, path, keys);
    const node: Node = {};
    copyAnnotations(input, node);
    return node;
  }
  if (type === "object") return compileObject(input, path, keys);
  if (type === "array") {
    assertKeys(input, path, [...keys, "items"]);
    const node: Node = { type: "array" };
    copyAnnotations(input, node);
    if (Object.hasOwn(input, "items")) node.items = compileValue(input.items, `${path}.items`, false);
    return node;
  }
  if (typeof type === "string" && SCALARS.has(type)) return compileScalar(input, path, keys, type);
  throw new SchemaDslError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
}

function compilePropertyMap(input: unknown, path: string): { properties: Node; required: string[] } {
  if (!isRecord(input)) throw new SchemaDslError(`${path} must be an object of value schemas`);
  const properties: Node = {};
  const required: string[] = [];
  for (const [key, property] of Object.entries(input)) {
    if (!isRecord(property)) throw new SchemaDslError(`${path}.${key} must be a value schema object`);
    if (Object.hasOwn(property, "required")) {
      if (property.required !== true) throw new SchemaDslError(`${path}.${key}.required must be true when present`);
      required.push(key);
    }
    properties[key] = compileValue(property, `${path}.${key}`, true);
  }
  return { properties, required };
}

/** Compile an implicit parameter map (`{ field: spec }`) to an object-rooted JSON Schema. */
export function compileParameterSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const map = compilePropertyMap(spec, "parameters");
  return {
    type: "object",
    properties: map.properties,
    ...(map.required.length ? { required: map.required } : {}),
  };
}

/** Close the root of an object schema (`additionalProperties: false`). */
export function closeSchemaRoot(schema: Record<string, unknown>): Record<string, unknown> {
  return { ...schema, additionalProperties: false };
}

/** Drop cardinality keywords some host DSLs cannot express. */
export function withoutCardinality<T>(spec: T): T {
  return JSON.parse(
    JSON.stringify(spec, (key, value: unknown) => (key === "minItems" || key === "maxItems" ? undefined : value)),
  ) as T;
}
