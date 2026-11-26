/**
 * Environment for the PDF child processes (image extraction and page render).
 * Only PATH and the temp-directory variables cross into a child, so credentials
 * and other parent settings stay in the parent. A child that writes temp files
 * therefore lands in the same temp root as its parent. Never widen this list.
 * @param {Record<string, string | undefined>} [source]
 * @returns {Record<string, string>}
 */
export function childProcessEnv(source = process.env) {
  /** @type {Record<string, string>} */
  const env = { PATH: source.PATH ?? "/usr/bin:/bin" };
  for (const name of ["TMPDIR", "TMP", "TEMP"]) {
    const value = source[name];
    if (value) env[name] = value;
  }
  return env;
}
