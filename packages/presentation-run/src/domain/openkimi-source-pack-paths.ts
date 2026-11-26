export class OpenKimiSourcePackError extends Error {
  override readonly name = "OpenKimiSourcePackError";
}

export function assertSamePaths(expected: readonly string[], actual: readonly string[], sourceRoot: string): void {
  const missing = expected.filter((candidate) => !actual.includes(candidate));
  const added = actual.filter((candidate) => !expected.includes(candidate));
  if (missing.length > 0 || added.length > 0) {
    const chunks: string[] = [];
    if (missing.length > 0) chunks.push(`missing ${missing.join(", ")}`);
    if (added.length > 0) chunks.push(`added ${added.join(", ")}`);
    throw new OpenKimiSourcePackError(`source pack file set mismatch at ${sourceRoot}: ${chunks.join("; ")}`);
  }
}
