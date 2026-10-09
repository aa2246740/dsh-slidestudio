import ts from "typescript";

export function debtMarkers(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const markers = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    if (!/\b(?:TODO|FIXME|HACK|XXX)\b/.test(scanner.getTokenText())) continue;
    markers.push({
      file,
      line: source.getLineAndCharacterOfPosition(scanner.getTokenPos()).line + 1,
      marker: scanner.getTokenText().trim(),
    });
  }
  return markers;
}
