import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

/** Resolve component bindings from actual AST declarations, including shared named lazy loaders. */
export function collectPageBindings(appFile, {
  webRoot = dirname(appFile),
  readSource = (file) => readFileSync(file, "utf8"),
  existsFile = (file) => existsSync(file) && statSync(file).isFile(),
} = {}) {
  const modules = new Map();
  const moduleFile = (from, specifier) => {
    if (!specifier.startsWith(".")) return null;
    const base = resolve(dirname(from), specifier);
    return [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")].find(existsFile) ?? null;
  };
  const isPage = (file) => {
    const inside = relative(webRoot, file).split(sep).join("/");
    return inside.startsWith("pages/") && /\.tsx?$/.test(inside);
  };
  const module = (file) => {
    if (modules.has(file)) return modules.get(file);
    const ast = ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const bindings = new Map();
    const variables = new Set();
    const imports = new Map();
    const exports = new Map();
    for (const statement of ast.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = moduleFile(file, statement.moduleSpecifier.text);
        const clause = statement.importClause;
        if (!target || !clause || clause.isTypeOnly) continue;
        if (clause.name) imports.set(clause.name.text, { file: target, name: "default" });
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const spec of clause.namedBindings.elements) {
            if (!spec.isTypeOnly) imports.set(spec.name.text, { file: target, name: spec.propertyName?.text ?? spec.name.text });
          }
        }
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) {
            bindings.set(declaration.name.text, declaration.initializer);
            variables.add(declaration.name.text);
          }
        }
      }
      if (ts.isFunctionDeclaration(statement) && statement.name) bindings.set(statement.name.text, statement);
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? moduleFile(file, statement.moduleSpecifier.text) : file;
        if (target) for (const spec of statement.exportClause.elements) exports.set(spec.name.text, { file: target, name: spec.propertyName?.text ?? spec.name.text });
      }
    }
    const result = { bindings, imports, exports, variables };
    modules.set(file, result);
    return result;
  };
  const resolveBinding = (file, name, seen) => {
    const key = `${file}::${name}`;
    if (seen.has(key)) return new Set();
    const nextSeen = new Set(seen).add(key);
    const info = module(file);
    const forwarded = info.exports.get(name) ?? info.imports.get(name);
    if (forwarded) return isPage(forwarded.file) ? new Set([forwarded.file]) : resolveBinding(forwarded.file, forwarded.name, nextSeen);
    const expression = info.bindings.get(name);
    if (!expression) return new Set();
    const pages = new Set();
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
          const target = moduleFile(file, node.arguments[0].text);
          if (target && isPage(target)) pages.add(target);
        }
        // Only arguments belong to the loader; do not inspect the lazy utility's implementation.
        node.arguments.forEach(visit);
        if (ts.isPropertyAccessExpression(node.expression)) visit(node.expression.expression);
        return;
      }
      if (ts.isIdentifier(node) && (info.bindings.has(node.text) || info.imports.has(node.text))) {
        for (const page of resolveBinding(file, node.text, nextSeen)) pages.add(page);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(expression);
    return pages;
  };
  const result = new Map();
  const info = module(appFile);
  for (const name of new Set([...info.variables, ...info.imports.keys()])) {
    const pages = resolveBinding(appFile, name, new Set());
    if (pages.size === 1) result.set(name, [...pages][0]);
    else if (pages.size > 1) throw new Error(`Ambiguous page binding ${name} in ${appFile}: ${[...pages].join(", ")}`);
  }
  return result;
}
