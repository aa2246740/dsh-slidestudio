export function columnIndex(
  input: { data: { cols: readonly string[] } },
  encodedName: string | undefined,
  fallback: number,
): number {
  const encoded = encodedName ? input.data.cols.indexOf(encodedName) : -1;
  if (encoded >= 0) return encoded;
  return Math.min(Math.max(0, fallback), Math.max(0, input.data.cols.length - 1));
}

export function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
