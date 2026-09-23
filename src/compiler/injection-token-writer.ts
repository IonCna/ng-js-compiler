import { parse } from "@swc/core";
import type { Expression, ModuleItem, ObjectExpression, VariableDeclaration } from "@swc/core";
import { DecoratorReader } from "@/compiler/decorator-reader.ts";
import { FactoryCode } from "@/compiler/factory-code.ts";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
import { PlatformCode } from "@/compiler/platform-code.ts";
import { TokenName } from "@/compiler/token-name.ts";

/**
 * `const API_URL = new InjectionToken(...)` a nivel de archivo → `API_URL.ɵprov = { token }`, como Ivy estampa
 * `ɵprov` en un `InjectionToken`. El nombre es el mismo que `TokenName` calcula en build en cada archivo que lo
 * usa (símbolo + paquete), así que coincide sin buscar los usos. Hace falta cuando el token llega como VALOR en
 * runtime (`providers` de un `ModuleWithProviders`, ver `ModuleWithProvidersRuntime`), no como texto fuente.
 *
 * Con `{ factory }` el token se provee solo, como en Angular (`providedIn: "root"`, el default con `factory`):
 * `ɵprov.factory` + la cola `providedIn: "root"` de la plataforma. Los `inject()` del factory se resuelven en build
 * igual que en un `useFactory` (`FactoryCode`). `providedIn: "any"`/`"platform"` no están soportados: error en build.
 *
 * Se reconoce por el símbolo `InjectionToken`, no por el paquete del que se importa.
 */
export class InjectionTokenWriter {
  static async write(code: string, path: string): Promise<string | undefined> {
    if (!/new\s+InjectionToken\b/.test(code)) return undefined;

    const ast = await parse(code, { syntax: "typescript", decorators: true, target: "es2022" });
    const declarations = ast.body.flatMap(InjectionTokenWriter.tokenDeclarations);
    if (!declarations.length) return undefined;

    const packageName = TokenName.packageOf(path);
    const statements = declarations.map(({ name, options }) => {
      const token = TokenName.of(name, packageName);
      const factoryExpr = InjectionTokenWriter.factoryOf(name, options);
      if (!factoryExpr) return `${name}.ɵprov = { token: ${JSON.stringify(token)} };`;

      const factory = DecoratorReader.tokenFactory(factoryExpr, name, code, path, ast.body);
      const array = FactoryCode.array([], undefined, factory.injectTokens, () => `(${factory.text})()`);
      return `${name}.ɵprov = { token: ${JSON.stringify(token)}, providedIn: "root", factory: ${array} };\n${PlatformCode.rootProviderStatement(token, `${name}.ɵprov.factory`)}`;
    });

    return `${code}\n${statements.join("\n")}\n`;
  }

  /** `{ providedIn?, factory }` → el `factory`; sin opciones o sin `factory`, `undefined` (solo el nombre). */
  private static factoryOf(name: string, options: ObjectExpression | undefined): Expression | undefined {
    let factory: Expression | undefined;
    for (const prop of options?.properties ?? []) {
      if (prop.type !== "KeyValueProperty" || (prop.key.type !== "Identifier" && prop.key.type !== "StringLiteral")) continue;
      if (prop.key.value === "factory") factory = prop.value;
      if (prop.key.value === "providedIn" && !(prop.value.type === "StringLiteral" && prop.value.value === "root")) {
        throw new Error(`InjectionTokenWriter: "${name}" — solo \`providedIn: "root"\` está soportado (es el default con \`factory\`).`);
      }
    }
    return factory;
  }

  private static tokenDeclarations(item: ModuleItem): { name: string; options?: ObjectExpression }[] {
    const declaration = InjectionTokenWriter.unwrapVariableDeclaration(item);
    if (!declaration) return [];

    return declaration.declarations.flatMap((declarator) => {
      const init = declarator.init;
      if (init?.type !== "NewExpression" || init.callee.type !== "Identifier" || init.callee.value !== "InjectionToken") return [];
      if (declarator.id.type !== "Identifier") return [];
      const options = init.arguments?.[1]?.expression;
      return [{ name: declarator.id.value, options: options?.type === "ObjectExpression" ? options : undefined }];
    });
  }

  private static unwrapVariableDeclaration(item: ModuleItem): VariableDeclaration | undefined {
    if (item.type === "VariableDeclaration") return item;
    if (item.type === "ExportDeclaration" && item.declaration.type === "VariableDeclaration") return item.declaration;
    return undefined;
  }
}

export const injectionTokenWriterTransform: NgjsTransform = {
  transform: (code, path) => InjectionTokenWriter.write(code, path),
};
