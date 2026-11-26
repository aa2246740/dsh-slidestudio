/**
 * Lazy loader for optional native image add-ons (`sharp`, `@napi-rs/canvas`).
 *
 * They are never package dependencies of the editor: a checkout without the
 * prebuilt binaries must still start, parse every text-bearing format and
 * pass its tests. Callers ask for a module and receive `null` when it is not
 * installed (or failed to load), then degrade with a typed warning instead of
 * throwing. Results are cached per process; tests replace them through
 * `setOptionalNativeOverride`.
 */

/** @typedef {"sharp" | "@napi-rs/canvas"} OptionalNativeName */

/** @type {Map<OptionalNativeName, Promise<any>>} */
const cache = new Map();
/** @type {Map<OptionalNativeName, any>} */
const overrides = new Map();

/**
 * @param {OptionalNativeName} name
 * @returns {Promise<any>}
 */
async function importOptional(name) {
  // The specifier is a variable on purpose: the add-on is resolved at run time only.
  const specifier = /** @type {string} */ (name);
  try {
    const mod = await import(specifier);
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}

/**
 * Resolve an optional native module, or `null` when it is unavailable.
 * @param {OptionalNativeName} name
 * @returns {Promise<any>}
 */
export function loadOptionalNative(name) {
  if (overrides.has(name)) return Promise.resolve(overrides.get(name));
  let pending = cache.get(name);
  if (!pending) {
    pending = importOptional(name);
    cache.set(name, pending);
  }
  return pending;
}

/** @param {OptionalNativeName} name */
export async function optionalNativeAvailable(name) {
  return (await loadOptionalNative(name)) !== null;
}

/**
 * Test seam: force a module to a stub (or `null` to simulate a missing add-on).
 * Passing `undefined` removes the override.
 * @param {OptionalNativeName} name
 * @param {any} value
 */
export function setOptionalNativeOverride(name, value) {
  if (value === undefined) overrides.delete(name);
  else overrides.set(name, value);
}
