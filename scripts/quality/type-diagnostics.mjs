/** @param {string} output */
export function parseTypeDiagnostics(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^(.+?)\(\d+,\d+\): error (TS\d+: .+)$/))
    .filter(Boolean)
    .map((match) => `${match[1].replaceAll("\\", "/")} ${match[2]}`);
}
