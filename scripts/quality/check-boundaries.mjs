import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ROOT, appFor, sourceFiles } from "./source-files.mjs";

const LEGACY = ["pptd", "agent-core", "exporter-pptx", "design-brain"];
const NATIVE = ["pptd-v2", "project-store", "canvas-session", "exporter-native", "presentation-run", "dsh-slides-host"];

export function moduleImports(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    const value =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")
          ? node.arguments[0]
          : undefined;
    if (value && ts.isStringLiteralLike(value)) imports.push(value.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}

export function boundaryViolation(file, specifier) {
  const app = appFor(file);
  const target = specifier.startsWith(".")
    ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
    : specifier;
  const targetApp = appFor(target);
  if (targetApp && targetApp !== app) return `${file} imports application ${targetApp}`;
  const pkg = specifier.startsWith("@open-slidestudio/")
    ? specifier.split("/")[1]
    : /^packages\/([^/]+)\//.exec(target)?.[1];
  if ((app === "apps/native-web" || app === "dsh-slidestudio") && LEGACY.includes(pkg)) {
    return `${file} imports legacy package ${pkg}`;
  }
  if ((app === "apps/server" || app === "apps/web") && NATIVE.includes(pkg)) {
    return `${file} imports native document/runtime package ${pkg}`;
  }
  return null;
}

export function checkBoundaries(root = ROOT) {
  return sourceFiles(root).flatMap((file) =>
    moduleImports(file, readFileSync(path.join(root, file), "utf8"))
      .map((specifier) => boundaryViolation(file, specifier))
      .filter(Boolean),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkBoundaries();
  for (const failure of failures) console.error(failure);
  console.log(`Architecture imports: ${failures.length} violations`);
  process.exitCode = failures.length ? 1 : 0;
}
