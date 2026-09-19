/** Development-only AST inspection. Never imported into the MCP runtime or presenter. */
import ts from "typescript";
export interface SourceRegistration { name: string; file: string; line: number }
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node) ? unwrap(node.expression) : node;
}
export function extractToolAliases(text: string): Readonly<Record<string, string>> {
  const source = ts.createSourceFile("types.ts", text, ts.ScriptTarget.Latest, true);
  const aliases: Record<string, string> = {};
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "toolNames" && node.initializer) {
      const value = unwrap(node.initializer);
      if (!ts.isObjectLiteralExpression(value)) throw new Error("toolNames must remain statically inspectable");
      for (const p of value.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isStringLiteral(p.initializer)) throw new Error("Dynamic toolNames member");
        aliases[p.name.getText(source)] = p.initializer.text;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source); return aliases;
}
export function extractRegistrations(file: string, text: string, aliases: Readonly<Record<string, string>>): SourceRegistration[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const rows: SourceRegistration[] = [];
  function names(node: ts.Expression, call: ts.CallExpression): string[] {
    node = unwrap(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === "toolNames") {
      const value = aliases[node.name.text]; if (!value) throw new Error(`Unresolved alias ${node.getText(source)}`); return [value];
    }
    if (ts.isTemplateExpression(node) && node.templateSpans.length === 1) {
      const span = node.templateSpans[0]!;
      for (let parent: ts.Node | undefined = call.parent; parent; parent = parent.parent) {
        if (!ts.isForOfStatement(parent) || !ts.isVariableDeclarationList(parent.initializer)) continue;
        const binding = parent.initializer.declarations[0]?.name.getText(source);
        if (span.expression.getText(source) !== binding) continue;
        const values = unwrap(parent.expression);
        if (ts.isArrayLiteralExpression(values) && values.elements.every(ts.isStringLiteral)) return values.elements.map(value => `${node.head.text}${(value as ts.StringLiteral).text}${span.literal.text}`);
      }
    }
    // Audited wrapper implementations; their literal invocation sites are collected below.
    if (file === "src/orchestration-v2-tools.ts" && ts.isIdentifier(node) && node.text === "name") return [];
    if (file === "src/coordinator-tools.ts" && ts.isIdentifier(node) && node.text === "toolName") return [];
    throw new Error(`Unresolved registration in ${file}:${source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1}: ${node.getText(source)}`);
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      let argument: ts.Expression | undefined;
      if (ts.isPropertyAccessExpression(expr) && expr.name.text === "registerTool") argument = node.arguments[0];
      else if (ts.isIdentifier(expr) && expr.text === "registerAppTool") argument = node.arguments[1];
      else if (file === "src/orchestration-v2-tools.ts" && ts.isIdentifier(expr) && expr.text === "register") argument = node.arguments[0];
      else if (file === "src/coordinator-tools.ts" && ts.isIdentifier(expr) && expr.text === "registerLeaseMutationTool") argument = node.arguments[1];
      if (argument) for (const name of names(argument, node)) rows.push({ name, file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(source); return rows;
}
