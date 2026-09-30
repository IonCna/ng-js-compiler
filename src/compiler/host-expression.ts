import { parseSync } from "@swc/core";
import { CodeEdit } from "@/compiler/code-edit.ts";

type AstNode = { type?: string; span?: { start: number; end: number }; [key: string]: unknown };
type Edit = { start: number; end: number; text: string };

/** Claves de nodos de TypeScript (tipos, genéricos): sus identificadores no son valores. */
const TYPE_KEYS = new Set(["typeAnnotation", "typeArguments", "typeParameters", "typeParams"]);
/** Lo que no se puede escribir en una expresión de template de Angular (tampoco en `host`). */
const FORBIDDEN: Record<string, string> = {
  ArrowFunctionExpression: "funciones",
  FunctionExpression: "funciones",
  ClassExpression: "clases",
  VariableDeclaration: "declaraciones",
  FunctionDeclaration: "declaraciones",
  ClassDeclaration: "declaraciones",
  NewExpression: "`new`",
  SuperPropExpression: "`super`",
};

/**
 * Traduce las expresiones de `host: { ... }` del decorador (sintaxis de template de Angular) a JavaScript sobre la
 * instancia, para el factory que arma `HostWiring`: como en Angular, todo identificador libre es un miembro de la clase
 * (`isOpen && !disabled` → `instance.isOpen && !instance.disabled`, `this.x` → `instance.x`); en un listener además
 * `$event` es el evento. Sin pipes, funciones, `new` ni declaraciones (Angular tampoco los acepta ahí): error en build.
 */
export class HostExpression {
  /** `"[prop]": "expr"` → una expresión JS. */
  static binding(expression: string, where: string): string {
    return HostExpression.compile(`(${expression})`, where, false).slice(1, -1);
  }

  /** `"(evento)": "sentencias"` → sentencias JS (separadas por `;`), con `$event` → `event`. */
  static listener(statements: string, where: string): string {
    return HostExpression.compile(`{${statements}}`, where, true).slice(1, -1).trim();
  }

  private static compile(source: string, where: string, listener: boolean): string {
    const fail = (reason: string): never => {
      throw new Error(`HostExpression: ${where} — ${reason}`);
    };
    let ast: AstNode;
    try {
      ast = parseSync(source, { syntax: "typescript" }) as unknown as AstNode;
    } catch (error) {
      return fail(`no es una expresión válida (${error instanceof Error ? error.message.split("\n")[0] : String(error)}).`);
    }
    const base = ast.span!.start;
    const edits: Edit[] = [];
    const replace = (node: AstNode, text: string) => edits.push({ start: node.span!.start - base, end: node.span!.end - base, text });
    const reference = (node: AstNode): string => {
      const name = node.value as string;
      if (name === "$event" && listener) return "event";
      if (name === "undefined") return name;
      return `instance.${name}`;
    };

    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      const current = node as AstNode;
      switch (current.type) {
        case undefined:
          break; // `{ spread, expression }` de un argumento: se recorren sus valores.
        case "Identifier":
          replace(current, reference(current));
          return;
        case "ThisExpression":
          replace(current, "instance");
          return;
        case "MemberExpression":
          visit(current.object);
          if ((current.property as AstNode).type === "Computed") visit(current.property);
          return;
        case "KeyValueProperty":
          if ((current.key as AstNode).type === "Computed") visit(current.key);
          visit(current.value);
          return;
        case "ObjectExpression":
          for (const property of current.properties as AstNode[]) {
            // `{ a }` → `{ a: instance.a }`.
            if (property.type === "Identifier") replace(property, `${property.value as string}: ${reference(property)}`);
            else visit(property);
          }
          return;
        case "TsNonNullExpression": {
          visit(current.expression);
          const end = current.span!.end - base;
          edits.push({ start: end - 1, end, text: "" });
          return;
        }
        case "BinaryExpression":
          if (current.operator === "|") fail("los pipes no están soportados en `host` (tampoco en Angular).");
          break;
        default:
          if (FORBIDDEN[current.type]) fail(`no admite ${FORBIDDEN[current.type]}.`);
      }
      for (const [key, value] of Object.entries(current)) {
        if (key === "span" || key === "type" || TYPE_KEYS.has(key)) continue;
        visit(value);
      }
    };
    visit((ast.body as AstNode[])[0]);

    const indexOf = CodeEdit.byteToIndex(source);
    let output = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      output = output.slice(0, indexOf(edit.start)) + edit.text + output.slice(indexOf(edit.end));
    }
    return output;
  }
}
