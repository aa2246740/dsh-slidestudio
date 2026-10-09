import ts from "typescript";

function isFunction(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function complexity(body) {
  let value = 1;
  function visit(node) {
    if (isFunction(node)) return;
    if (
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isCaseClause(node) ||
      ts.isCatchClause(node) ||
      ts.isConditionalExpression(node)
    )
      value += 1;
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
        node.operatorToken.kind,
      )
    )
      value += 1;
    ts.forEachChild(node, visit);
  }
  visit(body);
  return value;
}

export function measureSource(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const functions = {};
  const counts = new Map();
  function visit(node) {
    if (isFunction(node) && node.body) {
      const parent = node.parent;
      const label =
        node.name?.getText(source) ||
        (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)
          ? parent.name.getText(source)
          : "callback");
      const index = (counts.get(label) ?? 0) + 1;
      counts.set(label, index);
      functions[`${label}#${index}`] = complexity(node.body);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { lines: text.split(/\r?\n/).filter((line) => line.trim()).length, functions };
}

export function metricRegressions(file, current, baseline = {}) {
  const failures = [];
  if (current.lines > Math.max(500, baseline.lines ?? 0)) failures.push(`${file}: ${current.lines} nonblank lines`);
  for (const [name, value] of Object.entries(current.functions)) {
    if (value > Math.max(20, baseline.functions?.[name] ?? 0)) failures.push(`${file} ${name}: complexity ${value}`);
  }
  return failures;
}
