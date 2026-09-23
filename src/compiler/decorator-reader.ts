import { parse } from "@swc/core";
import type {
  ArrayExpression,
  BindingIdentifier,
  BooleanLiteral,
  ClassDeclaration,
  ClassMember,
  Decorator,
  Expression,
  ModuleItem,
  NumericLiteral,
  ObjectExpression,
  Param,
  Pattern,
  PropertyName,
  Span,
  StringLiteral,
  TsParameterProperty,
} from "@swc/core";
import { TokenName } from "@/compiler/token-name.ts";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
import type { BindingsMetadata, DecoratorMetadata, ModuleImport, ProviderMetadata } from "@/metadata/decorator-metadata.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";

/** Nombre local de un import → símbolo exportado + paquete (`undefined` = relativo, mismo paquete que el archivo). */
type ImportMap = Map<string, { symbol: string; packageName: string | undefined; specifier: string }>;

/** Inputs/outputs/host de la clase — los `providers` se leen aparte, del objeto del decorador. */
type ClassBindings = Omit<BindingsMetadata, "providers">;

/** Lo que cada clase del archivo necesita para resolver nombres de DI (`TokenName`). */
interface FileContext {
  path: string;
  code: string;
  imports: ImportMap;
}

/** Claves que acepta un provider objeto — cualquier otra es error (no se ignora en silencio). */
const PROVIDER_KEYS = new Set(["provide", "useClass", "useValue", "useFactory", "useExisting", "deps", "multi"]);
const PROVIDER_RECIPES = ["useClass", "useValue", "useFactory", "useExisting"] as const;

const CLASS_DECORATOR_KIND: Record<string, DecoratorMetadata["kind"]> = {
  Component: "component",
  Directive: "directive",
  Pipe: "pipe",
  Service: "service",
  Injectable: "injectable",
  NgModule: "ngmodule",
};

/**
 * Fase 1 del pipeline de compilación: parsea (vía `@swc/core`), GUARDA en
 * `MetadataStore`, y SACA del código cada decorador que ya leyó
 * (`@Component`/`@Input`/`@Inject`/etc.) — el punto es que ese trabajo deje
 * de correr en runtime, no que conviva al lado. Lo que no reconoce (un
 * decorador de otra librería) lo deja intacto.
 */
export class DecoratorReader {
  private static readonly PROPERTY_BINDING_HANDLERS: Record<
    string,
    (bindings: ClassBindings, propName: string, override: string) => void
  > = {
    Input: (bindings, propName, bindingName) => bindings.inputs.push({ propName, bindingName }),
    Output: (bindings, propName, bindingName) => bindings.outputs.push({ propName, bindingName }),
    HostBinding: (bindings, propName, hostProperty) => bindings.hostBindings.push({ propName, hostProperty }),
  };

  private static readonly LITERAL_READERS: Record<string, (expr: Expression) => unknown> = {
    StringLiteral: (expr) => (expr as StringLiteral).value,
    NumericLiteral: (expr) => (expr as NumericLiteral).value,
    BooleanLiteral: (expr) => (expr as BooleanLiteral).value,
    NullLiteral: () => null,
    ArrayExpression: (expr) =>
      (expr as ArrayExpression).elements.map((el) => (el ? DecoratorReader.literalValue(el.expression) : undefined)),
    ObjectExpression: (expr) => DecoratorReader.objectLiteralValue(expr as ObjectExpression),
  };

  static async read(code: string, path: string): Promise<string | undefined> {
    if (!/@(Component|Directive|Pipe|Service|Injectable|NgModule)\s*\(/.test(code)) return undefined;

    const ast = await parse(code, { syntax: "typescript", decorators: true, target: "es2022" });

    const context: FileContext = { path, code, imports: DecoratorReader.readImports(ast.body) };
    const metadata: DecoratorMetadata[] = [];
    const stripSpans: Span[] = [];
    for (const item of ast.body) {
      const cls = DecoratorReader.unwrapClassDeclaration(item);
      const found = cls && DecoratorReader.readClassMetadata(cls, stripSpans, context);
      if (found) metadata.push(found);
    }

    if (!metadata.length) return undefined;

    MetadataStore.set(path, metadata);
    return DecoratorReader.stripSpans(code, stripSpans);
  }

  /**
   * Saca cada span de atrás para adelante — de adelante para atrás correr un
   * splice invalidaría los offsets de los que faltan. `-1` en start/end:
   * `Span` de `@swc/core` arranca en `BytePos(1)`, no en 0 — confirmado con
   * un parse de prueba (`code.slice(span.start, span.end)` corta un
   * caracter de más al final y pierde el `@` al principio sin el ajuste).
   */
  private static stripSpans(code: string, spans: Span[]): string {
    const sorted = [...spans].sort((a, b) => b.start - a.start);
    return sorted.reduce((result, span) => result.slice(0, span.start - 1) + result.slice(span.end - 1), code);
  }

  /** `import { A as B } from "./x"` → `B → { symbol: "A", packageName: undefined }`; default/namespace no aplican (no son un símbolo con nombre). */
  private static readImports(body: ModuleItem[]): ImportMap {
    const imports: ImportMap = new Map();

    for (const item of body) {
      if (item.type !== "ImportDeclaration") continue;
      const packageName = TokenName.packageFromSpecifier(item.source.value);

      for (const specifier of item.specifiers) {
        if (specifier.type !== "ImportSpecifier") continue;
        const symbol = specifier.imported?.value ?? specifier.local.value;
        imports.set(specifier.local.value, { symbol, packageName, specifier: item.source.value });
      }
    }

    return imports;
  }

  /** Identificador local → nombre de DI: por su import si viene de otro archivo, si no declarado acá (mismo paquete). */
  private static diName(local: string, context: FileContext): string {
    const imported = context.imports.get(local);
    return TokenName.of(imported?.symbol ?? local, imported?.packageName ?? TokenName.packageOf(context.path));
  }

  private static unwrapClassDeclaration(item: ModuleItem): ClassDeclaration | undefined {
    if (item.type === "ClassDeclaration") return item;
    if (item.type === "ExportDeclaration" && item.declaration.type === "ClassDeclaration") return item.declaration;
    return undefined;
  }

  private static readClassMetadata(cls: ClassDeclaration, stripSpans: Span[], context: FileContext): DecoratorMetadata | undefined {
    for (const decorator of cls.decorators ?? []) {
      const decoratorName = DecoratorReader.decoratorCallName(decorator);
      const kind = decoratorName ? CLASS_DECORATOR_KIND[decoratorName] : undefined;
      if (!kind) continue;

      stripSpans.push(decorator.span);
      const className = cls.identifier.value;

      const argExpr = DecoratorReader.decoratorFirstArgExpression(decorator);
      const objExpr = argExpr?.type === "ObjectExpression" ? argExpr : undefined;

      if (kind === "ngmodule") {
        return {
          kind,
          className,
          declarations: DecoratorReader.identifierArray(objExpr, "declarations"),
          imports: DecoratorReader.readModuleImports(objExpr, className, context),
          providers: DecoratorReader.readProviders(objExpr, className, context),
          bootstrap: DecoratorReader.identifierArray(objExpr, "bootstrap"),
          controllerAs: DecoratorReader.stringProp(objExpr, "controllerAs"),
        };
      }

      const options = DecoratorReader.decoratorFirstArgObject(decorator);
      const { constructorTokens, constructorImports } = DecoratorReader.readConstructorTokens(cls, stripSpans, context);

      if (kind === "component" || kind === "directive") {
        return {
          kind,
          className,
          options,
          constructorTokens,
          constructorImports,
          ...DecoratorReader.readBindings(cls.body, stripSpans),
          providers: DecoratorReader.readProviders(objExpr, className, context),
        };
      }

      if (kind === "service" || kind === "injectable") {
        return { kind, className, options, constructorTokens, constructorImports, token: DecoratorReader.diName(className, context) };
      }

      return { kind, className, options, constructorTokens, constructorImports };
    }
    return undefined;
  }

  private static decoratorFirstArgExpression(decorator: Decorator): Expression | undefined {
    const expr = decorator.expression;
    return expr.type === "CallExpression" ? expr.arguments[0]?.expression : undefined;
  }

  /** `controllerAs: "ctrl"` — string literal simple, mismo criterio que el resto de `options`. */
  private static stringProp(objExpr: ObjectExpression | undefined, key: string): string | undefined {
    if (!objExpr) return undefined;
    for (const prop of objExpr.properties) {
      if (prop.type !== "KeyValueProperty" || DecoratorReader.propName(prop.key) !== key) continue;
      return prop.value.type === "StringLiteral" ? prop.value.value : undefined;
    }
    return undefined;
  }

  /** `declarations: [CardComponent]` — identificadores, no literales; `literalValue` no los resuelve a propósito. */
  private static identifierArray(objExpr: ObjectExpression | undefined, key: string): string[] {
    if (!objExpr) return [];

    for (const prop of objExpr.properties) {
      if (prop.type !== "KeyValueProperty" || DecoratorReader.propName(prop.key) !== key) continue;
      if (prop.value.type !== "ArrayExpression") return [];

      return prop.value.elements
        .map((el) => (el?.expression.type === "Identifier" ? el.expression.value : undefined))
        .filter((value): value is string => Boolean(value));
    }

    return [];
  }

  /**
   * `imports: [...]` de `@NgModule` — array literal (anidados se aplanan, como Angular). Un string es un
   * módulo de AngularJS por nombre; un identificador/`legacy.module` se resuelve después en el scanner
   * (`@NgModule` propio, de otro paquete o `IModule` legacy); `angular.module("x")` es un `IModule`. Cualquier otra
   * llamada (`RouterModule.forRoot()`) es error: daría `undefined` como módulo.
   */
  private static readModuleImports(objExpr: ObjectExpression | undefined, owner: string, context: FileContext): ModuleImport[] {
    const value = DecoratorReader.propValue(objExpr, "imports");
    if (!value) return [];
    if (value.type !== "ArrayExpression") {
      throw new Error(`DecoratorReader: "${owner}" — \`imports\` tiene que ser un array literal.`);
    }
    return DecoratorReader.moduleImportElements(value, owner, context);
  }

  private static moduleImportElements(array: ArrayExpression, owner: string, context: FileContext): ModuleImport[] {
    return array.elements.flatMap((element): ModuleImport[] => {
      if (!element || element.spread) {
        throw new Error(`DecoratorReader: "${owner}" — \`imports\` no admite huecos ni \`...spread\`.`);
      }

      const { expression } = element;
      if (expression.type === "ArrayExpression") return DecoratorReader.moduleImportElements(expression, owner, context);
      if (expression.type === "StringLiteral") return [{ kind: "name", name: expression.value }];
      if (expression.type === "Identifier") return [{ kind: "reference", identifier: expression.value }];
      if (expression.type === "MemberExpression") return [{ kind: "expression", expr: DecoratorReader.source(expression, context) }];
      if (DecoratorReader.isAngularModuleCall(expression)) {
        return [{ kind: "angularModule", expr: DecoratorReader.source(expression, context) }];
      }

      throw new Error(
        `DecoratorReader: "${owner}" — import \`${DecoratorReader.source(expression, context)}\` no soportado (un @NgModule, un angular.IModule o el nombre de un módulo).`,
      );
    });
  }

  /** `angular.module("x")` — la única llamada que da un `IModule` sin ambigüedad. */
  private static isAngularModuleCall(expr: Expression): boolean {
    if (expr.type !== "CallExpression" || expr.callee.type !== "MemberExpression") return false;
    const { object, property } = expr.callee;
    return object.type === "Identifier" && object.value === "angular" && property.type === "Identifier" && property.value === "module";
  }

  /**
   * `providers: [...]` — array literal (anidados se aplanan, como Angular). Cada elemento es una clase
   * (`UserService`) o un objeto literal (`{ provide, useClass/useValue/useFactory/useExisting, deps, multi }`).
   * Lo que no se puede leer en build (variable, `...spread`, `provideX()`) es error, nunca se descarta.
   */
  private static readProviders(objExpr: ObjectExpression | undefined, owner: string, context: FileContext): ProviderMetadata[] {
    const value = DecoratorReader.propValue(objExpr, "providers");
    if (!value) return [];
    if (value.type !== "ArrayExpression") {
      throw new Error(`DecoratorReader: "${owner}" — \`providers\` tiene que ser un array literal.`);
    }
    return DecoratorReader.providerElements(value, owner, context);
  }

  private static providerElements(array: ArrayExpression, owner: string, context: FileContext): ProviderMetadata[] {
    return array.elements.flatMap((element): ProviderMetadata[] => {
      if (!element || element.spread) {
        throw new Error(`DecoratorReader: "${owner}" — \`providers\` no admite huecos ni \`...spread\`.`);
      }

      const { expression } = element;
      if (expression.type === "ArrayExpression") return DecoratorReader.providerElements(expression, owner, context);
      if (expression.type === "Identifier") {
        return [{ kind: "class", token: DecoratorReader.diName(expression.value, context), classExpr: expression.value }];
      }
      if (expression.type === "ObjectExpression") return [DecoratorReader.providerObject(expression, owner, context)];

      throw new Error(
        `DecoratorReader: "${owner}" — provider \`${DecoratorReader.source(expression, context)}\` no soportado (solo una clase o un objeto { provide, ... }).`,
      );
    });
  }

  private static providerObject(object: ObjectExpression, owner: string, context: FileContext): ProviderMetadata {
    const fail = (reason: string): never => {
      throw new Error(`DecoratorReader: "${owner}" — provider \`${DecoratorReader.source(object, context)}\`: ${reason}`);
    };

    const props = new Map<string, Expression>();
    for (const prop of object.properties) {
      const key = prop.type === "KeyValueProperty" ? DecoratorReader.propName(prop.key) : undefined;
      if (prop.type !== "KeyValueProperty" || !key) return fail("solo admite propiedades `clave: valor`.");
      if (!PROVIDER_KEYS.has(key)) return fail(`clave "${key}" desconocida.`);
      props.set(key, prop.value);
    }

    const provide = props.get("provide") ?? fail("falta `provide`.");
    const token = DecoratorReader.tokenOf(provide, context) ?? fail("`provide` tiene que ser una clase, un InjectionToken o un string.");

    const multiExpr = props.get("multi");
    if (multiExpr && multiExpr.type !== "BooleanLiteral") fail("`multi` tiene que ser true/false literal.");
    const multi = multiExpr?.type === "BooleanLiteral" && multiExpr.value;

    const depsExpr = props.get("deps");
    const deps = depsExpr && DecoratorReader.depsOf(depsExpr, context, fail);

    const recipes = PROVIDER_RECIPES.filter((recipe) => props.has(recipe));
    if (recipes.length > 1) fail(`solo una receta a la vez (${recipes.join(", ")}).`);

    switch (recipes[0]) {
      case "useClass":
        return { kind: "useClass", token, classExpr: DecoratorReader.source(props.get("useClass")!, context), deps, multi };
      case "useValue":
        return { kind: "useValue", token, valueExpr: DecoratorReader.source(props.get("useValue")!, context), multi };
      case "useFactory":
        return { kind: "useFactory", token, factoryExpr: DecoratorReader.source(props.get("useFactory")!, context), deps: deps ?? [], multi };
      case "useExisting": {
        const existingToken = DecoratorReader.tokenOf(props.get("useExisting")!, context);
        return existingToken
          ? { kind: "useExisting", token, existingToken, multi }
          : fail("`useExisting` tiene que ser una clase, un InjectionToken o un string.");
      }
      default:
        if (provide.type !== "Identifier") return fail("sin receta, `provide` tiene que ser una clase.");
        return { kind: "constructor", token, classExpr: provide.value, deps, multi };
    }
  }

  /** `deps: [A, "$http"]` → nombres de DI; los flags de Angular (`[new Optional(), A]`) no se soportan todavía. */
  private static depsOf(expr: Expression, context: FileContext, fail: (reason: string) => never): string[] {
    if (expr.type !== "ArrayExpression") return fail("`deps` tiene que ser un array literal.");
    return expr.elements.map((element) => {
      const token = element && !element.spread ? DecoratorReader.tokenOf(element.expression, context) : undefined;
      return token ?? fail("cada elemento de `deps` tiene que ser una clase, un InjectionToken o un string.");
    });
  }

  /** Identificador → nombre de DI (`TokenName`); string literal → tal cual (nombre de AngularJS). */
  private static tokenOf(expr: Expression, context: FileContext): string | undefined {
    if (expr.type === "Identifier") return DecoratorReader.diName(expr.value, context);
    if (expr.type === "StringLiteral") return expr.value;
    return undefined;
  }

  private static propValue(objExpr: ObjectExpression | undefined, key: string): Expression | undefined {
    for (const prop of objExpr?.properties ?? []) {
      if (prop.type === "KeyValueProperty" && DecoratorReader.propName(prop.key) === key) return prop.value;
    }
    return undefined;
  }

  /** Texto fuente de un nodo — los `Span` de `@swc/core` son offsets en BYTES UTF-8 desde 1, no índices de string. */
  private static source(node: Expression, context: FileContext): string {
    const { start, end } = (node as Expression & { span: Span }).span;
    return Buffer.from(context.code, "utf8").subarray(start - 1, end - 1).toString("utf8");
  }

  private static readBindings(members: ClassMember[], stripSpans: Span[]): ClassBindings {
    const bindings: ClassBindings = { inputs: [], outputs: [], hostBindings: [], hostListeners: [] };

    for (const member of members) {
      if (member.type === "ClassProperty") {
        const name = DecoratorReader.propName(member.key);
        if (!name) continue;

        for (const decorator of member.decorators ?? []) {
          const args = DecoratorReader.decoratorArgs(decorator);
          const override = typeof args[0] === "string" ? args[0] : name;
          const decoratorName = DecoratorReader.decoratorCallName(decorator);
          const handler = decoratorName ? DecoratorReader.PROPERTY_BINDING_HANDLERS[decoratorName] : undefined;
          if (!handler) continue;
          handler(bindings, name, override);
          stripSpans.push(decorator.span);
        }
      }

      if (member.type === "ClassMethod") {
        const name = DecoratorReader.propName(member.key);
        if (!name) continue;

        for (const decorator of member.function.decorators ?? []) {
          if (DecoratorReader.decoratorCallName(decorator) !== "HostListener") continue;
          const [eventName] = DecoratorReader.decoratorArgs(decorator);
          bindings.hostListeners.push({ methodName: name, eventName: typeof eventName === "string" ? eventName : "" });
          stripSpans.push(decorator.span);
        }
      }
    }

    return bindings;
  }

  /**
   * Un nombre de DI por parámetro, en orden — `@Inject(Token)` si está, si no
   * la anotación de tipo (`constructor(private http: HttpClient)`, sin
   * decorador, como en Angular real). Sin ninguno de los dos no hay token que
   * inyectar: error en build (Angular real también falla ahí).
   */
  private static readConstructorTokens(
    cls: ClassDeclaration,
    stripSpans: Span[],
    context: FileContext,
  ): { constructorTokens: string[]; constructorImports: string[] } {
    const ctor = cls.body.find((member) => member.type === "Constructor");
    if (!ctor) return { constructorTokens: [], constructorImports: [] };

    const imports = new Set<string>();
    const constructorTokens = ctor.params.map((param, index) => {
      const token = DecoratorReader.paramToken(param, stripSpans, context);
      if (token === undefined) {
        throw new Error(
          `DecoratorReader: "${cls.identifier.value}" — el parámetro ${index} del constructor no tiene tipo de clase ni @Inject(), no hay token de DI que resolver.`,
        );
      }
      if (token.local) {
        const specifier = context.imports.get(token.local)?.specifier;
        if (specifier) imports.add(specifier);
      }
      return token.name;
    });
    return { constructorTokens, constructorImports: [...imports] };
  }

  /** `name` = nombre de DI; `local` = el identificador del que salió (para saber de qué archivo viene), si no era un string. */
  private static paramToken(
    param: TsParameterProperty | Param,
    stripSpans: Span[],
    context: FileContext,
  ): { name: string; local?: string } | undefined {
    for (const decorator of param.decorators ?? []) {
      if (DecoratorReader.decoratorCallName(decorator) !== "Inject") continue;
      stripSpans.push(decorator.span);
      const arg = DecoratorReader.decoratorFirstArgExpression(decorator);
      if (arg?.type === "Identifier") return { name: DecoratorReader.diName(arg.value, context), local: arg.value };
      if (arg?.type === "StringLiteral") return { name: arg.value };
    }

    const pat: Pattern = param.type === "TsParameterProperty" ? param.param : param.pat;
    // `Pattern` incluye tanto `BindingIdentifier` (con `typeAnnotation`) como el
    // `Identifier` de `Expression` (sin) — ambos con `type: "Identifier"`, TS no
    // los distingue solo, hace falta el cast.
    if (pat.type !== "Identifier") return undefined;
    const binding = pat as BindingIdentifier;

    const typeAnnotation = binding.typeAnnotation?.typeAnnotation;
    if (typeAnnotation?.type !== "TsTypeReference" || typeAnnotation.typeName.type !== "Identifier") return undefined;

    const local = typeAnnotation.typeName.value;
    return { name: DecoratorReader.diName(local, context), local };
  }

  private static decoratorCallName(decorator: Decorator): string | undefined {
    const expr = decorator.expression;
    if (expr.type === "CallExpression" && expr.callee.type === "Identifier") return expr.callee.value;
    if (expr.type === "Identifier") return expr.value;
    return undefined;
  }

  private static decoratorArgs(decorator: Decorator): unknown[] {
    const expr = decorator.expression;
    if (expr.type !== "CallExpression") return [];
    return expr.arguments.map((arg) => DecoratorReader.literalValue(arg.expression));
  }

  private static decoratorFirstArgObject(decorator: Decorator): Record<string, unknown> {
    const arg = DecoratorReader.decoratorArgs(decorator)[0];
    return arg && typeof arg === "object" && !Array.isArray(arg) ? (arg as Record<string, unknown>) : {};
  }

  /** Solo evalúa literales (string/número/booleano/null/array/objeto) — una referencia (identifier, etc.) no se puede resolver estáticamente acá. */
  private static literalValue(expr: Expression): unknown {
    return DecoratorReader.LITERAL_READERS[expr.type]?.(expr);
  }

  private static objectLiteralValue(expr: ObjectExpression): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const prop of expr.properties) {
      if (prop.type !== "KeyValueProperty") continue;
      const key = DecoratorReader.propName(prop.key);
      if (key) obj[key] = DecoratorReader.literalValue(prop.value);
    }
    return obj;
  }

  private static propName(key: PropertyName): string | undefined {
    if (key.type === "Identifier" || key.type === "StringLiteral") return key.value;
    if (key.type === "NumericLiteral") return String(key.value);
    return undefined;
  }
}

export const decoratorReaderTransform: NgjsTransform = {
  transform: (code, path) => DecoratorReader.read(code, path),
};
